// 開発用: 配布物（release/win-unpacked）を起動し、画面が出て取り込みが動くか、メモリ使用量を確かめる。
// 使い方: node scripts/check-packaged.ts <実行ファイル> <データフォルダー> <ログのホーム（空でもよい）>

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const [exe, dataDir, home] = process.argv.slice(2) as [string, string, string];
const t0 = Date.now();
const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, TOKEN_CALENDAR_DATA_DIR: dataDir, ...(home ? { TOKEN_CALENDAR_HOME: home } : {}) } });
const page = await app.firstWindow();
await page.waitForSelector('.cal-grid button.cell', { timeout: 60000 });
console.log('window ready ms', Date.now() - t0);
await page.waitForSelector('section[aria-labelledby="recent-h"]', { timeout: 30000 });
await page.waitForTimeout(8000);
console.log('recent:', (await page.locator('section[aria-labelledby="recent-h"]').innerText()).split('\n').slice(0, 3).join(' | '));
const pid = app.process().pid!;
// 本体と子プロセス（画面・GPU など）の使用メモリ（ワーキングセット）の合計
const ps = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `$root=${pid}; $all=Get-CimInstance Win32_Process; $ids=@($root); do { $n=$ids.Count; $ids=@($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })) | Select-Object -Unique } while ($ids.Count -gt $n); ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum / 1MB; $ids.Count`,
  ],
  { encoding: 'utf8' },
);
console.log('memory MB / processes:', ps.trim().split(/\r?\n/).join(' / '));
await app.close();
