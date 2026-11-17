// 開発用: 同じ条件のカレンダーと時系列、元イベントの合計が一致するかを実データで確かめる。
// 使い方: node scripts/check-consistency.ts <DBのパス>

import { DateTime } from 'luxon';
import { openDatabase } from '../src/db/database.ts';
import { QueryService } from '../src/query/service.ts';
import type { CommonFilter } from '../src/shared/api.ts';

const db = openDatabase(process.argv[2]!, { readOnly: true });
const svc = new QueryService(db);
const zone = 'Asia/Tokyo';
const f: CommonFilter = { provider: 'codex', account: 'all', models: [], projects: [], billingModes: [], includeSidechain: true, zone, pricingMode: 'historical' };
const q = svc.quotaOverview();
console.log('windows', q.windows.map((w) => `${w.key} n=${w.count}`));
const week = q.windows.find((w) => w.provider === 'codex' && w.windowMinutes === 10080)?.key ?? null;
for (const measure of ['tokens', 'cost'] as const) {
  const cal = svc.calendar({ ...f, year: 2026, month: 11, weekStart: 1, measure, dimension: 'provider', window: week });
  const d10 = cal.cells.find((c) => c.date === '2026-11-10')!;
  const tl = svc.timeline({ ...f, granularity: { kind: 'days', n: 1, m: 30 }, measure, dimension: 'provider', window: week, overlayWindow: null, weekStart: 1 });
  const t10 = tl.buckets.find((b) => DateTime.fromMillis(b.startMs, { zone }).toISODate() === '2026-11-10')!;
  const from = DateTime.fromISO('2026-11-10', { zone }).toMillis();
  const raw = db
    .prepare("SELECT SUM(total) t, SUM(CASE WHEN priced = 1 THEN cost_nano ELSE 0 END) c FROM usage_events WHERE provider = 'codex' AND ts >= ? AND ts < ?")
    .get(from, from + 86400000) as { t: number; c: number };
  console.log(measure, { calendar: d10.total, timeline: t10.total, raw: measure === 'cost' ? raw.c : raw.t, calWindow: cal.windowLabel, cycleNote: cal.cycleNote, cum: d10.cumulative });
}
