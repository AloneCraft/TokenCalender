// 説明書用の画面写真を撮る。実際のログは読まず（空のフォルダーをログの場所にする）、デモ表示（架空のデータ）で撮る。
// 使い方: node scripts/manual-shots.ts <作業フォルダー> <出力フォルダー> <ja|en>

import { _electron as electron } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const work = process.argv[2]!;
const outDir = process.argv[3]!;
const lang = process.argv[4] === 'en' ? 'en' : 'ja';
rmSync(work, { recursive: true, force: true });
const home = join(work, 'home');
const data = join(work, 'data');
mkdirSync(home, { recursive: true });
mkdirSync(data, { recursive: true });
mkdirSync(outDir, { recursive: true });

const L =
  lang === 'ja'
    ? { settings: '設定', demo: 'デモ表示（架空のデータ）', home: '利用枠', rates: '消費率', calendar: 'カレンダー', timeline: '時系列', banner: 'デモ表示中', cumulative: 'リセット周期内累積' }
    : { settings: 'Settings', demo: 'Demo mode (fictional data)', home: 'Limits', rates: 'Rates', calendar: 'Calendar', timeline: 'Timeline', banner: 'Demo mode', cumulative: 'Cumulative within reset cycle' };

const app = await electron.launch({
  args: ['out/main/index.js', `--lang=${lang === 'ja' ? 'ja-JP' : 'en-US'}`],
  env: { ...process.env, TOKEN_CALENDAR_HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: '', TOKEN_CALENDAR_DATA_DIR: data },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1360, height: 900 });
await page.waitForSelector('nav');
const nav = (name: string) => page.getByRole('button', { name, exact: true }).click();
const settle = async () => {
  await page.waitForTimeout(800);
  await page.waitForFunction(`!/読み込み中|Loading/.test(document.querySelector('.page')?.textContent ?? '')`, null, { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(900);
};
const shot = async (name: string, fullPage = false) => {
  await settle();
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
  console.log('saved', name);
};

await nav(L.settings);
await page.getByLabel(L.demo).click();
await page.locator('.banner.demo').waitFor({ timeout: 30000 });
await nav(L.home);
await page.waitForSelector('.metric', { timeout: 60000 });
await shot('dashboard');
await page.locator('details summary').first().click();
await page.locator('details').first().scrollIntoViewIfNeeded();
await shot('simulator');
await nav(L.rates);
await shot('rates');
await nav(L.calendar);
await page.waitForSelector('.cal-grid button.cell', { timeout: 60000 });
await page.getByRole('group', { name: 'provider' }).getByRole('button', { name: 'Codex' }).click();
await page.getByRole('group', { name: 'mode' }).getByRole('button', { name: L.cumulative }).click();
await shot('calendar');
await nav(L.timeline);
await shot('timeline');
await nav(L.settings);
await page.evaluate('window.scrollTo(0, 0)');
await shot('settings');
await app.close();
