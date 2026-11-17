// デモ表示用のデータを、実データとは別の DB に作る。
// 値は決まった乱数で作る架空の数で、実在のプランの上限や実際の使用量ではない。

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

export function ensureDemoDb(path: string, nowMs = Date.now()): void {
  if (existsSync(path)) return;
  const db = openDatabase(path);
  const repo = new WriteRepo(db);
  const r = rng(42);
  const H = 3600000;
  const events: UsageEvent[] = [];
  const quota: QuotaObservation[] = [];
  const start = nowMs - 75 * 24 * H;
  // 週枠のリセット: 7日ごと（デモ用の架空の周期）
  const firstReset = Math.floor(start / (7 * 24 * H)) * 7 * 24 * H + 3 * 24 * H;
  const capacityTokens = 900_000_000; // 架空の週枠全体
  let used = 0;
  let resetAt = firstReset;
  while (resetAt < start) resetAt += 7 * 24 * H;
  for (let t = start; t < nowMs; t += H) {
    if (t >= resetAt) {
      used = 0;
      resetAt += 7 * 24 * H;
    }
    const hour = new Date(t).getUTCHours();
    const active = hour >= 0 && hour <= 14 && r() < 0.55;
    if (!active) continue;
    for (const provider of ['claude', 'codex'] as const) {
      const n = 1 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        const ts = t + Math.floor(r() * H);
        const input = Math.floor(200 + r() * 3000);
        const cacheRead = Math.floor(r() * 80000);
        const cacheWrite = provider === 'claude' ? Math.floor(r() * 6000) : 0;
        const output = Math.floor(100 + r() * 4000);
        const model = provider === 'claude' ? (r() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5-5') : r() < 0.8 ? 'gpt-6.1-sol' : 'codex-auto-review';
        const session = `demo-${provider}-${Math.floor((t - start) / (6 * H))}`;
        events.push({
          eventKey: `demo:${provider}:${ts}:${i}`,
          provider,
          sourceId: 'demo',
          accountKey: null,
          sessionId: session,
          parentSessionId: null,
          agentId: null,
          isSidechain: false,
          turnId: `${session}-turn-${Math.floor((ts - t) / (15 * 60000))}`,
          requestId: null,
          messageId: null,
          tsMs: ts,
          model,
          effort: 'medium',
          speed: 'standard',
          serviceTier: 'standard',
          inferenceGeo: 'global',
          projectKey: provider === 'claude' ? 'demo-a' : 'demo-b',
          projectLabel: provider === 'claude' ? 'demo-project-a' : 'demo-project-b',
          billingMode: 'subscription',
          tokens: {
            inputUncached: input,
            cacheRead,
            cacheWrite,
            cacheWrite5m: provider === 'claude' ? cacheWrite : null,
            cacheWrite1h: provider === 'claude' ? 0 : null,
            output,
            reasoning: Math.floor(output * 0.3),
            unclassified: 0,
            providerTotal: null,
          },
          finality: 1,
          rank: 1e15,
          flags: [],
          origin: { fileKey: 'demo', offset: 0, parserVersion: 'demo' },
        });
        if (provider === 'codex') used += input + cacheRead + output;
      }
    }
    if (r() < 0.6) {
      quota.push({
        obsKey: `demo-q:${t}`,
        provider: 'codex',
        accountKey: null,
        planType: 'demo',
        limitId: 'codex',
        windowKind: '7d',
        windowMinutes: 10080,
        scopeModels: null,
        observedAtMs: t + 30 * 60000,
        usedPercent: Math.min(100, Math.floor((used / capacityTokens) * 100)),
        resetsAtMs: resetAt,
        source: 'codex_log',
        precision: 1,
        flags: ['demo'],
        originRef: null,
      });
    }
  }
  inTransaction(db, () => {
    repo.upsertEvents(events, nowMs);
    repo.insertQuota(quota, nowMs, 'demo');
  });
  db.close();
}
