// 取り込みの本体。データ元を探し、変化したファイルだけを差分で読み、DB へ保存する。
// 1つのファイルの処理は直列に行い、同じファイルを同時に解析しない。

import { stat } from 'node:fs/promises';
import type { Provider } from '../core/model/types.ts';
import { emptyParseOutput, type BillingMode, type ParseOutput } from '../core/model/types.ts';
import { CLAUDE_PARSER_VERSION, ClaudeFileParser, type ClaudeParserState } from '../core/sources/claude/parser.ts';
import { CODEX_PARSER_VERSION, CodexFileParser, type CodexParserState } from '../core/sources/codex/parser.ts';
import { STATUSLINE_PARSER_VERSION, parseBridgeLine } from '../core/quota/claudeStatusline.ts';
import { inTransaction, type Db } from '../db/database.ts';
import { WriteRepo, type FileCursor } from '../db/writeRepo.ts';
import { fileKeyFor, rolloutBaseName, scanSource, type FileInfo, type SourceDef } from './discovery.ts';
import { headFingerprint, readPlainLines, readZstdLines, sameHead } from './lineReader.ts';

export interface IngestProgress {
  phase: 'idle' | 'scanning' | 'watching';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  eventsInserted: number;
  eventsUpdated: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastChangeAt: number | null;
  errors: number;
}

export interface FileResult {
  skipped: boolean;
  reason?: string;
  inserted: number;
  updated: number;
  lines: number;
  badLines: number;
  quota: number;
}

interface SourceSettings {
  enabled: boolean;
  accountKey: string | null;
  billingMode: BillingMode;
}

type AnyParser =
  | { kind: 'claude'; p: ClaudeFileParser }
  | { kind: 'codex'; p: CodexFileParser }
  | { kind: 'statusline'; accountKey: string | null; fileKey: string };

const FLUSH_EVENTS = 4000;

export class IngestEngine {
  readonly repo: WriteRepo;
  private chain: Promise<unknown> = Promise.resolve();
  progress: IngestProgress = {
    phase: 'idle',
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    startedAt: null,
    finishedAt: null,
    lastChangeAt: null,
    errors: 0,
  };
  /** 最後に把握したファイル一覧（監視対象の照合に使う） */
  private readonly knownFiles = new Map<string, { def: SourceDef; file: FileInfo }>();

  private readonly db: Db;
  private readonly defs: () => SourceDef[];
  private readonly now: () => number;
  private readonly onChange: ((r: { inserted: number; updated: number; quota: number }) => void) | undefined;

  constructor(
    db: Db,
    defs: () => SourceDef[],
    now: () => number = Date.now,
    onChange?: (r: { inserted: number; updated: number; quota: number }) => void,
  ) {
    this.db = db;
    this.defs = defs;
    this.now = now;
    this.onChange = onChange;
    this.repo = new WriteRepo(db);
  }

  /** 処理を直列化する。同じファイルの解析が競合しないようにするため。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private sourceSettings(sourceId: string): SourceSettings {
    const r = this.db.prepare('SELECT enabled, account_key, billing_mode FROM data_sources WHERE source_id = ?').get(sourceId) as
      | { enabled: number; account_key: string | null; billing_mode: string }
      | undefined;
    return {
      enabled: r ? r.enabled === 1 : true,
      accountKey: r?.account_key ?? null,
      billingMode: (r?.billing_mode as BillingMode | undefined) ?? 'unknown',
    };
  }

  /** すべてのデータ元を走査し、変化したファイルを取り込む。 */
  scanAll(): Promise<IngestProgress> {
    return this.serial(async () => {
      const t0 = this.now();
      this.progress = { ...this.progress, phase: 'scanning', startedAt: t0, finishedAt: null, filesDone: 0, bytesDone: 0, errors: 0 };
      const work: { def: SourceDef; file: FileInfo }[] = [];
      const activeCodex = new Map<string, Set<string>>();
      const scans: { def: SourceDef; files: FileInfo[] }[] = [];
      for (const def of this.defs()) {
        this.repo.upsertSource({ sourceId: def.sourceId, provider: def.provider, kind: def.kind, rootPath: def.rootPath, label: def.label });
        const settings = this.sourceSettings(def.sourceId);
        if (!settings.enabled) {
          this.repo.setSourceStatus(def.sourceId, 'disabled', null, 0, this.now());
          continue;
        }
        const scan = await scanSource(def);
        this.repo.setSourceStatus(def.sourceId, scan.status, scan.detail, scan.files.length, this.now());
        scans.push({ def, files: scan.files });
        if (def.role === 'codex_sessions' && def.homeKey) {
          activeCodex.set(def.homeKey, new Set(scan.files.map((f) => rolloutBaseName(f.path))));
        }
      }
      for (const { def, files } of scans) {
        for (const f of files) {
          // archived_sessions の同名ファイルが sessions にもある場合は、sessions 側を正とする
          if (def.role === 'codex_archived' && def.homeKey && activeCodex.get(def.homeKey)?.has(rolloutBaseName(f.path))) continue;
          work.push({ def, file: f });
          this.knownFiles.set(f.path.toLowerCase(), { def, file: f });
        }
      }
      // 新しいファイルから読む（直近の利用を早く表示するため）
      work.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
      this.progress.filesTotal = work.length;
      this.progress.bytesTotal = work.reduce((s, w) => s + w.file.size, 0);
      for (const w of work) {
        try {
          await this.processFileNow(w.def, w.file);
        } catch (e) {
          this.progress.errors++;
          this.markFileError(w.def, w.file, e);
        }
        this.progress.filesDone++;
        this.progress.bytesDone += w.file.size;
      }
      this.progress.phase = 'watching';
      this.progress.finishedAt = this.now();
      return { ...this.progress };
    });
  }

  /** 監視で変化を見つけたファイルを取り込む。 */
  processPath(path: string): Promise<FileResult | null> {
    return this.serial(async () => {
      const known = this.knownFiles.get(path.toLowerCase());
      let def = known?.def;
      if (!def) {
        def = this.defs().find((d) => path.toLowerCase().startsWith(d.rootPath.toLowerCase()));
        if (!def) return null;
      }
      if (!this.sourceSettings(def.sourceId).enabled) return null;
      const scan = await scanSingle(def, path);
      if (!scan) return null;
      this.knownFiles.set(path.toLowerCase(), { def, file: scan });
      try {
        return await this.processFileNow(def, scan);
      } catch (e) {
        this.progress.errors++;
        this.markFileError(def, scan, e);
        return null;
      }
    });
  }

  /** 最近変化したファイルの大きさを確かめる（監視通知の取りこぼし対策の軽い再確認）。 */
  async recheckHotFiles(windowMs = 15 * 60 * 1000): Promise<number> {
    const since = this.now() - windowMs;
    const rows = this.db.prepare('SELECT path, size, mtime_ms FROM file_cursors WHERE updated_at >= ? AND compressed = 0').all(since) as {
      path: string;
      size: number;
      mtime_ms: number;
    }[];
    let n = 0;
    for (const r of rows) {
      try {
        const s = await stat(r.path);
        if (s.size !== r.size || Math.floor(s.mtimeMs) !== r.mtime_ms) {
          await this.processPath(r.path);
          n++;
        }
      } catch {
        /* 移動・削除された。次の全体走査で扱う */
      }
    }
    return n;
  }

  private markFileError(def: SourceDef, file: FileInfo, e: unknown): void {
    const code = (e as NodeJS.ErrnoException)?.code;
    const status = code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : code === 'ENOENT' ? 'missing' : 'error';
    const prev = this.repo.getCursor(file.fileKey);
    this.repo.putCursor(
      {
        fileKey: file.fileKey,
        sourceId: def.sourceId,
        path: file.path,
        compressed: file.compressed,
        size: prev?.size ?? 0,
        mtimeMs: prev?.mtimeMs ?? 0,
        offset: prev?.offset ?? 0,
        headHash: prev?.headHash ?? null,
        parserState: prev?.parserState ?? null,
        parserVersion: prev?.parserVersion ?? parserVersionFor(def),
        badLines: prev?.badLines ?? 0,
        status,
        error: String((e as Error)?.message ?? e).slice(0, 500),
      },
      this.now(),
    );
  }

  private makeParser(def: SourceDef, file: FileInfo, state: string | null, settings: SourceSettings): AnyParser {
    if (def.role === 'claude_statusline') return { kind: 'statusline', accountKey: settings.accountKey, fileKey: file.fileKey };
    if (def.provider === 'claude') {
      return {
        kind: 'claude',
        p: new ClaudeFileParser(
          { fileKey: file.fileKey, sourceId: def.sourceId, isSubagentFile: file.isSubagent, accountKey: settings.accountKey, billingMode: settings.billingMode },
          state ? (JSON.parse(state) as ClaudeParserState) : null,
        ),
      };
    }
    return {
      kind: 'codex',
      p: new CodexFileParser(
        { fileKey: file.fileKey, sourceId: def.sourceId, accountKey: settings.accountKey, billingMode: settings.billingMode },
        state ? (JSON.parse(state) as CodexParserState) : null,
      ),
    };
  }

  /** 1ファイルを処理する。呼び出し側で直列化されていること。 */
  async processFileNow(def: SourceDef, file: FileInfo): Promise<FileResult> {
    const result: FileResult = { skipped: false, inserted: 0, updated: 0, lines: 0, badLines: 0, quota: 0 };
    const version = parserVersionFor(def);
    const cursor = this.repo.getCursor(file.fileKey);
    const settings = this.sourceSettings(def.sourceId);
    const s = await stat(file.path);
    const size = s.size;
    const mtimeMs = Math.floor(s.mtimeMs);

    let offset = 0;
    let state: string | null = null;
    let badLines = 0;
    if (cursor && cursor.parserVersion !== version) {
      // 読み取り処理の版が変わった: このファイル由来の古いイベントを消してから最初から読み直す。
      // 正しいイベントは読み直しで同じ鍵のまま入り直すため、合計は新しい処理の結果だけになる。
      inTransaction(this.db, () => {
        this.db.prepare('DELETE FROM usage_events WHERE origin_file_key = ? AND parser_version != ?').run(file.fileKey, version);
      });
    }
    if (file.compressed) {
      // 圧縮ファイルは途中から再開できない。完了済みで変化が無ければ読まず、それ以外は最初から読む。
      if (cursor && cursor.parserVersion === version && cursor.status === 'complete' && cursor.size === size && cursor.mtimeMs === mtimeMs) {
        return { ...result, skipped: true, reason: 'unchanged' };
      }
    } else if (cursor && cursor.parserVersion === version && cursor.status !== 'error') {
      if (size < cursor.offset) {
        // 切り詰められた: 最初から読み直す（鍵で重複排除されるため合計は増えない）
      } else if (!(await sameHead(file.path, cursor.headHash))) {
        // 別の内容に置き換えられた: 最初から読み直す
      } else if (size === cursor.offset) {
        if (cursor.mtimeMs !== mtimeMs) this.repo.putCursor({ ...cursor, mtimeMs, status: 'ok', error: null }, this.now());
        return { ...result, skipped: true, reason: 'unchanged' };
      } else {
        offset = cursor.offset;
        state = cursor.parserState;
        badLines = cursor.badLines;
      }
    }

    const parser = this.makeParser(def, file, state, settings);
    let out: ParseOutput = emptyParseOutput();

    const feed = (line: string, off: number) => {
      result.lines++;
      if (parser.kind === 'statusline') {
        const obs = parseBridgeLine(line, parser.accountKey, `${parser.fileKey}@${off}`);
        if (obs.length === 0 && line.trim()) out.badLines++;
        out.quota.push(...obs);
      } else {
        parser.p.feed(line, off, out);
      }
    };

    const flush = async (endOffset: number, complete: boolean) => {
      const head = file.compressed ? null : await headFingerprint(file.path, endOffset);
      const parserState = parser.kind === 'statusline' ? null : JSON.stringify(parser.p.getState());
      const batch = out;
      out = emptyParseOutput();
      badLines += batch.badLines;
      const now = this.now();
      const stats = inTransaction(this.db, () => {
        const st = this.repo.applyParseOutput(batch, now);
        const c: FileCursor = {
          fileKey: file.fileKey,
          sourceId: def.sourceId,
          path: file.path,
          compressed: file.compressed,
          size,
          mtimeMs,
          offset: endOffset,
          headHash: head,
          parserState,
          parserVersion: version,
          badLines,
          status: complete ? 'complete' : 'ok',
          error: null,
        };
        this.repo.putCursor(c, now);
        return st;
      });
      result.inserted += stats.inserted;
      result.updated += stats.updated;
      result.quota += batch.quota.length;
    };

    if (file.compressed) {
      let processed = 0;
      // 圧縮ファイルは途中から再開できないため、途中の保存では読み取り位置を「未完了」にしておく
      await readZstdLines(file.path, async (line, off) => {
        feed(line, off);
        processed = off + line.length + 1;
        if (out.events.length >= FLUSH_EVENTS) await flush(0, false);
      });
      await flush(processed, true);
    } else {
      const r = await readPlainLines(file.path, offset, feed, async (end) => flush(end, false));
      await flush(r.endOffset, false);
    }

    if (parser.kind === 'codex') {
      const st = parser.p.getState();
      if (st.planType && st.sessionId) this.repo.markSessionBilling('codex', st.sessionId, 'subscription');
    }
    result.badLines = badLines;
    this.progress.eventsInserted += result.inserted;
    this.progress.eventsUpdated += result.updated;
    if (result.inserted + result.updated + result.quota > 0) {
      this.progress.lastChangeAt = this.now();
      this.onChange?.({ inserted: result.inserted, updated: result.updated, quota: result.quota });
    }
    return result;
  }
}

export function parserVersionFor(def: { provider: Provider; role: string }): string {
  if (def.role === 'claude_statusline') return STATUSLINE_PARSER_VERSION;
  return def.provider === 'claude' ? CLAUDE_PARSER_VERSION : CODEX_PARSER_VERSION;
}

async function scanSingle(def: SourceDef, path: string): Promise<FileInfo | null> {
  const lower = path.toLowerCase();
  const compressed = lower.endsWith('.jsonl.zst');
  if (!compressed && !lower.endsWith('.jsonl')) return null;
  if (def.provider === 'codex' && !/[\\/]rollout-[^\\/]+$/.test(path)) return null;
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return {
      path,
      fileKey: fileKeyFor(path),
      size: s.size,
      mtimeMs: Math.floor(s.mtimeMs),
      compressed,
      isSubagent: /[\\/]subagents[\\/]/.test(path),
    };
  } catch {
    return null;
  }
}
