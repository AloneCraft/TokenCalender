import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { EventRow } from '../../src/db/readRepo.ts';
import { aggregateBuckets, cumulativeWithinCycles, PrefixSum, usageByCycle } from '../../src/core/aggregate/series.ts';
import { buildCycles, cycleBands, type Cycle } from '../../src/core/quota/cycles.ts';
import { bucketIndexOf, calendarWeekBuckets, dayBuckets, fixedBuckets, nDayBuckets } from '../../src/core/time/periods.ts';
import type { QuotaObservation } from '../../src/core/model/types.ts';

const Z = 'Asia/Tokyo';

function row(tsIso: string, total: number, extra: Partial<EventRow> = {}): EventRow {
  return {
    eventKey: `k-${tsIso}-${total}-${Math.random()}`,
    ts: DateTime.fromISO(tsIso, { zone: Z }).toMillis(),
    provider: 'codex',
    accountKey: null,
    sessionId: 's',
    turnId: null,
    agentId: null,
    isSidechain: false,
    model: 'gpt-6.1-sol',
    effort: null,
    speed: null,
    inferenceGeo: null,
    projectKey: null,
    projectLabel: null,
    billingMode: 'subscription',
    inputUncached: total,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: null,
    cacheWrite1h: null,
    output: 0,
    reasoning: null,
    unclassified: 0,
    total,
    finality: 1,
    flags: [],
    costNano: total * 1000,
    priced: true,
    costKnown: true,
    ...extra,
  };
}

function cycle(startIso: string, endIso: string, basis: Cycle['basis'] = 'observed'): Cycle {
  return {
    startMs: DateTime.fromISO(startIso, { zone: Z }).toMillis(),
    endMs: DateTime.fromISO(endIso, { zone: Z }).toMillis(),
    basis,
    truncated: false,
    firstObservedAt: null,
    lastObservedAt: null,
    maxUsedPercent: null,
  };
}

describe('A: リセット周期内累積', () => {
  it('日別 10, 20, 15 は累積 10, 30, 45。期間合計は 45。リセット後の 7 は累積 7 から始まる', () => {
    const rows = [row('2026-11-02T10:00', 10), row('2026-11-03T10:00', 20), row('2026-11-04T10:00', 15), row('2026-11-05T10:00', 7)];
    const days = dayBuckets('2026-11-02', 4, Z);
    const cycles = [cycle('2026-11-02T00:00', '2026-11-05T00:00'), cycle('2026-11-05T00:00', '2026-11-12T00:00')];
    const prefix = new PrefixSum(rows, 'tokens');
    const cum = cumulativeWithinCycles(days, cycles, prefix, DateTime.fromISO('2026-11-30', { zone: Z }).toMillis());
    expect(cum.map((c) => c.cumulative)).toEqual([10, 30, 45, 7]);
    expect(cum.map((c) => c.increment)).toEqual([10, 20, 15, 7]);
    expect(cum.map((c) => c.prior)).toEqual([0, 10, 30, 0]);
    // 期間合計は元のイベントから求める（累積棒の高さの和 10+30+45 ではない）
    expect(prefix.sum(days[0]!.startMs, days[2]!.endMs)).toBe(45);
    const agg = aggregateBuckets(rows, days, 'tokens', 'none');
    expect(agg.map((a) => a.total)).toEqual([10, 20, 15, 7]);
  });
});

describe('B: 同じ日の途中でのリセット', () => {
  it('リセット前 10・後 5 を、日別合計 15、周期別 10 と 5 として扱う', () => {
    const rows = [row('2026-11-05T08:00', 10), row('2026-11-05T15:00', 5)];
    const days = dayBuckets('2026-11-05', 1, Z);
    const cycles = [cycle('2026-10-29T12:00', '2026-11-05T12:00'), cycle('2026-11-05T12:00', '2026-11-12T12:00')];
    const prefix = new PrefixSum(rows, 'tokens');
    const [c] = cumulativeWithinCycles(days, cycles, prefix, DateTime.fromISO('2026-11-30', { zone: Z }).toMillis());
    expect(c!.bucketTotal).toBe(15);
    expect(c!.resetInBucket).toBe(true);
    expect(c!.cumulative).toBe(5); // 旧周期の 10 に積み上げない
    expect(c!.oldCycleUsage).toBe(10);
    const split = usageByCycle(cycles, prefix, days[0]!.startMs, days[0]!.endMs).map((x) => x.usage);
    expect(split).toEqual([10, 5]);
  });

  it('周期が分からない日は累積を「不明」にし、0 にしない', () => {
    const rows = [row('2026-11-05T08:00', 10)];
    const days = dayBuckets('2026-11-05', 1, Z);
    const [c] = cumulativeWithinCycles(days, [], new PrefixSum(rows, 'tokens'));
    expect(c!.cycleKnown).toBe(false);
    expect(c!.cumulative).toBeNull();
    expect(c!.bucketTotal).toBe(10);
  });
});

describe('C: 時刻の境界', () => {
  it('境界ちょうどのイベントは次の期間に属する（[start, end)）', () => {
    const days = dayBuckets('2026-11-05', 2, Z);
    const t = DateTime.fromISO('2026-11-06T00:00', { zone: Z }).toMillis();
    expect(bucketIndexOf(days, t)).toBe(1);
    expect(bucketIndexOf(days, t - 1)).toBe(0);
  });

  it('5時間枠が日付と月をまたいでも、枠ごとに正しく分類する', () => {
    const anchor = DateTime.fromISO('2026-10-31T22:00', { zone: Z }).toMillis();
    const b = fixedBuckets(anchor, 5 * 3600000, anchor, anchor + 10 * 3600000, '5h');
    const rows = [row('2026-10-31T23:30', 3), row('2026-11-01T02:59', 4), row('2026-11-01T03:00', 5)];
    const agg = aggregateBuckets(rows, b, 'tokens', 'none');
    expect(agg.map((a) => a.total)).toEqual([7, 5]);
  });

  it('夏時間の日は 23 時間と 25 時間になる（America/New_York）', () => {
    const spring = dayBuckets('2026-03-08', 1, 'America/New_York')[0]!;
    const fall = dayBuckets('2026-11-01', 1, 'America/New_York')[0]!;
    expect((spring.endMs - spring.startMs) / 3600000).toBe(23);
    expect((fall.endMs - fall.startMs) / 3600000).toBe(25);
  });

  it('表示タイムゾーンを変えると、同じイベントの所属日が変わる', () => {
    const ts = DateTime.fromISO('2026-11-05T23:30', { zone: 'Asia/Tokyo' }).toMillis();
    const tokyo = dayBuckets('2026-11-05', 2, 'Asia/Tokyo');
    const utc = dayBuckets('2026-11-05', 2, 'UTC');
    expect(tokyo[bucketIndexOf(tokyo, ts)]!.key).toBe('2026-11-05');
    expect(utc[bucketIndexOf(utc, ts)]!.key).toBe('2026-11-05'); // UTC では 14:30
    const ny = dayBuckets('2026-11-04', 2, 'America/New_York');
    expect(ny[bucketIndexOf(ny, ts)]!.key).toBe('2026-11-05');
  });

  it('リセット時刻ちょうどのイベントは新しい周期に属する', () => {
    const rows = [row('2026-11-05T12:00', 9)];
    const cycles = [cycle('2026-10-29T12:00', '2026-11-05T12:00'), cycle('2026-11-05T12:00', '2026-11-12T12:00')];
    const usage = usageByCycle(cycles, new PrefixSum(rows, 'tokens'), 0, 8.64e15).map((x) => x.usage);
    expect(usage).toEqual([0, 9]);
  });

  it('N日単位で過去 M 日は、最後の区間が今日で終わる', () => {
    const b = nDayBuckets('2026-11-18', 7, 28, Z);
    expect(b).toHaveLength(4);
    expect(DateTime.fromMillis(b[3]!.endMs, { zone: Z }).toISODate()).toBe('2026-11-19');
    expect(DateTime.fromMillis(b[0]!.startMs, { zone: Z }).toISODate()).toBe('2026-10-22');
  });

  it('暦週は月曜始まり・日曜始まりを選べる', () => {
    const from = DateTime.fromISO('2026-11-18', { zone: Z }).toMillis();
    const mon = calendarWeekBuckets(from, from + 1, Z, 1)[0]!;
    const sun = calendarWeekBuckets(from, from + 1, Z, 7)[0]!;
    expect(DateTime.fromMillis(mon.startMs, { zone: Z }).weekday).toBe(1);
    expect(DateTime.fromMillis(sun.startMs, { zone: Z }).weekday).toBe(7);
  });
});

function obs(atIso: string, used: number | null, resetsIso: string, extra: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    obsKey: `o-${atIso}`,
    provider: 'codex',
    accountKey: null,
    planType: 'pro',
    limitId: 'codex',
    windowKind: '7d',
    windowMinutes: 10080,
    scopeModels: null,
    observedAtMs: DateTime.fromISO(atIso, { zone: 'UTC' }).toMillis(),
    usedPercent: used,
    resetsAtMs: DateTime.fromISO(resetsIso, { zone: 'UTC' }).toMillis(),
    source: 'codex_log',
    precision: 1,
    flags: [],
    originRef: null,
    ...extra,
  };
}

describe('周期の組み立て', () => {
  it('サーバーが示したリセット日時と枠の長さから周期を作り、早いリセットで前の周期を打ち切る', () => {
    const o = [
      obs('2026-11-01T00:00', 10, '2026-11-05T00:00'),
      obs('2026-11-03T00:00', 40, '2026-11-05T00:00'),
      // 予定より早いリセット（11/4 に新しい周期が始まった）
      obs('2026-11-04T06:00', 2, '2026-11-11T00:00'),
    ];
    const c = buildCycles(o, 10080);
    expect(c).toHaveLength(2);
    expect(new Date(c[0]!.endMs).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(c[0]!.truncated).toBe(true);
    expect(new Date(c[1]!.startMs).toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('リセット時刻が週ごとに数分ずれても、隙間に推定周期を作らずにつなげる（実ログで観測）', () => {
    const o = [obs('2026-11-01T00:00', 10, '2026-11-01T14:54'), obs('2026-11-03T00:00', 20, '2026-11-08T14:57')];
    const c = buildCycles(o, 10080);
    expect(c).toHaveLength(2);
    expect(c.every((x) => x.basis === 'observed')).toBe(true);
    expect(c[1]!.startMs).toBe(c[0]!.endMs);
  });

  it('7日未満で打ち切られた観測済みの周期だけを前倒しリセットとし、7日ちょうど・時刻の揺れ・推定周期は前倒しにしない', () => {
    const o = [
      obs('2026-10-26T00:00', 10, '2026-11-02T00:00'),
      obs('2026-11-02T01:00', 10, '2026-11-09T00:00'),
      // 11/6 に早いリセット（4日目で打ち切り）
      obs('2026-11-06T06:00', 2, '2026-11-13T00:00'),
    ];
    const cycles = buildCycles(o, 10080, { extrapolateToMs: Date.parse('2026-11-30T00:00Z') });
    const bands = cycleBands(cycles, 10080, Date.parse('2026-10-26T00:00Z'), Date.parse('2026-11-30T00:00Z'));
    const early = bands.filter((b) => b.early);
    expect(early).toHaveLength(1);
    expect((early[0]!.endMs - early[0]!.startMs) / 86400000).toBeLessThan(7);
    expect(bands.filter((b) => !b.early && !b.estimated).length).toBeGreaterThan(0);
    expect(bands.filter((b) => b.estimated).every((b) => !b.early)).toBe(true);
    // 期間外の周期は含めない
    expect(cycleBands(cycles, 10080, Date.parse('2026-11-20T00:00Z'), Date.parse('2026-11-30T00:00Z')).every((b) => b.endMs > Date.parse('2026-11-20T00:00Z'))).toBe(true);
  });

  it('リセット時刻が数分ずれただけの周期は前倒しにしない', () => {
    const o = [obs('2026-11-01T00:00', 10, '2026-11-01T14:54'), obs('2026-11-03T00:00', 20, '2026-11-08T14:48')];
    const bands = cycleBands(buildCycles(o, 10080), 10080, 0, Date.parse('2027-01-01T00:00Z'));
    expect(bands.some((b) => b.early)).toBe(false);
  });

  it('観測の無い期間の周期は推定として区別する', () => {
    const o = [obs('2026-11-10T00:00', 10, '2026-11-12T00:00')];
    const c = buildCycles(o, 10080, { extrapolateFromMs: Date.parse('2026-10-20T00:00Z'), extrapolateToMs: Date.parse('2026-11-25T00:00Z') });
    expect(c.filter((x) => x.basis === 'observed')).toHaveLength(1);
    expect(c.filter((x) => x.basis === 'extrapolated').length).toBeGreaterThan(0);
  });
});
