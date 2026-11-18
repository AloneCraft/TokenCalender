// 「いまのチャット」の判定。ログから分かることだけで決める。
// 「成功したか」はログから分からないので、判定には使わない。
//
// 判定は、そのユーザー自身の過去のチャットとの比較で行う（絶対的な基準は置かない）。
// - heavy: 使いすぎ。トークン量が、過去のチャットの上位に入るほど多い
// - wasteful: 無駄の疑い。大量に読み込んでいるのに、キャッシュがほとんど効いていない
// - smooth: 順調
// - unknown: 比べる過去のチャットが少なく、判定できない

export type ChatVerdict = 'smooth' | 'heavy' | 'wasteful' | 'unknown';

export interface SessionStats {
  tokens: number;
  requests: number;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ChatJudgement {
  verdict: ChatVerdict;
  /** 過去のチャットの中央値に対する倍率（比べられないとき null） */
  vsMedian: number | null;
  /** 過去のチャットの中央値と上位10%の値（比べられないとき null） */
  median: number | null;
  p90: number | null;
  /** 読み込んだ入力のうちキャッシュから読めた割合（0〜1。入力が無いとき null） */
  cacheHit: number | null;
  /** 1依頼あたりのトークン量 */
  perRequest: number;
}

export const MIN_BASELINE = 5;
export const MIN_REQUESTS_TO_COMPARE = 5;
export const HEAVY_FACTOR = 3;
export const WASTE_CACHE_HIT = 0.5;
export const WASTE_MIN_INPUT = 2_000_000;

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** baselineTokens: 過去のチャット（依頼数が十分あるもの）のトークン量 */
export function judgeChat(s: SessionStats, baselineTokens: number[]): ChatJudgement {
  const input = s.inputUncached + s.cacheRead + s.cacheWrite;
  const cacheHit = input > 0 ? s.cacheRead / input : null;
  const perRequest = s.requests > 0 ? s.tokens / s.requests : 0;
  const sorted = [...baselineTokens].sort((a, b) => a - b);
  const enough = sorted.length >= MIN_BASELINE;
  const median = enough ? quantile(sorted, 0.5) : null;
  const p90 = enough ? quantile(sorted, 0.9) : null;
  const vsMedian = median && median > 0 ? s.tokens / median : null;

  let verdict: ChatVerdict;
  if (!enough || s.requests < MIN_REQUESTS_TO_COMPARE) verdict = 'unknown';
  else if (median != null && p90 != null && s.tokens >= Math.max(p90, median * HEAVY_FACTOR)) verdict = 'heavy';
  else if (cacheHit != null && cacheHit < WASTE_CACHE_HIT && input >= WASTE_MIN_INPUT) verdict = 'wasteful';
  else verdict = 'smooth';
  return { verdict, vsMedian, median, p90, cacheHit, perRequest };
}
