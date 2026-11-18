// 書き込み側の処理。取り込み用の別スレッドだけが使う。

import type { ParseOutput, QuotaObservation, SessionRecord, TurnRecord, UsageEvent } from '../core/model/types.ts';
import { normalizedTotal } from '../core/model/tokens.ts';
import { StatementCache, type Db } from './database.ts';
import { PricingEngine } from '../core/pricing/engine.ts';

export interface FileCursor {
  fileKey: string;
  sourceId: string;
  path: string;
  compressed: boolean;
  size: number;
  mtimeMs: number;
  offset: number;
  headHash: string | null;
  parserState: string | null;
  parserVersion: string;
  badLines: number;
  status: string;
  error: string | null;
}

export interface UpsertStats {
  inserted: number;
  updated: number;
  unchanged: number;
  conflicting: number;
}

export class WriteRepo {
  private readonly st: StatementCache;
  private readonly db: Db;
  /** API料金換算を取り込み時に計算するための料金表（利用時点の単価で計算する） */
  private readonly pricing: PricingEngine;

  constructor(db: Db, pricing: PricingEngine = new PricingEngine()) {
    this.db = db;
    this.st = new StatementCache(db);
    this.pricing = pricing;
  }

  // ---------- 利用イベント ----------

  /**
   * 同じ鍵のイベントは1件にまとめる。
   * - 新しい記録の順位（rank）が高い場合だけ置き換え、訂正履歴を残す（途中経過 → 最終値）。
   * - 順位が同じで中身が違う場合は置き換えず、印（conflicting_copies）だけ付ける。
   * - 同じ記録の再読み込みは何も変えない（再読込・再起動で合計が増えない）。
   */
  upsertEvents(events: UsageEvent[], now: number): UpsertStats {
    const stats: UpsertStats = { inserted: 0, updated: 0, unchanged: 0, conflicting: 0 };
    const sel = this.st.get('SELECT rank, total, revision, flags FROM usage_events WHERE event_key = ?');
    for (const ev of events) {
      const total = normalizedTotal(ev.tokens);
      const row = sel.get(ev.eventKey) as { rank: number; total: number; revision: number; flags: string } | undefined;
      if (!row) {
        this.insertEvent(ev, total, now);
        stats.inserted++;
        continue;
      }
      if (ev.rank > row.rank) {
        this.replaceEvent(ev, total, row.revision + 1, now);
        this.st
          .get(
            'INSERT INTO event_revisions(event_key, revision, old_total, new_total, old_rank, new_rank, origin_file_key, at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(ev.eventKey, row.revision + 1, row.total, total, row.rank, ev.rank, ev.origin.fileKey, now);
        stats.updated++;
      } else if (ev.rank === row.rank && total !== row.total) {
        const flags = new Set<string>(JSON.parse(row.flags) as string[]);
        if (!flags.has('conflicting_copies')) {
          flags.add('conflicting_copies');
          this.st.get('UPDATE usage_events SET flags = ?, updated_at = ? WHERE event_key = ?').run(JSON.stringify([...flags]), now, ev.eventKey);
        }
        stats.conflicting++;
      } else {
        stats.unchanged++;
      }
    }
    return stats;
  }

  private eventParams(ev: UsageEvent, total: number): (string | number | null)[] {
    const t = ev.tokens;
    return [
      ev.provider,
      ev.sourceId,
      ev.accountKey,
      ev.sessionId,
      ev.parentSessionId,
      ev.agentId,
      ev.isSidechain ? 1 : 0,
      ev.turnId,
      ev.requestId,
      ev.messageId,
      ev.tsMs,
      ev.model,
      ev.effort,
      ev.speed,
      ev.serviceTier,
      ev.inferenceGeo,
      ev.projectKey,
      ev.projectLabel,
      ev.billingMode,
      t.inputUncached,
      t.cacheRead,
      t.cacheWrite,
      t.cacheWrite5m,
      t.cacheWrite1h,
      t.output,
      t.reasoning,
      t.unclassified,
      t.providerTotal,
      total,
      ev.finality,
      ev.rank,
      JSON.stringify(ev.flags),
      ev.origin.fileKey,
      ev.origin.offset,
      ev.origin.parserVersion,
      ...this.costOf(ev),
    ];
  }

  private costOf(ev: UsageEvent): [number, number] {
    const p = this.pricing.price({ provider: ev.provider, model: ev.model, tsMs: ev.tsMs, speed: ev.speed, inferenceGeo: ev.inferenceGeo, tokens: ev.tokens }, 'historical');
    return [p.priced ? p.nanoUsd : 0, p.priced ? 1 : 0];
  }

  private static readonly EVENT_COLS =
    'provider, source_id, account_key, session_id, parent_session_id, agent_id, is_sidechain, turn_id, request_id, message_id, ts, model, effort, speed, service_tier, inference_geo, project_key, project_label, billing_mode, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output, reasoning, unclassified, provider_total, total, finality, rank, flags, origin_file_key, origin_offset, parser_version, cost_nano, priced';

  private insertEvent(ev: UsageEvent, total: number, now: number): void {
    const cols = WriteRepo.EVENT_COLS;
    const n = cols.split(',').length;
    this.st
      .get(`INSERT INTO usage_events(event_key, ${cols}, revision, ingested_at, updated_at) VALUES (?, ${Array(n).fill('?').join(',')}, 0, ?, ?)`)
      .run(ev.eventKey, ...this.eventParams(ev, total), now, now);
  }

  private replaceEvent(ev: UsageEvent, total: number, revision: number, now: number): void {
    const sets = WriteRepo.EVENT_COLS.split(',')
      .map((c) => `${c.trim()} = ?`)
      .join(', ');
    this.st
      .get(`UPDATE usage_events SET ${sets}, revision = ?, updated_at = ? WHERE event_key = ?`)
      .run(...this.eventParams(ev, total), revision, now, ev.eventKey);
  }

  // ---------- ターン・セッション ----------

  upsertTurns(turns: TurnRecord[]): void {
    const s = this.st.get(`
      INSERT INTO turns(turn_key, provider, session_id, turn_id, started_at, completed_at, status) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(turn_key) DO UPDATE SET
        started_at = CASE
          WHEN turns.started_at IS NULL THEN excluded.started_at
          WHEN excluded.started_at IS NULL THEN turns.started_at
          ELSE MIN(turns.started_at, excluded.started_at) END,
        completed_at = CASE
          WHEN excluded.completed_at IS NULL THEN turns.completed_at
          WHEN turns.completed_at IS NULL THEN excluded.completed_at
          ELSE MAX(turns.completed_at, excluded.completed_at) END,
        status = CASE
          WHEN excluded.status IN ('completed', 'aborted') THEN excluded.status
          WHEN turns.status IN ('completed', 'aborted') THEN turns.status
          ELSE excluded.status END`);
    for (const t of turns) s.run(t.turnKey, t.provider, t.sessionId, t.turnId, t.startedAtMs, t.completedAtMs, t.status);
  }

  upsertSessions(sessions: SessionRecord[]): void {
    const s = this.st.get(`
      INSERT INTO sessions(session_key, provider, session_id, parent_session_id, source_id, account_key, project_key, project_label, originator, billing_mode, first_ts, last_ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_key) DO UPDATE SET
        parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
        account_key = COALESCE(sessions.account_key, excluded.account_key),
        project_key = COALESCE(sessions.project_key, excluded.project_key),
        project_label = COALESCE(sessions.project_label, excluded.project_label),
        originator = COALESCE(sessions.originator, excluded.originator),
        billing_mode = CASE WHEN sessions.billing_mode = 'unknown' THEN excluded.billing_mode ELSE sessions.billing_mode END,
        first_ts = CASE WHEN sessions.first_ts IS NULL THEN excluded.first_ts WHEN excluded.first_ts IS NULL THEN sessions.first_ts ELSE MIN(sessions.first_ts, excluded.first_ts) END,
        last_ts = CASE WHEN sessions.last_ts IS NULL THEN excluded.last_ts WHEN excluded.last_ts IS NULL THEN sessions.last_ts ELSE MAX(sessions.last_ts, excluded.last_ts) END`);
    // 同じセッションの行が大量に来るため、まとめてから書く
    const merged = new Map<string, SessionRecord>();
    for (const r of sessions) {
      const m = merged.get(r.sessionKey);
      if (!m) merged.set(r.sessionKey, { ...r });
      else {
        m.firstTsMs = minNullable(m.firstTsMs, r.firstTsMs);
        m.lastTsMs = maxNullable(m.lastTsMs, r.lastTsMs);
        m.projectKey ??= r.projectKey;
        m.projectLabel ??= r.projectLabel;
      }
    }
    for (const r of merged.values()) {
      s.run(
        r.sessionKey,
        r.provider,
        r.sessionId,
        r.parentSessionId,
        r.sourceId,
        r.accountKey,
        r.projectKey,
        r.projectLabel,
        r.originator,
        r.billingMode,
        r.firstTsMs,
        r.lastTsMs,
      );
    }
  }

  /** ログから課金区分が判明したとき、同じセッションの「不明」を更新する。 */
  markSessionBilling(provider: string, sessionId: string, billing: string): void {
    this.st
      .get("UPDATE usage_events SET billing_mode = ? WHERE provider = ? AND session_id = ? AND billing_mode = 'unknown'")
      .run(billing, provider, sessionId);
    this.st.get("UPDATE sessions SET billing_mode = ? WHERE provider = ? AND session_id = ? AND billing_mode = 'unknown'").run(billing, provider, sessionId);
  }

  // ---------- 公式利用率 ----------

  /**
   * 公式利用率の観測を保存する。
   * Codex のログには同じ値の観測が大量に繰り返し書かれるため、「同じ枠・同じ利用率・同じリセット日時」は
   * 15分の区切りごとに最初の1件だけを残す（値が変わった時刻は必ず残る）。
   * 最新の観測は quota_latest に必ず保持し、取得時刻の表示が古くならないようにする。
   * 手動記録は間引かない。
   */
  insertQuota(obs: QuotaObservation[], now: number, note: string | null = null): number {
    // IS で比べる（NULL どうしも一致する）。COALESCE で包むと索引の window_minutes と observed_at が使われず、
    // 観測が増えるほど1件ごとの確認が遅くなる（実ログの初回取り込みで約20分の差が出た）。
    const dup = this.st.get(`
      SELECT 1 FROM quota_observations WHERE provider = ? AND account_key IS ? AND limit_id = ?
        AND window_minutes IS ? AND observed_at >= ? AND observed_at < ?
        AND used_percent IS ? AND resets_at IS ? LIMIT 1`);
    const latest = this.st.get(`
      INSERT INTO quota_latest(window_key, provider, account_key, limit_id, window_kind, window_minutes, scope_models, plan_type, observed_at, used_percent, resets_at, source, precision, flags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(window_key) DO UPDATE SET plan_type = excluded.plan_type, observed_at = excluded.observed_at, used_percent = excluded.used_percent,
        resets_at = excluded.resets_at, source = excluded.source, precision = excluded.precision, flags = excluded.flags, window_kind = excluded.window_kind
      WHERE excluded.observed_at > quota_latest.observed_at`);
    const kept: QuotaObservation[] = [];
    for (const o of obs) {
      latest.run(
        quotaWindowKey(o),
        o.provider,
        o.accountKey,
        o.limitId,
        o.windowKind,
        o.windowMinutes,
        o.scopeModels,
        o.planType,
        o.observedAtMs,
        o.usedPercent,
        o.resetsAtMs,
        o.source,
        o.precision,
        JSON.stringify(o.flags),
      );
      if (o.source !== 'manual') {
        const b = Math.floor(o.observedAtMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
        if (dup.get(o.provider, o.accountKey, o.limitId, o.windowMinutes, b, b + QUOTA_BUCKET_MS, o.usedPercent, o.resetsAtMs)) continue;
      }
      kept.push(o);
    }
    return this.insertQuotaRows(kept, now, note);
  }

  /** 既に保存済みの重複した観測を間引く（版4より前の DB 用。最新値は quota_latest へ移す） */
  compactQuota(): number {
    this.db.exec(`
      INSERT OR IGNORE INTO quota_latest(window_key, provider, account_key, limit_id, window_kind, window_minutes, scope_models, plan_type, observed_at, used_percent, resets_at, source, precision, flags)
      SELECT provider || '|' || COALESCE(account_key, 'unknown') || '|' || limit_id || '|' || COALESCE(window_minutes, 'x') || '|' || COALESCE(scope_models, 'all'),
             provider, account_key, limit_id, window_kind, window_minutes, scope_models, plan_type, observed_at, used_percent, resets_at, source, precision, flags
      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY provider, account_key, limit_id, window_minutes, scope_models ORDER BY observed_at DESC) rn FROM quota_observations) WHERE rn = 1`);
    const r = this.db
      .prepare(
        `DELETE FROM quota_observations WHERE id IN (
           SELECT id FROM (
             SELECT id, source, ROW_NUMBER() OVER (
               PARTITION BY provider, COALESCE(account_key, ''), limit_id, COALESCE(window_minutes, -1), used_percent, resets_at, observed_at / ${QUOTA_BUCKET_MS}
               ORDER BY observed_at) rn
             FROM quota_observations) WHERE rn > 1 AND source != 'manual')`,
      )
      .run();
    return Number(r.changes);
  }

  /** API料金換算が未計算のイベントを、少しずつ計算して保存する。残りの件数を返す。 */
  backfillCosts(limit = 20000): number {
    const rows = this.db
      .prepare(
        `SELECT event_key, provider, model, ts, speed, inference_geo, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output, reasoning, unclassified
         FROM usage_events WHERE cost_nano IS NULL LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    const up = this.st.get('UPDATE usage_events SET cost_nano = ?, priced = ? WHERE event_key = ?');
    for (const r of rows) {
      const p = this.pricing.price(
        {
          provider: r.provider as 'claude',
          model: (r.model as string | null) ?? null,
          tsMs: Number(r.ts),
          speed: (r.speed as string | null) ?? null,
          inferenceGeo: (r.inference_geo as string | null) ?? null,
          tokens: {
            inputUncached: Number(r.input_uncached),
            cacheRead: Number(r.cache_read),
            cacheWrite: Number(r.cache_write),
            cacheWrite5m: r.cache_write_5m == null ? null : Number(r.cache_write_5m),
            cacheWrite1h: r.cache_write_1h == null ? null : Number(r.cache_write_1h),
            output: Number(r.output),
            reasoning: r.reasoning == null ? null : Number(r.reasoning),
            unclassified: Number(r.unclassified ?? 0),
            providerTotal: null,
          },
        },
        'historical',
      );
      up.run(p.priced ? p.nanoUsd : 0, p.priced ? 1 : 0, String(r.event_key));
    }
    return rows.length < limit ? 0 : (this.db.prepare('SELECT COUNT(*) n FROM usage_events WHERE cost_nano IS NULL').get() as { n: number }).n;
  }

  private insertQuotaRows(obs: QuotaObservation[], now: number, note: string | null): number {
    const s = this.st.get(`
      INSERT OR IGNORE INTO quota_observations(obs_key, provider, account_key, plan_type, limit_id, window_kind, window_minutes, scope_models, observed_at, used_percent, resets_at, source, precision, flags, origin_ref, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const o of obs) {
      const r = s.run(
        o.obsKey,
        o.provider,
        o.accountKey,
        o.planType,
        o.limitId,
        o.windowKind,
        o.windowMinutes,
        o.scopeModels,
        o.observedAtMs,
        o.usedPercent,
        o.resetsAtMs,
        o.source,
        o.precision,
        JSON.stringify(o.flags),
        o.originRef,
        note,
        now,
      );
      n += Number(r.changes);
    }
    return n;
  }

  deleteManualQuota(id: number): number {
    const n = Number(this.st.get("DELETE FROM quota_observations WHERE id = ? AND source = 'manual'").run(id).changes);
    if (n > 0) {
      // 最新値が手動記録だった場合に備えて、最新値の表を作り直す
      this.db.exec('DELETE FROM quota_latest');
      this.compactQuota();
    }
    return n;
  }

  setQuotaSourceStatus(source: string, status: string, detail: string | null, now: number): void {
    this.st
      .get(
        'INSERT INTO quota_source_status(source, status, detail, updated_at) VALUES (?,?,?,?) ON CONFLICT(source) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at',
      )
      .run(source, status, detail, now);
  }

  // ---------- 取り込み結果をまとめて保存 ----------

  applyParseOutput(out: ParseOutput, now: number): UpsertStats {
    const stats = this.upsertEvents(out.events, now);
    this.upsertTurns(out.turns);
    this.upsertSessions(out.sessions);
    this.insertQuota(out.quota, now);
    return stats;
  }

  // ---------- 読み取り位置 ----------

  getCursor(fileKey: string): FileCursor | null {
    const r = this.st.get('SELECT * FROM file_cursors WHERE file_key = ?').get(fileKey) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      fileKey: String(r.file_key),
      sourceId: String(r.source_id),
      path: String(r.path),
      compressed: r.compressed === 1,
      size: Number(r.size),
      mtimeMs: Number(r.mtime_ms),
      offset: Number(r.offset),
      headHash: (r.head_hash as string | null) ?? null,
      parserState: (r.parser_state as string | null) ?? null,
      parserVersion: String(r.parser_version),
      badLines: Number(r.bad_lines),
      status: String(r.status),
      error: (r.error as string | null) ?? null,
    };
  }

  putCursor(c: FileCursor, now: number): void {
    this.st
      .get(`
      INSERT INTO file_cursors(file_key, source_id, path, compressed, size, mtime_ms, offset, head_hash, parser_state, parser_version, bad_lines, status, error, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_key) DO UPDATE SET source_id = excluded.source_id, path = excluded.path, compressed = excluded.compressed, size = excluded.size,
        mtime_ms = excluded.mtime_ms, offset = excluded.offset, head_hash = excluded.head_hash, parser_state = excluded.parser_state,
        parser_version = excluded.parser_version, bad_lines = excluded.bad_lines, status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`)
      .run(
        c.fileKey,
        c.sourceId,
        c.path,
        c.compressed ? 1 : 0,
        c.size,
        c.mtimeMs,
        c.offset,
        c.headHash,
        c.parserState,
        c.parserVersion,
        c.badLines,
        c.status,
        c.error,
        now,
      );
  }

  // ---------- データ元 ----------

  upsertSource(s: {
    sourceId: string;
    provider: string;
    kind: string;
    rootPath: string;
    label: string | null;
  }): void {
    this.st
      .get(
        `INSERT INTO data_sources(source_id, provider, kind, root_path, label) VALUES (?,?,?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET root_path = excluded.root_path, label = COALESCE(data_sources.label, excluded.label)`,
      )
      .run(s.sourceId, s.provider, s.kind, s.rootPath, s.label);
  }

  setSourceStatus(sourceId: string, status: string, detail: string | null, fileCount: number, now: number): void {
    this.st
      .get('UPDATE data_sources SET status = ?, status_detail = ?, file_count = ?, last_scan_at = ? WHERE source_id = ?')
      .run(status, detail, fileCount, now, sourceId);
  }
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** 観測を間引く区切りの幅 */
export const QUOTA_BUCKET_MS = 15 * 60 * 1000;

/** 枠の識別子（src/core/quota/cycles.ts の windowKey と同じ形） */
export function quotaWindowKey(o: { provider: string; accountKey: string | null; limitId: string; windowMinutes: number | null; scopeModels: string | null }): string {
  return [o.provider, o.accountKey ?? 'unknown', o.limitId, o.windowMinutes ?? 'x', o.scopeModels ?? 'all'].join('|');
}
