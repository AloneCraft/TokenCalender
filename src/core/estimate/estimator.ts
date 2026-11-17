// 週制限などの「実効容量」の推定。
//
// 基本: 同じ枠・同じ周期の2つの観測 (p1 → p2) の間に、端末上で使ったトークン量 T と API料金換算 C があるとき、
//   参考の枠全体トークン量 = T × 100 / Δp、参考の枠全体換算額 = C × 100 / Δp   （Δp = p2 − p1、パーセントポイント）
// これは「現在のモデル構成・使い方における推定」であり、公式の上限値ではない。
//
// 区間の作り方: 周期ごとに観測を時刻順に並べ、Δp が最小幅（既定 5 ポイント）に達するまで区間を伸ばす。
// 除外・注意の理由は区間ごとに記録し、画面に表示する（外れ値として黙って消さない）。

import type { QuotaObservation } from '../model/types.ts';
import type { Cycle } from '../quota/cycles.ts';

export interface LocalUsage {
  tokens: number;
  costNano: number;
  unpricedTokens: number;
  events: number;
  /** 区間内に API 利用・追加課金と判定された利用が混ざっているか */
  mixedBillingTokens: number;
}

export type LocalUsageFn = (fromMs: number, toMs: number) => LocalUsage;

export interface EstimateParams {
  /** 区間とみなす最小の Δp（パーセントポイント） */
  minDeltaPct: number;
  /** この時間より短い区間は、反映遅延の影響が大きいため注意を付ける */
  minIntervalMs: number;
  /** 中央値に対してこの比率より小さい容量の区間は「未観測の利用」の疑いとする */
  unobservedRatio: number;
  /** 未観測の疑いの区間がこの割合を超えたら推定を控える */
  suppressFraction: number;
  /** 未換算トークンの割合がこれを超えたら金額の推定を控える */
  maxUnpricedShare: number;
  /** 推定ありと表示するのに必要な採用区間数 */
  minSegments: number;
}

export const DEFAULT_ESTIMATE_PARAMS: EstimateParams = {
  minDeltaPct: 5,
  minIntervalMs: 10 * 60 * 1000,
  unobservedRatio: 0.5,
  suppressFraction: 0.3,
  maxUnpricedShare: 0.2,
  minSegments: 2,
};

export type ExclusionReason =
  | 'crosses_reset'
  | 'plan_changed'
  | 'percent_decreased'
  | 'saturated'
  | 'no_local_usage'
  | 'possible_unobserved_usage'
  | 'mixed_billing'
  | 'estimated_cycle';

export type WarningReason = 'short_interval' | 'unpriced_share_high' | 'rounding_large' | 'unknown_billing';

export interface Range {
  mid: number;
  low: number;
  high: number;
}

export interface Segment {
  startMs: number;
  endMs: number;
  p1: number;
  p2: number;
  deltaPct: number;
  precision: number;
  local: LocalUsage;
  capacityTokens: Range | null;
  /** nano-dollar */
  capacityCostNano: Range | null;
  adopted: boolean;
  exclusions: ExclusionReason[];
  warnings: WarningReason[];
}

export type EstimateStatus = 'no_observations' | 'preparing' | 'ok' | 'difficult';

export interface EstimateResult {
  status: EstimateStatus;
  statusReasons: string[];
  segments: Segment[];
  adoptedCount: number;
  excludedCount: number;
  observationCount: number;
  periodFromMs: number | null;
  periodToMs: number | null;
  /** 採用区間からまとめた推定（status が ok のときだけ値を持つ。1区間だけの場合は reference に入る） */
  capacityTokens: Range | null;
  capacityCostNano: Range | null;
  /** 1区間だけのときの参考値（条件付き） */
  reference: { capacityTokens: Range | null; capacityCostNano: Range | null } | null;
  /** 採用区間の容量の散らばり（四分位の幅を中央値で割った比率） */
  spreadRatio: number | null;
  costEstimateSuppressed: boolean;
  params: EstimateParams;
}

function rangeFrom(value: number, delta: number, precision: number): Range {
  // 公表値が precision 刻みに丸められていると、真の増分は (Δp − precision, Δp + precision) にある
  const hiDen = Math.max(delta - precision, precision / 2);
  return { mid: (value * 100) / delta, low: (value * 100) / (delta + precision), high: (value * 100) / hiDen };
}

export function estimateCapacity(
  observations: QuotaObservation[],
  cycles: Cycle[],
  local: LocalUsageFn,
  params: EstimateParams = DEFAULT_ESTIMATE_PARAMS,
): EstimateResult {
  const obs = observations.filter((o) => o.usedPercent != null).sort((a, b) => a.observedAtMs - b.observedAtMs);
  const result: EstimateResult = {
    status: 'no_observations',
    statusReasons: [],
    segments: [],
    adoptedCount: 0,
    excludedCount: 0,
    observationCount: obs.length,
    periodFromMs: obs[0]?.observedAtMs ?? null,
    periodToMs: obs[obs.length - 1]?.observedAtMs ?? null,
    capacityTokens: null,
    capacityCostNano: null,
    reference: null,
    spreadRatio: null,
    costEstimateSuppressed: false,
    params,
  };
  if (obs.length < 2) {
    result.status = obs.length === 0 ? 'no_observations' : 'preparing';
    if (obs.length === 1) result.statusReasons.push('need_more_observations');
    return result;
  }

  const cycleOf = (o: QuotaObservation): Cycle | null => {
    if (o.resetsAtMs == null) return null;
    for (const c of cycles) if (o.observedAtMs >= c.startMs && o.observedAtMs < c.endMs) return c;
    return null;
  };

  let anchor = obs[0]!;
  for (let j = 1; j < obs.length; j++) {
    const o = obs[j]!;
    const ca = cycleOf(anchor);
    const co = cycleOf(o);
    const p1 = anchor.usedPercent!;
    const p2 = o.usedPercent!;
    const precision = Math.max(anchor.precision, o.precision);
    const sameCycle = ca != null && co != null && ca === co;
    const make = (exclusions: ExclusionReason[]): void => {
      const seg = buildSegment(anchor, o, local, precision, exclusions, params);
      result.segments.push(seg);
    };
    if (!sameCycle) {
      // リセットをまたぐ区間は使わない。ただし区間の候補になるほど離れていた場合だけ記録する
      if (p2 - p1 >= params.minDeltaPct || p2 < p1) make(['crosses_reset']);
      anchor = o;
      continue;
    }
    if ((anchor.planType ?? null) !== (o.planType ?? null) && anchor.planType != null && o.planType != null) {
      make(['plan_changed']);
      anchor = o;
      continue;
    }
    if (p2 < p1 - precision) {
      make(['percent_decreased']);
      anchor = o;
      continue;
    }
    if (p2 - p1 < params.minDeltaPct) continue; // まだ小さすぎる。区間を伸ばす
    const ex: ExclusionReason[] = [];
    if (p1 >= 100 || p2 >= 100) ex.push('saturated');
    if (ca.basis === 'extrapolated') ex.push('estimated_cycle');
    make(ex);
    anchor = o;
  }

  // 未観測の利用の疑い: 採用候補の中央値より極端に容量が小さい区間
  const candidates = result.segments.filter((s) => s.exclusions.length === 0 && s.capacityTokens);
  const med = weightedQuantile(
    candidates.map((s) => ({ v: s.capacityTokens!.mid, w: s.deltaPct })),
    0.5,
  );
  if (med != null && candidates.length >= 3) {
    for (const s of candidates) {
      if (s.capacityTokens!.mid < med * params.unobservedRatio) s.exclusions.push('possible_unobserved_usage');
    }
  }
  for (const s of result.segments) s.adopted = s.exclusions.length === 0 && s.capacityTokens != null;
  const adopted = result.segments.filter((s) => s.adopted);
  result.adoptedCount = adopted.length;
  result.excludedCount = result.segments.length - adopted.length;

  const suspicious = result.segments.filter(
    (s) => s.exclusions.includes('possible_unobserved_usage') || s.exclusions.includes('no_local_usage'),
  ).length;
  const considered = result.segments.filter((s) => !s.exclusions.includes('crosses_reset')).length;
  if (considered > 0 && suspicious / considered > params.suppressFraction) {
    result.status = 'difficult';
    result.statusReasons.push('unobserved_usage_suspected');
    return result;
  }

  const unpricedTotal = adopted.reduce((s, x) => s + x.local.unpricedTokens, 0);
  const tokenTotal = adopted.reduce((s, x) => s + x.local.tokens, 0);
  result.costEstimateSuppressed = tokenTotal > 0 && unpricedTotal / tokenTotal > params.maxUnpricedShare;

  if (adopted.length === 0) {
    result.status = result.segments.length === 0 ? 'preparing' : 'difficult';
    result.statusReasons.push(result.segments.length === 0 ? 'delta_too_small_so_far' : 'no_usable_segments');
    return result;
  }
  const summarize = (pick: (s: Segment) => Range | null): Range | null => {
    const items = adopted.map((s) => ({ r: pick(s), w: s.deltaPct })).filter((x): x is { r: Range; w: number } => x.r != null);
    if (items.length === 0) return null;
    const mid = weightedQuantile(items.map((x) => ({ v: x.r.mid, w: x.w })), 0.5)!;
    const q1 = weightedQuantile(items.map((x) => ({ v: x.r.mid, w: x.w })), 0.25)!;
    const q3 = weightedQuantile(items.map((x) => ({ v: x.r.mid, w: x.w })), 0.75)!;
    const lowR = weightedQuantile(items.map((x) => ({ v: x.r.low, w: x.w })), 0.5)!;
    const highR = weightedQuantile(items.map((x) => ({ v: x.r.high, w: x.w })), 0.5)!;
    return { mid, low: Math.min(q1, lowR), high: Math.max(q3, highR) };
  };
  const tokens = summarize((s) => s.capacityTokens);
  const cost = result.costEstimateSuppressed ? null : summarize((s) => s.capacityCostNano);
  if (adopted.length < params.minSegments) {
    result.status = 'preparing';
    result.statusReasons.push('need_more_segments');
    result.reference = { capacityTokens: tokens, capacityCostNano: cost };
    return result;
  }
  result.status = 'ok';
  result.capacityTokens = tokens;
  result.capacityCostNano = cost;
  if (tokens && tokens.mid > 0) {
    const mids = adopted.map((s) => ({ v: s.capacityTokens!.mid, w: s.deltaPct }));
    result.spreadRatio = (weightedQuantile(mids, 0.75)! - weightedQuantile(mids, 0.25)!) / tokens.mid;
  }
  return result;
}

function buildSegment(
  a: QuotaObservation,
  b: QuotaObservation,
  local: LocalUsageFn,
  precision: number,
  exclusions: ExclusionReason[],
  params: EstimateParams,
): Segment {
  const p1 = a.usedPercent!;
  const p2 = b.usedPercent!;
  const delta = p2 - p1;
  const lu = local(a.observedAtMs, b.observedAtMs);
  const ex = [...exclusions];
  const warnings: WarningReason[] = [];
  if (b.observedAtMs - a.observedAtMs < params.minIntervalMs) warnings.push('short_interval');
  if (lu.tokens > 0 && lu.unpricedTokens / lu.tokens > params.maxUnpricedShare) warnings.push('unpriced_share_high');
  if (delta > 0 && precision / delta > 0.2) warnings.push('rounding_large');
  if (lu.mixedBillingTokens > 0) ex.push('mixed_billing');
  const valid = delta > 0 && ex.length === 0;
  if (valid && lu.tokens === 0) ex.push('no_local_usage');
  const ok = delta > 0 && lu.tokens > 0;
  return {
    startMs: a.observedAtMs,
    endMs: b.observedAtMs,
    p1,
    p2,
    deltaPct: delta,
    precision,
    local: lu,
    capacityTokens: ok ? rangeFrom(lu.tokens, delta, precision) : null,
    capacityCostNano: ok && lu.costNano > 0 ? rangeFrom(lu.costNano, delta, precision) : null,
    adopted: false,
    exclusions: ex,
    warnings,
  };
}

/** 重み付き分位点（外れ値に強いまとめ方）。 */
export function weightedQuantile(items: { v: number; w: number }[], q: number): number | null {
  const xs = items.filter((x) => Number.isFinite(x.v) && x.w > 0).sort((a, b) => a.v - b.v);
  if (xs.length === 0) return null;
  const total = xs.reduce((s, x) => s + x.w, 0);
  const target = q * total;
  let acc = 0;
  for (const x of xs) {
    acc += x.w;
    if (acc >= target) return x.v;
  }
  return xs[xs.length - 1]!.v;
}
