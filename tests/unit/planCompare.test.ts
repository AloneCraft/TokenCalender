import { describe, expect, it } from 'vitest';
import { WriteRepo } from '../../src/db/writeRepo.ts';
import { comparePlans } from '../../src/query/plan.ts';
import type { QuotaObservation, UsageEvent } from '../../src/core/model/types.ts';
import { zeroTokens } from '../../src/core/model/tokens.ts';
import { memoryDb } from './helpers.ts';

const H = 3600000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 5, 1); // 2026-06-01（月曜 UTC 0 時）

function ev(i: number, ts: number, tokens: number, model = 'gpt-test'): UsageEvent {
  return {
    eventKey: `e${i}`, provider: 'codex', sourceId: 's', accountKey: null, sessionId: `s${i}`, parentSessionId: null, agentId: null, isSidechain: false,
    turnId: `t${i}`, requestId: null, messageId: null, tsMs: ts, model, effort: 'high', speed: null, serviceTier: null, inferenceGeo: null,
    projectKey: 'p', projectLabel: 'p', billingMode: 'subscription', tokens: { ...zeroTokens(), inputUncached: tokens }, finality: 1, rank: 1, flags: [],
    origin: { fileKey: 'f', offset: i, parserVersion: 'test' },
  };
}
function ob(n: number, ts: number, plan: string, used: number, resets: number): QuotaObservation {
  return {
    obsKey: `o${n}`, provider: 'codex', accountKey: null, planType: plan, limitId: 'codex', windowKind: '7d', windowMinutes: 10080, scopeModels: null,
    observedAtMs: ts, usedPercent: used, resetsAtMs: resets, source: 'codex_log', precision: 1, flags: [], originRef: null,
  };
}

/** 1% を使うのに必要なトークン量が、プランごとに決まっている世界を作る。 */
// 消費率の計算は期間ごとに短時間キャッシュされるため、テストごとに別の期間（開始日をずらす）で作る
function world(tokensPerPct: Record<string, number>, shiftDays = 0) {
  const db = memoryDb();
  const repo = new WriteRepo(db);
  const events: UsageEvent[] = [];
  const quota: QuotaObservation[] = [];
  let n = 0;
  let e = 0;
  const plans = Object.keys(tokensPerPct);
  plans.forEach((plan, pi) => {
    const start = T0 + shiftDays * DAY + pi * 21 * DAY; // 各プラン3週間
    for (let week = 0; week < 3; week++) {
      const wStart = start + week * 7 * DAY;
      const resets = wStart + 7 * DAY;
      let used = 0;
      for (let step = 0; step < 6; step++) {
        const t = wStart + step * DAY + 2 * H;
        // 観測 → 使う → 観測。使った分だけ増える（4% ずつ）
        quota.push(ob(n++, t, plan, used, resets));
        events.push(ev(e++, t + H, 4 * tokensPerPct[plan]!));
        used += 4;
        quota.push(ob(n++, t + 2 * H, plan, used, resets));
        quota.push(ob(n++, t + 3 * H, plan, used, resets));
      }
    }
  });
  repo.upsertEvents(events, 1);
  repo.insertQuota(quota, 1);
  return { db, now: T0 + shiftDays * DAY + plans.length * 21 * DAY };
}

describe('プラン間の消費の重さの比較（公称倍率の確かめ）', () => {
  it('同じモデルで、1% あたりのトークン量が20倍のプランは、比が約20倍になる', () => {
    const { db, now } = world({ plus: 1_000_000, pro: 20_000_000 });
    const v = comparePlans(db, 'codex', now);
    expect(v.unavailable).toBeNull();
    expect(v.basePlan).toBe('plus');
    const s = v.summary.find((x) => x.plan === 'pro')!;
    expect(s.best.mid).toBeGreaterThan(17);
    expect(s.best.mid).toBeLessThan(23);
    expect(s.nominal).toBe(20);
  });
  it('10倍なら約10倍と出る（公称20倍と区別できる）', () => {
    const { db, now } = world({ plus: 1_000_000, pro: 10_000_000 }, 100);
    const s = comparePlans(db, 'codex', now).summary.find((x) => x.plan === 'pro')!;
    expect(s.best.mid).toBeGreaterThan(8.5);
    expect(s.best.mid).toBeLessThan(11.5);
  });
  it('プランが1つだけなら比べられない', () => {
    const { db, now } = world({ plus: 1_000_000 }, 200);
    expect(comparePlans(db, 'codex', now).unavailable).toBe('one_plan');
  });
});
