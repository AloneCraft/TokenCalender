// 画面からの問い合わせに答える。問い合わせ用の別スレッドで動く。
// 4種類の数値（ログ使用量・API料金換算・公式利用率・推定）は、それぞれ別の項目として返す。

import { DateTime } from 'luxon';
import type { Db } from '../db/database.ts';
import { AGG_BUCKET_MS, getSetting, loadEventAggregates, listWindows, loadEvents, loadLatest, loadQuota, type EventFilter, type EventRow, type QuotaRow } from '../db/readRepo.ts';
import { PricingEngine, type PricingMode } from '../core/pricing/engine.ts';
import type { PriceEntry } from '../core/pricing/table.ts';
import { aggregateBuckets, cumulativeWithinCycles, PrefixSum, usageByCycle, type Dimension, type Measure } from '../core/aggregate/series.ts';
import { buildCycles, cycleBands, parseWindowKey, windowKey, type Cycle } from '../core/quota/cycles.ts';
import { bucketStats, boundarySet, dimValues, IntervalPrefix, statValue } from './intervals.ts';
import { addStats, intervalStats, zeroStats, type DimSql, type IntervalStats } from '../db/readRepo.ts';
import { calendarWeekBuckets, dayBuckets, fixedBuckets, monthGridStart, nDayBuckets, todayIn, type Bucket } from '../core/time/periods.ts';
import { estimateCapacity, type LocalUsage } from '../core/estimate/estimator.ts';
import { computePace, STALE_AFTER_MS } from '../core/estimate/pace.ts';
import type {
  AnalysisRequest,
  AnalysisSeries,
  CalendarRequest,
  CalendarResponse,
  CommonFilter,
  CumulativeCell,
  DayCell,
  DayDetailRequest,
  DayDetailResponse,
  CurrentChat,
  EstimateView,
  QuotaOverview,
  RecentResponse,
  RecentUsage,
  TimelineRequest,
  TimelineResponse,
  TurnState,
  UsageTotals,
} from '../shared/api.ts';
import type { Provider } from '../core/model/types.ts';
import { splitByPlan } from '../core/quota/planRuns.ts';
import { judgeChat, MIN_REQUESTS_TO_COMPARE } from '../core/chat/judge.ts';

const DAY = 86400000;
const FIVE_H = 5 * 3600000;
/** 推定に使う観測の期間 */
const ESTIMATE_HORIZON_MS = 56 * DAY;

export class QueryService {
  private readonly db: Db;
  private readonly demo: boolean;
  private readonly nowFn: () => number;

  constructor(db: Db, opts: { demo?: boolean; now?: () => number } = {}) {
    this.db = db;
    this.demo = opts.demo === true;
    this.nowFn = opts.now ?? Date.now;
  }

  private now(): number {
    return this.nowFn();
  }

  /** この問い合わせが読む DB（デモ表示中はデモ用 DB） */
  get database(): Db {
    return this.db;
  }

  private pricing(): PricingEngine {
    const overrides = (this.db.prepare('SELECT * FROM price_overrides').all() as Record<string, unknown>[]).map(
      (r): PriceEntry => ({
        id: `manual-${String(r.id)}`,
        provider: r.provider as Provider,
        models: [String(r.model)],
        effectiveFrom: r.effective_from == null ? null : new Date(Number(r.effective_from)).toISOString(),
        effectiveTo: r.effective_to == null ? null : new Date(Number(r.effective_to)).toISOString(),
        standard: JSON.parse(String(r.rates_json)),
        sourceUrl: (r.source_url as string | null) ?? '',
        fetchedAt: r.fetched_at == null ? '' : new Date(Number(r.fetched_at)).toISOString(),
        origin: 'manual',
        verified: true,
      }),
    );
    return new PricingEngine(overrides);
  }

  // ---------- 共通 ----------

  private eventFilter(f: CommonFilter, fromMs: number, toMs: number): EventFilter {
    return {
      fromMs,
      toMs,
      providers: f.provider === 'both' ? undefined : [f.provider],
      accountKeys: f.account === 'all' ? undefined : [f.account],
      models: f.models.length ? f.models : undefined,
      projectKeys: f.projects.length ? f.projects : undefined,
      billingModes: f.billingModes.length ? f.billingModes : undefined,
      includeSidechain: f.includeSidechain,
    };
  }

  /**
   * イベントを読み、API料金換算を付ける。
   * 取り込み時に「利用時点の単価」で計算した値を使う。未計算の行と、
   * 「現在の単価で再評価」を選び、かつ適用期間つきの単価がある場合だけ、ここで計算し直す。
   */
  loadPriced(filter: EventFilter, mode: PricingMode): EventRow[] {
    const rows = loadEvents(this.db, filter);
    const engine = this.pricing();
    const recompute = mode === 'current' && engine.hasDatedEntries();
    for (const r of rows) {
      if (r.costKnown && !recompute) continue;
      const p = engine.price(
        {
          provider: r.provider,
          model: r.model,
          tsMs: r.ts,
          speed: r.speed,
          inferenceGeo: r.inferenceGeo,
          tokens: {
            inputUncached: r.inputUncached,
            cacheRead: r.cacheRead,
            cacheWrite: r.cacheWrite,
            cacheWrite5m: r.cacheWrite5m,
            cacheWrite1h: r.cacheWrite1h,
            output: r.output,
            reasoning: r.reasoning,
            unclassified: r.unclassified,
            providerTotal: null,
          },
        },
        mode,
      );
      r.priced = p.priced;
      r.costNano = p.nanoUsd;
    }
    return rows;
  }

  /** 枠の観測と周期。windowKey が無効なら null。 */
  private windowCycles(key: string | null, fromMs: number, toMs: number): { obs: QuotaRow[]; cycles: Cycle[]; label: string; parts: ReturnType<typeof parseWindowKey> } | null {
    if (!key) return null;
    const parts = parseWindowKey(key);
    if (!parts.windowMinutes) return null;
    const obs = loadQuota(this.db, {
      provider: parts.provider as Provider,
      accountKey: parts.accountKey,
      limitId: parts.limitId,
      windowMinutes: parts.windowMinutes,
    });
    const cycles = buildCycles(obs, parts.windowMinutes, { extrapolateFromMs: fromMs, extrapolateToMs: toMs });
    return { obs, cycles, label: windowLabel(parts.provider, parts.windowMinutes, parts.limitId), parts };
  }

  /** 枠に対応するイベントだけを選ぶ（周期内累積・推定はプロバイダーとアカウントを分けて扱う）。 */
  private rowsForWindow(rows: EventRow[], parts: ReturnType<typeof parseWindowKey>): EventRow[] {
    return rows.filter((r) => r.provider === parts.provider && (parts.accountKey == null || r.accountKey === parts.accountKey || r.accountKey == null));
  }

  private firstEventMs(provider: CommonFilter['provider']): number | null {
    const r = (
      provider === 'both'
        ? this.db.prepare('SELECT MIN(ts) t FROM usage_events').get()
        : this.db.prepare('SELECT MIN(ts) t FROM usage_events WHERE provider = ?').get(provider)
    ) as { t: number | null };
    return r.t ?? null;
  }

  // ---------- カレンダー ----------

  /** 「現在の単価で再評価」を選び、かつ適用期間つきの単価がある場合は、1件ずつ計算し直す必要がある */
  private needsRowPricing(mode: PricingMode): boolean {
    return mode === 'current' && this.pricing().hasDatedEntries();
  }

  /** 枠のプロバイダーとアカウントに絞った条件（要求の絞り込みも保つ） */
  private windowFilter(f: EventFilter, parts: ReturnType<typeof parseWindowKey>): EventFilter {
    const providers = f.providers ? f.providers.filter((p) => p === parts.provider) : [parts.provider as Provider];
    return { ...f, providers: providers.length ? providers : ['__none__' as Provider], windowAccount: parts.accountKey };
  }

  /** 周期内累積を、区間と周期の境界で区切った小区間の合計から求める */
  private cumulative(f: EventFilter, win: NonNullable<ReturnType<QueryService['windowCycles']>>, buckets: Bucket[], measure: Measure, now: number): CumulativeCell[] {
    const fromMs = buckets[0]!.startMs;
    const toMs = buckets[buckets.length - 1]!.endMs;
    const cyc = win.cycles.filter((c) => c.endMs > fromMs && c.startMs < toMs);
    const bset = boundarySet(
      buckets.map((b) => b.startMs),
      buckets.map((b) => b.endMs),
      cyc.map((c) => c.startMs),
      cyc.map((c) => c.endMs),
    );
    const stats = intervalStats(this.db, this.windowFilter(f, win.parts), bset, 'none');
    const prefix = new IntervalPrefix(
      bset,
      stats.map((m) => {
        const v = m.get('all');
        return v ? statValue(v, measure) : 0;
      }),
    );
    return cumulativeWithinCycles(buckets, win.cycles, prefix, now);
  }

  calendar(req: CalendarRequest): CalendarResponse {
    if (this.needsRowPricing(req.pricingMode)) return this.calendarFromRows(req);
    const zone = req.zone;
    const gridStart = monthGridStart(req.year, req.month, zone, req.weekStart);
    const buckets = dayBuckets(gridStart, 42, zone);
    const fromMs = buckets[0]!.startMs;
    const toMs = buckets[buckets.length - 1]!.endMs;
    const now = this.now();
    const win = this.windowCycles(req.window, fromMs - 8 * DAY, toMs);
    const f = this.eventFilter(req, fromMs, toMs);
    const main = bucketStats(this.db, f, buckets, req.dimension as DimSql);
    const cum = win ? this.cumulative(f, win, buckets, req.measure, now) : null;
    const first = this.firstEventMs(req.provider);
    const observedResets = new Set(win?.cycles.filter((c) => c.basis === 'observed').map((c) => c.endMs) ?? []);
    const cells: DayCell[] = buckets.map((b, i) => {
      const a = main.buckets[i]!;
      const marks: { atMs: number; estimated: boolean }[] = [];
      for (const c of win?.cycles ?? []) {
        if (c.startMs >= b.startMs && c.startMs < b.endMs) marks.push({ atMs: c.startMs, estimated: !observedResets.has(c.startMs) });
      }
      return {
        date: b.key,
        startMs: b.startMs,
        endMs: b.endMs,
        inMonth: DateTime.fromMillis(b.startMs, { zone }).month === req.month,
        future: b.startMs > now,
        noData: first == null || b.endMs <= first,
        total: statValue(a.total, req.measure),
        byDim: dimValues(a, req.measure, req.dimension === 'token_type'),
        events: a.total.events,
        tokens: a.total.tokens,
        unpricedEvents: a.total.unpricedEvents,
        unpricedTokens: a.total.unpricedTokens,
        flaggedEvents: a.total.flagged,
        partialEvents: a.total.partial,
        cumulative: cum ? pickCum(cum[i]!) : EMPTY_CUM,
        resetMarks: marks,
      };
    });
    const monthCells = cells.filter((c) => c.inMonth);
    const dimKeys = new Set<string>();
    for (const c of monthCells) for (const k of Object.keys(c.byDim)) dimKeys.add(k);
    const cyclesInView = win?.cycles.filter((c) => c.endMs > fromMs && c.startMs < toMs) ?? [];
    return {
      cells,
      maxDaily: Math.max(0, ...monthCells.map((c) => c.total)),
      maxCumulative: Math.max(0, ...monthCells.map((c) => c.cumulative.cumulative ?? 0)),
      monthTotal: monthCells.reduce((sum, c) => sum + c.total, 0),
      monthUnpricedTokens: monthCells.reduce((sum, c) => sum + c.unpricedTokens, 0),
      monthUnpricedEvents: monthCells.reduce((sum, c) => sum + c.unpricedEvents, 0),
      dimensionKeys: sortDimKeys([...dimKeys], monthCells),
      windowLabel: win?.label ?? null,
      cycleNote: !win || win.cycles.length === 0 ? 'unknown' : cyclesInView.some((c) => c.basis === 'extrapolated') ? 'partly_estimated' : 'observed',
      dataAsOfMs: this.lastIngestMs(),
      demo: this.demo,
    };
  }

  /** 1件ずつ料金を計算し直す経路（適用期間つきの単価で「現在の単価」を選んだ場合） */
  private calendarFromRows(req: CalendarRequest): CalendarResponse {
    const zone = req.zone;
    const gridStart = monthGridStart(req.year, req.month, zone, req.weekStart);
    const buckets = dayBuckets(gridStart, 42, zone);
    const fromMs = buckets[0]!.startMs;
    const toMs = buckets[buckets.length - 1]!.endMs;
    const now = this.now();
    const win = this.windowCycles(req.window, fromMs - 8 * DAY, toMs);
    const loadFrom = win ? fromMs - (win.parts.windowMinutes ?? 0) * 60000 - DAY : fromMs;
    const rows = this.loadPriced(this.eventFilter(req, loadFrom, toMs), req.pricingMode);
    const agg = aggregateBuckets(rows, buckets, req.measure, req.dimension);
    let cum: CumulativeCell[] | null = null;
    if (win) {
      const prefix = new PrefixSum(this.rowsForWindow(rows, win.parts), req.measure);
      cum = cumulativeWithinCycles(buckets, win.cycles, prefix, now);
    }
    const first = this.firstEventMs(req.provider);
    const observedResets = new Set(win?.cycles.filter((c) => c.basis === 'observed').map((c) => c.endMs) ?? []);
    const cells: DayCell[] = buckets.map((b, i) => {
      const a = agg[i]!;
      const inMonth = DateTime.fromMillis(b.startMs, { zone }).month === req.month;
      const marks: { atMs: number; estimated: boolean }[] = [];
      for (const c of win?.cycles ?? []) {
        if (c.startMs >= b.startMs && c.startMs < b.endMs) marks.push({ atMs: c.startMs, estimated: !observedResets.has(c.startMs) });
      }
      return {
        date: b.key,
        startMs: b.startMs,
        endMs: b.endMs,
        inMonth,
        future: b.startMs > now,
        noData: first == null || b.endMs <= first,
        total: a.total,
        byDim: a.byDim,
        events: a.events,
        tokens: a.tokens,
        unpricedEvents: a.unpricedEvents,
        unpricedTokens: a.unpricedTokens,
        flaggedEvents: a.flaggedEvents,
        partialEvents: a.partialEvents,
        cumulative: cum
          ? pickCum(cum[i]!)
          : { cycleKnown: false, cycleEstimated: false, prior: null, increment: null, cumulative: null, resetInBucket: false, oldCycleUsage: 0 },
        resetMarks: marks,
      };
    });
    const monthCells = cells.filter((c) => c.inMonth);
    const monthStart = monthCells[0]!.startMs;
    const monthEnd = monthCells[monthCells.length - 1]!.endMs;
    const monthRows = rows.filter((r) => r.ts >= monthStart && r.ts < monthEnd);
    const allPrefix = new PrefixSum(rows, req.measure);
    const dimKeys = new Set<string>();
    for (const c of monthCells) for (const k of Object.keys(c.byDim)) dimKeys.add(k);
    const cyclesInView = win?.cycles.filter((c) => c.endMs > fromMs && c.startMs < toMs) ?? [];
    return {
      cells,
      maxDaily: Math.max(0, ...monthCells.map((c) => c.total)),
      maxCumulative: Math.max(0, ...monthCells.map((c) => c.cumulative.cumulative ?? 0)),
      monthTotal: allPrefix.sum(monthStart, monthEnd),
      monthUnpricedTokens: monthRows.filter((r) => !r.priced).reduce((s, r) => s + r.total, 0),
      monthUnpricedEvents: monthRows.filter((r) => !r.priced).length,
      dimensionKeys: sortDimKeys([...dimKeys], monthCells),
      windowLabel: win?.label ?? null,
      cycleNote: !win || win.cycles.length === 0 ? 'unknown' : cyclesInView.some((c) => c.basis === 'extrapolated') ? 'partly_estimated' : 'observed',
      dataAsOfMs: this.lastIngestMs(),
      demo: this.demo,
    };
  }

  private lastIngestMs(): number | null {
    const r = this.db.prepare('SELECT MAX(updated_at) t FROM file_cursors').get() as { t: number | null };
    return r.t ?? null;
  }

  // ---------- 時系列 ----------

  timeline(req: TimelineRequest): TimelineResponse {
    return this.timelineImpl(req, !this.needsRowPricing(req.pricingMode));
  }

  private timelineImpl(req: TimelineRequest, useIntervals: boolean): TimelineResponse {
    const zone = req.zone;
    const now = this.now();
    let buckets: Bucket[];
    let fiveHourBasis: TimelineResponse['fiveHourBasis'] = null;
    let win = null as ReturnType<QueryService['windowCycles']>;
    const g = req.granularity;
    if (g.kind === 'days') {
      buckets = nDayBuckets(todayIn(zone, now), g.n, g.m, zone);
    } else if (g.kind === 'calendar_week') {
      const end = DateTime.fromMillis(now, { zone }).endOf('day').toMillis() + 1;
      buckets = calendarWeekBuckets(end - g.weeks * 7 * DAY, end, zone, req.weekStart);
    } else {
      const span = g.m * FIVE_H;
      win = this.windowCycles(req.window, now - span - FIVE_H, now + FIVE_H);
      const official = win && win.parts.windowMinutes === 300 ? win.cycles.filter((c) => c.endMs > now - span - FIVE_H && c.startMs <= now) : [];
      if (official.length > 0) {
        fiveHourBasis = 'official';
        buckets = official.slice(-g.m).map((c) => ({ key: `5h:${c.startMs}`, startMs: c.startMs, endMs: c.endMs }));
      } else {
        fiveHourBasis = 'analytic';
        const anchor = DateTime.fromMillis(now, { zone }).startOf('day').toMillis();
        buckets = fixedBuckets(anchor, FIVE_H, now - (g.m - 1) * FIVE_H, now + 1, '5h').slice(-g.m);
      }
    }
    if (buckets.length === 0) {
      return { buckets: [], dimensionKeys: [], periodTotal: 0, periodUnpricedTokens: 0, fiveHourBasis, resets: [], cycles: [], windowLabel: null, demo: this.demo };
    }
    const fromMs = buckets[0]!.startMs;
    const toMs = buckets[buckets.length - 1]!.endMs;
    if (!win) win = this.windowCycles(req.window, fromMs - 8 * DAY, toMs);
    const overlay = req.overlayWindow ? this.windowCycles(req.overlayWindow, fromMs - 8 * DAY, toMs) : null;
    if (useIntervals) {
      const f = this.eventFilter(req, fromMs, toMs);
      const main = bucketStats(this.db, f, buckets, req.dimension as DimSql);
      const cumI = win ? this.cumulative(f, win, buckets, req.measure, now) : null;
      const ovI = overlay ? this.cumulative(f, overlay, buckets, req.measure, now) : null;
      const observedEndsI = new Set(win?.cycles.filter((c) => c.basis === 'observed').map((c) => c.endMs) ?? []);
      const keys = new Set<string>();
      const tb = buckets.map((b, i) => {
        const a = main.buckets[i]!;
        const byDim = dimValues(a, req.measure, req.dimension === 'token_type');
        for (const k of Object.keys(byDim)) keys.add(k);
        return {
          key: b.key,
          startMs: b.startMs,
          endMs: b.endMs,
          total: statValue(a.total, req.measure),
          byDim,
          unpricedTokens: a.total.unpricedTokens,
          events: a.total.events,
          cumulative: cumI ? pickCum(cumI[i]!) : EMPTY_CUM,
          overlayCumulative: ovI ? pickCum(ovI[i]!) : null,
          future: b.startMs > now,
        };
      });
      return {
        buckets: tb,
        dimensionKeys: [...keys],
        periodTotal: tb.reduce((sum, b) => sum + b.total, 0),
        periodUnpricedTokens: tb.reduce((sum, b) => sum + b.unpricedTokens, 0),
        fiveHourBasis,
        resets: (win?.cycles ?? []).filter((c) => c.startMs > fromMs && c.startMs < toMs).map((c) => ({ atMs: c.startMs, estimated: !observedEndsI.has(c.startMs) })),
        cycles: win ? cycleBands(win.cycles, win.parts.windowMinutes ?? 0, fromMs, toMs) : [],
        windowLabel: win?.label ?? null,
        demo: this.demo,
      };
    }
    const span = Math.max(win?.parts.windowMinutes ?? 0, overlay?.parts.windowMinutes ?? 0) * 60000;
    const rows = this.loadPriced(this.eventFilter(req, fromMs - span - DAY, toMs), req.pricingMode);
    const agg = aggregateBuckets(rows, buckets, req.measure, req.dimension);
    const cum = win ? cumulativeWithinCycles(buckets, win.cycles, new PrefixSum(this.rowsForWindow(rows, win.parts), req.measure), now) : null;
    const ov = overlay ? cumulativeWithinCycles(buckets, overlay.cycles, new PrefixSum(this.rowsForWindow(rows, overlay.parts), req.measure), now) : null;
    const prefix = new PrefixSum(rows, req.measure);
    const periodRows = rows.filter((r) => r.ts >= fromMs && r.ts < toMs);
    const observedEnds = new Set(win?.cycles.filter((c) => c.basis === 'observed').map((c) => c.endMs) ?? []);
    const dimKeys = new Set<string>();
    for (const a of agg) for (const k of Object.keys(a.byDim)) dimKeys.add(k);
    return {
      buckets: buckets.map((b, i) => ({
        key: b.key,
        startMs: b.startMs,
        endMs: b.endMs,
        total: agg[i]!.total,
        byDim: agg[i]!.byDim,
        unpricedTokens: agg[i]!.unpricedTokens,
        events: agg[i]!.events,
        cumulative: cum
          ? pickCum(cum[i]!)
          : { cycleKnown: false, cycleEstimated: false, prior: null, increment: null, cumulative: null, resetInBucket: false, oldCycleUsage: 0 },
        overlayCumulative: ov ? pickCum(ov[i]!) : null,
        future: b.startMs > now,
      })),
      dimensionKeys: [...dimKeys],
      periodTotal: prefix.sum(fromMs, toMs),
      periodUnpricedTokens: periodRows.filter((r) => !r.priced).reduce((s, r) => s + r.total, 0),
      fiveHourBasis,
      resets: (win?.cycles ?? [])
        .filter((c) => c.startMs > fromMs && c.startMs < toMs)
        .map((c) => ({ atMs: c.startMs, estimated: !observedEnds.has(c.startMs) })),
      cycles: win ? cycleBands(win.cycles, win.parts.windowMinutes ?? 0, fromMs, toMs) : [],
      windowLabel: win?.label ?? null,
      demo: this.demo,
    };
  }

  // ---------- 日の詳細 ----------

  dayDetail(req: DayDetailRequest): DayDetailResponse {
    const [day] = dayBuckets(req.date, 1, req.zone);
    const rows = this.loadPriced(this.eventFilter(req, day!.startMs, day!.endMs), req.pricingMode);
    const step = req.stepMinutes * 60000;
    const slotsB = fixedBuckets(day!.startMs, step, day!.startMs, day!.endMs, 'slot');
    const slotsAgg = aggregateBuckets(rows, slotsB, 'tokens', 'model');
    const byModel = new Map<string, { tokens: number; costNano: number; priced: boolean }>();
    const turns = new Map<string, DayDetailResponse['turns'][number]>();
    const totals = { tokens: 0, costNano: 0, unpricedTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    for (const r of rows) {
      const m = r.model ?? 'unknown';
      const bm = byModel.get(m) ?? { tokens: 0, costNano: 0, priced: true };
      bm.tokens += r.total;
      bm.costNano += r.costNano;
      bm.priced &&= r.priced;
      byModel.set(m, bm);
      totals.tokens += r.total;
      totals.costNano += r.costNano;
      if (!r.priced) totals.unpricedTokens += r.total;
      totals.input += r.inputUncached;
      totals.cacheRead += r.cacheRead;
      totals.cacheWrite += r.cacheWrite;
      totals.output += r.output;
      totals.reasoning += r.reasoning ?? 0;
      const tk = `${r.provider}|${r.sessionId}|${r.turnId ?? '-'}`;
      const t = turns.get(tk) ?? {
        provider: r.provider,
        sessionId: r.sessionId,
        turnId: r.turnId,
        startedAtMs: null,
        lastAtMs: r.ts,
        model: r.model,
        projectLabel: r.projectLabel,
        tokens: 0,
        costNano: 0,
        unpricedTokens: 0,
        requests: 0,
        subagentRequests: 0,
      };
      t.tokens += r.total;
      t.costNano += r.costNano;
      if (!r.priced) t.unpricedTokens += r.total;
      t.requests++;
      if (r.isSidechain) t.subagentRequests++;
      t.lastAtMs = Math.max(t.lastAtMs, r.ts);
      turns.set(tk, t);
    }
    const turnStarts = this.db.prepare('SELECT started_at FROM turns WHERE turn_key = ?');
    for (const t of turns.values()) {
      if (t.turnId) {
        const s = turnStarts.get(`${t.provider}:${t.sessionId}:${t.turnId}`) as { started_at: number | null } | undefined;
        t.startedAtMs = s?.started_at ?? null;
      }
    }
    const win = this.windowCycles(req.window, day!.startMs - 8 * DAY, day!.endMs);
    let cycles: DayDetailResponse['cycles'] = [];
    if (win) {
      const wr = this.rowsForWindow(rows, win.parts);
      const cost = new PrefixSum(wr, 'cost');
      const tok = new PrefixSum(wr, 'tokens');
      cycles = usageByCycle(win.cycles, cost, day!.startMs, day!.endMs).map(({ cycle }) => {
        const s = Math.max(cycle.startMs, day!.startMs);
        const e = Math.min(cycle.endMs, day!.endMs);
        return { startMs: cycle.startMs, endMs: cycle.endMs, estimated: cycle.basis === 'extrapolated', usageInDay: cost.sum(s, e), tokensInDay: tok.sum(s, e) };
      });
    }
    return {
      date: req.date,
      slots: slotsAgg.map((a) => ({ startMs: a.startMs, total: a.total, byModel: a.byDim })),
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens),
      turns: [...turns.values()].sort((a, b) => b.lastAtMs - a.lastAtMs),
      cycles,
      totals,
    };
  }

  // ---------- 直近の利用 ----------

  recent(req: { zone: string; pricingMode: PricingMode; limit: number }): RecentResponse {
    const now = this.now();
    const latest = this.db
      .prepare(
        // 最新の記録から7日以内だけを見る（全期間をまとめると遅いため）
        `SELECT provider, session_id, turn_id, MAX(ts) last FROM usage_events
         WHERE ts >= (SELECT MAX(ts) FROM usage_events) - 7 * 86400000
         GROUP BY provider, session_id, turn_id ORDER BY last DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(20, req.limit))) as { provider: Provider; session_id: string; turn_id: string | null; last: number }[];
    const items: RecentUsage[] = [];
    const turnRow = this.db.prepare('SELECT started_at, completed_at, status FROM turns WHERE turn_key = ?');
    const sessionRow = this.db.prepare('SELECT project_label, source_id FROM sessions WHERE session_key = ?');
    for (const l of latest) {
      const sessionRows = this.loadPriced({ fromMs: 0, toMs: 8.64e15, providers: [l.provider], sessionId: l.session_id }, req.pricingMode);
      const turnRows = sessionRows.filter((r) => (r.turnId ?? null) === (l.turn_id ?? null));
      if (turnRows.length === 0) continue;
      const t = l.turn_id ? (turnRow.get(`${l.provider}:${l.session_id}:${l.turn_id}`) as { started_at: number | null; completed_at: number | null; status: string } | undefined) : undefined;
      const s = sessionRow.get(`${l.provider}:${l.session_id}`) as { project_label: string | null; source_id: string | null } | undefined;
      const partial = turnRows.some((r) => r.finality === 0);
      let state: TurnState;
      if (t?.status === 'completed' || t?.status === 'aborted') state = partial ? 'partial' : 'recorded';
      else if (now - l.last < 2 * 60 * 1000) state = 'running';
      else state = partial ? 'partial' : 'waiting';
      const subs = new Map<string, { agentId: string | null; tokens: number; requests: number }>();
      for (const r of turnRows.filter((x) => x.isSidechain)) {
        const k = r.agentId ?? 'unknown';
        const v = subs.get(k) ?? { agentId: r.agentId, tokens: 0, requests: 0 };
        v.tokens += r.total;
        v.requests++;
        subs.set(k, v);
      }
      const models = [...new Set(turnRows.map((r) => r.model ?? 'unknown'))];
      items.push({
        provider: l.provider,
        sessionId: l.session_id,
        turnId: l.turn_id,
        model: turnRows[turnRows.length - 1]!.model,
        models,
        projectLabel: s?.project_label ?? turnRows[0]!.projectLabel,
        startedAtMs: t?.started_at ?? turnRows[0]!.ts,
        lastUpdatedMs: l.last,
        state,
        turn: totalsOf(turnRows),
        session: totalsOf(sessionRows),
        subagents: [...subs.values()],
        requests: turnRows.length,
        dataSource: s?.source_id ?? '',
        ingestedAtMs: this.lastIngestMs(),
      });
    }
    return { items, generatedAtMs: now, liveNote: 'usage_recorded_after_response', demo: this.demo };
  }

  /** プロバイダーごとに、最後に動いたチャットの状態と判定を返す。比べる相手は、そのユーザー自身の過去30日のチャット。 */
  currentChats(): CurrentChat[] {
    const now = this.now();
    const out: CurrentChat[] = [];
    const rows = this.db.prepare(
      `SELECT session_id, count(*) n, sum(total) tok, sum(input_uncached) i, sum(cache_read) cr, sum(cache_write) cw, sum(output) o, min(ts) a, max(ts) b
       FROM usage_events WHERE provider = ? AND ts >= ? GROUP BY session_id ORDER BY b DESC`,
    );
    for (const provider of ['claude', 'codex'] as const) {
      const all = rows.all(provider, now - 30 * DAY) as { session_id: string; n: number; tok: number; i: number; cr: number; cw: number; o: number; a: number; b: number }[];
      const cur = all[0];
      if (!cur) continue;
      const weekTokens = all.filter((r) => r.b >= now - 7 * DAY).reduce((a, r) => a + r.tok, 0);
      const baseline = all.slice(1).filter((r) => r.n >= MIN_REQUESTS_TO_COMPARE).map((r) => r.tok);
      const j = judgeChat({ tokens: cur.tok, requests: cur.n, inputUncached: cur.i, cacheRead: cur.cr, cacheWrite: cur.cw, output: cur.o }, baseline);
      const meta = this.db.prepare('SELECT project_label FROM sessions WHERE session_key = ?').get(`${provider}:${cur.session_id}`) as { project_label: string | null } | undefined;
      out.push({
        provider,
        sessionId: cur.session_id,
        projectLabel: meta?.project_label ?? null,
        startedAtMs: cur.a,
        lastUpdatedMs: cur.b,
        active: now - cur.b < 10 * 60000,
        tokens: cur.tok,
        requests: cur.n,
        inputUncached: cur.i,
        cacheRead: cur.cr,
        cacheWrite: cur.cw,
        output: cur.o,
        shareOfWeekPct: weekTokens > 0 ? (cur.tok / weekTokens) * 100 : 0,
        verdict: j.verdict,
        vsMedian: j.vsMedian,
        median: j.median,
        p90: j.p90,
        cacheHit: j.cacheHit,
      });
    }
    return out;
  }

  private priceRows(rows: EventRow[], engine: PricingEngine, mode: PricingMode): EventRow[] {
    for (const r of rows) {
      const p = engine.price(
        {
          provider: r.provider,
          model: r.model,
          tsMs: r.ts,
          speed: r.speed,
          inferenceGeo: r.inferenceGeo,
          tokens: {
            inputUncached: r.inputUncached,
            cacheRead: r.cacheRead,
            cacheWrite: r.cacheWrite,
            cacheWrite5m: r.cacheWrite5m,
            cacheWrite1h: r.cacheWrite1h,
            output: r.output,
            reasoning: r.reasoning,
            unclassified: r.unclassified,
            providerTotal: null,
          },
        },
        mode,
      );
      r.priced = p.priced;
      r.costNano = p.nanoUsd;
    }
    return rows;
  }

  // ---------- 公式利用率 ----------

  quotaOverview(): QuotaOverview {
    const now = this.now();
    const windows = listWindows(this.db).map((w) => {
      const key = windowKey(w);
      const lastRow = this.db.prepare('SELECT * FROM quota_latest WHERE window_key = ?').get(key) as Record<string, unknown> | undefined;
      return {
        key,
        ...w,
        latest: lastRow
          ? {
              usedPercent: lastRow.used_percent == null ? null : Number(lastRow.used_percent),
              resetsAtMs: lastRow.resets_at == null ? null : Number(lastRow.resets_at),
              observedAtMs: Number(lastRow.observed_at),
              source: lastRow.source as 'codex_log',
              planType: (lastRow.plan_type as string | null) ?? null,
              stale: now - Number(lastRow.observed_at) > STALE_AFTER_MS,
            }
          : null,
      };
    });
    const statusRows = this.db.prepare('SELECT source, status, detail, updated_at FROM quota_source_status').all() as {
      source: string;
      status: string;
      detail: string | null;
      updated_at: number;
    }[];
    const statusMap = new Map(statusRows.map((r) => [r.source, r]));
    const hasCodexLog = windows.some((w) => w.provider === 'codex' && w.latest?.source === 'codex_log');
    const sources: QuotaOverview['sources'] = [
      {
        source: 'codex_log',
        status: hasCodexLog ? 'ok' : 'no_data',
        detail: null,
        updatedAt: windows.filter((w) => w.provider === 'codex').reduce<number | null>((m, w) => Math.max(m ?? 0, w.lastObservedAt), null),
      },
      {
        source: 'claude_statusline',
        status: (statusMap.get('claude_statusline')?.status as QuotaOverview['sources'][number]['status']) ?? 'not_configured',
        detail: statusMap.get('claude_statusline')?.detail ?? null,
        updatedAt: statusMap.get('claude_statusline')?.updated_at ?? null,
      },
      { source: 'codex_app_server', status: 'unsupported', detail: 'not_implemented_unverified', updatedAt: null },
    ];
    const has5h = (p: Provider) => windows.some((w) => w.provider === p && w.windowMinutes === 300);
    return { windows: windows.map((w) => ({ ...w, key: w.key })), sources, noFiveHour: { claude: !has5h('claude'), codex: !has5h('codex') }, demo: this.demo };
  }

  // ---------- 推定 ----------

  estimate(req: { windowKey: string; pricingMode: PricingMode }): EstimateView {
    const now = this.now();
    const parts = parseWindowKey(req.windowKey);
    const label = windowLabel(parts.provider, parts.windowMinutes, parts.limitId);
    const empty: EstimateView = {
      windowKey: req.windowKey,
      windowLabel: label,
      status: 'no_observations',
      statusReasons: [],
      observationCount: 0,
      adoptedCount: 0,
      excludedCount: 0,
      periodFromMs: null,
      periodToMs: null,
      capacityTokens: null,
      capacityCostNano: null,
      reference: null,
      spreadRatio: null,
      costEstimateSuppressed: false,
      plan: null,
      earlierPlans: [],
      segments: [],
      pace: {
        official: null,
        resetTimePassedUnconfirmed: false,
        timeToResetMs: null,
        auxiliary: null,
        burnRatePctPerHour: null,
        projectedExhaustion: null,
        outlook: 'unknown',
        evenPacePctPerHour: null,
      },
      observations: [],
      localHourly: [],
      unknownBillingShare: 0,
      modelMix: [],
      demo: this.demo,
    };
    if (!parts.windowMinutes) return empty;
    // 推定に使う観測は直近8週間に限る（使い方の変化を反映し、問い合わせを軽くするため）
    let obs = loadQuota(this.db, {
      provider: parts.provider as Provider,
      accountKey: parts.accountKey,
      limitId: parts.limitId,
      windowMinutes: parts.windowMinutes,
      fromMs: now - ESTIMATE_HORIZON_MS,
    });
    const latestObs = loadLatest(this.db, req.windowKey);
    if (latestObs && (obs.length === 0 || latestObs.observedAtMs > obs[obs.length - 1]!.observedAtMs) && latestObs.observedAtMs >= now - ESTIMATE_HORIZON_MS) {
      obs.push({ ...latestObs, id: -1, note: null });
    }
    if (obs.length === 0) return empty;
    // プランが違うと枠の大きさが違う。推定は「現在のプラン」の観測だけで行い、以前のプランは別に参考として出す。
    const runs = splitByPlan(obs);
    const currentRun = runs[runs.length - 1]!;
    const allObs = obs;
    obs = currentRun.obs;
    const fromMs = allObs[0]!.observedAtMs - (parts.windowMinutes * 60000);
    const cycles = buildCycles(obs, parts.windowMinutes, { extrapolateToMs: now + 1 });
    // 観測時刻と1時間ごとの区切りを境界にした小区間を SQL で合計する（イベントを1件ずつ読み込まない）。
    // 推定に使う区間・ペース・重ね図は、すべてこの境界の上で正確に求められる。
    const viewFrom = Math.max(fromMs, now - 14 * DAY);
    const hourly = fixedBuckets(0, 3600000, viewFrom, now + 1, 'h');
    const bset = boundarySet(
      allObs.map((o) => o.observedAtMs),
      hourly.map((h) => h.startMs),
      hourly.map((h) => h.endMs),
      [fromMs, now + 1],
    );
    const baseFilter = this.windowFilter({ fromMs, toMs: now + 1 }, parts);
    const perModel = intervalStats(this.db, baseFilter, bset, 'model');
    const per = perModel.map((m) => {
      const z = zeroStats();
      for (const v of m.values()) addStats(z, v);
      return z;
    });
    const prefixOf = (pick: (x: IntervalStats) => number) => new IntervalPrefix(bset, per.map(pick));
    const pTok = prefixOf((x) => x.tokens);
    const pCost = prefixOf((x) => x.cost);
    const pUnpriced = prefixOf((x) => x.unpricedTokens);
    const pMixed = prefixOf((x) => x.mixedBillingTokens);
    const pEvents = prefixOf((x) => x.events);
    const pUnknown = prefixOf((x) => x.unknownBillingTokens);
    const local = (a: number, b: number): LocalUsage => ({
      tokens: pTok.sum(a, b),
      costNano: pCost.sum(a, b),
      unpricedTokens: pUnpriced.sum(a, b),
      events: pEvents.sum(a, b),
      mixedBillingTokens: pMixed.sum(a, b),
    });
    const est = estimateCapacity(obs, cycles, local);
    const earlierPlans = runs.slice(0, -1).filter((r) => r.obs.length >= 2).map((r) => {
      const e = estimateCapacity(r.obs, buildCycles(r.obs, parts.windowMinutes!, { extrapolateToMs: r.obs[r.obs.length - 1]!.observedAtMs + 1 }), local);
      return { plan: r.plan ?? 'unknown', fromMs: r.obs[0]!.observedAtMs, toMs: r.obs[r.obs.length - 1]!.observedAtMs, observationCount: r.obs.length, capacityTokens: e.capacityTokens, capacityCostNano: e.capacityCostNano };
    });
    // ペース: 最後の観測と同じ周期の観測
    const lastObs = obs[obs.length - 1]!;
    const cyc = cycles.find((c) => lastObs.observedAtMs >= c.startMs && lastObs.observedAtMs < c.endMs);
    const sameCycle = cyc ? obs.filter((o) => o.observedAtMs >= cyc.startMs && o.observedAtMs < cyc.endMs) : [lastObs];
    const capacity = est.capacityTokens ?? est.reference?.capacityTokens ?? null;
    const pace = computePace(sameCycle, now, capacity, pTok.sum(lastObs.observedAtMs, now + 1));
    const periodFrom = est.periodFromMs ?? fromMs;
    const periodTokens = pTok.sum(periodFrom, now + 1);
    const unknownTokens = pUnknown.sum(periodFrom, now + 1);
    const hourlyAgg = hourly.map((h) => ({ startMs: h.startMs, total: pTok.sum(h.startMs, h.endMs) }));
    const hourlyCost = hourly.map((h) => ({ total: pCost.sum(h.startMs, h.endMs) }));
    const mix = new Map<string, number>();
    bset.forEach((b, i) => {
      if (i >= perModel.length || b < periodFrom) return;
      for (const [model, v] of perModel[i]!) mix.set(model, (mix.get(model) ?? 0) + v.tokens);
    });
    return {
      ...empty,
      status: est.status,
      statusReasons: est.statusReasons,
      observationCount: est.observationCount,
      adoptedCount: est.adoptedCount,
      excludedCount: est.excludedCount,
      periodFromMs: est.periodFromMs,
      periodToMs: est.periodToMs,
      capacityTokens: est.capacityTokens,
      capacityCostNano: est.capacityCostNano,
      reference: est.reference,
      spreadRatio: est.spreadRatio,
      costEstimateSuppressed: est.costEstimateSuppressed,
      plan: currentRun.plan,
      earlierPlans,
      segments: est.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        p1: s.p1,
        p2: s.p2,
        deltaPct: s.deltaPct,
        tokens: s.local.tokens,
        costNano: s.local.costNano,
        unpricedTokens: s.local.unpricedTokens,
        capacityTokens: s.capacityTokens,
        capacityCostNano: s.capacityCostNano,
        adopted: s.adopted,
        exclusions: s.exclusions,
        warnings: s.warnings,
      })),
      pace,
      observations: obs.filter((o) => o.observedAtMs >= viewFrom).map((o) => ({ atMs: o.observedAtMs, usedPercent: o.usedPercent, resetsAtMs: o.resetsAtMs, source: o.source })),
      localHourly: hourlyAgg.map((a, i) => ({ atMs: a.startMs, tokens: a.total, costNano: hourlyCost[i]!.total })),
      unknownBillingShare: periodTokens > 0 ? unknownTokens / periodTokens : 0,
      modelMix: [...mix.entries()].map(([model, t]) => ({ model, share: periodTokens > 0 ? t / periodTokens : 0 })).sort((a, b) => b.share - a.share),
    };
  }

  // ---------- 分析 ----------

  /**
   * 分析の図用にイベントを読む。通常は SQL 側で 5分 × 属性ごとにまとめて読む（数十万件でも速い）。
   * 次の場合は、1件ずつ読む従来の経路にする: セッション単位の図、期間の端が 5分の区切りに合わない、
   * 取り込み時に金額を計算していない行がある、「現在の単価で再評価」で金額を計算し直す。
   */
  private loadForAnalysis(req: AnalysisRequest): EventRow[] {
    const filter = this.eventFilter(req, req.fromMs, req.toMs);
    const aligned = req.fromMs % AGG_BUCKET_MS === 0 && req.toMs % AGG_BUCKET_MS === 0;
    const recompute = req.pricingMode === 'current' && this.pricing().hasDatedEntries();
    if (req.chartId !== 'session_size' && aligned && !recompute) {
      const agg = loadEventAggregates(this.db, filter);
      if (!agg.hasUncosted) return agg.rows;
    }
    return this.loadPriced(filter, req.pricingMode);
  }

  analysis(req: AnalysisRequest): AnalysisSeries {
    const rows = this.loadForAnalysis(req);
    const unpricedTokens = rows.filter((r) => !r.priced).reduce((s, r) => s + r.total, 0);
    const prefix = new PrefixSum(rows, req.measure);
    const periodTotal = prefix.sum(req.fromMs, req.toMs);
    if (req.chartId === 'weekday_hour') {
      const matrix = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      for (const r of rows) {
        const d = DateTime.fromMillis(r.ts, { zone: req.zone });
        matrix[d.weekday - 1]![d.hour]! += valueForMeasure(r, req.measure);
      }
      return { buckets: [], dimensionKeys: [], matrix, periodTotal, unpricedTokens };
    }
    if (req.chartId === 'session_size') {
      const sessions = new Map<string, number>();
      for (const r of rows) sessions.set(`${r.provider}|${r.sessionId}`, (sessions.get(`${r.provider}|${r.sessionId}`) ?? 0) + valueForMeasure(r, req.measure));
      const vals = [...sessions.values()].filter((v) => v > 0);
      const edges = logEdges(vals);
      const counts = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
      for (const v of vals) {
        let i = edges.findIndex((e, j) => j + 1 < edges.length && v >= e && v < edges[j + 1]!);
        if (i < 0) i = counts.length - 1;
        if (i >= 0) counts[i]!++;
      }
      return {
        buckets: counts.map((c, i) => ({ startMs: edges[i]!, total: c, byDim: {} })),
        dimensionKeys: [],
        periodTotal,
        unpricedTokens,
      };
    }
    if (req.chartId === 'ranking') {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = dimKey(r, req.dimension === 'none' ? 'project' : req.dimension);
        m.set(k, (m.get(k) ?? 0) + valueForMeasure(r, req.measure));
      }
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
      return { buckets: sorted.map(([, v], i) => ({ startMs: i, total: v, byDim: {} })), dimensionKeys: sorted.map(([k]) => k), periodTotal, unpricedTokens };
    }
    const step = Math.max(5, req.stepMinutes) * 60000;
    const anchor = DateTime.fromMillis(req.fromMs, { zone: req.zone }).startOf('day').toMillis();
    const buckets = step >= DAY ? dayBuckets(DateTime.fromMillis(req.fromMs, { zone: req.zone }).toISODate()!, Math.ceil((req.toMs - req.fromMs) / DAY), req.zone) : fixedBuckets(anchor, step, req.fromMs, req.toMs, 'a');
    if (req.chartId === 'cache_ratio') {
      const inp = aggregateBuckets(rows, buckets, 'input', 'none');
      const cr = aggregateBuckets(rows, buckets, 'cache_read', 'none');
      const cw = aggregateBuckets(rows, buckets, 'cache_write', 'none');
      return {
        buckets: buckets.map((b, i) => {
          const denom = inp[i]!.total + cr[i]!.total + cw[i]!.total;
          return { startMs: b.startMs, total: denom > 0 ? cr[i]!.total / denom : NaN, byDim: {} };
        }),
        dimensionKeys: [],
        periodTotal,
        unpricedTokens,
      };
    }
    const agg = aggregateBuckets(rows, buckets, req.measure, req.dimension);
    const keys = new Set<string>();
    for (const a of agg) for (const k of Object.keys(a.byDim)) keys.add(k);
    return { buckets: agg.map((a) => ({ startMs: a.startMs, total: a.total, byDim: a.byDim })), dimensionKeys: [...keys], periodTotal, unpricedTokens };
  }

  // ---------- 書き出し ----------

  exportRows(kind: 'events' | 'daily' | 'quota', zone: string, mode: PricingMode): Record<string, unknown>[] {
    if (kind === 'quota') {
      return loadQuota(this.db).map((q) => ({
        provider: q.provider,
        account: q.accountKey,
        limit_id: q.limitId,
        window_minutes: q.windowMinutes,
        observed_at: new Date(q.observedAtMs).toISOString(),
        used_percent: q.usedPercent,
        resets_at: q.resetsAtMs == null ? null : new Date(q.resetsAtMs).toISOString(),
        source: q.source,
        plan_type: q.planType,
      }));
    }
    const rows = this.loadPriced({ fromMs: 0, toMs: 8.64e15 }, mode);
    if (kind === 'events') {
      return rows.map((r) => ({
        event_key: r.eventKey,
        ts: new Date(r.ts).toISOString(),
        provider: r.provider,
        account: r.accountKey,
        session_id: r.sessionId,
        turn_id: r.turnId,
        is_subagent: r.isSidechain,
        model: r.model,
        effort: r.effort,
        speed: r.speed,
        project: r.projectLabel,
        billing_mode: r.billingMode,
        input_uncached: r.inputUncached,
        cache_read: r.cacheRead,
        cache_write: r.cacheWrite,
        cache_write_5m: r.cacheWrite5m,
        cache_write_1h: r.cacheWrite1h,
        output: r.output,
        reasoning: r.reasoning,
        unclassified: r.unclassified,
        total_tokens: r.total,
        api_cost_equivalent_usd: r.priced ? r.costNano / 1e9 : null,
        priced: r.priced,
        partial: r.finality === 0,
        flags: r.flags.join(' '),
      }));
    }
    const byDay = new Map<string, { tokens: number; costNano: number; unpricedTokens: number; events: number }>();
    for (const r of rows) {
      const d = `${DateTime.fromMillis(r.ts, { zone }).toISODate()}|${r.provider}`;
      const v = byDay.get(d) ?? { tokens: 0, costNano: 0, unpricedTokens: 0, events: 0 };
      v.tokens += r.total;
      v.costNano += r.costNano;
      if (!r.priced) v.unpricedTokens += r.total;
      v.events++;
      byDay.set(d, v);
    }
    return [...byDay.entries()].map(([k, v]) => {
      const [date, provider] = k.split('|');
      return { date, provider, tokens: v.tokens, api_cost_equivalent_usd: v.costNano / 1e9, unpriced_tokens: v.unpricedTokens, events: v.events, zone };
    });
  }

  settingsValue<T>(key: string, fallback: T): T {
    return getSetting(this.db, key, fallback);
  }
}

const EMPTY_CUM: CumulativeCell = { cycleKnown: false, cycleEstimated: false, prior: null, increment: null, cumulative: null, resetInBucket: false, oldCycleUsage: 0 };

function pickCum(c: CumulativeCell): CumulativeCell {
  return {
    cycleKnown: c.cycleKnown,
    cycleEstimated: c.cycleEstimated,
    prior: c.prior,
    increment: c.increment,
    cumulative: c.cumulative,
    resetInBucket: c.resetInBucket,
    oldCycleUsage: c.oldCycleUsage,
  };
}

function sortDimKeys(keys: string[], cells: { byDim: Record<string, number> }[]): string[] {
  const totals = new Map<string, number>();
  for (const c of cells) for (const [k, v] of Object.entries(c.byDim)) totals.set(k, (totals.get(k) ?? 0) + v);
  return keys.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
}

export function windowLabel(provider: string, minutes: number | null, limitId: string): string {
  const p = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
  const w =
    minutes === 300
      ? '5時間枠'
      : minutes === 10080
        ? '週枠'
        : minutes && minutes % 1440 === 0
          ? `${minutes / 1440}日枠`
          : minutes
            ? `${Math.round(minutes / 60)}時間枠`
            : '期間不明の枠';
  return `${p} ${w}${limitId && limitId !== provider ? `（${limitId}）` : ''}`;
}

function totalsOf(rows: EventRow[]): UsageTotals {
  const t: UsageTotals = { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costNano: 0, unpricedTokens: 0, priced: true };
  for (const r of rows) {
    t.tokens += r.total;
    t.input += r.inputUncached;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.output += r.output;
    t.reasoning += r.reasoning ?? 0;
    t.costNano += r.costNano;
    if (!r.priced) {
      t.unpricedTokens += r.total;
      t.priced = false;
    }
  }
  return t;
}

function valueForMeasure(r: EventRow, m: Measure): number {
  switch (m) {
    case 'tokens':
      return r.total;
    case 'cost':
      return r.priced ? r.costNano : 0;
    case 'input':
      return r.inputUncached;
    case 'cache_read':
      return r.cacheRead;
    case 'cache_write':
      return r.cacheWrite;
    case 'output':
      return r.output;
    case 'reasoning':
      return r.reasoning ?? 0;
    case 'events':
      return 1;
  }
}

function dimKey(r: EventRow, d: Dimension): string {
  switch (d) {
    case 'provider':
      return r.provider;
    case 'model':
      return r.model ?? 'unknown';
    case 'project':
      return r.projectLabel ?? 'unknown';
    case 'effort':
      return r.effort ?? 'unknown';
    case 'billing':
      return r.billingMode;
    case 'account':
      return r.accountKey ?? 'unknown';
    case 'sidechain':
      return r.isSidechain ? 'subagent' : 'main';
    default:
      return 'all';
  }
}

function logEdges(vals: number[]): number[] {
  if (vals.length === 0) return [];
  const max = Math.max(...vals);
  const edges: number[] = [0];
  let e = 1000;
  while (e <= max * 2) {
    edges.push(e);
    e *= 2;
  }
  edges.push(e);
  return edges;
}
