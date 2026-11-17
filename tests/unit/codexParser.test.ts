import { beforeEach, describe, expect, it } from 'vitest';
import { CodexFileParser } from '../../src/core/sources/codex/parser.ts';
import { emptyParseOutput, type ParseOutput } from '../../src/core/model/types.ts';
import { normalizedTotal } from '../../src/core/model/tokens.ts';
import { WriteRepo } from '../../src/db/writeRepo.ts';
import {
  addUsage,
  codexMeta,
  codexRecord,
  codexResponseItem,
  codexTaskComplete,
  codexTaskStarted,
  codexTokenCount,
  codexTurnContext,
  resetOrdinal,
  type CodexUsage,
} from '../fixtures/builders.ts';
import { memoryDb } from './helpers.ts';

const ctx = { fileKey: 'cf1', sourceId: 'cs1', billingMode: 'unknown' as const, accountKey: null };

function run(ls: string[], c = ctx, parser?: CodexFileParser): { out: ParseOutput; parser: CodexFileParser } {
  const p = parser ?? new CodexFileParser(c);
  const out = emptyParseOutput();
  let off = 0;
  for (const l of ls) {
    p.feed(l, off, out);
    off += l.length + 1;
  }
  return { out, parser: p };
}

const sum = (out: ParseOutput) => out.events.reduce((s, e) => s + normalizedTotal(e.tokens), 0);
const T = (s: number) => `2026-11-10T00:00:${String(s).padStart(2, '0')}Z`;

beforeEach(() => resetOrdinal());

describe('F: Codex の累積値と最新値', () => {
  const u1: CodexUsage = { input: 100, cached: 40, output: 10, reasoning: 4 };
  const u2: CodexUsage = { input: 200, cached: 150, output: 20, reasoning: 5 };

  it('token_count だけのログ: 累積と最新値を足さず、同じ累積値の再通知は数えない', () => {
    const c1 = u1;
    const c2 = addUsage(u1, u2);
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: c1, last: u1 }),
      codexTokenCount({ ts: T(3), total: c1, last: u1 }), // 再通知
      codexTokenCount({ ts: T(4), total: c2, last: u2 }),
      codexTokenCount({ ts: T(5), total: c2, last: u2 }), // 再通知
    ]);
    expect(out.events).toHaveLength(2);
    expect(sum(out)).toBe(330); // (100+10) + (200+20)
    const t = out.events[0]!.tokens;
    // キャッシュは入力の内数、推論は出力の内数
    expect(t).toMatchObject({ inputUncached: 60, cacheRead: 40, output: 10, reasoning: 4 });
  });

  it('応答ごとの記録と token_count が混在しても1回だけ数える', () => {
    const c1 = u1;
    const c2 = addUsage(u1, u2);
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexRecord({ ts: T(2), threadId: 'th1', turnId: 't1', responseId: 'r1', usage: u1, thread: c1 }),
      codexTokenCount({ ts: T(2), total: c1, last: u1 }),
      codexTokenCount({ ts: T(3), total: c2, last: u2 }), // 記録より先に token_count が来た
      codexRecord({ ts: T(3), threadId: 'th1', turnId: 't1', responseId: 'r2', usage: u2, thread: c2 }),
    ]);
    expect(sum(out)).toBe(330);
    // 応答ごとの記録があるので、どちらの応答も応答 ID を鍵にする
    expect(out.events.map((e) => e.eventKey)).toEqual(['codex:resp:r1', 'codex:resp:r2']);
  });

  it('応答ごとの記録が途中から始まる場合、記録前の利用も取りこぼさない', () => {
    const early: CodexUsage = { input: 1000, output: 100 };
    const c1 = early;
    const c2 = addUsage(c1, u1);
    const c3 = addUsage(c2, u2);
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: c1, last: early }),
      // ここで記録が始まるが、token_count に現れていない応答 u1 が挟まっている
      codexRecord({ ts: T(4), threadId: 'th1', turnId: 't1', responseId: 'r2', usage: u2, thread: c3 }),
    ]);
    expect(sum(out)).toBe(1100 + 110 + 220);
    expect(out.events.some((e) => e.flags.includes('cumulative_gap'))).toBe(true);
  });

  it('累積値が減ったら世代が変わったとみなし、新しい利用を捨てない', () => {
    const big = { input: 5000, output: 500 };
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: big, last: big }),
      codexTokenCount({ ts: T(3), total: u1, last: u1 }), // カウンターが小さくなった
      codexTokenCount({ ts: T(4), total: addUsage(u1, u2), last: u2 }),
    ]);
    expect(sum(out)).toBe(5500 + 110 + 220);
    expect(out.events[1]!.flags).toContain('counter_reset');
    expect(new Set(out.events.map((e) => e.eventKey)).size).toBe(3);
  });

  it('fork で引き継いだ親の履歴は数えず、引き継いだ累積を基準にする', () => {
    const parent = { input: 9000, output: 900 };
    resetOrdinal(0);
    const { out } = run([
      codexMeta({ id: 'child', ts: T(0), parent: 'th1', startOrdinal: 4 }, 0),
      codexTurnContext({ ts: T(0), turnId: 'pt', model: 'gpt-6.1-sol' }, 1),
      codexRecord({ ts: T(0), threadId: 'th1', turnId: 'pt', responseId: 'parent-r', usage: parent, thread: parent }, 2),
      codexTokenCount({ ts: T(0), total: parent, last: parent }, 3),
      codexTurnContext({ ts: T(5), turnId: 'ct', model: 'gpt-6.1-terra' }, 4),
      codexRecord({ ts: T(6), threadId: 'child', turnId: 'ct', responseId: 'child-r', usage: u1, thread: addUsage(parent, u1) }, 5),
      codexTokenCount({ ts: T(6), total: addUsage(parent, u1), last: u1 }, 6),
    ]);
    expect(sum(out)).toBe(110);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.isSidechain).toBe(true);
    expect(out.events[0]!.parentSessionId).toBe('th1');
    expect(out.events[0]!.model).toBe('gpt-6.1-terra');
  });

  it('token_count の累積が応答記録の累積より少し遅れていても、リセットと誤認して数え直さない', () => {
    // 実ログで観測: 記録と token_count が交互に来て、token_count 側の累積が常に少し小さい
    const drift = { input: 50, output: 0 };
    let rec: CodexUsage = { input: 0, output: 0 };
    const ls = [codexMeta({ id: 'th1', ts: T(0) }), codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' })];
    const per: CodexUsage = { input: 300, cached: 100, output: 30 };
    for (let i = 0; i < 5; i++) {
      rec = addUsage(rec, per);
      ls.push(codexRecord({ ts: T(2 + i), threadId: 'th1', turnId: 't1', responseId: `r${i}`, usage: per, thread: rec }));
      const lag = i === 0 ? rec : { ...rec, input: rec.input - drift.input };
      ls.push(codexTokenCount({ ts: T(2 + i), total: lag, last: per }));
    }
    const { out } = run(ls);
    expect(sum(out)).toBe(5 * 330);
    expect(out.events.every((e) => !e.flags.includes('counter_reset'))).toBe(true);
  });

  it('2つの累積が交互に書かれるファイルでは、それぞれの列の増分を数える（実ログで観測）', () => {
    // 実ログの並び（数値は縮小）: 1つの累積から2列に分かれ、A 列と B 列が交互に現れる。各列の中では 増分 = last が成り立つ
    const ls = [codexMeta({ id: 'th1', ts: T(0) }), codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' })];
    let a = 7000;
    let b = 7000; // B 列は A 列の値からちょうど分かれて始まる（実ログで確認）
    ls.push(codexTokenCount({ ts: T(2), total: { input: a, output: 0 }, last: { input: 170, output: 0 } }));
    for (let i = 0; i < 4; i++) {
      b += 186;
      ls.push(codexTokenCount({ ts: T(3 + i), total: { input: b, output: 0 }, last: { input: 186, output: 0 } }));
      a += 175;
      ls.push(codexTokenCount({ ts: T(3 + i), total: { input: a, output: 0 }, last: { input: 175, output: 0 } }));
    }
    const { out } = run(ls);
    // A 列: 最初の 170 と 175×4、B 列: 186×4
    expect(sum(out)).toBe(170 + 175 * 4 + 186 * 4);
  });

  it('内訳が無く合計だけの記録も、分類不明のトークンとして残す（実ログで観測）', () => {
    const line = JSON.stringify({
      timestamp: T(2),
      ordinal: 5,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 69349 },
          last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 69349 },
          model_context_window: null,
        },
        rate_limits: null,
      },
    });
    const { out } = run([codexMeta({ id: 'th1', ts: T(0) }), line]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.tokens.unclassified).toBe(69349);
    expect(sum(out)).toBe(69349);
  });

  it('列が1つのファイルで token_count の行が欠けても、累積の差として数える', () => {
    const ls = [
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      // 累積 220 の行が書かれていない
      codexTokenCount({ ts: T(4), total: { input: 300, output: 30 }, last: { input: 100, output: 10 } }),
    ];
    const { out } = run(ls);
    expect(sum(out)).toBe(330);
    expect(out.events[1]!.flags).toContain('delta_differs_from_last');
  });

  it('token_count の累積が先行する場合は、大きい方の累積までを数える', () => {
    const per: CodexUsage = { input: 300, output: 30 };
    const extra: CodexUsage = { input: 1000, output: 0 }; // 記録に現れない利用
    const c1 = per;
    const c2 = addUsage(c1, extra);
    const c3 = addUsage(c2, per);
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexRecord({ ts: T(2), threadId: 'th1', turnId: 't1', responseId: 'r1', usage: per, thread: c1 }),
      codexTokenCount({ ts: T(3), total: c2, last: extra }),
      codexRecord({ ts: T(4), threadId: 'th1', turnId: 't1', responseId: 'r2', usage: per, thread: c3 }),
    ]);
    expect(sum(out)).toBe(330 + 1000 + 330);
  });

  it('コンパクション後も累積が続く場合は差分だけを数える', () => {
    const c1 = u1;
    const c2 = addUsage(c1, { input: 3000, output: 300 }); // 要約のための呼び出し
    const c3 = addUsage(c2, u2);
    const ls = [
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: c1, last: u1 }),
      JSON.stringify({ timestamp: T(3), ordinal: 99, type: 'compacted', payload: { message: '', replacement_history: [] } }),
      codexTokenCount({ ts: T(3), total: c2, last: { input: 3000, output: 300 } }),
      codexTokenCount({ ts: T(4), total: c3, last: u2 }),
    ];
    const { out } = run(ls);
    expect(sum(out)).toBe(110 + 3300 + 220);
  });

  it('途中で区切って読んでも、状態を引き継げば同じ結果になる', () => {
    const ls = [
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: u1, last: u1 }),
      codexTokenCount({ ts: T(3), total: addUsage(u1, u2), last: u2 }),
    ];
    const whole = run(ls).out;
    const first = run(ls.slice(0, 3));
    const restored = new CodexFileParser(ctx, JSON.parse(JSON.stringify(first.parser.getState())));
    const second = run(ls.slice(3), ctx, restored).out;
    expect(sum(first.out) + sum(second)).toBe(sum(whole));
    expect([...first.out.events, ...second.events].map((e) => e.eventKey)).toEqual(whole.events.map((e) => e.eventKey));
  });

  it('本文に記録の型名を含む行を使用量と取り違えない', () => {
    const { out } = run([codexMeta({ id: 'th1', ts: T(0) }), codexResponseItem(T(1))]);
    expect(out.events).toHaveLength(0);
  });
});

describe('Codex のターンと公式利用率', () => {
  it('ターンの開始と完了、枠の識別子と期間を記録する（primary を固定の意味にしない）', () => {
    const { out } = run([
      codexMeta({ id: 'th1', ts: T(0), account: 'acct-1' }),
      codexTaskStarted({ ts: T(1), turnId: 't1' }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexTokenCount({ ts: T(2), total: { input: 10, output: 1 }, primary: { used: 52, minutes: 10080, resetsAtSec: 1795359269 }, secondary: null }),
      codexTokenCount({ ts: T(3), total: null, primary: { used: 7, minutes: 300, resetsAtSec: 1795300000 }, secondary: { used: 53, minutes: 10080, resetsAtSec: 1795359269 } }),
      codexTaskComplete({ ts: T(4), turnId: 't1' }),
    ]);
    expect(out.turns.map((t) => t.status)).toEqual(['running', 'completed']);
    expect(out.quota.map((q) => [q.windowKind, q.usedPercent])).toEqual([
      ['7d', 52],
      ['5h', 7],
      ['7d', 53],
    ]);
    expect(out.quota[0]!.accountKey).toMatch(/^codex:acct:/);
    expect(out.events[0]!.billingMode).toBe('subscription');
  });

  it('枠が無い（null）場合は観測を作らず、0% にしない', () => {
    const { out } = run([codexMeta({ id: 'th1', ts: T(0) }), codexTokenCount({ ts: T(2), total: null, primary: null, secondary: null })]);
    expect(out.quota).toHaveLength(0);
  });
});

describe('D: 同じイベントの再読込', () => {
  it('同じログを2回取り込んでも合計が増えない', () => {
    const db = memoryDb();
    const repo = new WriteRepo(db);
    const ls = [
      codexMeta({ id: 'th1', ts: T(0) }),
      codexTurnContext({ ts: T(1), turnId: 't1', model: 'gpt-6.1-sol' }),
      codexRecord({ ts: T(2), threadId: 'th1', turnId: 't1', responseId: 'r1', usage: { input: 10, output: 1 }, thread: { input: 10, output: 1 } }),
    ];
    repo.applyParseOutput(run(ls).out, 1);
    repo.applyParseOutput(run(ls).out, 2);
    expect((db.prepare('SELECT SUM(total) t, COUNT(*) n FROM usage_events').get() as { t: number; n: number })).toEqual({ t: 11, n: 1 });
  });
});
