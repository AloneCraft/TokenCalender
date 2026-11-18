// デモ表示用のデータを、実データとは別の DB に作る。
// 値は決まった乱数で作る架空の数で、実在のプランの上限や実際の使用量ではない。
// 説明書の画面写真にも使うため、利用枠の計画の各機能（消費率・予測・予算）が働く程度の量と形にしている:
// - Codex は1回の依頼ごとに、組み合わせ（モデル×エフォート）に応じて架空の週枠を消費する
// - 時間帯ごとに主に使う組み合わせを決める（組み合わせ別の消費率を推定できるようにするため）
// - 週の途中で上限に達する週もある、よく使う利用者を想定する。上限に達したら次のリセットまで Codex を使わない

import { existsSync } from 'node:fs';
import { openDatabase, inTransaction } from '../db/database.ts';
import { WriteRepo } from '../db/writeRepo.ts';
import type { QuotaObservation, UsageEvent } from '../core/model/types.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 架空の組み合わせ: 1回あたりの消費（ポイント）と、1回あたりのトークンの目安 */
const DEMO_GROUPS = [
  // 1週間でおよそ 85〜120 ポイント使う量（週によっては途中で上限に達する）
  { model: 'gpt-6.1-sol', effort: 'medium', pct: 0.05, cache: 400_000, input: 12_000, output: 5_000, turnsPerHour: [8, 16] },
  { model: 'gpt-6.1-sol', effort: 'high', pct: 0.12, cache: 900_000, input: 20_000, output: 9_000, turnsPerHour: [6, 12] },
  { model: 'gpt-6-astra', effort: 'ultra', pct: 1.5, cache: 1_100_000, input: 30_000, output: 25_000, turnsPerHour: [1, 4] },
] as const;

export function ensureDemoDb(path: string, nowMs = Date.now()): void {
  if (existsSync(path)) return;
  const db = openDatabase(path);
  const repo = new WriteRepo(db);
  const r = rng(42);
  const H = 3600000;
  const D = 24 * H;
  const events: UsageEvent[] = [];
  const quota: QuotaObservation[] = [];
  const start = Math.floor((nowMs - 75 * D) / H) * H;
  // 週枠のリセット: 7日ごと（デモ用の架空の周期。今からおよそ4日後にリセットが来るようにずらす）
  let resetAt = nowMs + 4 * D - 3 * H;
  while (resetAt - 7 * D > start) resetAt -= 7 * D;
  let used = 0;
  let weekIntensity = 0.8 + r() * 0.6;

  const pushEvent = (provider: 'claude' | 'codex', ts: number, i: number, session: string, turn: string, model: string, effort: string, t: { input: number; cache: number; cacheWrite: number; output: number }) => {
    events.push({
      eventKey: `demo:${provider}:${ts}:${i}`,
      provider,
      sourceId: 'demo',
      accountKey: null,
      sessionId: session,
      parentSessionId: null,
      agentId: null,
      isSidechain: false,
      turnId: turn,
      requestId: null,
      messageId: null,
      tsMs: ts,
      model,
      effort,
      speed: 'standard',
      serviceTier: 'standard',
      inferenceGeo: 'global',
      projectKey: provider === 'claude' ? 'demo-a' : 'demo-b',
      projectLabel: provider === 'claude' ? 'demo-project-a' : 'demo-project-b',
      billingMode: 'subscription',
      tokens: {
        inputUncached: t.input,
        cacheRead: t.cache,
        cacheWrite: t.cacheWrite,
        cacheWrite5m: provider === 'claude' ? t.cacheWrite : null,
        cacheWrite1h: provider === 'claude' ? 0 : null,
        output: t.output,
        reasoning: Math.floor(t.output * 0.3),
        unclassified: 0,
        providerTotal: null,
      },
      finality: 1,
      rank: 1e15,
      flags: [],
      origin: { fileKey: 'demo', offset: 0, parserVersion: 'demo' },
    });
  };

  const observe = (at: number) => {
    quota.push({
      obsKey: `demo-q:${at}`,
      provider: 'codex',
      accountKey: null,
      planType: 'demo',
      limitId: 'codex',
      windowKind: '7d',
      windowMinutes: 10080,
      scopeModels: null,
      observedAtMs: at,
      usedPercent: Math.min(100, Math.floor(used)),
      resetsAtMs: resetAt,
      source: 'codex_log',
      precision: 1,
      flags: ['demo'],
      originRef: null,
    });
  };

  let n = 0;
  for (let t = start; t < nowMs; t += H) {
    if (t >= resetAt) {
      used = 0;
      resetAt += 7 * D;
      weekIntensity = 0.8 + r() * 0.6;
    }
    const hour = new Date(t).getUTCHours(); // 0〜14時（UTC）＝日本時間の 9〜23時に作業する想定
    const weekday = new Date(t).getUTCDay();
    const dayFactor = weekday === 0 ? 0.4 : weekday === 6 ? 0.7 : 1;
    if (!(hour <= 14 && r() < 0.75 * dayFactor)) continue;
    // Claude: 公式の利用率は無い（ログに記録されないため）。使用量だけ作る
    const cn = 1 + Math.floor(r() * 5);
    for (let i = 0; i < cn; i++) {
      const ts = t + Math.floor(r() * H);
      if (ts >= nowMs) continue;
      const session = `demo-claude-${Math.floor((t - start) / (6 * H))}`;
      pushEvent('claude', ts, n++, session, `${session}-turn-${Math.floor((ts - t) / (15 * 60000))}`, r() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', 'medium', {
        input: Math.floor(200 + r() * 3000),
        cache: Math.floor(r() * 80000),
        cacheWrite: Math.floor(r() * 6000),
        output: Math.floor(100 + r() * 4000),
      });
    }
    // Codex: 上限に達していたら次のリセットまで使わない
    if (used >= 100) continue;
    // この時間に主に使う組み合わせ（ultra は時々だけ）
    const pick = r();
    const g = pick < 0.12 ? DEMO_GROUPS[2] : pick < 0.55 ? DEMO_GROUPS[1] : DEMO_GROUPS[0];
    const turns = Math.round((g.turnsPerHour[0] + r() * (g.turnsPerHour[1] - g.turnsPerHour[0])) * weekIntensity);
    const session = `demo-codex-${Math.floor((t - start) / (3 * H))}`;
    for (let i = 0; i < turns; i++) {
      const ts = t + Math.floor(((i + r()) / Math.max(1, turns)) * H);
      if (ts >= nowMs || used >= 100) break;
      const k = 0.7 + r() * 0.6;
      pushEvent('codex', ts, n++, session, `${session}-t${ts}`, g.model, g.effort, {
        input: Math.floor(g.input * k),
        cache: Math.floor(g.cache * k),
        cacheWrite: 0,
        output: Math.floor(g.output * k),
      });
      used += g.pct * k;
      // 公式の値は時々報告される（同じ値の繰り返しは保存時に間引かれる）
      if (r() < 0.5) observe(ts + 1000);
    }
    observe(Math.min(nowMs - 60000, t + H - 60000));
  }
  // 直前の公式値（古い値にならないように）
  observe(nowMs - 5 * 60000);
  inTransaction(db, () => {
    repo.upsertEvents(events, nowMs);
    repo.insertQuota(quota, nowMs, 'demo');
  });
  db.close();
}
