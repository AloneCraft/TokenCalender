// 問い合わせスレッドが受け付ける命令。入力はすべて検査してから使う。

import type { Db } from '../db/database.ts';
import type { WriteRepo } from '../db/writeRepo.ts';
import type { QueryService } from './service.ts';
import { getSetting, listWindows } from '../db/readRepo.ts';
import { DEFAULT_SETTINGS, type AppStatus, type Settings } from '../shared/api.ts';
import * as v from '../shared/validate.ts';
import { windowKindFromMinutes, type QuotaObservation } from '../core/model/types.ts';
import { ensureDemoDb } from '../demo/generate.ts';

/** 状態表示のモデル・プロジェクト一覧は直近120日から作る（全期間の集計は遅いため） */
const RECENT_MS = 120 * 86400000;

export interface CommandContext {
  db: Db;
  service: QueryService;
  repo: WriteRepo;
  demoDbPath: string;
}

export function readSettings(db: Db): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    (s as unknown as Record<string, unknown>)[k] = getSetting(db, k, DEFAULT_SETTINGS[k]);
  }
  return s;
}

function writeSettings(db: Db, patch: Partial<Settings>): void {
  const st = db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json');
  for (const [k, val] of Object.entries(patch)) st.run(k, JSON.stringify(val));
}

export function handleCommand(method: string, params: unknown, ctx: CommandContext): unknown {
  const { db, service } = ctx;
  switch (method) {
    case 'getSettings':
      return readSettings(db);
    case 'setSettings': {
      const patch = v.settingsPatch(params);
      writeSettings(db, patch);
      if (patch.demo) ensureDemoDb(ctx.demoDbPath);
      return readSettings(db);
    }
    case 'getStatus':
      return status(ctx);
    case 'calendar':
      return service.calendar(v.calendarRequest(params));
    case 'timeline':
      return service.timeline(v.timelineRequest(params));
    case 'dayDetail':
      return service.dayDetail(v.dayDetailRequest(params));
    case 'recent': {
      const o = params as Record<string, unknown>;
      return service.recent({
        zone: v.str(o?.zone, 'zone', 64),
        pricingMode: v.oneOf(o?.pricingMode ?? 'historical', 'pricingMode', ['historical', 'current'] as const),
        limit: v.int(o?.limit ?? 5, 'limit', 1, 20),
      });
    }
    case 'quotaOverview':
      return service.quotaOverview();
    case 'estimate': {
      const o = params as Record<string, unknown>;
      return service.estimate({
        windowKey: v.str(o?.windowKey, 'windowKey', 512),
        pricingMode: v.oneOf(o?.pricingMode ?? 'historical', 'pricingMode', ['historical', 'current'] as const),
      });
    }
    case 'analysis':
      return service.analysis(v.analysisRequest(params));
    case 'addManualObservation': {
      const m = v.manualObservation(params);
      const obs: QuotaObservation = {
        obsKey: `manual:${m.provider}:${m.limitId}:${m.windowMinutes}:${m.observedAtMs}`,
        provider: m.provider,
        accountKey: m.accountKey,
        planType: null,
        limitId: m.limitId,
        windowKind: windowKindFromMinutes(m.windowMinutes),
        windowMinutes: m.windowMinutes,
        scopeModels: null,
        observedAtMs: m.observedAtMs,
        usedPercent: m.usedPercent,
        resetsAtMs: m.resetsAtMs,
        source: 'manual',
        precision: 1,
        flags: ['manual_entry'],
        originRef: null,
      };
      const n = ctx.repo.insertQuota([obs], Date.now(), m.note);
      return { ok: n > 0, message: n > 0 ? null : 'duplicate' };
    }
    case 'deleteManualObservation': {
      const id = v.int((params as Record<string, unknown>)?.id, 'id', 1, Number.MAX_SAFE_INTEGER);
      return { ok: ctx.repo.deleteManualQuota(id) > 0 };
    }
    case 'listManualObservations':
      return (
        db.prepare("SELECT id, provider, limit_id, window_minutes, used_percent, resets_at, observed_at, note FROM quota_observations WHERE source = 'manual' ORDER BY observed_at DESC").all() as Record<
          string,
          unknown
        >[]
      ).map((r) => ({
        id: Number(r.id),
        provider: r.provider,
        limitId: r.limit_id,
        windowMinutes: r.window_minutes == null ? null : Number(r.window_minutes),
        usedPercent: r.used_percent == null ? null : Number(r.used_percent),
        resetsAtMs: r.resets_at == null ? null : Number(r.resets_at),
        observedAtMs: Number(r.observed_at),
        note: r.note ?? null,
      }));
    case 'updateSource': {
      const u = v.sourceUpdate(params);
      if (u.accountKey !== undefined) {
        db.prepare('UPDATE data_sources SET account_key = ? WHERE source_id = ?').run(u.accountKey, u.sourceId);
        if (u.accountKey) {
          db.prepare('INSERT OR IGNORE INTO accounts(account_key, provider, label, created_at) SELECT ?, provider, NULL, ? FROM data_sources WHERE source_id = ?').run(
            u.accountKey,
            Date.now(),
            u.sourceId,
          );
          // 利用者が関連付けたデータ元の「アカウント不明」イベントだけを更新する（ログに根拠がある所属は変えない）
          db.prepare('UPDATE usage_events SET account_key = ? WHERE source_id = ? AND account_key IS NULL').run(u.accountKey, u.sourceId);
        }
      }
      if (u.billingMode !== undefined) {
        db.prepare('UPDATE data_sources SET billing_mode = ? WHERE source_id = ?').run(u.billingMode, u.sourceId);
        db.prepare("UPDATE usage_events SET billing_mode = ? WHERE source_id = ? AND billing_mode = 'unknown'").run(u.billingMode, u.sourceId);
      }
      if (u.enabled !== undefined) db.prepare('UPDATE data_sources SET enabled = ? WHERE source_id = ?').run(u.enabled ? 1 : 0, u.sourceId);
      return { ok: true };
    }
    case 'addSource': {
      const o = params as Record<string, unknown>;
      const provider = v.oneOf(o?.provider, 'provider', ['claude', 'codex'] as const);
      const path = v.str(o?.path, 'path', 1024);
      const cur = readSettings(db).extraSources;
      if (!cur.some((e) => e.provider === provider && e.path.toLowerCase() === path.toLowerCase())) {
        writeSettings(db, { extraSources: [...cur, { provider, path }] });
      }
      return { ok: true, message: null };
    }
    case 'exportRows': {
      const o = params as Record<string, unknown>;
      return service.exportRows(
        v.oneOf(o?.kind, 'kind', ['events', 'daily', 'quota'] as const),
        v.str(o?.zone, 'zone', 64),
        v.oneOf(o?.pricingMode ?? 'historical', 'pricingMode', ['historical', 'current'] as const),
      );
    }
    case 'importEvents':
      return importEvents(db, params);
    case 'setBridgeStatus': {
      const o = params as Record<string, unknown>;
      ctx.repo.setQuotaSourceStatus(
        'claude_statusline',
        v.oneOf(o?.status, 'status', ['ok', 'not_configured', 'failed', 'no_data'] as const),
        o?.detail == null ? null : v.str(o.detail, 'detail', 500),
        Date.now(),
      );
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function status(ctx: CommandContext): Omit<AppStatus, 'ingest' | 'dbPath'> {
  const db = ctx.db;
  const sources = (
    db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM file_cursors f WHERE f.source_id = s.source_id AND f.status IN ('error','permission_denied')) errs,
                (SELECT COALESCE(SUM(bad_lines),0) FROM file_cursors f WHERE f.source_id = s.source_id) bad
         FROM data_sources s ORDER BY provider, kind`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    sourceId: String(r.source_id),
    provider: r.provider as 'claude' | 'codex',
    kind: String(r.kind),
    label: (r.label as string | null) ?? null,
    rootPath: String(r.root_path),
    status: String(r.status),
    detail: (r.status_detail as string | null) ?? null,
    fileCount: Number(r.file_count),
    lastScanAt: r.last_scan_at == null ? null : Number(r.last_scan_at),
    accountKey: (r.account_key as string | null) ?? null,
    billingMode: r.billing_mode as 'unknown',
    enabled: r.enabled === 1,
    filesWithErrors: Number(r.errs),
    badLines: Number(r.bad),
  }));
  const target = ctx.service.database;
  const ev = target.prepare('SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM usage_events').get() as { n: number; a: number | null; b: number | null };
  const models = (target.prepare('SELECT provider, COALESCE(model, \'unknown\') model, SUM(total) t FROM usage_events WHERE ts >= ? GROUP BY 1, 2 ORDER BY t DESC LIMIT 60').all(Date.now() - RECENT_MS) as Record<string, unknown>[]).map(
    (r) => ({ provider: r.provider as 'claude', model: String(r.model), tokens: Number(r.t) }),
  );
  const projects = (
    target.prepare('SELECT project_key k, MAX(project_label) l, SUM(total) t FROM usage_events WHERE project_key IS NOT NULL AND ts >= ? GROUP BY 1 ORDER BY t DESC LIMIT 80').all(Date.now() - RECENT_MS) as Record<string, unknown>[]
  ).map((r) => ({ key: String(r.k), label: String(r.l), tokens: Number(r.t) }));
  const accountsFromEvents = target.prepare('SELECT DISTINCT provider, account_key FROM sessions WHERE account_key IS NOT NULL').all() as Record<string, unknown>[];
  const labels = new Map((db.prepare('SELECT account_key, label FROM accounts').all() as Record<string, unknown>[]).map((r) => [String(r.account_key), (r.label as string | null) ?? null]));
  const windows = listWindows(target);
  const acctSet = new Map<string, 'claude' | 'codex'>();
  for (const a of accountsFromEvents) acctSet.set(String(a.account_key), a.provider as 'claude');
  for (const w of windows) if (w.accountKey) acctSet.set(w.accountKey, w.provider);
  return {
    sources,
    accounts: [...acctSet.entries()].map(([accountKey, provider]) => ({ accountKey, provider, label: labels.get(accountKey) ?? null })),
    eventCount: Number(ev.n),
    firstEventMs: ev.a,
    lastEventMs: ev.b,
    models,
    projects,
    demo: readSettings(db).demo,
  };
}

/** 他の端末で書き出したイベント（JSON）を取り込む。元のイベント鍵で重複を防ぐ。 */
function importEvents(db: Db, params: unknown): { ok: boolean; inserted: number; skipped: number; message: string | null } {
  const rows = (params as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || rows.length > 5_000_000) return { ok: false, inserted: 0, skipped: 0, message: 'invalid_file' };
  const ins = db.prepare(`INSERT OR IGNORE INTO usage_events(event_key, provider, source_id, account_key, session_id, parent_session_id, agent_id, is_sidechain, turn_id, request_id, message_id, ts, model, effort, speed,
    service_tier, inference_geo, project_key, project_label, billing_mode, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output, reasoning, provider_total, total, finality, rank, flags,
    origin_file_key, origin_offset, parser_version, revision, ingested_at, updated_at)
    VALUES (?,?,?,?,?,NULL,NULL,?,?,NULL,NULL,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,'import',0,'import',0,?,?)`);
  let inserted = 0;
  let skipped = 0;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const ts = Date.parse(String(r.ts));
      const ok =
        typeof r.event_key === 'string' &&
        (r.provider === 'claude' || r.provider === 'codex') &&
        Number.isFinite(ts) &&
        ['input_uncached', 'cache_read', 'cache_write', 'output', 'total_tokens'].every((k) => typeof r[k] === 'number' && (r[k] as number) >= 0);
      if (!ok) {
        skipped++;
        continue;
      }
      const res = ins.run(
        r.event_key as string,
        r.provider as string,
        'import',
        (r.account as string | null) ?? null,
        String(r.session_id ?? 'import'),
        r.is_subagent ? 1 : 0,
        (r.turn_id as string | null) ?? null,
        ts,
        (r.model as string | null) ?? null,
        (r.effort as string | null) ?? null,
        (r.speed as string | null) ?? null,
        (r.project as string | null) ?? null,
        v.oneOf(r.billing_mode ?? 'unknown', 'billing_mode', v.BILLING),
        r.input_uncached as number,
        r.cache_read as number,
        r.cache_write as number,
        (r.cache_write_5m as number | null) ?? null,
        (r.cache_write_1h as number | null) ?? null,
        r.output as number,
        (r.reasoning as number | null) ?? null,
        r.total_tokens as number,
        r.partial ? 0 : 1,
        r.partial ? 0 : 1e15,
        JSON.stringify(['imported']),
        now,
        now,
      );
      if (Number(res.changes) > 0) inserted++;
      else skipped++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, inserted, skipped, message: null };
}
