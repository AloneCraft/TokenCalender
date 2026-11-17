import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { QueryService } from '../../src/query/service.ts';
import { WriteRepo } from '../../src/db/writeRepo.ts';
import type { QuotaObservation, UsageEvent } from '../../src/core/model/types.ts';
import { zeroTokens } from '../../src/core/model/tokens.ts';
import { windowKey } from '../../src/core/quota/cycles.ts';
import { memoryDb } from './helpers.ts';
import type { CommonFilter } from '../../src/shared/api.ts';

const Z = 'Asia/Tokyo';
const NOW = DateTime.fromISO('2026-11-20T12:00', { zone: Z }).toMillis();

function ev(key: string, iso: string, tokens: number, extra: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventKey: key,
    provider: 'codex',
    sourceId: 's',
    accountKey: null,
    sessionId: 'sess',
    parentSessionId: null,
    agentId: null,
    isSidechain: false,
    turnId: 't',
    requestId: null,
    messageId: null,
    tsMs: DateTime.fromISO(iso, { zone: Z }).toMillis(),
    model: 'gpt-6.1-sol',
    effort: null,
    speed: null,
    serviceTier: null,
    inferenceGeo: null,
    projectKey: 'p',
    projectLabel: 'proj',
    billingMode: 'subscription',
    tokens: { ...zeroTokens(), inputUncached: tokens },
    finality: 1,
    rank: 1,
    flags: [],
    origin: { fileKey: 'f', offset: 0, parserVersion: 'test' },
    ...extra,
  };
}

function obs(iso: string, used: number, resetsIso: string): QuotaObservation {
  return {
    obsKey: `o-${iso}`,
    provider: 'codex',
    accountKey: null,
    planType: 'pro',
    limitId: 'codex',
    windowKind: '7d',
    windowMinutes: 10080,
    scopeModels: null,
    observedAtMs: DateTime.fromISO(iso, { zone: Z }).toMillis(),
    usedPercent: used,
    resetsAtMs: DateTime.fromISO(resetsIso, { zone: Z }).toMillis(),
    source: 'codex_log',
    precision: 1,
    flags: [],
    originRef: null,
  };
}

const filter: CommonFilter = { provider: 'codex', account: 'all', models: [], projects: [], billingModes: [], includeSidechain: true, zone: Z, pricingMode: 'historical' };

function setup() {
  const db = memoryDb();
  const repo = new WriteRepo(db);
  repo.upsertEvents(
    [
      ev('a', '2026-11-02T10:00', 10),
      ev('b', '2026-11-03T10:00', 20),
      ev('c', '2026-11-04T10:00', 15),
      ev('d', '2026-11-05T08:00', 10),
      ev('e', '2026-11-05T15:00', 5),
      ev('f', '2026-11-06T01:30', 7, { billingMode: 'api' }),
      ev('g', '2026-11-06T02:00', 3, { billingMode: 'unknown', model: 'mystery-model' }),
    ],
    1,
  );
  // 週枠: 11/5 12:00 にリセット
  repo.insertQuota([obs('2026-11-03T12:00', 20, '2026-11-05T12:00'), obs('2026-11-06T12:00', 5, '2026-11-12T12:00')], 1);
  return { db, svc: new QueryService(db, { now: () => NOW }) };
}

describe('Q: 日別・週別・5時間表示と元イベント合計の整合', () => {
  it('カレンダーの日別合計・月合計・時系列の期間合計が、元イベントの合計と一致する', () => {
    const { db, svc } = setup();
    const raw = (db.prepare('SELECT SUM(total) t FROM usage_events').get() as { t: number }).t;
    const cal = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'none', window: null });
    const inMonth = cal.cells.filter((c) => c.inMonth);
    expect(inMonth.reduce((s, c) => s + c.total, 0)).toBe(raw);
    expect(cal.monthTotal).toBe(raw);
    const days = svc.timeline({ ...filter, granularity: { kind: 'days', n: 1, m: 30 }, measure: 'tokens', dimension: 'none', window: null, overlayWindow: null, weekStart: 1 });
    expect(days.periodTotal).toBe(raw);
    expect(days.buckets.reduce((s, b) => s + b.total, 0)).toBe(raw);
    const weeks = svc.timeline({ ...filter, granularity: { kind: 'calendar_week', weeks: 6 }, measure: 'tokens', dimension: 'none', window: null, overlayWindow: null, weekStart: 1 });
    expect(weeks.buckets.reduce((s, b) => s + b.total, 0)).toBe(raw);
  });

  it('カレンダーの周期内累積は、公式のリセットで 0 に戻り、日の途中のリセットでは旧周期の利用を別に示す', () => {
    const { svc } = setup();
    const key = windowKey({ provider: 'codex', accountKey: null, limitId: 'codex', windowMinutes: 10080, scopeModels: null });
    const cal = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'none', window: key });
    const day = (d: string) => cal.cells.find((c) => c.date === d)!;
    expect(day('2026-11-04').cumulative.cumulative).toBe(45);
    expect(day('2026-11-05').total).toBe(15);
    expect(day('2026-11-05').cumulative.cumulative).toBe(5);
    expect(day('2026-11-05').cumulative.oldCycleUsage).toBe(10);
    expect(day('2026-11-05').resetMarks).toHaveLength(1);
    expect(day('2026-11-05').resetMarks[0]!.estimated).toBe(false);
  });

  it('記録より前の日は「未取得」で、使用量 0 とは区別する', () => {
    const { svc } = setup();
    const cal = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'none', window: null });
    expect(cal.cells.find((c) => c.date === '2026-11-01')!.noData).toBe(true);
    expect(cal.cells.find((c) => c.date === '2026-11-07')!.noData).toBe(false);
  });
});

describe('P: 課金区分を区別する', () => {
  it('サブスク・API・不明を別々に集計できる', () => {
    const { svc } = setup();
    const cal = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'billing', window: null });
    const d6 = cal.cells.find((c) => c.date === '2026-11-06')!;
    expect(d6.byDim).toEqual({ api: 7, unknown: 3 });
    const onlySub = svc.calendar({ ...filter, billingModes: ['subscription'], year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'none', window: null });
    expect(onlySub.monthTotal).toBe(60);
  });

  it('H: 未知モデルのトークンは残り、金額は未換算として数える', () => {
    const { svc } = setup();
    const cal = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'cost', dimension: 'none', window: null });
    expect(cal.monthUnpricedTokens).toBe(3);
    expect(cal.monthUnpricedEvents).toBe(1);
    const tok = svc.calendar({ ...filter, year: 2026, month: 11, weekStart: 1, measure: 'tokens', dimension: 'none', window: null });
    expect(tok.monthTotal).toBe(70);
  });
});

describe('直近の利用', () => {
  it('最新のターンとセッション累計を返す', () => {
    const { svc } = setup();
    const r = svc.recent({ zone: Z, pricingMode: 'historical', limit: 3 });
    expect(r.items[0]!.turn.tokens).toBe(70);
    expect(r.items[0]!.session.tokens).toBe(70);
    expect(r.items[0]!.turn.priced).toBe(false); // 未知モデルを含む
  });
});
