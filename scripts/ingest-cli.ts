// 開発用: 画面なしで実ログを取り込み、件数と所要時間を表示する。
// 使い方: node scripts/ingest-cli.ts <DBのパス> [--again]
// 元のログは読むだけで変更しない。

import { openDatabase } from '../src/db/database.ts';
import { IngestEngine } from '../src/ingest/engine.ts';
import { defaultSourceDefs } from '../src/ingest/discovery.ts';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('DB のパスを指定してください');
  process.exit(2);
}
const db = openDatabase(dbPath);
const engine = new IngestEngine(db, () => defaultSourceDefs());
const t0 = Date.now();
const timer = setInterval(() => {
  const p = engine.progress;
  console.error(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] files ${p.filesDone}/${p.filesTotal} bytes ${(p.bytesDone / 1e9).toFixed(2)}/${(p.bytesTotal / 1e9).toFixed(2)}GB ins ${p.eventsInserted} upd ${p.eventsUpdated} err ${p.errors} rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`,
  );
}, 10000);
const p = await engine.scanAll();
const t1 = Date.now();
let again: string | null = null;
if (process.argv.includes('--again')) {
  await engine.scanAll();
  again = `${Date.now() - t1}ms`;
}
clearInterval(timer);
const summary = db
  .prepare(
    `SELECT provider, COUNT(*) events, SUM(total) total, SUM(input_uncached) input, SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(output) output,
            SUM(finality = 0) partial, MIN(ts) first_ts, MAX(ts) last_ts FROM usage_events GROUP BY provider`,
  )
  .all();
const quota = db.prepare('SELECT provider, source, window_kind, COUNT(*) n, MAX(observed_at) last FROM quota_observations GROUP BY 1,2,3').all();
const sources = db.prepare('SELECT source_id, status, file_count, status_detail FROM data_sources').all();
const cursors = db.prepare('SELECT status, COUNT(*) n, SUM(bad_lines) bad FROM file_cursors GROUP BY status').all();
const revisions = db.prepare('SELECT COUNT(*) n FROM event_revisions').get();
console.log(
  JSON.stringify(
    {
      seconds: (t1 - t0) / 1000,
      secondScan: again,
      progress: p,
      summary,
      quota,
      sources,
      cursors,
      revisions,
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
    },
    null,
    1,
  ),
);
db.close();
