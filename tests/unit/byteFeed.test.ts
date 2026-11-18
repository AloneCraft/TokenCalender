// 取り込みの高速経路（行をバイトのまま振り分ける feedBytes）が、文字列で処理する feed と同じ結果になること。
// 利用者の行は先頭と末尾だけを文字に変換するため、大きな本文・多バイト文字・引用符を含む行で確かめる。

import { describe, expect, it } from 'vitest';
import { ClaudeFileParser } from '../../src/core/sources/claude/parser.ts';
import { CodexFileParser } from '../../src/core/sources/codex/parser.ts';
import { emptyParseOutput } from '../../src/core/model/types.ts';
import { claudeAssistant, claudeUser, codexMeta, codexRecord, codexResponseItem, codexTokenCount, codexTurnContext, resetOrdinal } from '../fixtures/builders.ts';

function runBoth<P extends { feed(l: string, o: number, out: ReturnType<typeof emptyParseOutput>): void; feedBytes(b: Buffer, o: number, out: ReturnType<typeof emptyParseOutput>): void; getState(): unknown }>(
  make: () => P,
  lines: string[],
) {
  const a = make();
  const b = make();
  const outA = emptyParseOutput();
  const outB = emptyParseOutput();
  let off = 0;
  for (const l of lines) {
    a.feed(l, off, outA);
    b.feedBytes(Buffer.from(l, 'utf8'), off, outB);
    off += Buffer.byteLength(l) + 1;
  }
  return { outA, outB, stateA: a.getState(), stateB: b.getState() };
}

describe('feedBytes は feed と同じ結果を返す', () => {
  it('Claude: 大きな本文を持つ利用者の行・応答の行', () => {
    const lines = [
      claudeUser({ promptId: 'p1', sessionId: 's1', ts: '2026-11-10T01:00:00.000Z', bigContentChars: 50_000 }),
      claudeAssistant({ msgId: 'm1', requestId: 'r1', sessionId: 's1', ts: '2026-11-10T01:00:05.000Z', usage: { input: 10, output: 20, cacheRead: 300 } }),
      claudeUser({ promptId: 'p2', sessionId: 's1', ts: '2026-11-10T01:05:00.000Z' }),
      claudeUser({ promptId: 'p2', sessionId: 's1', ts: '2026-11-10T01:05:01.000Z', bigContentChars: 9_000 }),
      claudeAssistant({ msgId: 'm2', requestId: 'r2', sessionId: 's1', ts: '2026-11-10T01:05:09.000Z', usage: { input: 1, output: 2 } }),
    ];
    const r = runBoth(() => new ClaudeFileParser({ fileKey: 'f', sourceId: 's', isSubagentFile: false, accountKey: null, billingMode: 'unknown' }), lines);
    expect(r.outB).toEqual(r.outA);
    expect(r.stateB).toEqual(r.stateA);
    // 利用者の行から作るターンの開始時刻（応答の行が出す開始時刻なしの記録は除く）が、行の末尾の timestamp から取れている
    expect(r.outB.turns.filter((t) => t.startedAtMs != null).map((t) => [t.turnId, t.startedAtMs])).toEqual([
      ['p1', Date.parse('2026-11-10T01:00:00.000Z')],
      ['p2', Date.parse('2026-11-10T01:05:00.000Z')],
    ]);
    expect(r.outB.events).toHaveLength(2);
  });

  it('Codex: 使わない行は飛ばしても、行番号の数え方が変わらない', () => {
    resetOrdinal();
    const u = { input: 100, cached: 40, output: 10, reasoning: 2, total: 110 };
    const lines = [
      codexMeta({ id: 'th1', ts: '2026-11-10T01:00:00.000Z' }),
      codexTurnContext({ ts: '2026-11-10T01:00:01.000Z', turnId: 't1', model: 'gpt-x' }),
      codexResponseItem('2026-11-10T01:00:02.000Z'),
      codexRecord({ ts: '2026-11-10T01:00:03.000Z', threadId: 'th1', turnId: 't1', responseId: 'resp1', usage: u, thread: u }),
      codexResponseItem('2026-11-10T01:00:04.000Z'),
      codexTokenCount({ ts: '2026-11-10T01:00:05.000Z', total: u, last: u, primary: { used: 12, minutes: 10080, resetsAtSec: 1795000000 } }),
    ];
    const r = runBoth(() => new CodexFileParser({ fileKey: 'f', sourceId: 's', accountKey: null, billingMode: 'unknown' }, null), lines);
    expect(r.outB).toEqual(r.outA);
    expect(r.stateB).toEqual(r.stateA);
    expect(r.outB.events).toHaveLength(1);
  });
});
