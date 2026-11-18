import { describe, expect, it } from 'vitest';
import { judgeChat, quantile, type SessionStats } from '../../src/core/chat/judge.ts';

const base = [100, 120, 90, 110, 130, 95, 105, 115, 100, 125]; // 中央値 約 107、上位10% 約 126
const s = (over: Partial<SessionStats>): SessionStats => ({ tokens: 100, requests: 20, inputUncached: 10, cacheRead: 90, cacheWrite: 0, output: 5, ...over });

describe('いまのチャットの判定', () => {
  it('過去のチャットと同じくらいなら順調', () => {
    expect(judgeChat(s({ tokens: 110 }), base).verdict).toBe('smooth');
  });
  it('過去の上位に入る量なら使いすぎ', () => {
    const j = judgeChat(s({ tokens: 1000 }), base);
    expect(j.verdict).toBe('heavy');
    expect(j.vsMedian).toBeGreaterThan(5);
  });
  it('大量に読み込んでいるのにキャッシュが効いていなければ無駄の疑い', () => {
    const j = judgeChat(s({ tokens: 110, inputUncached: 3_000_000, cacheRead: 100_000 }), base);
    expect(j.verdict).toBe('wasteful');
    expect(j.cacheHit).toBeLessThan(0.1);
  });
  it('読み込みが少ないときは、キャッシュが低くても無駄とは言わない', () => {
    expect(judgeChat(s({ tokens: 110, inputUncached: 900, cacheRead: 100 }), base).verdict).toBe('smooth');
  });
  it('比べる過去のチャットが少ない、または依頼が少ないときは判定しない', () => {
    expect(judgeChat(s({ tokens: 99999 }), [100, 200]).verdict).toBe('unknown');
    expect(judgeChat(s({ tokens: 99999, requests: 2 }), base).verdict).toBe('unknown');
  });
  it('使いすぎは無駄の疑いより優先する', () => {
    expect(judgeChat(s({ tokens: 5000, inputUncached: 3_000_000, cacheRead: 0 }), base).verdict).toBe('heavy');
  });
  it('入力が0でも落ちない', () => {
    expect(judgeChat(s({ inputUncached: 0, cacheRead: 0, cacheWrite: 0 }), base).cacheHit).toBeNull();
    expect(quantile([], 0.5)).toBe(0);
  });
});
