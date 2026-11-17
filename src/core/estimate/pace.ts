// 残量とペース。公式値・補助推定・予測を別々の項目で返す（黙って置き換えない）。

import type { QuotaObservation } from '../model/types.ts';
import type { Range } from './estimator.ts';

export interface PaceInfo {
  /** 公式の値（最後の観測） */
  official: {
    usedPercent: number;
    remainingPercent: number;
    observedAtMs: number;
    ageMs: number;
    stale: boolean;
    source: QuotaObservation['source'];
    resetsAtMs: number | null;
  } | null;
  /** リセット予定時刻を過ぎたが、新しい公式の観測はまだ無い */
  resetTimePassedUnconfirmed: boolean;
  timeToResetMs: number | null;
  /** 最後の公式観測以降のローカル利用から求めた補助推定（推定容量が必要） */
  auxiliary: { addedPercent: Range; usedPercent: Range; localTokensSince: number } | null;
  /** 同じ周期内の観測から求めた消費ペース（ポイント/時） */
  burnRatePctPerHour: number | null;
  /** 現在のペースでの枯渇予測時刻（幅つき）。枯渇しない見込みなら null */
  projectedExhaustion: { earliestMs: number; latestMs: number } | null;
  /** リセットまで持つ見込みか（予測の幅を考えて判定。判定できない場合は unknown） */
  outlook: 'lasts' | 'runs_out' | 'borderline' | 'unknown';
  /** リセットまで均等に使う場合の参考ペース（ポイント/時） */
  evenPacePctPerHour: number | null;
}

export const STALE_AFTER_MS = 30 * 60 * 1000;

export function computePace(
  sameCycleObs: QuotaObservation[],
  nowMs: number,
  capacityTokens: Range | null,
  localTokensSinceLast: number,
): PaceInfo {
  const obs = sameCycleObs.filter((o) => o.usedPercent != null).sort((a, b) => a.observedAtMs - b.observedAtMs);
  const last = obs[obs.length - 1];
  const info: PaceInfo = {
    official: null,
    resetTimePassedUnconfirmed: false,
    timeToResetMs: null,
    auxiliary: null,
    burnRatePctPerHour: null,
    projectedExhaustion: null,
    outlook: 'unknown',
    evenPacePctPerHour: null,
  };
  if (!last) return info;
  const used = last.usedPercent!;
  info.official = {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    observedAtMs: last.observedAtMs,
    ageMs: nowMs - last.observedAtMs,
    stale: nowMs - last.observedAtMs > STALE_AFTER_MS,
    source: last.source,
    resetsAtMs: last.resetsAtMs,
  };
  if (last.resetsAtMs != null) {
    info.timeToResetMs = last.resetsAtMs - nowMs;
    if (info.timeToResetMs <= 0) {
      info.resetTimePassedUnconfirmed = true;
      return info;
    }
  }
  if (capacityTokens && capacityTokens.mid > 0) {
    const add = (cap: number) => (localTokensSinceLast * 100) / cap;
    const added: Range = { mid: add(capacityTokens.mid), low: add(capacityTokens.high), high: add(capacityTokens.low) };
    info.auxiliary = {
      addedPercent: added,
      usedPercent: { mid: used + added.mid, low: used + added.low, high: used + added.high },
      localTokensSince: localTokensSinceLast,
    };
  }
  // 直近 24 時間の観測からペースを求める
  const since = nowMs - 24 * 3600 * 1000;
  const recent = obs.filter((o) => o.observedAtMs >= since);
  const first = recent[0];
  if (first && last.observedAtMs - first.observedAtMs >= 30 * 60 * 1000) {
    const hours = (last.observedAtMs - first.observedAtMs) / 3600000;
    const rate = (used - first.usedPercent!) / hours;
    info.burnRatePctPerHour = rate;
    const prec = Math.max(first.precision, last.precision);
    const rateLow = Math.max(0, (used - first.usedPercent! - prec) / hours);
    const rateHigh = (used - first.usedPercent! + prec) / hours;
    const remaining = Math.max(0, 100 - used);
    if (rateHigh > 0) {
      const earliest = last.observedAtMs + (remaining / rateHigh) * 3600000;
      const latest = rateLow > 0 ? last.observedAtMs + (remaining / rateLow) * 3600000 : Number.POSITIVE_INFINITY;
      info.projectedExhaustion = { earliestMs: earliest, latestMs: latest };
      if (last.resetsAtMs != null) {
        if (latest < last.resetsAtMs) info.outlook = 'runs_out';
        else if (earliest >= last.resetsAtMs) info.outlook = 'lasts';
        else info.outlook = 'borderline';
      }
    } else if (last.resetsAtMs != null) {
      info.outlook = 'lasts';
    }
  }
  if (info.timeToResetMs != null && info.timeToResetMs > 0) {
    info.evenPacePctPerHour = Math.max(0, 100 - used) / (info.timeToResetMs / 3600000);
  }
  return info;
}
