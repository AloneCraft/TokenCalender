import type { TokenBreakdown } from './types.ts';

export function zeroTokens(): TokenBreakdown {
  return {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: null,
    cacheWrite1h: null,
    output: 0,
    reasoning: null,
    unclassified: 0,
    providerTotal: null,
  };
}

/** 重なりのない分類（4分類＋分類不明）の合計。推論・キャッシュ書き込みの内訳は足さない。 */
export function normalizedTotal(t: TokenBreakdown): number {
  return t.inputUncached + t.cacheRead + t.cacheWrite + t.output + t.unclassified;
}

export interface TokenSums {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export function zeroSums(): TokenSums {
  return { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}

export function addToSums(s: TokenSums, t: TokenBreakdown): void {
  s.inputUncached += t.inputUncached;
  s.cacheRead += t.cacheRead;
  s.cacheWrite += t.cacheWrite;
  s.output += t.output;
  s.reasoning += t.reasoning ?? 0;
  s.total += normalizedTotal(t);
}

/** 負や非数を 0 に丸め、整数にする。ログの値が壊れていても集計を壊さない。 */
export function safeCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
