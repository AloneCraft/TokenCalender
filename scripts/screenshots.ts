// 開発用: アプリを起動して各ページの画像を保存する（ホストのマウス・キーボードは使わない）。
// 使い方: node scripts/screenshots.ts <データフォルダー> <出力フォルダー>
// データフォルダーに token-calendar.sqlite があれば、それを使って起動する。

import { _electron as electron } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2]!;
const outDir = process.argv[3]!;
mkdirSync(outDir, { recursive: true });

const app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, TOKEN_CALENDAR_DATA_DIR: dataDir } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 960 });
await page.waitForSelector('.cal-grid button.cell', { timeout: 60000 });
await page.waitForTimeout(4000);
const shot = async (name: string) => {
  await page.waitForTimeout(800);
  // 結果を待っている間の「読み込み中…」が消えるまで待つ
  await page.waitForFunction(`!document.querySelector('.page [role="status"]')`, null, { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });
  console.log('saved', name);
};
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
await page.getByRole('button', { name: /推定/ }).first().click();
await shot('07-estimate');
await page.getByRole('button', { name: /分析/ }).click();
await shot('08-analysis');
await page.getByRole('button', { name: /データ元/ }).click();
await shot('09-sources');
await app.close();
