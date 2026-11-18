// 開発用: アプリを起動して各ページの画像を保存する（ホストのマウス・キーボードは使わない）。
// 使い方: node scripts/screenshots.ts <データフォルダー> <出力フォルダー> [言語（ja-JP / en-US）]
// データフォルダーに token-calendar.sqlite があれば、それを使って起動する。
// 英語で撮る場合は、ダッシュボードと消費率のページだけを撮る（ほかのページの操作は日本語の名前で行うため）。

import { _electron as electron } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2]!;
const outDir = process.argv[3]!;
const lang = process.argv[4] ?? 'ja-JP';
mkdirSync(outDir, { recursive: true });

const app = await electron.launch({ args: ['out/main/index.js', `--lang=${lang}`], env: { ...process.env, TOKEN_CALENDAR_DATA_DIR: dataDir } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 960 });
await page.waitForSelector('nav', { timeout: 60000 });
const shot = async (name: string, fullPage = false) => {
  await page.waitForTimeout(800);
  // 結果を待っている間の「読み込み中…」が消えるまで待つ
  await page.waitForFunction(`!document.querySelector('.page [role="status"]') && !/読み込み中|Loading/.test(document.querySelector('.page')?.textContent ?? '')`, null, { timeout: 90000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
  console.log('saved', name);
};
// 起動直後はダッシュボード
await page.waitForSelector('.metric', { timeout: 90000 }).catch(() => undefined);
await shot('00-dashboard', true);
await page.locator('details summary').first().click();
await page.locator('details').first().scrollIntoViewIfNeeded();
await shot('00b-dashboard-simulator');
await page.locator('nav button').nth(1).click();
await shot('00c-rates', true);
if (lang.startsWith('ja')) {
  await page.getByRole('button', { name: /カレンダー/ }).click();
  await page.waitForSelector('.cal-grid button.cell', { timeout: 60000 });
  await shot('01-calendar-daily');
  await page.getByRole('group', { name: 'provider' }).getByRole('button', { name: 'Codex' }).click();
  await page.getByRole('group', { name: 'mode' }).getByRole('button', { name: 'リセット周期内累積' }).click();
  await shot('02-calendar-codex-cumulative');
  await page.getByRole('group', { name: 'measure' }).getByRole('button', { name: 'API料金換算' }).click();
  await shot('03-calendar-codex-cost');
  await page.locator('.cell.today').click();
  await page.waitForSelector('section[aria-label="日別の詳細"]', { timeout: 20000 });
  await page.locator('section[aria-label="日別の詳細"]').scrollIntoViewIfNeeded();
  await shot('04-day-detail');
  await page.getByRole('button', { name: /時系列/ }).click();
  await shot('05-timeline-days');
  await page.getByRole('group', { name: 'granularity' }).getByRole('button', { name: '5時間単位' }).click();
  await shot('06-timeline-5h');
  await page.getByRole('button', { name: '推定', exact: true }).click();
  await shot('07-estimate');
  await page.getByRole('button', { name: /分析/ }).click();
  await shot('08-analysis');
  await page.getByRole('button', { name: /データ元/ }).click();
  await shot('09-sources');
}
await app.close();
