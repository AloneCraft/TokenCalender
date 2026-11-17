// 開発用の検証: Codex の rollout ファイルごとに、取り込み処理とは別の素朴な方法で使用量を計算し、DB と比べる。
//   R 型（応答ごとの記録がファイルの最初からある）: 記録の usage の合計
//   T 型（token_count だけで累積が減らない）        : 最後の累積 −（最初の累積 − 最初の last）
//   M 型（token_count だけで累積が減る＝複数列）     : 「前回値＋last＝今回」で列を組み、各列の（最後 − 最初 ＋ 最初の last）の合計
//   X 型（記録が途中から始まる等）                  : 比較対象外（件数だけ数える）
// fork の引き継ぎ行（subagent_history_start_ordinal より前）は除く。
// 使い方: node scripts/verify-codex-totals.ts <DBのパス> [ファイル数の上限]

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { openDatabase } from '../src/db/database.ts';

const db = openDatabase(process.argv[2]!, { readOnly: true });
const limit = Number(process.argv[3] ?? 400);
const files = db
  .prepare("SELECT file_key, path, compressed FROM file_cursors WHERE source_id LIKE 'codex%' ORDER BY updated_at DESC LIMIT ?")
  .all(limit) as { file_key: string; path: string; compressed: number }[];
db.exec('CREATE TEMP TABLE IF NOT EXISTS sums AS SELECT origin_file_key k, SUM(total) t, COUNT(*) n FROM usage_events GROUP BY origin_file_key');
const sumByFile = db.prepare('SELECT COALESCE(t,0) t, COALESCE(n,0) n FROM sums WHERE k = ?');

type Cls = 'R' | 'T' | 'M' | 'X';
const stats: Record<Cls, { files: number; match: number; indep: number; db: number }> = {
  R: { files: 0, match: 0, indep: 0, db: 0 },
  T: { files: 0, match: 0, indep: 0, db: 0 },
  M: { files: 0, match: 0, indep: 0, db: 0 },
  X: { files: 0, match: 0, indep: 0, db: 0 },
};
const samples: unknown[] = [];

for (const f of files) {
  let text: string;
  try {
    text = f.compressed ? zstdDecompressSync(readFileSync(f.path)).toString('utf8') : readFileSync(f.path, 'utf8');
  } catch {
    continue;
  }
  let start: number | null = null;
  const recs: { usage: number; cum: number }[] = [];
  const tcs: { total: number; last: number }[] = [];
  let firstRecordAfterTc = false;
  for (const line of text.split('\n')) {
    const head = line.slice(0, 200);
    if (!/"type":"(session_meta|token_usage_record|event_msg)"/.test(head)) continue;
    if (head.includes('"event_msg"') && !head.includes('"token_count"')) continue;
    let o: { ordinal?: number; type: string; payload: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session_meta') {
      if (start === null && typeof o.payload.subagent_history_start_ordinal === 'number') start = o.payload.subagent_history_start_ordinal;
      continue;
    }
    if (start != null && o.ordinal != null && o.ordinal < start) continue;
    if (o.type === 'token_usage_record') {
      if (recs.length === 0 && tcs.length > 0) firstRecordAfterTc = true;
      recs.push({ usage: o.payload.usage.total_tokens, cum: o.payload.thread_token_usage.total_tokens });
    } else if (o.payload.info) {
      tcs.push({ total: o.payload.info.total_token_usage.total_tokens, last: o.payload.info.last_token_usage.total_tokens });
    }
  }
  let cls: Cls;
  let indep = 0;
  if (recs.length > 0) {
    cls = firstRecordAfterTc || start != null ? 'X' : 'R';
    indep = recs.reduce((s, r) => s + r.usage, 0);
  } else if (tcs.length > 0) {
    const dec = tcs.some((t, i) => i > 0 && t.total < tcs[i - 1]!.total);
    cls = dec ? 'M' : 'T';
    if (!dec) {
      const first = tcs[0]!;
      indep = tcs[tcs.length - 1]!.total - (first.total - first.last);
    } else {
      const chains: { first: { total: number; last: number }; lastTotal: number }[] = [];
      const seen = new Set<number>();
      for (const t of tcs) {
        if (seen.has(t.total)) continue;
        seen.add(t.total);
        const c = chains.find((x) => x.lastTotal + t.last === t.total);
        if (c) c.lastTotal = t.total;
        else chains.push({ first: t, lastTotal: t.total });
      }
      indep = chains.reduce((s, c) => s + (c.lastTotal - (c.first.total - c.first.last)), 0);
    }
  } else continue;
  if (start != null && cls !== 'X') cls = 'X';
  const r = (sumByFile.get(f.file_key) as { t: number; n: number } | undefined) ?? { t: 0, n: 0 };
  const s = stats[cls];
  s.files++;
  s.indep += indep;
  s.db += r.t;
  if (indep === r.t) s.match++;
  else if (cls !== 'X' && samples.length < 8) samples.push({ cls, indep, db: r.t, events: r.n, recs: recs.length, tcs: tcs.length });
}
console.log(JSON.stringify({ files: files.length, stats, samples }, null, 1));
