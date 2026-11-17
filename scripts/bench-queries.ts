// 開発用: 実データの DB で、画面の主な問い合わせの所要時間を測る。
// 使い方: node scripts/bench-queries.ts <DBのパス>

import { openDatabase } from '../src/db/database.ts';
import { QueryService } from '../src/query/service.ts';
import { handleCommand } from '../src/query/commands.ts';
import { WriteRepo } from '../src/db/writeRepo.ts';
import type { CommonFilter } from '../src/shared/api.ts';

const db = openDatabase(process.argv[2]!);
const svc = new QueryService(db);
const zone = 'Asia/Tokyo';
const now = new Date();
const f: CommonFilter = { provider: 'both', account: 'all', models: [], projects: [], billingModes: [], includeSidechain: true, zone, pricingMode: 'historical' };
const time = <T>(name: string, fn: () => T): T => {
  const t0 = performance.now();
  const r = fn();
  console.log(`${name}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
};
time('getStatus', () => handleCommand('getStatus', null, { db, service: svc, repo: new WriteRepo(db), demoDbPath: '' }));
const q = time('quotaOverview', () => svc.quotaOverview());
const week = q.windows.find((w) => w.provider === 'codex' && w.windowMinutes === 10080)?.key ?? null;
time('calendar(both, tokens)', () => svc.calendar({ ...f, year: now.getFullYear(), month: now.getMonth() + 1, weekStart: 1, measure: 'tokens', dimension: 'provider', window: null }));
time('calendar(codex, cumulative)', () =>
  svc.calendar({ ...f, provider: 'codex', year: now.getFullYear(), month: now.getMonth() + 1, weekStart: 1, measure: 'cost', dimension: 'none', window: week }),
);
time('recent', () => svc.recent({ zone, pricingMode: 'historical', limit: 4 }));
if (week) time('estimate(codex week)', () => svc.estimate({ windowKey: week, pricingMode: 'historical' }));
time('timeline(90d)', () => svc.timeline({ ...f, provider: 'codex', granularity: { kind: 'days', n: 1, m: 90 }, measure: 'tokens', dimension: 'none', window: week, overlayWindow: null, weekStart: 1 }));
