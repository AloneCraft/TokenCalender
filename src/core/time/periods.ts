// 表示上の集計単位（日・暦週・N日・固定幅）を作る。
// 期間は [start, end) で、境界ちょうどの時刻は次の期間に属する。
// 暦日は IANA タイムゾーンで数えるため、夏時間の日は 23 時間や 25 時間になる。
// ※ ここで作るのは「表示上の区切り」であり、サブスクの制限周期（cycles.ts）とは別物。

import { DateTime } from 'luxon';

export interface Bucket {
  key: string;
  startMs: number;
  endMs: number;
}

export function isValidZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

function startOfDay(ms: number, zone: string): DateTime {
  return DateTime.fromMillis(ms, { zone }).startOf('day');
}

/** startDate（YYYY-MM-DD）から days 日分の暦日。 */
export function dayBuckets(startDate: string, days: number, zone: string): Bucket[] {
  let d: DateTime<boolean> = DateTime.fromISO(startDate, { zone }).startOf("day");
  if (!d.isValid) throw new Error(`invalid date: ${startDate}`);
  const out: Bucket[] = [];
  for (let i = 0; i < days; i++) {
    const next: DateTime<boolean> = d.plus({ days: 1 });
    out.push({ key: d.toISODate()!, startMs: d.toMillis(), endMs: next.toMillis() });
    d = next;
  }
  return out;
}

/** 指定月のすべての日。 */
export function monthDayBuckets(year: number, month: number, zone: string): Bucket[] {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone });
  if (!first.isValid) throw new Error(`invalid month: ${year}-${month}`);
  return dayBuckets(first.toISODate()!, first.daysInMonth!, zone);
}

/** 月表示の1マス目の日付（週の始まりに合わせる）。weekStart: 1 = 月曜、7 = 日曜。 */
export function monthGridStart(year: number, month: number, zone: string, weekStart: 1 | 7): string {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone });
  const offset = (first.weekday - weekStart + 7) % 7;
  return first.minus({ days: offset }).toISODate()!;
}

/** 暦週。weekStart の曜日 0 時から7日間。 */
export function calendarWeekBuckets(fromMs: number, toMs: number, zone: string, weekStart: 1 | 7): Bucket[] {
  let d = startOfDay(fromMs, zone);
  d = d.minus({ days: (d.weekday - weekStart + 7) % 7 });
  const out: Bucket[] = [];
  while (d.toMillis() < toMs) {
    const next: DateTime<boolean> = d.plus({ weeks: 1 });
    out.push({ key: `week:${d.toISODate()}`, startMs: d.toMillis(), endMs: next.toMillis() });
    d = next;
  }
  return out;
}

/**
 * N日単位で過去 M 日まで。最後の区間が endDate（含む）で終わるように並べる。
 * M が N の倍数でない場合、最初の区間は切り上げて N 日幅にそろえる。
 */
export function nDayBuckets(endDate: string, n: number, m: number, zone: string): Bucket[] {
  if (n < 1 || m < 1) throw new Error('n and m must be >= 1');
  const count = Math.ceil(m / n);
  const endExclusive = DateTime.fromISO(endDate, { zone }).startOf('day').plus({ days: 1 });
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const e = endExclusive.minus({ days: i * n });
    const s = e.minus({ days: n });
    out.push({ key: `${s.toISODate()}/${n}d`, startMs: s.toMillis(), endMs: e.toMillis() });
  }
  return out;
}

/** 固定幅の区間（5時間、15分など）。anchorMs を境界の1つとして揃える。 */
export function fixedBuckets(anchorMs: number, stepMs: number, fromMs: number, toMs: number, keyPrefix: string): Bucket[] {
  const k0 = Math.floor((fromMs - anchorMs) / stepMs);
  const out: Bucket[] = [];
  for (let k = k0; anchorMs + k * stepMs < toMs; k++) {
    const s = anchorMs + k * stepMs;
    out.push({ key: `${keyPrefix}:${s}`, startMs: s, endMs: s + stepMs });
  }
  return out;
}

/** 区間の配列（開始時刻の昇順・重なりなし）から、時刻が属する区間の番号を返す。無ければ -1。 */
export function bucketIndexOf(buckets: Bucket[], ts: number): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (ts < b.startMs) hi = mid - 1;
    else if (ts >= b.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function todayIn(zone: string, nowMs = Date.now()): string {
  return DateTime.fromMillis(nowMs, { zone }).toISODate()!;
}
