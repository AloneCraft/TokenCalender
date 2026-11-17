// サブスクの制限周期（リセットからリセットまで）を、公式の観測から組み立てる。
//
// 原則:
// - 周期の終わりは、サーバーが示したリセット日時（resets_at）を使う。
// - 周期の長さは、サーバーが示した枠の長さ（window_minutes。Claude は項目名 five_hour / seven_day）を使う。
// - 予定より早いリセット（特別なリセット）で新しいリセット日時が現れた場合、前の周期をそこで打ち切る。
// - 観測の無い期間の周期は「推定周期」とし、観測に基づく周期と区別する。
// - 「毎週同じ時刻」「購入日から7日」などは仮定しない。推定周期は観測済みの周期を窓の長さで延長しただけのもの。

import type { QuotaObservation } from '../model/types.ts';

export interface Cycle {
  startMs: number;
  endMs: number;
  /** observed = 観測された resets_at に基づく。extrapolated = 観測の無い期間を延長した推定 */
  basis: 'observed' | 'extrapolated';
  /** 次の周期の開始で早めに打ち切られた（特別なリセット等） */
  truncated: boolean;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  maxUsedPercent: number | null;
}

export interface WindowKeyParts {
  provider: string;
  accountKey: string | null;
  limitId: string;
  windowMinutes: number | null;
  scopeModels: string | null;
}

export function windowKey(w: WindowKeyParts): string {
  return [w.provider, w.accountKey ?? 'unknown', w.limitId, w.windowMinutes ?? 'x', w.scopeModels ?? 'all'].join('|');
}

export function parseWindowKey(key: string): WindowKeyParts {
  const [provider, account, limitId, minutes, scope] = key.split('|');
  return {
    provider: provider ?? '',
    accountKey: account && account !== 'unknown' ? account : null,
    limitId: limitId ?? '',
    windowMinutes: minutes && minutes !== 'x' ? Number(minutes) : null,
    scopeModels: scope && scope !== 'all' ? scope : null,
  };
}

/** resets_at の小さな揺れ（数分以内）は同じリセットとみなす。 */
const RESET_TOLERANCE_MS = 10 * 60 * 1000;

export function buildCycles(
  observations: QuotaObservation[],
  windowMinutes: number,
  opts: { extrapolateFromMs?: number; extrapolateToMs?: number } = {},
): Cycle[] {
  const W = windowMinutes * 60 * 1000;
  if (!(W > 0)) return [];
  const obs = observations.filter((o) => o.resetsAtMs != null).sort((a, b) => a.observedAtMs - b.observedAtMs);
  // リセット日時ごとにまとめる
  const groups: { resetsAt: number; obs: QuotaObservation[] }[] = [];
  for (const o of obs) {
    const r = o.resetsAtMs!;
    const g = groups.find((x) => Math.abs(x.resetsAt - r) <= RESET_TOLERANCE_MS);
    if (g) {
      g.obs.push(o);
      g.resetsAt = Math.max(g.resetsAt, r);
    } else groups.push({ resetsAt: r, obs: [o] });
  }
  groups.sort((a, b) => a.resetsAt - b.resetsAt);
  const cycles: Cycle[] = groups.map((g) => {
    const used = g.obs.map((o) => o.usedPercent).filter((v): v is number => v != null);
    return {
      startMs: g.resetsAt - W,
      endMs: g.resetsAt,
      basis: 'observed',
      truncated: false,
      firstObservedAt: g.obs[0]!.observedAtMs,
      lastObservedAt: g.obs[g.obs.length - 1]!.observedAtMs,
      maxUsedPercent: used.length ? Math.max(...used) : null,
    };
  });
  for (let i = 0; i + 1 < cycles.length; i++) {
    const a = cycles[i]!;
    const b = cycles[i + 1]!;
    if (b.startMs < a.endMs) {
      // 重なり: 後の周期の開始で前の周期を打ち切る（予定より早いリセット）
      a.endMs = Math.max(a.startMs, b.startMs);
      a.truncated = true;
    } else if (b.startMs > a.endMs && b.startMs - a.endMs < W / 7) {
      // 枠の長さに比べて短い隙間は、リセット時刻のずれとみなしてつなげる（週ごとに数分ずれることを実ログで確認）
      b.startMs = a.endMs;
    }
  }
  const real = cycles.filter((c) => c.endMs > c.startMs);
  if (real.length === 0) return [];
  const out: Cycle[] = [];
  // 観測より前の推定周期
  if (opts.extrapolateFromMs != null) {
    let s = real[0]!.startMs;
    const before: Cycle[] = [];
    while (s > opts.extrapolateFromMs) {
      before.unshift(extrapolated(s - W, s));
      s -= W;
    }
    out.push(...before);
  }
  for (let i = 0; i < real.length; i++) {
    const c = real[i]!;
    out.push(c);
    const next = real[i + 1];
    // 観測の間に空白がある場合（長く使わなかった等）、空白を推定周期で埋める
    if (next && next.startMs > c.endMs) {
      let s = c.endMs;
      while (s + W <= next.startMs) {
        out.push(extrapolated(s, s + W));
        s += W;
      }
      if (s < next.startMs) out.push({ ...extrapolated(s, next.startMs), truncated: true });
    }
  }
  if (opts.extrapolateToMs != null) {
    let s = real[real.length - 1]!.endMs;
    while (s < opts.extrapolateToMs) {
      out.push(extrapolated(s, s + W));
      s += W;
    }
  }
  return out;
}

function extrapolated(startMs: number, endMs: number): Cycle {
  return { startMs, endMs, basis: 'extrapolated', truncated: false, firstObservedAt: null, lastObservedAt: null, maxUsedPercent: null };
}

/** 時刻が属する周期の番号。無ければ -1。 */
export function cycleIndexAt(cycles: Cycle[], ts: number): number {
  let lo = 0;
  let hi = cycles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cycles[mid]!;
    if (ts < c.startMs) hi = mid - 1;
    else if (ts >= c.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}
