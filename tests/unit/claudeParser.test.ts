import { describe, expect, it } from 'vitest';
import { ClaudeFileParser } from '../../src/core/sources/claude/parser.ts';
import { emptyParseOutput } from '../../src/core/model/types.ts';
import { normalizedTotal } from '../../src/core/model/tokens.ts';
import { WriteRepo } from '../../src/db/writeRepo.ts';
import { claudeAssistant, claudeUser } from '../fixtures/builders.ts';
import { memoryDb } from './helpers.ts';

const ctx = { fileKey: 'f1', sourceId: 's1', isSubagentFile: false, accountKey: null, billingMode: 'unknown' as const };

function parse(ls: string[], c = ctx) {
  const p = new ClaudeFileParser(c);
  const out = emptyParseOutput();
  let off = 0;
  for (const l of ls) {
    p.feed(l, off, out);
    off += l.length + 1;
  }
  return out;
}

describe('Claude の正規化', () => {
  it('G: キャッシュ書き込みの内訳と推論は合計に足さない', () => {
    const out = parse([
      claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:00Z', usage: { input: 10, cacheWrite: 100, w5: 60, w1: 40, cacheRead: 200, output: 50, thinking: 20 } }),
    ]);
    const t = out.events[0]!.tokens;
    expect(t).toMatchObject({ inputUncached: 10, cacheWrite: 100, cacheWrite5m: 60, cacheWrite1h: 40, cacheRead: 200, output: 50, reasoning: 20 });
    // 10 + 100 + 200 + 50。内訳（60+40）や推論（20）は再加算しない
    expect(normalizedTotal(t)).toBe(360);
  });

  it('内訳が総数と合わない場合は内訳を捨てて印を付ける', () => {
    const out = parse([claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:00Z', usage: { cacheWrite: 100, w5: 10, w1: 10 } })]);
    expect(out.events[0]!.tokens.cacheWrite5m).toBeNull();
    expect(out.events[0]!.flags).toContain('cache_write_breakdown_mismatch');
  });

  it('同じ応答の複数行は同じ鍵になり、ターンは直前の promptId に属する', () => {
    const out = parse([
      claudeUser({ promptId: 'p1', sessionId: 's', ts: '2026-11-01T00:00:00Z' }),
      claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:01Z', stop: null, usage: { input: 5, output: 3 } }),
      claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:02Z', stop: 'tool_use', usage: { input: 5, output: 40 } }),
      claudeUser({ promptId: 'p1', sessionId: 's', ts: '2026-11-01T00:00:03Z', toolResult: true }),
      claudeAssistant({ msgId: 'm2', sessionId: 's', ts: '2026-11-01T00:00:04Z', usage: { input: 2, output: 7 } }),
    ]);
    expect(out.events.map((e) => e.eventKey)).toEqual(['claude:msg:m1', 'claude:msg:m1', 'claude:msg:m2']);
    expect(out.events.every((e) => e.turnId === 'p1')).toBe(true);
    expect(out.events[0]!.rank).toBeLessThan(out.events[1]!.rank);
    expect(out.turns.find((t) => t.status === 'completed')?.turnId).toBe('p1');
  });

  it('本文に "type":"user" を含む応答行をユーザー行と取り違えない', () => {
    const tricky = claudeAssistant({ msgId: 'm9', sessionId: 's', ts: '2026-11-01T00:00:00Z', usage: { input: 1, output: 1 } }).replace(
      '"text":"answer"',
      '"text":"{\\"type\\":\\"user\\",\\"promptId\\":\\"evil\\"}"',
    );
    const out = parse([tricky]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.turnId).toBeNull();
  });

  it('合成メッセージは数えない。message.id が無い行は位置を鍵にし印を付ける', () => {
    const out = parse([
      claudeAssistant({ msgId: 'x', sessionId: 's', ts: '2026-11-01T00:00:00Z', model: '<synthetic>', usage: { output: 0 } }),
      claudeAssistant({ msgId: null, sessionId: 's', ts: '2026-11-01T00:00:01Z', usage: { input: 1, output: 1 } }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.eventKey).toMatch(/^claude:pos:f1:/);
    expect(out.events[0]!.flags).toContain('no_message_id');
  });

  it('破損した行は数えて飛ばし、続きの行は読む', () => {
    const out = parse([
      '{"type":"assistant","usage": broken',
      claudeAssistant({ msgId: 'ok', sessionId: 's', ts: '2026-11-01T00:00:00Z', usage: { input: 1, output: 2 } }),
    ]);
    expect(out.badLines).toBe(1);
    expect(out.events).toHaveLength(1);
  });
});

describe('E: 途中値から最終値への更新', () => {
  it('途中値を登録した後の最終値で置き換え、二重計上しない', () => {
    const db = memoryDb();
    const repo = new WriteRepo(db);
    const partial = parse([claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:01Z', stop: null, usage: { input: 5, output: 3 } })]);
    repo.applyParseOutput(partial, 1);
    expect((db.prepare('SELECT SUM(total) t FROM usage_events').get() as { t: number }).t).toBe(8);
    const fin = parse([claudeAssistant({ msgId: 'm1', sessionId: 's', ts: '2026-11-01T00:00:02Z', stop: 'end_turn', usage: { input: 5, output: 40 } })]);
    const st = repo.applyParseOutput(fin, 2);
    expect(st.updated).toBe(1);
    expect((db.prepare('SELECT SUM(total) t, COUNT(*) n FROM usage_events').get() as { t: number; n: number })).toEqual({ t: 45, n: 1 });
    expect((db.prepare('SELECT COUNT(*) n FROM event_revisions').get() as { n: number }).n).toBe(1);
    // 古い途中値が後から届いても、最終値を戻さない
    repo.applyParseOutput(partial, 3);
    expect((db.prepare('SELECT SUM(total) t FROM usage_events').get() as { t: number }).t).toBe(45);
  });

  it('再開時に別ファイルへ写された同じ応答は1回だけ数える', () => {
    const db = memoryDb();
    const repo = new WriteRepo(db);
    const a = parse([claudeAssistant({ msgId: 'm1', sessionId: 's1', ts: '2026-11-01T00:00:01Z', usage: { input: 5, output: 40 } })]);
    const b = parse([claudeAssistant({ msgId: 'm1', sessionId: 's2', ts: '2026-11-01T00:00:01Z', usage: { input: 5, output: 40 } })], { ...ctx, fileKey: 'f2' });
    repo.applyParseOutput(a, 1);
    repo.applyParseOutput(b, 2);
    expect((db.prepare('SELECT SUM(total) t, COUNT(*) n FROM usage_events').get() as { t: number; n: number })).toEqual({ t: 45, n: 1 });
  });
});
