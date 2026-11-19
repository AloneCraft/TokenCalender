// 利用枠の計画: ダッシュボード・消費率・シミュレーターの問い合わせ。
// 計算そのものは src/core/plan にあり、ここでは DB から材料を集めて渡す。

import { DateTime } from 'luxon';
import type { Db } from '../db/database.ts';
import { intervalStats, listWindows, loadLatest, loadQuota, type EventFilter, type QuotaRow } from '../db/readRepo.ts';
import type { Provider } from '../core/model/types.ts';
import { parseWindowKey, windowKey } from '../core/quota/cycles.ts';
import { computePace } from '../core/estimate/pace.ts';
import { changeIntervals, estimateRates, type GroupUsage, type IntervalWithUsage, type ObsPoint } from '../core/plan/rates.ts';
import { budgetPlan, forecastWindow, simulate, weekdayWeightsFrom, workCapacity, type CyclePath } from '../core/plan/forecast.ts';
import { splitByPlan, CODEX_NOMINAL_MULTIPLE, CODEX_PLAN_ORDER } from '../core/quota/planRuns.ts';
import type { Band, GroupRateView, PlanCompareView, PlanOverview, PlanWindow, ProviderPlan, RatesView, SimulateRequest, SimulateResult } from '../shared/plan.ts';

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** 推定と予測に使う過去の範囲（使い方の変化を反映するため長すぎない範囲） */
export const PLAN_HORIZON_MS = 56 * DAY;
/** 同じ周期とみなすリセット日時のずれ */
const RESET_JITTER_MS = 30 * 60 * 1000;

export interface PlanSettings {
  reservePct: number;
  /** 曜日の重み（月=0…日=6）。null なら過去の実績から求める */
  weekdayWeights: number[] | null;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = { reservePct: 5, weekdayWeights: null };

function emptyUsage(): GroupUsage {
  return { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, events: 0, turns: 0, sessions: 0 };
}

function windowEventFilter(parts: ReturnType<typeof parseWindowKey>, fromMs: number, toMs: number): EventFilter {
  return { fromMs, toMs, providers: [parts.provider as Provider], windowAccount: parts.accountKey };
}

function toPoint(o: QuotaRow): ObsPoint {
  return { t: o.observedAtMs, p: o.usedPercent!, resetsAt: o.resetsAtMs, plan: o.planType, precision: o.precision };
}

/**
 * 有効な枠の一覧。期間の分からない枠と、置き換わった枠（リセット日時を過ぎ、同じプロバイダーに
 * より新しい観測の枠がある。例: アカウント情報が記録される前の枠、以前のプランの枠）は除く。
 */
function activeWindows(db: Db, now: number) {
  const ws = listWindows(db).filter((w) => w.windowMinutes != null && w.windowMinutes > 0 && w.lastObservedAt >= now - w.windowMinutes * 60000 - 7 * DAY);
  const newest = new Map<string, number>();
  for (const w of ws) newest.set(w.provider, Math.max(newest.get(w.provider) ?? 0, w.lastObservedAt));
  return ws.filter((w) => {
    if (w.lastObservedAt >= (newest.get(w.provider) ?? 0)) return true;
    const latest = loadLatest(db, windowKey(w));
    return latest?.resetsAtMs != null && latest.resetsAtMs > now;
  });
}

/**
 * 推定に使う観測。アカウントが分かっている枠で、そのプロバイダーの既知のアカウントが1つだけなら、
 * アカウント情報が記録される前（アカウント不明）の観測も同じ利用者のものとして含める。
 */
function rateObservations(db: Db, parts: ReturnType<typeof parseWindowKey>, fromMs: number, toMs: number): QuotaRow[] {
  const provider = parts.provider as Provider;
  const own = loadQuota(db, { provider, accountKey: parts.accountKey, limitId: parts.limitId, windowMinutes: parts.windowMinutes, fromMs, toMs });
  if (parts.accountKey == null) return own;
  const accounts = db.prepare('SELECT COUNT(DISTINCT account_key) n FROM quota_latest WHERE provider = ? AND account_key IS NOT NULL').get(provider) as { n: number };
  if (accounts.n !== 1) return own;
  const legacy = loadQuota(db, { provider, accountKey: null, limitId: parts.limitId, windowMinutes: parts.windowMinutes, fromMs, toMs });
  return [...legacy, ...own].sort((a, b) => a.observedAtMs - b.observedAtMs);
}

/** 消費率の推定は約1秒かかるため、同じ条件（分単位）の結果を短い間だけ使い回す（シミュレーターの操作を軽くするため） */
const rateCache = new Map<string, { at: number; v: { view: RatesView; points: ObsPoint[] } }>();
const RATE_CACHE_MS = 60 * 1000;

/** 期間内の公式観測と、ローカル使用量（モデル|エフォート別）から消費率を推定する。 */
export function computeRates(db: Db, provider: Provider, key: string | null, fromMs: number, toMs: number): { view: RatesView; points: ObsPoint[] } {
  const ck = `${provider}|${key}|${Math.floor(fromMs / 60000)}|${Math.floor(toMs / 60000)}`;
  const hit = rateCache.get(ck);
  const t = Date.now();
  if (hit && t - hit.at < RATE_CACHE_MS) return hit.v;
  const v = computeRatesUncached(db, provider, key, fromMs, toMs);
  for (const [k, e] of rateCache) if (t - e.at >= RATE_CACHE_MS) rateCache.delete(k);
  rateCache.set(ck, { at: t, v });
  return v;
}

function computeRatesUncached(db: Db, provider: Provider, key: string | null, fromMs: number, toMs: number): { view: RatesView; points: ObsPoint[] } {
  const base: RatesView = {
    provider,
    windowKey: key,
    windowMinutes: key ? parseWindowKey(key).windowMinutes : null,
    fromMs,
    toMs,
    intervals: 0,
    dominatedIntervals: 0,
    mixedIntervals: 0,
    unobservedIntervals: 0,
    overall: { pctPerMTokens: null, pctPerTurn: null, totalDeltaPct: 0, tokens: 0, turns: 0 },
    baseline: null,
    groups: [],
    usageMix: [],
    unavailable: key ? null : 'no_official_window',
  };
  // 期間内の使用量の構成（公式値が無くても出せる）
  const mixStats = intervalStats(db, { fromMs, toMs, providers: [provider] }, [fromMs, toMs], 'model_effort', { counts: true })[0];
  let mixTotal = 0;
  for (const v of mixStats?.values() ?? []) mixTotal += v.tokens;
  base.usageMix = [...(mixStats?.entries() ?? [])]
    .map(([group, v]) => ({ group, tokens: v.tokens, turns: v.turns, share: mixTotal > 0 ? v.tokens / mixTotal : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  if (!key) return { view: base, points: [] };
  const parts = parseWindowKey(key);
  const obs = rateObservations(db, parts, fromMs, toMs).filter((o) => o.usedPercent != null);
  const points = obs.map(toPoint);
  if (points.length < 2) return { view: { ...base, unavailable: 'no_observations' }, points };
  const ivs = changeIntervals(points);
  const bounds = [...new Set(ivs.flatMap((i) => [i.from, i.to]))].sort((a, b) => a - b);
  const idx = new Map(bounds.map((b, i) => [b, i]));
  const stats = bounds.length >= 2 ? intervalStats(db, windowEventFilter(parts, fromMs, toMs), bounds, 'model_effort', { counts: true }) : [];
  const withUsage: IntervalWithUsage[] = ivs.map((iv) => {
    const g = new Map<string, GroupUsage>();
    for (let k = idx.get(iv.from)!; k < idx.get(iv.to)!; k++) {
      for (const [gk, s] of stats[k]!) {
        const u = g.get(gk) ?? emptyUsage();
        u.tokens += s.tokens;
        u.input += s.input;
        u.cacheRead += s.cacheRead;
        u.cacheWrite += s.cacheWrite;
        u.output += s.output;
        u.reasoning += s.reasoning;
        u.events += s.events;
        u.turns += s.turns;
        u.sessions += s.sessions;
        g.set(gk, u);
      }
    }
    return { ...iv, groups: g };
  });
  const r = estimateRates(withUsage);
  return {
    view: {
      ...base,
      intervals: r.intervals,
      dominatedIntervals: r.dominatedIntervals,
      mixedIntervals: r.mixedIntervals,
      unobservedIntervals: r.unobservedIntervals,
      overall: r.overall,
      baseline: r.baseline,
      groups: r.groups,
    },
    points,
  };
}

/** 消費率を求める枠を選ぶ: 有効な週枠（10080分）があればそれ、無ければ最も長い枠。同じ長さならいちばん最近観測された枠 */
function rateWindowFor(db: Db, provider: Provider, now: number): string | null {
  const ws = activeWindows(db, now)
    .filter((w) => w.provider === provider)
    .sort((a, b) => (b.windowMinutes === 10080 ? 1 : 0) - (a.windowMinutes === 10080 ? 1 : 0) || (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0) || b.lastObservedAt - a.lastObservedAt);
  return ws[0] ? windowKey(ws[0]) : null;
}

/** 周期ごとに観測をまとめる（リセット日時が同じものを1つの周期とする） */
function cyclePaths(obs: QuotaRow[], windowMs: number): { resetsAt: number; plan: string | null; points: { t: number; p: number }[] }[] {
  const out: { resetsAt: number; plan: string | null; points: { t: number; p: number }[] }[] = [];
  for (const o of obs) {
    if (o.usedPercent == null || o.resetsAtMs == null) continue;
    let c = out.find((x) => Math.abs(x.resetsAt - o.resetsAtMs!) < RESET_JITTER_MS && x.plan === o.planType);
    if (!c) {
      c = { resetsAt: o.resetsAtMs, plan: o.planType, points: [] };
      out.push(c);
    }
    if (o.observedAtMs >= o.resetsAtMs - windowMs) c.points.push({ t: o.observedAtMs, p: o.usedPercent });
  }
  for (const c of out) c.points.sort((a, b) => a.t - b.t);
  return out.sort((a, b) => a.resetsAt - b.resetsAt);
}

function planWindow(db: Db, key: string, now: number, zone: string, settings: PlanSettings, pctPerMTokens: Band | null): PlanWindow {
  const parts = parseWindowKey(key);
  const windowMs = (parts.windowMinutes ?? 0) * 60000;
  const latest = loadLatest(db, key);
  const obs = rateObservations(db, parts, now - PLAN_HORIZON_MS - windowMs, now + 1);
  if (latest && (obs.length === 0 || latest.observedAtMs > obs[obs.length - 1]!.observedAtMs)) obs.push({ ...latest, id: -1, note: null });
  const res: PlanWindow = {
    key,
    provider: parts.provider as Provider,
    windowMinutes: parts.windowMinutes,
    planType: latest?.planType ?? null,
    official: null,
    resetPassedUnconfirmed: false,
    local: { tokensSinceOfficial: 0, addedPct: null },
    usablePct: null,
    forecast: null,
    budget: null,
    path: [],
    cycleStartMs: null,
  };
  if (!latest || latest.usedPercent == null) return res;
  const used = latest.usedPercent;
  res.official = {
    usedPct: used,
    remainingPct: Math.max(0, 100 - used),
    observedAtMs: latest.observedAtMs,
    stale: now - latest.observedAtMs > 30 * 60 * 1000,
    resetsAtMs: latest.resetsAtMs,
    source: latest.source,
  };
  // ローカルログからの暫定値: 最後の公式値より後の使用量 × 消費率
  const sinceStats = intervalStats(db, windowEventFilter(parts, latest.observedAtMs, now + 1), [latest.observedAtMs, now + 1], 'none')[0];
  const tokensSince = sinceStats?.get('all')?.tokens ?? 0;
  res.local.tokensSinceOfficial = tokensSince;
  if (pctPerMTokens) {
    const f = (r: number) => (tokensSince * r) / 1e6;
    res.local.addedPct = { mid: f(pctPerMTokens.mid), low: f(pctPerMTokens.low), high: f(pctPerMTokens.high) };
  }
  if (latest.resetsAtMs == null || !windowMs) return res;
  if (latest.resetsAtMs <= now) {
    res.resetPassedUnconfirmed = true;
    return res;
  }
  res.usablePct = Math.max(0, 100 - used - settings.reservePct);
  const cycles = cyclePaths(obs, windowMs);
  const current = cycles.find((c) => Math.abs(c.resetsAt - latest.resetsAtMs!) < RESET_JITTER_MS && c.plan === latest.planType);
  const cycleStart = latest.resetsAtMs - windowMs;
  res.cycleStartMs = cycleStart;
  res.path = current?.points ?? [{ t: latest.observedAtMs, p: used }];
  const past: CyclePath[] = cycles
    .filter((c) => c !== current && c.resetsAt <= now && c.plan === latest.planType && c.points.length > 0)
    // 記録が途中で終わった周期などは予測の側で除くため、多めに渡す
    .slice(-16)
    .map((c) => ({ startMs: c.resetsAt - windowMs, endMs: c.resetsAt, points: c.points }));
  const sameCycleObs = obs.filter((o) => o.resetsAtMs != null && Math.abs(o.resetsAtMs - latest.resetsAtMs!) < RESET_JITTER_MS);
  const pace = computePace(sameCycleObs, now, null, 0);
  res.forecast = forecastWindow({ nowMs: now, usedNow: used, cycleStartMs: cycleStart, resetsAtMs: latest.resetsAtMs, pastCycles: past, recentPctPerHour: pace.burnRatePctPerHour });
  // 1日ごとの予算は、1日以上の枠だけに出す（5時間枠には意味が薄い）
  if (windowMs >= DAY) {
    const ivs = changeIntervals(obs.filter((o) => o.usedPercent != null).map(toPoint));
    const weights = settings.weekdayWeights ?? weekdayWeightsFrom(ivs.map((iv) => ({ t: iv.to, pct: iv.deltaPct })), zone);
    const dayStart = startOfDay(now, zone);
    let usedAtDayStart: number | null = null;
    if (dayStart <= cycleStart) usedAtDayStart = 0;
    else {
      const before = res.path.filter((p) => p.t <= dayStart);
      usedAtDayStart = before.length ? before[before.length - 1]!.p : res.path.length && res.path[0]!.t > dayStart ? 0 : null;
    }
    res.budget = budgetPlan({ nowMs: now, zone, usedNow: used, usedAtDayStart, resetsAtMs: latest.resetsAtMs, reservePct: settings.reservePct, weekdayWeights: weights });
  }
  return res;
}

function startOfDay(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).startOf('day').toMillis();
}

function bandScale(b: Band | null, k: number): Band | null {
  return b ? { mid: b.mid * k, low: b.low * k, high: b.high * k } : null;
}

export function planOverview(db: Db, opts: { now: number; zone: string; demo: boolean; settings?: PlanSettings }): PlanOverview {
  const { now, zone } = opts;
  const settings = opts.settings ?? DEFAULT_PLAN_SETTINGS;
  const providers: ProviderPlan[] = [];
  const rateByProvider = new Map<Provider, RatesView>();
  for (const provider of ['codex', 'claude'] as Provider[]) {
    const key = rateWindowFor(db, provider, now);
    const { view } = computeRates(db, provider, key, now - PLAN_HORIZON_MS, now + 1);
    rateByProvider.set(provider, view);
  }
  const windows = activeWindows(db, now).map((w) => {
    const key = windowKey(w);
    return planWindow(db, key, now, zone, settings, rateByProvider.get(w.provider)?.overall.pctPerMTokens ?? null);
  });
  windows.sort((a, b) => (a.provider === b.provider ? (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0) : a.provider.localeCompare(b.provider)));

  for (const provider of ['codex', 'claude'] as Provider[]) {
    const rates = rateByProvider.get(provider)!;
    const capWin = windows.find((w) => w.key === rates.windowKey) ?? null;
    const usable = capWin?.usablePct ?? null;
    const recent = intervalStats(db, { fromMs: now - DAY, toMs: now + 1, providers: [provider] }, [now - DAY, now + 1], 'model_effort')[0];
    const currentGroup = [...(recent?.entries() ?? [])].sort((a, b) => b[1].tokens - a[1].tokens)[0]?.[0] ?? null;
    const capacity = rates.groups.map((g) => ({
      group: g.group,
      status: g.status,
      turns: usable != null ? workCapacity(usable, g.pctPerTurn) : null,
      sessions: usable != null ? workCapacity(usable, g.pctPerSession) : null,
      mtokens: usable != null ? workCapacity(usable, g.pctPerMTokens) : null,
    }));
    // 作業した時間（ローカル使用があった1時間）あたりの消費
    let pctPerActiveHour: number | null = null;
    if (rates.overall.totalDeltaPct > 0) {
      const r = db
        .prepare('SELECT COUNT(DISTINCT ts / 3600000) n FROM usage_events WHERE provider = ? AND ts >= ? AND ts < ?')
        .get(provider, rates.fromMs, rates.toMs) as { n: number };
      if (r.n > 0) pctPerActiveHour = rates.overall.totalDeltaPct / r.n;
    }
    const hoursLeft = usable != null && pctPerActiveHour ? { mid: usable / pctPerActiveHour, low: usable / (pctPerActiveHour * 1.25), high: usable / (pctPerActiveHour * 0.8) } : null;
    // 直近7日の実績と、同じトークン量を別の組み合わせで処理した場合（条件付き）
    const wiFrom = now - 7 * DAY;
    const wiStats = intervalStats(db, { fromMs: wiFrom, toMs: now + 1, providers: [provider] }, [wiFrom, now + 1], 'none')[0];
    const wiTokens = wiStats?.get('all')?.tokens ?? 0;
    let actualPct: number | null = null;
    if (rates.windowKey) {
      const parts = parseWindowKey(rates.windowKey);
      const pts = rateObservations(db, parts, wiFrom - DAY, now + 1)
        .filter((o) => o.usedPercent != null)
        .map(toPoint);
      const ivs = changeIntervals(pts).filter((iv) => iv.to > wiFrom);
      if (pts.length >= 2) actualPct = ivs.reduce((a, iv) => a + iv.deltaPct, 0);
    }
    providers.push({
      provider,
      rates,
      currentGroup,
      capacityWindowKey: rates.windowKey,
      capacity,
      overallCapacity: {
        turns: usable != null ? workCapacity(usable, rates.overall.pctPerTurn) : null,
        mtokens: usable != null ? workCapacity(usable, rates.overall.pctPerMTokens) : null,
      },
      activeHours: { pctPerActiveHour, hoursLeft },
      whatIf: {
        days: 7,
        actualPct,
        tokens: wiTokens,
        byGroup: rates.groups.filter((g) => g.status === 'measured').map((g) => ({ group: g.group, pct: bandScale(g.pctPerMTokens, wiTokens / 1e6) })),
      },
    });
  }

  // 次に作業を妨げる枠: すでに 100% → 予測で最も早く枯渇 → 枯渇しないなら余裕の最も少ない枠
  let binding: PlanOverview['binding'] = null;
  const live = windows.filter((w) => w.official && !w.resetPassedUnconfirmed);
  const exhausted = live.find((w) => (w.official?.usedPct ?? 0) >= 100);
  if (exhausted) binding = { key: exhausted.key, reason: 'already_exhausted', atMs: exhausted.official?.resetsAtMs ?? null };
  else {
    const ex = live
      .map((w) => ({ w, at: w.forecast?.exhaustion?.likelyMs ?? null }))
      .filter((x): x is { w: PlanWindow; at: number } => x.at != null)
      .sort((a, b) => a.at - b.at)[0];
    if (ex) binding = { key: ex.w.key, reason: 'exhausts_first', atMs: ex.at };
    else {
      const least = [...live].sort((a, b) => (b.forecast?.finalPct?.mid ?? b.official!.usedPct) - (a.forecast?.finalPct?.mid ?? a.official!.usedPct))[0];
      if (least) binding = { key: least.key, reason: 'least_margin', atMs: least.official?.resetsAtMs ?? null };
    }
  }
  return { generatedAtMs: now, reservePct: settings.reservePct, windows, binding, providers, demo: opts.demo };
}

export function ratesFor(db: Db, req: { provider: Provider; fromMs: number; toMs: number; windowKey?: string | null }, now: number): RatesView {
  const key = req.windowKey ?? rateWindowFor(db, req.provider, now);
  return computeRates(db, req.provider, key, req.fromMs, req.toMs).view;
}

export function simulatePlan(db: Db, req: SimulateRequest, now: number): SimulateResult {
  const parts = parseWindowKey(req.windowKey);
  const latest = loadLatest(db, req.windowKey);
  const base: SimulateResult = {
    windowKey: req.windowKey,
    group: req.group,
    pctPerTurn: null,
    usedNow: latest?.usedPercent ?? null,
    resetsAtMs: latest?.resetsAtMs ?? null,
    points: [],
    finalPct: null,
    exhaustionMs: null,
    unavailable: null,
  };
  if (!latest || latest.usedPercent == null || latest.resetsAtMs == null) return { ...base, unavailable: 'no_official' };
  if (latest.resetsAtMs <= now) return { ...base, unavailable: 'reset_passed' };
  const rates = computeRates(db, parts.provider as Provider, rateWindowFor(db, parts.provider as Provider, now), now - PLAN_HORIZON_MS, now + 1).view;
  const g = req.group ? rates.groups.find((x) => x.group === req.group) : null;
  const perTurn = g ? g.pctPerTurn : rates.overall.pctPerTurn;
  if (!perTurn) return { ...base, unavailable: 'no_rate' };
  // 消費率を求めた枠と違う枠（例: 5時間枠）では、同じ率をそのまま使えないため計算しない
  if (rates.windowKey !== req.windowKey) return { ...base, unavailable: 'rate_window_differs' };
  const sim = simulate({
    nowMs: now,
    zone: req.zone,
    usedNow: latest.usedPercent,
    resetsAtMs: latest.resetsAtMs,
    pctPerTurn: perTurn,
    turnsPerDay: req.turnsPerDay,
    workWeekdays: req.workWeekdays,
    workStartHour: req.workStartHour,
    workHours: req.workHours,
  });
  return { ...base, pctPerTurn: perTurn, points: sim.points, finalPct: sim.finalPct, exhaustionMs: sim.exhaustionMs };
}

const MIN_RUN_OBSERVATIONS = 20;

/** 契約プランごとに、同じモデル・エフォートの消費率を比べる（公称の倍率が本当かを確かめるため）。 */
export function comparePlans(db: Db, provider: 'codex', now: number): PlanCompareView {
  const key = rateWindowFor(db, provider, now);
  const view: PlanCompareView = { provider, windowKey: key, basePlan: null, plans: [], groups: [], summary: [], unavailable: null };
  if (!key) return { ...view, unavailable: 'no_window' };
  const parts = parseWindowKey(key);
  const obs = rateObservations(db, parts, 0, now + 1).filter((o) => o.usedPercent != null);
  const runs = splitByPlan(obs).filter((r) => r.plan != null && r.obs.length >= MIN_RUN_OBSERVATIONS);
  // 同じプランの期間が複数あれば、観測の変化量が最も大きい期間を使う
  const best = new Map<string, { plan: string; fromMs: number; toMs: number; observations: number; rates: RatesView }>();
  for (const r of runs) {
    const fromMs = r.obs[0]!.observedAtMs;
    const toMs = r.obs[r.obs.length - 1]!.observedAtMs + 1;
    const rates = computeRates(db, provider, key, fromMs, toMs).view;
    const cur = best.get(r.plan!);
    if (!cur || rates.overall.totalDeltaPct > cur.rates.overall.totalDeltaPct) best.set(r.plan!, { plan: r.plan!, fromMs, toMs, observations: r.obs.length, rates });
  }
  const order = (p: string): number => {
    const i = (CODEX_PLAN_ORDER as readonly string[]).indexOf(p);
    return i < 0 ? 99 : i;
  };
  const plans = [...best.values()].sort((a, b) => order(a.plan) - order(b.plan));
  view.plans = plans.map((p) => ({ plan: p.plan, fromMs: p.fromMs, toMs: p.toMs, observations: p.observations, totalDeltaPct: p.rates.overall.totalDeltaPct, nominal: CODEX_NOMINAL_MULTIPLE[p.plan] ?? null }));
  if (plans.length < 2) return { ...view, unavailable: 'one_plan' };
  const base = plans[0]!;
  view.basePlan = base.plan;
  const usable = (g: GroupRateView): boolean => g.pctPerMTokens != null && g.status !== 'insufficient';
  const baseGroups = new Map(base.rates.groups.filter(usable).map((g) => [g.group, g]));
  const bestOf = new Map<string, { group: string; ratio: Band; width: number }[]>();
  for (const [group, bg] of baseGroups) {
    const byPlan: PlanCompareView['groups'][number]['byPlan'] = [];
    for (const p of plans.slice(1)) {
      const g = p.rates.groups.find((x) => x.group === group && usable(x));
      if (!g) continue;
      const b = bg.pctPerMTokens!;
      const o = g.pctPerMTokens!;
      const ratio: Band = { mid: b.mid / o.mid, low: b.low / Math.max(o.high, 1e-12), high: b.high / Math.max(o.low, 1e-12) };
      byPlan.push({ plan: p.plan, pctPerMTokens: o, ratio, status: g.status === 'measured' && bg.status === 'measured' ? 'measured' : 'tentative' });
      // 集計には、両方のプランで「実測」のものだけを使う（暫定の値は誤差が大きく、中央値を乱すため）
      if (g.status === 'measured' && bg.status === 'measured') bestOf.set(p.plan, [...(bestOf.get(p.plan) ?? []), { group, ratio, width: Math.log(Math.max(ratio.high, 1e-9) / Math.max(ratio.low, 1e-9)) }]);
    }
    if (byPlan.length > 0) view.groups.push({ group, base: bg.pctPerMTokens!, byPlan });
  }
  if (view.groups.length === 0) return { ...view, unavailable: 'no_common_group' };
  view.groups.sort((a, b) => (b.byPlan.filter((x) => x.status === 'measured').length - a.byPlan.filter((x) => x.status === 'measured').length) || a.group.localeCompare(b.group));
  for (const [plan, rs] of bestOf) {
    const best = [...rs].sort((x, y) => x.width - y.width)[0]!;
    view.summary.push({ plan, bestGroup: best.group, best: best.ratio, measuredGroups: rs.length, nominal: CODEX_NOMINAL_MULTIPLE[plan] ?? null });
  }
  view.summary.sort((a, b) => order(a.plan) - order(b.plan));
  return view;
}
