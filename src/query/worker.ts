// 問い合わせ用の別スレッド。画面からの要求を受けて集計し、結果を返す。
// 書き込むのは設定・手動記録・推定結果だけ。

import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase, type Db } from '../db/database.ts';
import { WriteRepo } from '../db/writeRepo.ts';
import { QueryService } from './service.ts';
import { handleCommand } from './commands.ts';

interface WorkerInit {
  dbPath: string;
  demoDbPath: string;
}

const init = workerData as WorkerInit;
let db: Db = openDatabase(init.dbPath);
let demoDb: Db | null = null;
const port = parentPort!;

function isDemo(): boolean {
  const r = db.prepare("SELECT value_json FROM settings WHERE key = 'demo'").get() as { value_json: string } | undefined;
  return r ? JSON.parse(r.value_json) === true : false;
}

function service(): QueryService {
  if (isDemo()) {
    if (!demoDb) demoDb = openDatabase(init.demoDbPath);
    return new QueryService(demoDb, { demo: true });
  }
  return new QueryService(db);
}

port.on('message', (m: { id: number; method: string; params: unknown }) => {
  try {
    if (m.method === '__reopen') {
      db.close();
      demoDb?.close();
      demoDb = null;
      db = openDatabase(init.dbPath);
      port.postMessage({ id: m.id, result: true });
      return;
    }
    if (m.method === '__close') {
      db.close();
      demoDb?.close();
      demoDb = null;
      port.postMessage({ id: m.id, result: true });
      return;
    }
    const t0 = performance.now();
    const result = handleCommand(m.method, m.params, { db, service: service(), repo: new WriteRepo(db), demoDbPath: init.demoDbPath });
    // 開発用: 要求ごとの所要時間を標準エラーへ出す
    if (process.env.TOKEN_CALENDAR_DEBUG) console.error(`[query] ${m.method} ${(performance.now() - t0).toFixed(0)}ms`);
    port.postMessage({ id: m.id, result });
  } catch (e) {
    port.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) });
  }
});
