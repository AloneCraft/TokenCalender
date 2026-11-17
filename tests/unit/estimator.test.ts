import { describe, expect, it } from 'vitest';
import { estimateCapacity, type LocalUsage } from '../../src/core/estimate/estimator.ts';
import { computePace } from '../../src/core/estimate/pace.ts';
import { buildCycles } from '../../src/core/quota/cycles.ts';
import type { QuotaObservation } from '../../src/core/model/types.ts';

const H = 3600000;
const base = Date.parse('2026-11-10T00:00:00Z');
const reset = base + 5 * 24 * H;

function o(hour: number, used: number | null, extra: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    obsKey: `o${hour}-${used}-${extra.windowMinutes ?? 10080}`,
    provider: 'codex',
    accountKey: null,
    planType: 'pro',
    limitId: 'codex',
    windowKind: '7d',
    windowMinutes: 10080,
    scopeModels: null,
    observedAtMs: base + hour * H,
    usedPercent: used,
    resetsAtMs: reset,
    source: 'codex_log',
    precision: 1,
    flags: [],
    originRef: null,
    ...extra,
  };
}

/** 1時間あたりのローカル使用量（トークン・金額）を与えて、区間の使用量を返す関数を作る */
function localFrom(perHour: (h: number) => { tokens: number; usd: number }): (a: number, b: number) => LocalUsage {
  return (a, b) => {
    let tokens = 0;
    let cost = 0;
    for (let t = a; t < b; t += H) {
      const v = perHour(Math.floor((t - base) / H));
      tokens += v.tokens;
      cost += v.usd * 1e9;
    }
    return { tokens, costNano: Math.round(cost), unpricedTokens: 0, events: tokens > 0 ? 1 : 0, mixedBillingTokens: 0 };
  };
}

describe('I: 基本の推定', () => {
  it('公式利用率 20 → 30、換算額 12 ドルなら、条件付きの参考容量は 120 ドル', () => {
    const observations = [o(0, 20), o(10, 30)];
    const cycles = buildCycles(observations, 10080);
    const local = localFrom(() => ({ tokens: 100_000, usd: 1.2 }));
    const r = estimateCapacity(observations, cycles, local);
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    expect(s.deltaPct).toBe(10);
    expect(s.local.costNano).toBe(12e9);
    expect(s.capacityCostNano!.mid / 1e9).toBeCloseTo(120, 6);
    // 整数丸め（±1 ポイント）を考えた幅
    expect(s.capacityCostNano!.low / 1e9).toBeCloseTo(12 * 100 / 11, 6);
    expect(s.capacityCostNano!.high / 1e9).toBeCloseTo(12 * 100 / 9, 6);
    // 1区間だけなので「推定あり」ではなく参考値（推定準備中）
    expect(r.status).toBe('preparing');
    expect(r.reference!.capacityCostNano!.mid / 1e9).toBeCloseTo(120, 6);
    expect(r.capacityCostNano).toBeNull();
  });

  it('条件のよい区間が複数あれば、重み付き中央値で推定する', () => {
    const observations = [o(0, 20), o(10, 30), o(20, 40), o(30, 50)];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), localFrom(() => ({ tokens: 1000, usd: 1.2 })));
    expect(r.status).toBe('ok');
    expect(r.adoptedCount).toBe(3);
    expect(r.capacityCostNano!.mid / 1e9).toBeCloseTo(120, 6);
  });
});

describe('J: 除外・警告・推定抑制', () => {
  const steady = localFrom(() => ({ tokens: 1000, usd: 1.2 }));

  it('リセットをまたぐ区間は使わない', () => {
    const observations = [o(0, 80), o(30, 90), o(130, 5, { resetsAtMs: reset + 7 * 24 * H })];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), steady);
    expect(r.segments.some((s) => s.exclusions.includes('crosses_reset'))).toBe(true);
    expect(r.segments.filter((s) => s.adopted).every((s) => !s.exclusions.length)).toBe(true);
  });

  it('プランが変わった区間は使わない', () => {
    const observations = [o(0, 20), o(10, 30, { planType: 'plus' })];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), steady);
    expect(r.segments[0]!.exclusions).toContain('plan_changed');
    expect(r.adoptedCount).toBe(0);
  });

  it('丸め誤差に対して小さすぎる変化では区間を作らない', () => {
    const observations = [o(0, 20), o(10, 21), o(20, 22)];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), steady);
    expect(r.segments).toHaveLength(0);
    expect(r.status).toBe('preparing');
  });

  it('利用率の減少と 100% 張り付きは使わない', () => {
    const observations = [o(0, 90), o(10, 80), o(20, 95), o(30, 100), o(40, 100)];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), steady);
    expect(r.segments.some((s) => s.exclusions.includes('percent_decreased'))).toBe(true);
    expect(r.segments.some((s) => s.exclusions.includes('saturated'))).toBe(true);
  });

  it('端末上の利用がないのに利用率が増えた（別端末など）場合は、推定を控えて理由を示す', () => {
    const observations = [o(0, 10), o(10, 20), o(20, 30), o(30, 40)];
    // 10〜30時は端末上の利用がない（未観測の利用）
    const local = localFrom((h) => (h < 10 ? { tokens: 1000, usd: 1.2 } : { tokens: 0, usd: 0 }));
    const r = estimateCapacity(observations, buildCycles(observations, 10080), local);
    expect(r.status).toBe('difficult');
    expect(r.statusReasons).toContain('unobserved_usage_suspected');
    expect(r.segments.filter((s) => s.exclusions.includes('no_local_usage'))).toHaveLength(2);
  });

  it('一部の区間だけ容量が極端に小さい場合は「未観測の利用の疑い」として除外し、黙って消さない', () => {
    const observations = [o(0, 10), o(10, 20), o(20, 30), o(30, 40), o(40, 50), o(50, 60)];
    // 30〜40時だけ、別端末の利用で利用率が増えた（端末上は少ない）
    const local = localFrom((h) => (h >= 30 && h < 40 ? { tokens: 200, usd: 0.24 } : { tokens: 1000, usd: 1.2 }));
    const r = estimateCapacity(observations, buildCycles(observations, 10080), local);
    const flagged = r.segments.filter((s) => s.exclusions.includes('possible_unobserved_usage'));
    expect(flagged).toHaveLength(1);
    expect(r.status).toBe('ok');
    expect(r.capacityCostNano!.mid / 1e9).toBeCloseTo(120, 6);
  });

  it('API 利用や追加課金が混在する区間は使わない', () => {
    const observations = [o(0, 20), o(10, 30)];
    const local = (a: number, b: number) => ({ ...steady(a, b), mixedBillingTokens: 50 });
    const r = estimateCapacity(observations, buildCycles(observations, 10080), local);
    expect(r.segments[0]!.exclusions).toContain('mixed_billing');
  });

  it('未換算のトークンが多い場合は金額の推定を控え、トークンの推定は残す', () => {
    const observations = [o(0, 20), o(10, 30), o(20, 40)];
    const local = (a: number, b: number) => {
      const v = steady(a, b);
      return { ...v, unpricedTokens: v.tokens * 0.5 };
    };
    const r = estimateCapacity(observations, buildCycles(observations, 10080), local);
    expect(r.costEstimateSuppressed).toBe(true);
    expect(r.capacityCostNano).toBeNull();
    expect(r.capacityTokens).not.toBeNull();
  });
});

describe('K: 重なる枠を混同しない', () => {
  it('5時間枠 100%・週枠 35% を、週枠も 100% と誤認しない', () => {
    const fiveH = [o(0, 60, { windowKind: '5h', windowMinutes: 300, resetsAtMs: base + 2 * H }), o(1, 100, { windowKind: '5h', windowMinutes: 300, resetsAtMs: base + 2 * H })];
    const weekly = [o(0, 30), o(1, 35)];
    const now = base + 1 * H + 60000;
    const paceWeekly = computePace(weekly, now, null, 0);
    const pace5h = computePace(fiveH, now, null, 0);
    expect(paceWeekly.official!.usedPercent).toBe(35);
    expect(paceWeekly.official!.remainingPercent).toBe(65);
    expect(pace5h.official!.usedPercent).toBe(100);
    // 枠ごとに周期を作り、割合は足し合わせない
    expect(buildCycles(fiveH, 300)[0]!.endMs - buildCycles(fiveH, 300)[0]!.startMs).toBe(5 * H);
    expect(buildCycles(weekly, 10080)[0]!.endMs - buildCycles(weekly, 10080)[0]!.startMs).toBe(7 * 24 * H);
  });
});

describe('L: 公式値の欠損と古さ', () => {
  it('利用率が欠けた観測は 0% として扱わず、推定にも使わない', () => {
    const observations = [o(0, 20), o(5, null), o(10, 30)];
    const r = estimateCapacity(observations, buildCycles(observations, 10080), localFrom(() => ({ tokens: 10, usd: 1.2 })));
    expect(r.observationCount).toBe(2);
    expect(r.segments[0]!.p1).toBe(20);
  });

  it('古い観測は取得時刻と古さを返し、リセット予定時刻を過ぎたことと 0% の観測を区別する', () => {
    const p = computePace([o(0, 50)], base + 2 * H, null, 0);
    expect(p.official!.stale).toBe(true);
    expect(p.official!.ageMs).toBe(2 * H);
    const after = computePace([o(0, 50)], reset + H, null, 0);
    expect(after.resetTimePassedUnconfirmed).toBe(true);
    expect(after.official!.usedPercent).toBe(50); // 0% に置き換えない
  });

  it('補助推定は公式値と別の項目で返す', () => {
    const p = computePace([o(0, 50)], base + H, { mid: 100000, low: 90000, high: 110000 }, 5000);
    expect(p.official!.usedPercent).toBe(50);
    expect(p.auxiliary!.addedPercent.mid).toBeCloseTo(5, 6);
    expect(p.auxiliary!.usedPercent.mid).toBeCloseTo(55, 6);
  });

  it('現在のペースで尽きるかどうかを幅つきで判定する', () => {
    const observations = [o(0, 40), o(10, 60)]; // 2 ポイント/時、残り 40 ポイント → 約 20 時間で尽きる
    const p = computePace(observations, base + 10 * H, null, 0);
    expect(p.burnRatePctPerHour).toBeCloseTo(2, 6);
    expect(p.outlook).toBe('runs_out'); // リセットまで約 110 時間
    expect(p.evenPacePctPerHour).toBeCloseTo(40 / 110, 3);
  });
});
