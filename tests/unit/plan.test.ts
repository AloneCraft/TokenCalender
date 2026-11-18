// 利用枠の計画（消費率・予測・予算・シミュレーション）の試験。
// 仕様の試験シナリオ（単一モデル・混用・エフォート違い・他端末・リセット境界・上限到達・長期間未使用・
// プラン変更・新しいモデル・推定不能・大量の観測）を、計算の入口ごとに確かめる。

import { describe, expect, it } from 'vitest';
import { changeIntervals, estimateRates, nnls3, type GroupUsage, type IntervalWithUsage, type ObsPoint } from '../../src/core/plan/rates.ts';
import { budgetPlan, forecastWindow, simulate, weekdayWeightsFrom, workCapacity, type CyclePath } from '../../src/core/plan/forecast.ts';

const H = 3600000;
const D = 24 * H;
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0); // 月曜 0:00 UTC

function usage(tokens: number, turns = 1, opts: Partial<GroupUsage> = {}): GroupUsage {
  return { tokens, input: tokens * 0.1, cacheRead: tokens * 0.85, cacheWrite: 0, output: tokens * 0.05, reasoning: 0, events: turns, turns, sessions: 1, ...opts };
}

/** 1つの組み合わせだけを使った連続区間（各区間 Δp=1、トークンは perPct × 1e6） */
function run(group: string, n: number, perPctMTok: number, start = T0, turnsPerPct = 4): IntervalWithUsage[] {
  return Array.from({ length: n }, (_, i) => ({
    from: start + i * H,
    to: start + (i + 1) * H,
    deltaPct: 1,
    precision: 1,
    groups: new Map([[group, usage(perPctMTok * 1e6, turnsPerPct)]]),
  }));
}

describe('変化点の区間（changeIntervals）', () => {
  const p = (t: number, v: number, resetsAt = T0 + 7 * D, plan: string | null = 'pro'): ObsPoint => ({ t, p: v, resetsAt, plan, precision: 1 });

  it('同じ値の繰り返しは区間を作らず、値が変わった時点どうしを結ぶ', () => {
    const iv = changeIntervals([p(0, 10), p(10, 10), p(20, 11), p(30, 11), p(40, 13)]);
    expect(iv).toEqual([
      { from: 0, to: 20, deltaPct: 1, precision: 1 },
      { from: 20, to: 40, deltaPct: 2, precision: 1 },
    ]);
  });

  it('週のリセットの直前と直後をまたいだ区間は作らない', () => {
    const iv = changeIntervals([p(0, 98, T0), p(10, 99, T0), p(20, 1, T0 + 7 * D), p(30, 3, T0 + 7 * D)]);
    expect(iv).toEqual([
      { from: 0, to: 10, deltaPct: 1, precision: 1 },
      { from: 20, to: 30, deltaPct: 2, precision: 1 },
    ]);
  });

  it('プランが変わった所と、値が減った所で区切る', () => {
    const iv = changeIntervals([p(0, 10, T0, 'plus'), p(10, 20, T0, 'pro'), p(20, 25, T0, 'pro'), p(30, 5, T0, 'pro'), p(40, 6, T0, 'pro')]);
    expect(iv.map((x) => [x.from, x.to])).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('数分程度のリセット日時の揺れは同じ周期とみなす', () => {
    const iv = changeIntervals([p(0, 10, T0), p(10, 12, T0 + 120000)]);
    expect(iv).toHaveLength(1);
  });
});

describe('消費率の推定（estimateRates）', () => {
  it('単一モデルだけの期間: 比 ΣΔp / Σトークン を幅つきで返す', () => {
    const r = estimateRates(run('m|high', 12, 50));
    const g = r.groups.find((x) => x.group === 'm|high')!;
    expect(g.status).toBe('measured');
    expect(g.pctPerMTokens!.mid).toBeCloseTo(1 / 50, 6);
    expect(g.pctPerTurn!.mid).toBeCloseTo(0.25, 6);
    expect(g.pctPerMTokens!.low).toBeLessThanOrEqual(g.pctPerMTokens!.mid);
    expect(g.pctPerMTokens!.high).toBeGreaterThanOrEqual(g.pctPerMTokens!.mid);
  });

  it('同じモデルでエフォートが違うと別々に推定し、基準との比を出す', () => {
    // 「実測」になるよう、それぞれ合計 12 ポイント分の区間を用意する
    const r = estimateRates([...run('m|low', 12, 100), ...run('m|high', 12, 25, T0 + 20 * H)]);
    const low = r.groups.find((x) => x.group === 'm|low')!;
    const high = r.groups.find((x) => x.group === 'm|high')!;
    expect(high.pctPerMTokens!.mid / low.pctPerMTokens!.mid).toBeCloseTo(4, 6);
    expect(r.baseline).not.toBeNull();
    expect(r.groups.find((x) => x.group === r.baseline)!.relativeToBaseline).toBe(1);
  });

  it('複数モデルを混ぜて使った区間は、組み合わせ別の推定に使わない（全体平均には入れる）', () => {
    const mixed: IntervalWithUsage[] = Array.from({ length: 10 }, (_, i) => ({
      from: T0 + i * H,
      to: T0 + (i + 1) * H,
      deltaPct: 1,
      precision: 1,
      groups: new Map([
        ['a|x', usage(30e6)],
        ['b|y', usage(30e6)],
      ]),
    }));
    const r = estimateRates(mixed);
    expect(r.mixedIntervals).toBe(10);
    expect(r.groups).toHaveLength(0);
    expect(r.overall.pctPerMTokens!.mid).toBeCloseTo(10 / 600, 6);
  });

  it('他端末での利用（ログに使用量が無いのに利用率が増えた区間）を数え、推定には使わない', () => {
    const others: IntervalWithUsage[] = [{ from: T0 + 50 * H, to: T0 + 51 * H, deltaPct: 3, precision: 1, groups: new Map() }];
    const r = estimateRates([...run('m|high', 9, 50), ...others]);
    expect(r.unobservedIntervals).toBe(1);
    expect(r.groups[0]!.totalDeltaPct).toBe(9);
  });

  it('観測が足りない組み合わせは「暫定」、区間が無ければ値を出さない', () => {
    const r = estimateRates(run('m|high', 3, 50));
    expect(r.groups[0]!.status).toBe('tentative');
    expect(estimateRates([]).groups).toHaveLength(0);
    expect(estimateRates([]).overall.pctPerMTokens).toBeNull();
  });

  it('新しいモデルの版は別の組み合わせとして扱う（既存の係数を流用しない）', () => {
    const r = estimateRates([...run('m-1|high', 9, 50), ...run('m-2|high', 3, 20, T0 + 30 * H)]);
    expect(r.groups.map((g) => g.group).sort()).toEqual(['m-1|high', 'm-2|high']);
    expect(r.groups.find((g) => g.group === 'm-2|high')!.status).toBe('tentative');
  });

  it('入力・キャッシュ・出力が一緒に動く（比率が一定の）場合、係数は「識別できない」とする', () => {
    const r = estimateRates(run('m|high', 40, 50));
    const g = r.groups[0]!;
    expect(g.coefficients).toBeNull();
    expect(g.coefficientNote).toBe('not_identifiable');
  });

  it('3つの量が独立に動くとき、非負の最小二乗で係数を取り戻す', () => {
    const truth = [0.4, 0.002, 4]; // 100万トークンあたりのポイント
    const ivs: IntervalWithUsage[] = [];
    for (let i = 0; i < 60; i++) {
      const inp = (1 + ((i * 7) % 5)) * 1e6;
      const cr = (10 + ((i * 3) % 11) * 20) * 1e6;
      const out = (0.2 + ((i * 5) % 7) * 0.15) * 1e6;
      const dp = (truth[0]! * inp + truth[1]! * cr + truth[2]! * out) / 1e6;
      ivs.push({ from: T0 + i * H, to: T0 + (i + 1) * H, deltaPct: dp, precision: 1, groups: new Map([['m|x', usage(inp + cr + out, 3, { input: inp, cacheRead: cr, output: out })]]) });
    }
    const r = estimateRates(ivs, { dominance: 0.85, minDeltaPct: 0, minSegments: 3, minTotalDelta: 10, minSegmentsForCoefficients: 12, bootstrap: 50 });
    const c = r.groups[0]!.coefficients!;
    expect(c.input.mid).toBeCloseTo(truth[0]!, 4);
    expect(c.cacheRead.mid).toBeCloseTo(truth[1]!, 5);
    expect(c.output.mid).toBeCloseTo(truth[2]!, 4);
  });

  it('非負の最小二乗は負の係数を出さない', () => {
    const X = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ];
    const sol = nnls3(X, [1, -1, 2, 2])!;
    expect(sol.every((v) => v >= 0)).toBe(true);
  });

  it('数万件の区間でも短時間で終わる', () => {
    const many = run('m|high', 30000, 50);
    const t = performance.now();
    const r = estimateRates(many);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(r.groups[0]!.status).toBe('measured');
  });
});

describe('予測（forecastWindow）', () => {
  const start = T0;
  const reset = T0 + 7 * D;
  /** 過去の周期: 毎日 perDay ポイントずつ使った */
  const past = (k: number, perDay: number): CyclePath => {
    const s = T0 - (k + 1) * 7 * D;
    return { startMs: s, endMs: s + 7 * D, points: Array.from({ length: 7 }, (_, i) => ({ t: s + (i + 1) * D - H, p: Math.min(100, perDay * (i + 1)) })) };
  };

  it('過去の周期の「この時点から終わりまで」の消費を足して予測する', () => {
    const f = forecastWindow({ nowMs: start + 3 * D, usedNow: 30, cycleStartMs: start, resetsAtMs: reset, pastCycles: [past(0, 10), past(1, 10), past(2, 10), past(3, 10)], recentPctPerHour: null });
    expect(f.finalPct!.mid).toBeCloseTo(30 + 40, 6);
    expect(f.probabilityLasts).toBe(1);
    expect(f.exhaustion!.likelyMs).toBeNull();
    expect(f.confidence).toBe('medium');
  });

  it('使い方が多い週だと、枯渇の見込み時刻を返す', () => {
    const f = forecastWindow({ nowMs: start + 3 * D, usedNow: 60, cycleStartMs: start, resetsAtMs: reset, pastCycles: [past(0, 20), past(1, 20), past(2, 20), past(3, 20)], recentPctPerHour: null });
    expect(f.finalPct!.mid).toBe(100);
    expect(f.exhaustion!.likelyMs).not.toBeNull();
    expect(f.exhaustion!.likelyMs!).toBeLessThan(reset);
    expect(f.probabilityLasts).toBe(0);
  });

  it('記録が途中で終わった周期と、同じ時点ですでに上限だった周期は使わない', () => {
    const truncatedCycle: CyclePath = { startMs: T0 - 7 * D, endMs: T0, points: [{ t: T0 - 7 * D + 2 * H, p: 10 }] };
    const s = T0 - 14 * D;
    const cappedEarly: CyclePath = { startMs: s, endMs: s + 7 * D, points: [{ t: s + D, p: 100 }, { t: s + 6 * D, p: 100 }] };
    const f = forecastWindow({ nowMs: start + 3 * D, usedNow: 30, cycleStartMs: start, resetsAtMs: reset, pastCycles: [truncatedCycle, cappedEarly, past(2, 10)], recentPctPerHour: null });
    expect(f.cyclesUsed).toBe(1);
    expect(f.reasons).toEqual(expect.arrayContaining(['excluded_truncated_cycles', 'excluded_capped_cycles']));
    expect(f.finalPct!.mid).toBeCloseTo(70, 6);
  });

  it('過去の周期が少ないときは確率を出さず、理由を返す', () => {
    const f = forecastWindow({ nowMs: start + D, usedNow: 10, cycleStartMs: start, resetsAtMs: reset, pastCycles: [past(0, 10)], recentPctPerHour: null });
    expect(f.probabilityLasts).toBeNull();
    expect(f.reasons).toContain('few_cycles_for_probability');
    expect(f.confidence).toBe('low');
  });

  it('過去の周期が無ければ予測しない（長期間利用が無い場合を含む）', () => {
    const f = forecastWindow({ nowMs: start + D, usedNow: 0, cycleStartMs: start, resetsAtMs: reset, pastCycles: [], recentPctPerHour: null });
    expect(f.finalPct).toBeNull();
    expect(f.reasons).toContain('no_past_cycles');
  });

  it('上限に達している場合は、枯渇済みとして返す', () => {
    const f = forecastWindow({ nowMs: start + D, usedNow: 100, cycleStartMs: start, resetsAtMs: reset, pastCycles: [], recentPctPerHour: 1 });
    expect(f.reasons).toContain('already_exhausted');
    expect(f.remainingAtReset!.mid).toBe(0);
  });

  it('直近のペースによる枯渇時刻は、リセット後なら出さない', () => {
    const f = forecastWindow({ nowMs: start + 6 * D, usedNow: 50, cycleStartMs: start, resetsAtMs: reset, pastCycles: [], recentPctPerHour: 1 });
    expect(f.recentPace!.exhaustionMs).toBeNull();
    const g = forecastWindow({ nowMs: start + D, usedNow: 50, cycleStartMs: start, resetsAtMs: reset, pastCycles: [], recentPctPerHour: 1 });
    expect(g.recentPace!.exhaustionMs).toBe(start + D + 50 * H);
  });
});

describe('1日ごとの予算（budgetPlan）', () => {
  const zone = 'UTC';
  it('目標残量を引いた残りを、曜日の重みで割り振る', () => {
    // 月曜 12:00、リセットは金曜 0:00（月・火・水・木の4日）
    const p = budgetPlan({ nowMs: T0 + 12 * H, zone, usedNow: 40, usedAtDayStart: 40, resetsAtMs: T0 + 4 * D, reservePct: 4, weekdayWeights: [1, 1, 1, 1, 1, 1, 1] });
    expect(p.allocatablePct).toBe(56);
    expect(p.days).toHaveLength(4);
    expect(p.today!.budgetPct).toBeCloseTo(14, 6);
    expect(p.days.reduce((a, d) => a + d.budgetPct, 0)).toBeCloseTo(56, 6);
    expect(p.todayStatus).toBe('ok');
  });

  it('今日の使い過ぎは「超過」とし、明日以降の予算を減らす', () => {
    const p = budgetPlan({ nowMs: T0 + 12 * H, zone, usedNow: 60, usedAtDayStart: 40, resetsAtMs: T0 + 4 * D, reservePct: 4, weekdayWeights: [1, 1, 1, 1, 1, 1, 1] });
    expect(p.todayStatus).toBe('over');
    expect(p.today!.leftPct).toBeCloseTo(14 - 20, 6);
    expect(p.days.slice(1).reduce((a, d) => a + d.budgetPct, 0)).toBeCloseTo(36, 6);
  });

  it('重み 0 の曜日には予算を割り振らない', () => {
    const p = budgetPlan({ nowMs: T0 + 12 * H, zone, usedNow: 0, usedAtDayStart: 0, resetsAtMs: T0 + 7 * D, reservePct: 0, weekdayWeights: [1, 1, 1, 1, 1, 0, 0] });
    expect(p.days.filter((d) => d.budgetPct === 0)).toHaveLength(2);
  });

  it('今日の始まりの値が分からなければ「今日の使用」は出さない', () => {
    const p = budgetPlan({ nowMs: T0 + 12 * H, zone, usedNow: 40, usedAtDayStart: null, resetsAtMs: T0 + 4 * D, reservePct: 0, weekdayWeights: [1, 1, 1, 1, 1, 1, 1] });
    expect(p.today!.usedPct).toBeNull();
    expect(p.todayStatus).toBe('unknown');
  });

  it('夏時間のある地域でも、日の区切りがずれない', () => {
    // 2026-11-01 は米国の夏時間終了日（25時間の日）
    const start = Date.UTC(2026, 10, 1, 12, 0, 0);
    const p = budgetPlan({ nowMs: start, zone: 'America/New_York', usedNow: 0, usedAtDayStart: 0, resetsAtMs: start + 3 * D, reservePct: 0, weekdayWeights: [1, 1, 1, 1, 1, 1, 1] });
    for (let i = 1; i < p.days.length; i++) expect(p.days[i]!.startMs).toBe(p.days[i - 1]!.endMs);
  });

  it('曜日の重みは過去の消費の傾向から作り、最低限の重みを残す', () => {
    const w = weekdayWeightsFrom(
      [
        { t: T0 + 10 * H, pct: 10 },
        { t: T0 + 7 * D + 10 * H, pct: 10 },
        { t: T0 + 5 * D + 10 * H, pct: 1 },
      ],
      'UTC',
    );
    expect(w[0]).toBeGreaterThan(w[5]!);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0.25);
  });
});

describe('作業可能量とシミュレーション', () => {
  it('残りを1回あたりの消費で割り、消費の幅から回数の幅を出す', () => {
    const c = workCapacity(30, { mid: 0.3, low: 0.2, high: 0.5 })!;
    expect(c.mid).toBeCloseTo(100, 6);
    expect(c.low).toBeCloseTo(60, 6);
    expect(c.high).toBeCloseTo(150, 6);
    expect(workCapacity(0, { mid: 1, low: 1, high: 1 })!.mid).toBe(0);
    expect(workCapacity(10, null)).toBeNull();
  });

  it('作業日・作業時間だけ消費が増え、上限に達する時刻を返す', () => {
    const s = simulate({ nowMs: T0, zone: 'UTC', usedNow: 50, resetsAtMs: T0 + 7 * D, pctPerTurn: { mid: 1, low: 0.5, high: 2 }, turnsPerDay: 10, workWeekdays: [0, 1, 2, 3, 4], workStartHour: 9, workHours: 8 });
    expect(s.finalPct.mid).toBe(100);
    expect(s.exhaustionMs.mid).toBe(T0 + 4 * D + 17 * H); // 金曜の作業終わり（5日 × 10ポイント）
    expect(s.exhaustionMs.earliest!).toBeLessThan(s.exhaustionMs.mid!);
    // 土日は増えない
    const sat = s.points.find((p) => p.t === T0 + 5 * D + 12 * H)!;
    const sun = s.points.find((p) => p.t === T0 + 6 * D + 12 * H)!;
    expect(sat.low).toBe(sun.low);
  });

  it('依頼回数が 0 なら、今の値のまま変わらない', () => {
    const s = simulate({ nowMs: T0, zone: 'UTC', usedNow: 20, resetsAtMs: T0 + 2 * D, pctPerTurn: { mid: 1, low: 1, high: 1 }, turnsPerDay: 0, workWeekdays: [0, 1, 2, 3, 4, 5, 6], workStartHour: 0, workHours: 24 });
    expect(s.finalPct.mid).toBe(20);
    expect(s.exhaustionMs.mid).toBeNull();
  });
});
