// 時系列グラフの「周期の帯」を、横軸のマス（バケット）の位置に直す。画面の描画から切り離した計算だけを置く。

import type { TimelineBucket, TimelineResponse } from './api.ts';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export interface BandLayout {
  /** 画面に出る最初のマス（含む） */
  from: number;
  /** 画面に出る最後のマスの次（含まない） */
  to: number;
  /** 周期全体のマス数（画面の外に出た分も数える）。7日周期なら 7 */
  cells: number;
  /** from のマスが周期の何日目か（1 始まり）。画面の左端で周期が切れているとき 1 より大きい */
  firstDayNo: number;
  early: boolean;
  estimated: boolean;
}

/** すべてのマスが約1日（夏時間の23〜25時間を含む）なら、日付と周期の何日目かを毎日表示できる。 */
export function isDayBuckets(buckets: TimelineBucket[]): boolean {
  return buckets.length > 0 && buckets.every((b) => b.endMs - b.startMs >= 20 * HOUR && b.endMs - b.startMs <= 28 * HOUR);
}

/** 時刻 t が入るマスの番号。範囲の外なら負の数、または buckets.length 以上（1日ずつ数える）。 */
export function bucketIndexAt(buckets: TimelineBucket[], t: number): number {
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  if (t < first.startMs) return -Math.ceil((first.startMs - t) / DAY);
  if (t >= last.endMs) return buckets.length + Math.floor((t - last.endMs) / DAY);
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid]!.startMs <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 周期ごとの帯を作る。リセットが入ったマスは新しい周期のものとして数える
 * （前の周期はその前のマスで終わる）ので、帯どうしは重ならない。
 */
export function layoutBands(buckets: TimelineBucket[], cycles: TimelineResponse['cycles']): BandLayout[] {
  if (buckets.length === 0) return [];
  const out: BandLayout[] = [];
  for (const c of cycles) {
    const rawFrom = bucketIndexAt(buckets, c.startMs);
    const rawTo = bucketIndexAt(buckets, c.endMs);
    const from = Math.max(rawFrom, 0);
    const to = Math.min(rawTo, buckets.length);
    if (rawTo <= rawFrom || to <= from) continue;
    out.push({ from, to, cells: rawTo - rawFrom, firstDayNo: from - rawFrom + 1, early: c.early, estimated: c.estimated });
  }
  return out;
}
