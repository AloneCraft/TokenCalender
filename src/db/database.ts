import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

/** DB を開き、必要なら表を作る。readOnly のときは表を作らない。 */
export function openDatabase(path: string, opts: { readOnly?: boolean } = {}): Db {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly === true });
  db.exec('PRAGMA busy_timeout = 5000;');
  // 集計の読み込みを速くする: ページの記憶領域を 64MB に広げ、ファイルを直接割り当てて読む（256MB まで）
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA mmap_size = 268435456;');
  if (!opts.readOnly) {
    // 新しい DB を複数のスレッドが同時に初期化すると、busy_timeout が効かない形の
    // 「database is locked」が起きる（読み取りから書き込みへの格上げの競合）。短く待って再試行する。
    for (let attempt = 0; ; attempt++) {
      try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        migrate(db);
        break;
      } catch (e) {
        if (attempt >= 40 || !/locked|busy/i.test(String(e))) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + attempt * 5);
      }
    }
  }
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version++;
      db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(version),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** 関数を1つのトランザクションで実行する。失敗したら全体を取り消す。 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 取り消しの失敗は元の例外を優先する */
    }
    throw e;
  }
}

/** 同じ SQL の準備を繰り返さないための小さな入れ物。 */
export class StatementCache {
  private readonly map = new Map<string, StatementSync>();
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  get(sql: string): StatementSync {
    let s = this.map.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.map.set(sql, s);
    }
    return s;
  }
}
