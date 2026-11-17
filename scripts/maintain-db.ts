// 開発用: アプリの起動時と同じ後片付け（公式利用率の重複の間引き、未計算の API料金換算の計算）を画面なしで行う。
// 使い方: node scripts/maintain-db.ts <DBのパス>

import { openDatabase } from '../src/db/database.ts';
import { WriteRepo } from '../src/db/writeRepo.ts';

const db = openDatabase(process.argv[2]!);
const repo = new WriteRepo(db);
let t = performance.now();
console.log('compacted', repo.compactQuota(), `${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
let left = 1;
while (left > 0) left = repo.backfillCosts(20000);
console.log('backfill', `${(performance.now() - t).toFixed(0)} ms`);
console.log(db.prepare('SELECT COUNT(*) n FROM quota_observations').get(), db.prepare('SELECT COUNT(*) n FROM usage_events WHERE cost_nano IS NULL').get());
db.close();
