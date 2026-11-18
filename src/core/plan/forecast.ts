// 利用枠の残り期間の予測・1日ごとの予算・作業可能量・切り替えのシミュレーション。
// どれも「公式の観測値」から出発し、結果は推定であることを型（Band・confidence）で示す。
//
// 予測の考え方: 過去の完了した周期それぞれについて、「今と同じ経過時点から周期の終わりまでに何ポイント使ったか」を
// 求め、それを今の値に足したものを将来の候補（シナリオ）とする。曜日や時間帯の癖は過去の周期に含まれる。
// 周期の数が少ないときは確率を出さない。
// 記録が途中で終わった周期と、同じ時点ですでに上限だった周期は使わない（実ログで、これらを「その後の消費 0」と
// 数えて予測が大きく楽観側にずれた）。

import { DateTime } from 'luxon';
import type { Band } from './rates.ts';

export interface CyclePath {
  startMs: number;
  endMs: number;
  /** 周期内の観測（時刻順）。周期の始めは 0% とみなす */
  points: { t: number; p: number }[];
}

export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface WindowForecast {
  /** 使った過去の周期の数 */
  cyclesUsed: number;
  confidence: Confidence;
  /** リセット時点の利用率の見込み（上限 100） */
  finalPct: Band | null;
  /** リセット時に残る見込み */
  remainingAtReset: Band | null;
  /** 枯渇の見込み時刻。likely は中央のシナリオで枯渇する場合のみ */
  exhaustion: { likelyMs: number | null; earliestMs: number | null } | null;
  /** リセットまで持つ割合（過去の周期の中で）。周期が少ない場合は null */
  probabilityLasts: number | null;
  /** 直近のペース（ポイント/時）がそのまま続いた場合の枯渇時刻 */
  recentPace: { pctPerHour: number; exhaustionMs: number | null } | null;
  reasons: string[];
}

function valueAt(points: { t: number; p: number }[], t: number): number {
  let v = 0;
  for (const pt of points) {
    if (pt.t > t) break;
    v = pt.p;
  }
  return v;
}

function q(sorted: number[], f: number): number {
  const pos = (sorted.length - 1) * f;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function forecastWindow(input: {
  nowMs: number;
  usedNow: number;
  cycleStartMs: number;
  resetsAtMs: number;
  pastCycles: CyclePath[];
  recentPctPerHour: number | null;
}): WindowForecast {
  const { nowMs, usedNow, cycleStartMs, resetsAtMs } = input;
  const res: WindowForecast = {
    cyclesUsed: 0,
    confidence: 'none',
    finalPct: null,
    remainingAtReset: null,
    exhaustion: null,
    probabilityLasts: null,
    recentPace: null,
    reasons: [],
  };
  const elapsed = nowMs - cycleStartMs;
  const need = 100 - usedNow;
  if (input.recentPctPerHour != null && input.recentPctPerHour >= 0) {
    const r = input.recentPctPerHour;
    const ex = r > 0 ? nowMs + (need / r) * 3600000 : null;
    res.recentPace = { pctPerHour: r, exhaustionMs: ex != null && ex < resetsAtMs ? ex : null };
  }
  if (need <= 0) {
    res.finalPct = { mid: 100, low: 100, high: 100 };
    res.remainingAtReset = { mid: 0, low: 0, high: 0 };
    res.exhaustion = { likelyMs: nowMs, earliestMs: nowMs };
    res.confidence = 'high';
    res.reasons.push('already_exhausted');
    return res;
  }
  const finals: number[] = [];
  const exhaust: number[] = [];
  let truncated = 0;
  let censored = 0;
  // 新しい周期から順に、使える周期を最大 8 個まで使う（使い方の変化を反映するため）
  for (const c of [...input.pastCycles].sort((a, b) => b.startMs - a.startMs)) {
    if (finals.length >= 8) break;
    const len = c.endMs - c.startMs;
    if (len <= 0 || c.points.length === 0) continue;
    // 周期の長さが違う場合は、経過の割合で合わせる
    const scale = len / (resetsAtMs - cycleStartMs);
    const tNow = c.startMs + elapsed * scale;
    const last = c.points[c.points.length - 1]!;
    // 記録が途中で終わった周期（早めのリセットなど）は、周期の終わりの値が分からないため使わない
    if (last.p < 100 && last.t - c.startMs < 0.85 * len) {
      truncated++;
      continue;
    }
    const base = valueAt(c.points, tNow);
    // 同じ時点ですでに上限だった周期は、その後の消費が上限で打ち切られていて比べられないため使わない
    if (base >= 100) {
      censored++;
      continue;
    }
    const end = c.points[c.points.length - 1]!.p;
    const rest = Math.max(0, end - base);
    finals.push(Math.min(100, usedNow + rest));
    let ex = Number.POSITIVE_INFINITY;
    for (const pt of c.points) {
      if (pt.t <= tNow) continue;
      if (pt.p - base >= need) {
        ex = cycleStartMs + (pt.t - c.startMs) / scale;
        break;
      }
    }
    exhaust.push(ex);
  }
  res.cyclesUsed = finals.length;
  if (truncated > 0) res.reasons.push('excluded_truncated_cycles');
  if (censored > 0) res.reasons.push('excluded_capped_cycles');
  if (finals.length === 0) {
    res.reasons.push('no_past_cycles');
    return res;
  }
  finals.sort((a, b) => a - b);
  exhaust.sort((a, b) => a - b);
  res.finalPct = { mid: q(finals, 0.5), low: q(finals, 0.2), high: q(finals, 0.8) };
  res.remainingAtReset = { mid: 100 - res.finalPct.mid, low: 100 - res.finalPct.high, high: 100 - res.finalPct.low };
  const med = q(exhaust, 0.5);
  const early = q(exhaust, 0.2);
  res.exhaustion = { likelyMs: Number.isFinite(med) ? med : null, earliestMs: Number.isFinite(early) ? early : null };
  res.confidence = finals.length >= 6 ? 'high' : finals.length >= 3 ? 'medium' : 'low';
  if (finals.length >= 4) res.probabilityLasts = exhaust.filter((e) => !Number.isFinite(e)).length / exhaust.length;
  else res.reasons.push('few_cycles_for_probability');
  return res;
}

export interface DayBudget {
  date: string;
  startMs: number;
  endMs: number;
  weight: number;
  budgetPct: number;
  /** 今日の分だけ: 今日すでに使った量 */
  usedPct: number | null;
}

export interface BudgetPlan {
  reservePct: number;
  /** リセットまでに使ってよい残り（目標残量を引いた後） */
  allocatablePct: number;
  today: { budgetPct: number; usedPct: number | null; leftPct: number | null } | null;
  days: DayBudget[];
  /** 今日の使い方の判定 */
  todayStatus: 'over' | 'near' | 'ok' | 'unknown';
}

/**
 * リセットまでの1日ごとの予算。曜日の重み（過去の実績から。利用者が変えられる）で割り振る。
 * 今日の予算は「今日の始まりの時点の残り」から割り振り、今日の使用分と比べる。
 */
export function budgetPlan(input: {
  nowMs: number;
  zone: string;
  usedNow: number;
  usedAtDayStart: number | null;
  resetsAtMs: number;
  reservePct: number;
  /** 曜日の重み（月=0 … 日=6） */
  weekdayWeights: number[];
}): BudgetPlan {
  const { nowMs, zone, usedNow, resetsAtMs, reservePct } = input;
  const plan: BudgetPlan = { reservePct, allocatablePct: Math.max(0, 100 - usedNow - reservePct), today: null, days: [], todayStatus: 'unknown' };
  if (!(resetsAtMs > nowMs)) return plan;
  const w = (ms: number) => Math.max(0, input.weekdayWeights[DateTime.fromMillis(ms, { zone }).weekday - 1] ?? 1);
  const days: DayBudget[] = [];
  let d = DateTime.fromMillis(nowMs, { zone }).startOf('day');
  while (d.toMillis() < resetsAtMs) {
    const s = d.toMillis();
    const next = d.plus({ days: 1 }).startOf('day');
    const e = Math.min(next.toMillis(), resetsAtMs);
    const frac = (e - s) / (next.toMillis() - s);
    days.push({ date: d.toISODate()!, startMs: s, endMs: e, weight: w(s) * frac, budgetPct: 0, usedPct: null });
    d = next;
  }
  if (days.length === 0) return plan;
  const startUsed = input.usedAtDayStart ?? usedNow;
  const alloc0 = Math.max(0, 100 - startUsed - reservePct);
  const sumW = days.reduce((a, x) => a + x.weight, 0);
  const todayDay = days[0]!;
  todayDay.budgetPct = sumW > 0 ? (alloc0 * todayDay.weight) / sumW : alloc0 / days.length;
  const usedToday = input.usedAtDayStart != null ? Math.max(0, usedNow - input.usedAtDayStart) : null;
  todayDay.usedPct = usedToday;
  const todayLeft = usedToday != null ? todayDay.budgetPct - usedToday : null;
  // 明日以降は、今の残りから今日の残り予算を除いた分を割り振る
  const restAlloc = Math.max(0, 100 - usedNow - reservePct - Math.max(0, todayLeft ?? 0));
  const restW = days.slice(1).reduce((a, x) => a + x.weight, 0);
  for (const x of days.slice(1)) x.budgetPct = restW > 0 ? (restAlloc * x.weight) / restW : restAlloc / Math.max(1, days.length - 1);
  plan.days = days;
  plan.today = { budgetPct: todayDay.budgetPct, usedPct: usedToday, leftPct: todayLeft };
  if (usedToday != null) plan.todayStatus = usedToday > todayDay.budgetPct ? 'over' : usedToday > todayDay.budgetPct * 0.8 ? 'near' : 'ok';
  return plan;
}

/** 曜日ごとの重み（月=0…日=6）。区間の消費（ポイント）を曜日別に合計し、平均で割る。極端に小さい曜日にも最低限の重みを残す。 */
export function weekdayWeightsFrom(consumption: { t: number; pct: number }[], zone: string): number[] {
  const sum = new Array<number>(7).fill(0);
  const seen = new Set<string>();
  const daysPerWd = new Array<number>(7).fill(0);
  for (const c of consumption) {
    const dt = DateTime.fromMillis(c.t, { zone });
    sum[dt.weekday - 1]! += c.pct;
    const key = dt.toISODate()!;
    if (!seen.has(key)) {
      seen.add(key);
      daysPerWd[dt.weekday - 1]!++;
    }
  }
  const avg = sum.map((s, i) => (daysPerWd[i]! > 0 ? s / daysPerWd[i]! : 0));
  const mean = avg.reduce((a, v) => a + v, 0) / 7;
  if (!(mean > 0)) return new Array<number>(7).fill(1);
  return avg.map((v) => Math.max(0.25, v / mean));
}

/** 残りを作業回数などに直す。low は消費が多めの場合（回数が少ない側）。 */
export function workCapacity(usablePct: number, perUnit: Band | null): Band | null {
  if (!perUnit || !(perUnit.mid > 0) || usablePct <= 0) return usablePct <= 0 ? { mid: 0, low: 0, high: 0 } : null;
  return {
    mid: usablePct / perUnit.mid,
    low: usablePct / Math.max(perUnit.high, perUnit.mid),
    high: perUnit.low > 0 ? usablePct / perUnit.low : usablePct / perUnit.mid,
  };
}

export interface SimPoint {
  t: number;
  mid: number;
  low: number;
  high: number;
}

export interface Simulation {
  points: SimPoint[];
  finalPct: Band;
  exhaustionMs: { mid: number | null; earliest: number | null };
}

/**
 * 「このモデル・エフォートで、1日に N 回依頼したら」の将来の推移。
 * 依頼は作業日の作業時間帯に均等に起きるとみなす（条件付きの試算）。
 */
export function simulate(input: {
  nowMs: number;
  zone: string;
  usedNow: number;
  resetsAtMs: number;
  pctPerTurn: Band;
  turnsPerDay: number;
  /** 作業する曜日（月=0…日=6） */
  workWeekdays: number[];
  workStartHour: number;
  workHours: number;
}): Simulation {
  const { nowMs, zone, usedNow, resetsAtMs, pctPerTurn } = input;
  const points: SimPoint[] = [{ t: nowMs, mid: usedNow, low: usedNow, high: usedNow }];
  let mid = usedNow;
  let low = usedNow;
  let high = usedNow;
  let exMid: number | null = null;
  let exEarly: number | null = null;
  const stepMs = 3600000;
  const perHour = input.workHours > 0 ? input.turnsPerDay / input.workHours : 0;
  for (let t = Math.ceil(nowMs / stepMs) * stepMs; t <= resetsAtMs; t += stepMs) {
    const dt = DateTime.fromMillis(t - stepMs / 2, { zone });
    const working = input.workWeekdays.includes(dt.weekday - 1) && dt.hour >= input.workStartHour && dt.hour < input.workStartHour + input.workHours;
    if (working) {
      mid += perHour * pctPerTurn.mid;
      low += perHour * pctPerTurn.low;
      high += perHour * pctPerTurn.high;
      if (exMid == null && mid >= 100) exMid = t;
      if (exEarly == null && high >= 100) exEarly = t;
    }
    points.push({ t, mid: Math.min(100, mid), low: Math.min(100, low), high: Math.min(100, high) });
  }
  return {
    points,
    finalPct: { mid: Math.min(100, mid), low: Math.min(100, low), high: Math.min(100, high) },
    exhaustionMs: { mid: exMid, earliest: exEarly },
  };
}
