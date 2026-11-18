// 読み取り側の処理。問い合わせ用の別スレッドが使う。

import type { BillingMode, Provider, QuotaObservation, WindowKind } from '../core/model/types.ts';
import type { Db } from './database.ts';

export interface EventFilter {
  fromMs: number;
  toMs: number;
  providers?: Provider[];
  /** 'unknown' はアカウント不明を表す */
  accountKeys?: string[];
  models?: string[];
  projectKeys?: string[];
  billingModes?: BillingMode[];
  includeSidechain?: boolean;
  sessionId?: string;
  /** 枠のアカウントに合うイベント（そのアカウント、または不明）だけに絞る */
  windowAccount?: string | null;
}

export interface EventRow {
  eventKey: string;
  ts: number;
  provider: Provider;
  accountKey: string | null;
  sessionId: string;
  turnId: string | null;
  agentId: string | null;
  isSidechain: boolean;
  model: string | null;
  effort: string | null;
  speed: string | null;
  inferenceGeo: string | null;
  projectKey: string | null;
  projectLabel: string | null;
  billingMode: BillingMode;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  output: number;
  reasoning: number | null;
  unclassified: number;
  total: number;
  finality: number;
  flags: string[];
  /** 取り込み時に計算した API料金換算（nano-dollar）。costKnown が false なら未計算 */
  costNano: number;
  priced: boolean;
  costKnown: boolean;
}

function inList(col: string, values: string[] | undefined, params: (string | number | null)[]): string {
  if (!values || values.length === 0) return '';
  const hasUnknown = values.includes('unknown');
  const known = values.filter((v) => v !== 'unknown');
  const parts: string[] = [];
  if (known.length) {
    parts.push(`${col} IN (${known.map(() => '?').join(',')})`);
    params.push(...known);
  }
  if (hasUnknown) parts.push(`${col} IS NULL`);
  return ` AND (${parts.join(' OR ')})`;
}

export function loadEvents(db: Db, f: EventFilter): EventRow[] {
  const params: (string | number | null)[] = [f.fromMs, f.toMs];
  let sql = `SELECT event_key, ts, provider, account_key, session_id, turn_id, agent_id, is_sidechain, model, effort, speed, inference_geo,
      project_key, project_label, billing_mode, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output, reasoning, unclassified, total, finality, flags, cost_nano, priced
    FROM usage_events WHERE ts >= ? AND ts < ?`;
  sql += inList('provider', f.providers, params);
  sql += inList('account_key', f.accountKeys, params);
  sql += inList('model', f.models, params);
  sql += inList('project_key', f.projectKeys, params);
  sql += inList('billing_mode', f.billingModes, params);
  if (f.includeSidechain === false) sql += ' AND is_sidechain = 0';
  if (f.sessionId) {
    sql += ' AND session_id = ?';
    params.push(f.sessionId);
  }
  sql += ' ORDER BY ts';
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    eventKey: String(r.event_key),
    ts: Number(r.ts),
    provider: r.provider as Provider,
    accountKey: (r.account_key as string | null) ?? null,
    sessionId: String(r.session_id),
    turnId: (r.turn_id as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
    isSidechain: r.is_sidechain === 1,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    speed: (r.speed as string | null) ?? null,
    inferenceGeo: (r.inference_geo as string | null) ?? null,
    projectKey: (r.project_key as string | null) ?? null,
    projectLabel: (r.project_label as string | null) ?? null,
    billingMode: r.billing_mode as BillingMode,
    inputUncached: Number(r.input_uncached),
    cacheRead: Number(r.cache_read),
    cacheWrite: Number(r.cache_write),
    cacheWrite5m: r.cache_write_5m == null ? null : Number(r.cache_write_5m),
    cacheWrite1h: r.cache_write_1h == null ? null : Number(r.cache_write_1h),
    output: Number(r.output),
    reasoning: r.reasoning == null ? null : Number(r.reasoning),
    unclassified: Number(r.unclassified ?? 0),
    total: Number(r.total),
    finality: Number(r.finality),
    flags: JSON.parse(String(r.flags)) as string[],
    costNano: r.cost_nano == null ? 0 : Number(r.cost_nano),
    priced: r.priced === 1,
    costKnown: r.cost_nano != null,
  }));
}

export interface QuotaRow extends QuotaObservation {
  id: number;
  note: string | null;
}

export function loadQuota(
  db: Db,
  f: { provider?: Provider; accountKey?: string | null; limitId?: string; windowMinutes?: number | null; fromMs?: number; toMs?: number } = {},
): QuotaRow[] {
  const params: (string | number | null)[] = [];
  let sql = 'SELECT * FROM quota_observations WHERE 1 = 1';
  if (f.provider) {
    sql += ' AND provider = ?';
    params.push(f.provider);
  }
  if (f.accountKey !== undefined) {
    if (f.accountKey === null) sql += ' AND account_key IS NULL';
    else {
      sql += ' AND account_key = ?';
      params.push(f.accountKey);
    }
  }
  if (f.limitId) {
    sql += ' AND limit_id = ?';
    params.push(f.limitId);
  }
  if (f.windowMinutes !== undefined) {
    if (f.windowMinutes === null) sql += ' AND window_minutes IS NULL';
    else {
      sql += ' AND window_minutes = ?';
      params.push(f.windowMinutes);
    }
  }
  if (f.fromMs != null) {
    sql += ' AND observed_at >= ?';
    params.push(f.fromMs);
  }
  if (f.toMs != null) {
    sql += ' AND observed_at < ?';
    params.push(f.toMs);
  }
  sql += ' ORDER BY observed_at';
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(toQuotaRow);
}

export function toQuotaRow(r: Record<string, unknown>): QuotaRow {
  return {
    id: Number(r.id),
    obsKey: String(r.obs_key),
    provider: r.provider as Provider,
    accountKey: (r.account_key as string | null) ?? null,
    planType: (r.plan_type as string | null) ?? null,
    limitId: String(r.limit_id),
    windowKind: r.window_kind as WindowKind,
    windowMinutes: r.window_minutes == null ? null : Number(r.window_minutes),
    scopeModels: (r.scope_models as string | null) ?? null,
    observedAtMs: Number(r.observed_at),
    usedPercent: r.used_percent == null ? null : Number(r.used_percent),
    resetsAtMs: r.resets_at == null ? null : Number(r.resets_at),
    source: r.source as QuotaObservation['source'],
    precision: Number(r.precision),
    flags: JSON.parse(String(r.flags)) as string[],
    originRef: (r.origin_ref as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

/** 観測された枠の一覧（プロバイダー・アカウント・枠ID・期間ごと）。 */
export function listWindows(db: Db): {
  provider: Provider;
  accountKey: string | null;
  limitId: string;
  windowMinutes: number | null;
  windowKind: WindowKind;
  scopeModels: string | null;
  count: number;
  lastObservedAt: number;
}[] {
  return (
    db
      .prepare(
        `SELECT l.provider, l.account_key, l.limit_id, l.window_minutes, l.window_kind, l.scope_models, l.observed_at last,
           (SELECT COUNT(*) FROM quota_observations q WHERE q.provider = l.provider AND COALESCE(q.account_key, '') = COALESCE(l.account_key, '')
              AND q.limit_id = l.limit_id AND COALESCE(q.window_minutes, -1) = COALESCE(l.window_minutes, -1)) n
         FROM quota_latest l ORDER BY last DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    provider: r.provider as Provider,
    accountKey: (r.account_key as string | null) ?? null,
    limitId: String(r.limit_id),
    windowMinutes: r.window_minutes == null ? null : Number(r.window_minutes),
    windowKind: r.window_kind as WindowKind,
    scopeModels: (r.scope_models as string | null) ?? null,
    count: Number(r.n),
    lastObservedAt: Number(r.last),
  }));
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!r) return fallback;
  try {
    return JSON.parse(r.value_json) as T;
  } catch {
    return fallback;
  }
}

/** 枠ごとの最新の観測（間引かずに保持している） */
export function loadLatest(db: Db, windowKey: string): QuotaObservation | null {
  const r = db.prepare('SELECT * FROM quota_latest WHERE window_key = ?').get(windowKey) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    obsKey: 'latest:' + windowKey,
    provider: r.provider as Provider,
    accountKey: (r.account_key as string | null) ?? null,
    planType: (r.plan_type as string | null) ?? null,
    limitId: String(r.limit_id),
    windowKind: r.window_kind as WindowKind,
    windowMinutes: r.window_minutes == null ? null : Number(r.window_minutes),
    scopeModels: (r.scope_models as string | null) ?? null,
    observedAtMs: Number(r.observed_at),
    usedPercent: r.used_percent == null ? null : Number(r.used_percent),
    resetsAtMs: r.resets_at == null ? null : Number(r.resets_at),
    source: r.source as QuotaObservation['source'],
    precision: Number(r.precision),
    flags: JSON.parse(String(r.flags)) as string[],
    originRef: null,
  };
}

/** 小区間ごとの集計値（SQL で合計する）。金額は取り込み時に計算した値を使う。 */
export interface IntervalStats {
  tokens: number;
  cost: number;
  unpricedTokens: number;
  unpricedEvents: number;
  events: number;
  flagged: number;
  partial: number;
  mixedBillingTokens: number;
  unknownBillingTokens: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  unclassified: number;
  /** 小区間内の異なるターン数・セッション数。小区間をまたぐターンは両方で数えるため、足し合わせると多めになる */
  turns: number;
  sessions: number;
}

export function zeroStats(): IntervalStats {
  return { tokens: 0, cost: 0, unpricedTokens: 0, unpricedEvents: 0, events: 0, flagged: 0, partial: 0, mixedBillingTokens: 0, unknownBillingTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unclassified: 0, turns: 0, sessions: 0 };
}

export function addStats(a: IntervalStats, b: IntervalStats): void {
  for (const k of Object.keys(a) as (keyof IntervalStats)[]) a[k] += b[k];
}

export type DimSql = 'none' | 'provider' | 'model' | 'project' | 'effort' | 'billing' | 'account' | 'sidechain' | 'token_type' | 'model_effort';

/** model_effort の値の区切り（モデル名とエフォートに現れない文字） */
export const MODEL_EFFORT_SEP = '|';

const DIM_EXPR: Record<DimSql, string> = {
  none: "'all'",
  model_effort: `COALESCE(model, 'unknown') || '${MODEL_EFFORT_SEP}' || COALESCE(effort, 'unknown')`,
  token_type: "'all'",
  provider: 'provider',
  model: "COALESCE(model, 'unknown')",
  project: "COALESCE(project_label, 'unknown')",
  effort: "COALESCE(effort, 'unknown')",
  billing: 'billing_mode',
  account: "COALESCE(account_key, 'unknown')",
  sidechain: "CASE is_sidechain WHEN 1 THEN 'subagent' ELSE 'main' END",
};

/**
 * 境界 boundaries（昇順）で区切った小区間 [b_i, b_{i+1}) ごとに、切り口 dim 別の集計値を返す。
 * 時刻の索引で各小区間を範囲検索するため、イベント全件を読み出すより速い。
 */
export function intervalStats(db: Db, f: EventFilter, boundaries: number[], dim: DimSql, opts: { counts?: boolean } = {}): Map<string, IntervalStats>[] {
  // 異なるターン数・セッション数は数えるのが重いため、必要なとき（消費率の推定）だけ数える
  const counts = opts.counts === true ? 'COUNT(DISTINCT e.turn_id) tn, COUNT(DISTINCT e.session_id) sn' : '0 tn, 0 sn';
  const out: Map<string, IntervalStats>[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) out.push(new Map());
  if (out.length === 0) return out;
  // 1回の SQL の引数の上限を超えないよう、区間を分けて問い合わせる
  const CHUNK = 4000;
  for (let start = 0; start < out.length; start += CHUNK) {
    const end = Math.min(out.length, start + CHUNK);
    const params: (string | number | null)[] = [];
    const values: string[] = [];
    for (let i = start; i < end; i++) {
      values.push('(?,?,?)');
      params.push(i, boundaries[i]!, boundaries[i + 1]!);
    }
    let where = '';
    const wp: (string | number | null)[] = [];
    where += inList('e.provider', f.providers, wp);
    where += inList('e.account_key', f.accountKeys, wp);
    where += inList('e.model', f.models, wp);
    where += inList('e.project_key', f.projectKeys, wp);
    where += inList('e.billing_mode', f.billingModes, wp);
    if (f.includeSidechain === false) where += ' AND e.is_sidechain = 0';
    if (f.windowAccount !== undefined && f.windowAccount !== null) {
      where += ' AND (e.account_key = ? OR e.account_key IS NULL)';
      wp.push(f.windowAccount);
    }
    const sql = `WITH b(i, s, t) AS (VALUES ${values.join(',')})
      SELECT b.i i, ${DIM_EXPR[dim].replace(/\b(provider|model|project_label|effort|billing_mode|account_key|is_sidechain)\b/g, 'e.$1')} d,
        SUM(e.total) tokens, SUM(CASE WHEN e.priced = 1 THEN e.cost_nano ELSE 0 END) cost,
        SUM(CASE WHEN COALESCE(e.priced, 0) = 0 THEN e.total ELSE 0 END) ut, SUM(COALESCE(e.priced, 0) = 0) ue, COUNT(*) n,
        SUM(e.flags != '[]') fl, SUM(e.finality = 0) pa, SUM(CASE WHEN e.billing_mode IN ('api','extra_credit') THEN e.total ELSE 0 END) mx, SUM(CASE WHEN e.billing_mode = 'unknown' THEN e.total ELSE 0 END) ub,
        SUM(e.input_uncached) inp, SUM(e.cache_read) cr, SUM(e.cache_write) cw, SUM(e.output) outp, SUM(COALESCE(e.reasoning, 0)) rs, SUM(e.unclassified) uc,
        ${counts}
      FROM b JOIN usage_events e ON e.ts >= b.s AND e.ts < b.t
      WHERE 1 = 1 ${where}
      GROUP BY b.i, d`;
    const rows = db.prepare(sql).all(...params, ...wp) as Record<string, number | string>[];
    for (const r of rows) {
      out[Number(r.i)]!.set(String(r.d), {
        tokens: Number(r.tokens),
        cost: Number(r.cost),
        unpricedTokens: Number(r.ut),
        unpricedEvents: Number(r.ue),
        events: Number(r.n),
        flagged: Number(r.fl),
        partial: Number(r.pa),
        mixedBillingTokens: Number(r.mx),
        unknownBillingTokens: Number(r.ub),
        input: Number(r.inp),
        cacheRead: Number(r.cr),
        cacheWrite: Number(r.cw),
        output: Number(r.outp),
        reasoning: Number(r.rs),
        unclassified: Number(r.uc),
        turns: Number(r.tn),
        sessions: Number(r.sn),
      });
    }
  }
  return out;
}
