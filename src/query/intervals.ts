// 小区間（SQL で合計した値）から、表示用の区間の合計と周期内累積を組み立てる。
// 区間・周期の境界はすべて小区間の境目になるように境界の集合を作るため、
// 元のイベントから直接合計した場合と同じ結果になる（[start, end) の扱いも同じ）。

import type { Db } from '../db/database.ts';
import { addStats, intervalStats, zeroStats, type DimSql, type EventFilter, type IntervalStats } from '../db/readRepo.ts';
import type { Measure } from '../core/aggregate/series.ts';
import type { Bucket } from '../core/time/periods.ts';

export function statValue(s: IntervalStats, m: Measure): number {
  switch (m) {
    case 'tokens':
      return s.tokens;
    case 'cost':
      return s.cost;
    case 'input':
      return s.input;
    case 'cache_read':
      return s.cacheRead;
    case 'cache_write':
      return s.cacheWrite;
    case 'output':
      return s.output;
    case 'reasoning':
      return s.reasoning;
    case 'events':
      return s.events;
  }
}

/** 境界の集合（昇順・重複なし）を作る */
export function boundarySet(...lists: number[][]): number[] {
  const set = new Set<number>();
  for (const l of lists) for (const v of l) if (Number.isFinite(v)) set.add(v);
  return [...set].sort((a, b) => a - b);
}

/** 境界ごとの累積和。任意の境界 a, b について [a, b) の合計を返す。 */
export class IntervalPrefix {
  private readonly index = new Map<number, number>();
  private readonly cum: number[];
  private readonly boundaries: number[];

  constructor(boundaries: number[], perInterval: number[]) {
    this.boundaries = boundaries;
    this.cum = new Array<number>(boundaries.length).fill(0);
    boundaries.forEach((b, i) => this.index.set(b, i));
    for (let i = 1; i < boundaries.length; i++) this.cum[i] = this.cum[i - 1]! + (perInterval[i - 1] ?? 0);
  }

  private at(t: number): number {
    const i = this.index.get(t);
    if (i !== undefined) return this.cum[i]!;
    // 境界に無い時刻（範囲の外）: 範囲外は 0 として扱う
    if (t <= this.boundaries[0]!) return 0;
    return this.cum[this.cum.length - 1]!;
  }

  sum(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    return this.at(toMs) - this.at(fromMs);
  }
}

export interface BucketStats {
  total: IntervalStats;
  byDim: Map<string, IntervalStats>;
}

/** 小区間の集計を、表示用の区間ごとにまとめる */
export function bucketStats(db: Db, f: EventFilter, buckets: Bucket[], dim: DimSql, extraBoundaries: number[] = []): { buckets: BucketStats[]; boundaries: number[]; perInterval: IntervalStats[] } {
  const boundaries = boundarySet(
    buckets.map((b) => b.startMs),
    buckets.map((b) => b.endMs),
    extraBoundaries,
  );
  const stats = intervalStats(db, f, boundaries, dim);
  const perInterval = stats.map((m) => {
    const z = zeroStats();
    for (const s of m.values()) addStats(z, s);
    return z;
  });
  const idx = new Map<number, number>();
  boundaries.forEach((b, i) => idx.set(b, i));
  const out = buckets.map((b) => {
    const total = zeroStats();
    const byDim = new Map<string, IntervalStats>();
    const from = idx.get(b.startMs)!;
    const to = idx.get(b.endMs)!;
    for (let i = from; i < to; i++) {
      addStats(total, perInterval[i]!);
      for (const [k, s] of stats[i]!) {
        const cur = byDim.get(k) ?? zeroStats();
        addStats(cur, s);
        byDim.set(k, cur);
      }
    }
    return { total, byDim };
  });
  return { buckets: out, boundaries, perInterval };
}

/** 区間ごとの切り口別の値（トークン種別の場合は種別ごとの値） */
export function dimValues(b: BucketStats, measure: Measure, tokenType: boolean): Record<string, number> {
  if (tokenType && measure !== 'cost' && measure !== 'events') {
    return { input: b.total.input, cache_read: b.total.cacheRead, cache_write: b.total.cacheWrite, output: b.total.output, ...(b.total.unclassified ? { unclassified: b.total.unclassified } : {}) };
  }
  const out: Record<string, number> = {};
  for (const [k, s] of b.byDim) out[k] = statValue(s, measure);
  return out;
}
