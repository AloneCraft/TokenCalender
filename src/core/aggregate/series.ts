// 区間ごとの集計と、リセット周期内の累積。
//
// 守ること:
// - 期間の合計は、必ず元のイベントから計算する（累積棒の高さを足し合わせない）。
// - 周期をまたぐ区間では、最後の周期の累積を表示し、旧周期の利用は別の数値として残す。
// - 周期が分からない区間の累積は「不明」とし、0 にしない。

import type { EventRow } from '../../db/readRepo.ts';
import type { Bucket } from '../time/periods.ts';
import { bucketIndexOf } from '../time/periods.ts';
import type { Cycle } from '../quota/cycles.ts';

export type Measure = 'tokens' | 'cost' | 'input' | 'cache_read' | 'cache_write' | 'output' | 'reasoning' | 'events';
export type Dimension = 'none' | 'provider' | 'model' | 'project' | 'token_type' | 'effort' | 'billing' | 'account' | 'sidechain';

export const TOKEN_TYPES = ['input', 'cache_read', 'cache_write', 'output'] as const;

export function valueOf(r: EventRow, m: Measure): number {
  switch (m) {
    case 'tokens':
      return r.total;
    case 'cost':
      return r.priced ? r.costNano : 0;
    case 'input':
      return r.inputUncached;
    case 'cache_read':
      return r.cacheRead;
    case 'cache_write':
      return r.cacheWrite;
    case 'output':
      return r.output;
    case 'reasoning':
      return r.reasoning ?? 0;
    case 'events':
      return r.count ?? 1;
  }
}

export function dimensionKey(r: EventRow, d: Dimension): string {
  switch (d) {
    case 'none':
      return 'all';
    case 'provider':
      return r.provider;
    case 'model':
      return r.model ?? 'unknown';
    case 'project':
      return r.projectLabel ?? 'unknown';
    case 'effort':
      return r.effort ?? 'unknown';
    case 'billing':
      return r.billingMode;
    case 'account':
      return r.accountKey ?? 'unknown';
    case 'sidechain':
      return r.isSidechain ? 'subagent' : 'main';
    case 'token_type':
      return 'mixed';
  }
}

export interface BucketAgg {
  key: string;
  startMs: number;
  endMs: number;
  /** 区間の合計（測る値の単位。金額は nano-dollar） */
  total: number;
  byDim: Record<string, number>;
  events: number;
  tokens: number;
  /** 料金を換算できなかったイベントの数とトークン量（金額表示で「未換算」として示す） */
  unpricedEvents: number;
  unpricedTokens: number;
  /** 品質の印が付いたイベントの数 */
  flaggedEvents: number;
  partialEvents: number;
}

export function aggregateBuckets(rows: EventRow[], buckets: Bucket[], measure: Measure, dim: Dimension): BucketAgg[] {
  const out: BucketAgg[] = buckets.map((b) => ({
    key: b.key,
    startMs: b.startMs,
    endMs: b.endMs,
    total: 0,
    byDim: {},
    events: 0,
    tokens: 0,
    unpricedEvents: 0,
    unpricedTokens: 0,
    flaggedEvents: 0,
    partialEvents: 0,
  }));
  for (const r of rows) {
    const i = bucketIndexOf(buckets, r.ts);
    if (i < 0) continue;
    const a = out[i]!;
    const n = r.count ?? 1;
    a.events += n;
    a.tokens += r.total;
    if (!r.priced) {
      a.unpricedEvents += n;
      a.unpricedTokens += r.total;
    }
    if (r.flags.length > 0) a.flaggedEvents += n;
    if (r.finality === 0) a.partialEvents += n;
    if (dim === 'token_type' && measure !== 'cost' && measure !== 'events') {
      const parts: [string, number][] = [
        ['input', r.inputUncached],
        ['cache_read', r.cacheRead],
        ['cache_write', r.cacheWrite],
        ['output', r.output],
      ];
      for (const [k, v] of parts) a.byDim[k] = (a.byDim[k] ?? 0) + v;
      a.total += valueOf(r, measure);
      continue;
    }
    const v = valueOf(r, measure);
    a.total += v;
    const k = dimensionKey(r, dim);
    a.byDim[k] = (a.byDim[k] ?? 0) + v;
  }
  return out;
}

/** 期間 [a, b) の合計を返すもの（イベントの累積和、または小区間の累積和） */
export interface RangeSum {
  sum(fromMs: number, toMs: number): number;
}

/** 時刻で並んだイベントの累積和。任意の期間 [a, b) の合計を元のイベントから求める。 */
export class PrefixSum implements RangeSum {
  private readonly ts: number[];
  private readonly sums: number[];

  constructor(rows: EventRow[], measure: Measure) {
    this.ts = rows.map((r) => r.ts);
    this.sums = new Array<number>(rows.length + 1);
    this.sums[0] = 0;
    for (let i = 0; i < rows.length; i++) this.sums[i + 1] = this.sums[i]! + valueOf(rows[i]!, measure);
  }

  /** ts >= t となる最初の位置 */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  sum(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    return this.sums[this.lowerBound(toMs)]! - this.sums[this.lowerBound(fromMs)]!;
  }
}

export interface CumulativeBucket {
  key: string;
  startMs: number;
  endMs: number;
  /** 区間全体の利用（旧周期の分も含む） */
  bucketTotal: number;
  /** 区間の終わりの時点で有効な周期が分かるか */
  cycleKnown: boolean;
  /** その周期が推定周期か */
  cycleEstimated: boolean;
  cycleStartMs: number | null;
  cycleEndMs: number | null;
  /** 同じ周期内の、区間より前までの累計（薄色部分） */
  prior: number | null;
  /** 区間内でその周期に加わった量（濃色部分） */
  increment: number | null;
  /** 区間終わり時点の周期内累計（棒全体） */
  cumulative: number | null;
  /** 区間の途中でリセットがあった */
  resetInBucket: boolean;
  /** 区間内で、旧周期に属する利用 */
  oldCycleUsage: number;
}

/**
 * 各区間について「区間の終わりに有効な周期」の累計を求める。
 * 区間の途中でリセットがあれば、新しい周期の累計を表示し、旧周期の利用は oldCycleUsage に残す。
 */
export function cumulativeWithinCycles(buckets: Bucket[], cycles: Cycle[], prefix: RangeSum, nowMs = Date.now()): CumulativeBucket[] {
  return buckets.map((b) => {
    const bucketTotal = prefix.sum(b.startMs, b.endMs);
    // 区間内で最後に有効な周期を探す（未来の区間は今の時刻で切る）
    const probe = Math.min(b.endMs, Math.max(b.startMs + 1, nowMs)) - 1;
    const c = findCycle(cycles, probe) ?? lastCycleOverlapping(cycles, b.startMs, b.endMs);
    if (!c) {
      return {
        key: b.key,
        startMs: b.startMs,
        endMs: b.endMs,
        bucketTotal,
        cycleKnown: false,
        cycleEstimated: false,
        cycleStartMs: null,
        cycleEndMs: null,
        prior: null,
        increment: null,
        cumulative: null,
        resetInBucket: false,
        oldCycleUsage: 0,
      };
    }
    const segStart = Math.max(b.startMs, c.startMs);
    const segEnd = Math.min(b.endMs, c.endMs);
    const prior = prefix.sum(c.startMs, segStart);
    const increment = prefix.sum(segStart, segEnd);
    const resetInBucket = c.startMs > b.startMs && c.startMs < b.endMs;
    return {
      key: b.key,
      startMs: b.startMs,
      endMs: b.endMs,
      bucketTotal,
      cycleKnown: true,
      cycleEstimated: c.basis === 'extrapolated',
      cycleStartMs: c.startMs,
      cycleEndMs: c.endMs,
      prior,
      increment,
      cumulative: prior + increment,
      resetInBucket,
      oldCycleUsage: bucketTotal - increment,
    };
  });
}

function findCycle(cycles: Cycle[], ts: number): Cycle | null {
  for (let i = cycles.length - 1; i >= 0; i--) {
    const c = cycles[i]!;
    if (ts >= c.startMs && ts < c.endMs) return c;
  }
  return null;
}

function lastCycleOverlapping(cycles: Cycle[], from: number, to: number): Cycle | null {
  for (let i = cycles.length - 1; i >= 0; i--) {
    const c = cycles[i]!;
    if (c.startMs < to && c.endMs > from) return c;
  }
  return null;
}

/** 周期ごとの利用（詳細画面で旧周期と新周期を分けて表示するため）。 */
export function usageByCycle(cycles: Cycle[], prefix: RangeSum, fromMs: number, toMs: number): { cycle: Cycle; usage: number }[] {
  const out: { cycle: Cycle; usage: number }[] = [];
  for (const c of cycles) {
    const s = Math.max(c.startMs, fromMs);
    const e = Math.min(c.endMs, toMs);
    if (e > s) out.push({ cycle: c, usage: prefix.sum(s, e) });
  }
  return out;
}
