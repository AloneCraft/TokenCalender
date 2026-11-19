import { describe, expect, it } from 'vitest';
import { bucketIndexAt, isDayBuckets, layoutBands } from '../../src/shared/cycleLayout.ts';
import type { TimelineBucket } from '../../src/shared/api.ts';

const DAY = 86400000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

function days(n: number): TimelineBucket[] {
  return Array.from({ length: n }, (_, i) => ({ startMs: T0 + i * DAY, endMs: T0 + (i + 1) * DAY }) as TimelineBucket);
}

const band = (startDay: number, endDay: number, extra: { early?: boolean; estimated?: boolean } = {}) => ({
  startMs: T0 + startDay * DAY,
  endMs: T0 + endDay * DAY,
  estimated: false,
  early: false,
  ...extra,
});

describe('周期の帯の配置', () => {
  it('7日周期はちょうど7マスで、日番号は 1 から始まる', () => {
    const [b] = layoutBands(days(20), [band(3, 10)]);
    expect(b).toMatchObject({ from: 3, to: 10, cells: 7, firstDayNo: 1, early: false });
  });

  it('リセットが日の途中でも、そのマスは新しい周期のものになり、隣の帯と重ならない', () => {
    const bands = layoutBands(days(20), [
      { startMs: T0 + 2 * DAY + 14 * 3600000, endMs: T0 + 9 * DAY + 14 * 3600000, estimated: false, early: false },
      { startMs: T0 + 9 * DAY + 14 * 3600000, endMs: T0 + 16 * DAY + 14 * 3600000, estimated: false, early: false },
    ]);
    expect(bands.map((b) => [b.from, b.to, b.cells])).toEqual([
      [2, 9, 7],
      [9, 16, 7],
    ]);
  });

  it('前倒しリセットで短くなった周期は、7より少ないマス数になる', () => {
    const [b] = layoutBands(days(20), [band(6, 10, { early: true })]);
    expect(b).toMatchObject({ cells: 4, early: true });
  });

  it('画面の左端で切れた周期は、全体のマス数を保ち、日番号を途中から数える', () => {
    const buckets = days(10).slice(3); // 11/4 から表示
    const [b] = layoutBands(buckets, [band(0, 7)]);
    expect(b).toMatchObject({ from: 0, to: 4, cells: 7, firstDayNo: 4 });
  });

  it('画面の右端で切れた周期も、全体のマス数を保つ', () => {
    const [b] = layoutBands(days(10), [band(7, 14)]);
    expect(b).toMatchObject({ from: 7, to: 10, cells: 7, firstDayNo: 1 });
  });

  it('範囲の外の周期と、1日未満の周期は作らない', () => {
    expect(layoutBands(days(5), [band(10, 17)])).toEqual([]);
    expect(layoutBands(days(5), [{ startMs: T0 + 100, endMs: T0 + 200, estimated: false, early: false }])).toEqual([]);
  });

  it('マスの番号は範囲の外でも日数で数える', () => {
    const b = days(5);
    expect(bucketIndexAt(b, T0 - 1)).toBe(-1);
    expect(bucketIndexAt(b, T0 + 2 * DAY)).toBe(2);
    expect(bucketIndexAt(b, T0 + 5 * DAY)).toBe(5);
    expect(bucketIndexAt(b, T0 + 9 * DAY + 5)).toBe(9);
  });

  it('日単位かどうかは、マスの幅が約1日かで決める', () => {
    expect(isDayBuckets(days(3))).toBe(true);
    expect(isDayBuckets([{ startMs: T0, endMs: T0 + 5 * 3600000 } as TimelineBucket])).toBe(false);
    expect(isDayBuckets([{ startMs: T0, endMs: T0 + 7 * DAY } as TimelineBucket])).toBe(false);
    expect(isDayBuckets([])).toBe(false);
  });
});
