// 取り込み用の別スレッド。DB へ書き込むのはこのスレッドだけ（設定・手動記録を除く）。
// 起動時に全体を走査し、その後はファイル監視と軽い再確認で差分を取り込む。

import { parentPort, workerData } from 'node:worker_threads';
import { watch, type FSWatcher } from 'chokidar';
import { openDatabase } from '../db/database.ts';
import { getSetting } from '../db/readRepo.ts';
import { IngestEngine } from './engine.ts';
import { defaultSourceDefs, manualSourceDefs, sourceIdFor, type SourceDef } from './discovery.ts';

interface WorkerInit {
  dbPath: string;
  bridgeDir: string;
}

export type IngestWorkerMessage = { type: 'rescan' } | { type: 'stop' };

const init = workerData as WorkerInit;
const db = openDatabase(init.dbPath);
const port = parentPort!;

// 試験・開発用: ログを探すホームフォルダーだけを差し替える（OS のホームは変えない。Electron が起動できなくなるため）
const logHome = process.env.TOKEN_CALENDAR_HOME || undefined;

function sourceDefs(): SourceDef[] {
  const defs = defaultSourceDefs(process.env, logHome);
  const extra = getSetting<{ provider: 'claude' | 'codex'; path: string }[]>(db, 'extraSources', []);
  for (const e of extra) defs.push(...manualSourceDefs(e.provider, e.path));
  defs.push({
    sourceId: sourceIdFor('claude_statusline', init.bridgeDir),
    provider: 'claude',
    kind: 'bridge',
    role: 'claude_statusline',
    rootPath: init.bridgeDir,
    label: 'Claude ステータスライン連携',
  });
  return defs;
}

let changedPending = false;
const engine = new IngestEngine(db, sourceDefs, Date.now, () => {
  changedPending = true;
});

// 変化の通知はまとめて送る（画面の再描画を増やしすぎない）
setInterval(() => {
  if (changedPending) {
    changedPending = false;
    port.postMessage({ type: 'changed', at: Date.now() });
  }
}, 250);
setInterval(() => port.postMessage({ type: 'progress', progress: engine.progress }), 1000);

let watcher: FSWatcher | null = null;

function startWatcher(): void {
  watcher?.close().catch(() => undefined);
  const roots = sourceDefs().map((d) => d.rootPath);
  watcher = watch(roots, {
    ignoreInitial: true,
    persistent: true,
    // 元のログには触れない（読み取りのみ）
    awaitWriteFinish: false,
    ignored: (p, stats) => !!stats?.isFile() && !/\.jsonl(\.zst)?$/i.test(p),
  });
  const onPath = (p: string) => {
    void engine.processPath(p);
  };
  watcher.on('add', onPath).on('change', onPath).on('error', () => undefined);
}

/** 版4より前の DB の後片付け: 公式利用率の重複を間引き、未計算の API料金換算を少しずつ埋める */
async function maintenance(): Promise<void> {
  const removed = engine.repo.compactQuota();
  if (removed > 0) port.postMessage({ type: 'changed', at: Date.now() });
  for (;;) {
    const left = engine.repo.backfillCosts(20000);
    port.postMessage({ type: 'changed', at: Date.now() });
    if (left === 0) break;
    await new Promise((r) => setTimeout(r, 50)); // 他の処理に順番を譲る
  }
}

async function main(): Promise<void> {
  const debug = (label: string, t0: number) => {
    if (process.env.TOKEN_CALENDAR_DEBUG) console.error(`[ingest] ${label} ${(performance.now() - t0).toFixed(0)}ms`);
  };
  let t0 = performance.now();
  await maintenance();
  debug('maintenance', t0);
  t0 = performance.now();
  await engine.scanAll();
  debug('scanAll', t0);
  port.postMessage({ type: 'progress', progress: engine.progress });
  port.postMessage({ type: 'changed', at: Date.now() });
  startWatcher();
  // 監視通知の取りこぼし対策: 最近変化したファイルを数秒ごとに確かめる
  setInterval(() => {
    void engine.recheckHotFiles();
  }, 3000);
  // 新しいファイルや移動の検出: 1分ごとに全体を走査する（変化の無いファイルは読まない）
  setInterval(() => {
    void engine.scanAll();
  }, 60000);
}

port.on('message', (m: IngestWorkerMessage) => {
  if (m.type === 'rescan') {
    void engine.scanAll().then(() => startWatcher());
  } else if (m.type === 'stop') {
    void watcher?.close();
    db.close();
    process.exit(0);
  }
});

main().catch((e) => {
  port.postMessage({ type: 'error', message: String((e as Error)?.stack ?? e) });
});
