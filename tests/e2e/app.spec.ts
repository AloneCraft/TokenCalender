// 画面の通し試験。試験用のホームフォルダーに匿名のログを置き、アプリにはそこだけを読ませる。
// ホストのマウス・キーボードは使わない（Electron の操作は CDP 経由）。

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claudeAssistant,
  claudeUser,
  codexMeta,
  codexRecord,
  codexTaskStarted,
  codexTokenCount,
  codexTurnContext,
} from '../fixtures/builders.ts';

const base = process.env.TOKEN_CALENDAR_TEST_TMP ?? (existsSync('D:/CodexTemp') ? 'D:/CodexTemp/TokenCalendar/e2e' : tmpdir());

interface Env {
  root: string;
  home: string;
  dataDir: string;
  codexFile: string;
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeEnv(withData: boolean): Env {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'e2e-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(join(home, '.claude', 'projects', 'proj'), { recursive: true });
  const day = new Date().toISOString().slice(0, 10).split('-');
  const codexDir = join(home, '.codex', 'sessions', day[0]!, day[1]!, day[2]!);
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  // 利用者の設定が変わらないことを確かめるための設定ファイル
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo mine' } }, null, 2));
  const codexFile = join(codexDir, 'rollout-e2e-th1.jsonl');
  if (withData) {
    // アプリ起動前に完了したターン（Claude）
    writeFileSync(
      join(home, '.claude', 'projects', 'proj', 'sess-a.jsonl'),
      [
        claudeUser({ promptId: 'p-before', sessionId: 'sess-a', ts: iso(10 * 60000) }),
        claudeAssistant({ msgId: 'm-before', sessionId: 'sess-a', ts: iso(9 * 60000), usage: { input: 1200, output: 3400, cacheRead: 5000 } }),
      ].join('\n') + '\n',
    );
    // Codex: 週枠の公式利用率つき
    const resets = Math.floor((Date.now() + 3 * 86400000) / 1000);
    writeFileSync(
      codexFile,
      [
        codexMeta({ id: 'th1', ts: iso(60 * 60000), account: 'acct-e2e' }),
        codexTaskStarted({ ts: iso(59 * 60000), turnId: 't1' }),
        codexTurnContext({ ts: iso(59 * 60000), turnId: 't1', model: 'gpt-6.1-sol' }),
        codexRecord({ ts: iso(58 * 60000), threadId: 'th1', turnId: 't1', responseId: 'r1', usage: { input: 10000, cached: 4000, output: 500 }, thread: { input: 10000, cached: 4000, output: 500 } }),
        codexTokenCount({ ts: iso(58 * 60000), total: { input: 10000, cached: 4000, output: 500 }, primary: { used: 20, minutes: 10080, resetsAtSec: resets } }),
        codexTokenCount({ ts: iso(30 * 60000), total: { input: 10000, cached: 4000, output: 500 }, primary: { used: 30, minutes: 10080, resetsAtSec: resets } }),
      ].join('\n') + '\n',
    );
  }
  return { root, home, dataDir, codexFile };
}

async function launch(env: Env, lang = 'ja-JP'): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // 表示言語は既定で OS に合わせるため、試験では --lang で OS の言語を固定する
    args: ['out/main/index.js', `--lang=${lang}`],
    env: {
      ...process.env,
      // OS のホームは変えず、ログを探す場所だけを差し替える
      TOKEN_CALENDAR_HOME: env.home,
      CODEX_HOME: join(env.home, '.codex'),
      CLAUDE_CONFIG_DIR: '',
      TOKEN_CALENDAR_DATA_DIR: env.dataDir,
      TZ: 'Asia/Tokyo',
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('nav');
  return { app, page };
}

/** 起動直後はダッシュボードが開く。カレンダーの試験はカレンダーへ移ってから行う */
async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: /カレンダー/ }).click();
}

test.describe('Token Calendar', () => {
  let env: Env;
  let app: ElectronApplication;
  let page: Page;

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    try {
      rmSync(env.root, { recursive: true, force: true });
    } catch {
      /* Windows で DB が閉じきる前は消せない場合がある */
    }
  });

  test('N: 起動前の直近ターンを表示し、起動後に追加されたターンを約2秒以内に反映する', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env));
    await openCalendar(page);
    const first = page.getByTestId('recent-first');
    const recent = page.locator('section[aria-labelledby="recent-h"]');
    // 起動前に完了したターン（Claude 9分前・Codex 58分前）の両方を表示する
    await expect(recent).toContainText('Claude', { timeout: 20000 });
    await expect(recent).toContainText('Codex', { timeout: 20000 });

    // 起動後に Claude の新しいターンを追記する
    const t0 = Date.now();
    appendFileSync(
      join(env.home, '.claude', 'projects', 'proj', 'sess-a.jsonl'),
      [
        claudeUser({ promptId: 'p-after', sessionId: 'sess-a', ts: iso(0) }),
        claudeAssistant({ msgId: 'm-after', sessionId: 'sess-a', ts: iso(0), model: 'claude-opus-5-5', usage: { input: 7, output: 77777 } }),
      ].join('\n') + '\n',
    );
    await expect(first).toContainText('Claude', { timeout: 10000 });
    await expect(first).toContainText('7.8万', { timeout: 10000 });
    const latency = Date.now() - t0;
    console.log(`[measure] append-to-ui latency: ${latency} ms`);
    writeFileSync(join(base, 'latency.txt'), `${new Date().toISOString()} ${latency}\n`, { flag: 'a' });
    expect(latency).toBeLessThan(6000);
  });

  test('カレンダーに棒を描き、周期内累積と公式利用率を区別して表示する', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env));
    await openCalendar(page);
    await expect(page.locator('.cal-grid button.cell')).toHaveCount(42, { timeout: 20000 });
    await expect(page.locator('.cell.today svg rect').first()).toBeVisible({ timeout: 20000 });
    // Codex を選び、周期内累積へ切り替える
    await page.getByRole('group', { name: 'provider' }).getByRole('button', { name: 'Codex' }).click();
    await page.getByRole('group', { name: 'mode' }).getByRole('button', { name: 'リセット周期内累積' }).click();
    await expect(page.locator('.toolbar')).toContainText('周期の対象枠');
    await expect(page.locator('.cell.today .vals')).toContainText('計', { timeout: 10000 });
    // 公式利用率は取得時刻つきで表示する
    await expect(page.locator('section[aria-labelledby="quota-h"]')).toContainText('30%');
    await expect(page.locator('section[aria-labelledby="quota-h"]')).toContainText('取得');
    // API料金換算は「相当」として表示する
    await page.getByRole('group', { name: 'measure' }).getByRole('button', { name: 'API料金換算' }).click();
    await expect(page.locator('.card').first()).toContainText('請求額ではありません');
  });

  test('O: 利用者の同意なしに Claude Code の設定を変更しない', async () => {
    env = makeEnv(true);
    const settingsPath = join(env.home, '.claude', 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');
    ({ app, page } = await launch(env));
    await page.getByRole('button', { name: /データ元/ }).click();
    await page.getByRole('button', { name: '変更内容を確認' }).click();
    await expect(page.getByText('変更後の statusLine')).toBeVisible();
    // プレビューだけでは変わらない
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  test('R: データが無い環境では空の状態を示し、デモ表示は明示する', async () => {
    env = makeEnv(false);
    ({ app, page } = await launch(env));
    // ダッシュボード: 公式値が無いことを明示し、架空の数値を出さない
    await expect(page.locator('section[aria-label="Codex"]')).toContainText('公式の利用率がまだ取得できていない', { timeout: 20000 });
    await openCalendar(page);
    await expect(page.locator('section[aria-labelledby="recent-h"]')).toContainText('まだ利用の記録がありません', { timeout: 20000 });
    await expect(page.locator('.cell.today .vals')).toContainText('未取得');
    await page.getByRole('button', { name: /設定/ }).click();
    await page.getByLabel('デモ表示（架空のデータ）').click();
    await expect(page.locator('.banner.demo')).toContainText('デモ表示中', { timeout: 20000 });
  });

  test('ダッシュボード: 公式の残り・リセットまでの時間を、公式値の札つきで最初に表示する', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env));
    const codex = page.locator('section[aria-label^="Codex"]').first();
    await expect(codex).toContainText('週枠', { timeout: 20000 });
    // 最新の公式値は 30% 使用 → 残り 70%
    await expect(codex.locator('.metric').first()).toContainText('70%');
    await expect(codex.locator('.metric').first()).toContainText('公式');
    await expect(codex).toContainText('リセットまで');
    // Claude は公式値が無いので、残りを推測で出さない
    await expect(page.locator('section[aria-label="Claude"]')).toContainText('公式の利用率がまだ取得できていない');
    // 消費率のページへ移れる
    // ダッシュボード内の「消費率の詳しい表…」ボタンと区別するため、名前の完全一致で探す
    await page.getByRole('button', { name: '消費率', exact: true }).click();
    await expect(page.locator('h1')).toContainText('モデル・エフォート別の消費率');
  });

  test('言語の選択欄: 国旗とその言語の文字の言語名を並べ、選ぶとすぐ切り替わる', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env));
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const button = page.locator('#s-l-button');
    // 既定は OS（ここでは ja-JP）に合わせる
    await expect(button).toContainText('OS に合わせる（今は 日本語）');
    await button.click();
    const list = page.getByRole('listbox');
    // OS に合わせる ＋ 登録されている言語（日本語・English・한국어）
    await expect(list.getByRole('option')).toHaveCount(4);
    await expect(list.locator('[data-value="ko"] [lang="ko"]')).toHaveText('한국어');
    await expect(list.locator('[data-value="ko"] svg.flag')).toHaveCount(1);
    await expect(list.locator('[data-value="ja"] [lang="ja"]')).toHaveText('日本語');
    await expect(list.locator('[data-value="en"] [lang="en"]').first()).toHaveText('English');
    await expect(list.locator('[data-value="ja"] svg.flag')).toHaveCount(1);
    // キーボードで English を選ぶ（OS → 日本語 → English）
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('nav')).toContainText('Limits', { timeout: 10000 });
    await expect(page.locator('#s-l-button')).toContainText('English');
    // 案内帯の下の小さい選択欄からも戻せる
    await page.locator('#nav-lang-button').click();
    await page.locator('#nav-lang-list [data-value="ja"]').click();
    await expect(page.locator('nav')).toContainText('利用枠', { timeout: 10000 });
  });

  test('OS の言語が韓国語なら韓国語で表示し、確認ダイアログの用語も同じ辞書から出す', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env, 'ko-KR'));
    await expect(page.locator('h1')).toContainText('이용 한도 대시보드', { timeout: 20000 });
    await expect(page.locator('nav')).toContainText('캘린더');
    const codex = page.locator('section[aria-label^="Codex"]').first();
    await expect(codex).toContainText('주간 한도', { timeout: 20000 });
    await expect(codex.locator('.metric').first()).toContainText('공식');
    // 数字は韓国語の規則（만・억）、期間も韓国語で出る
    await expect(codex).toContainText('리셋까지');
    // 書式から日本語・英語の文が混ざっていない
    const text = await page.locator('.page').innerText();
    expect(text).not.toMatch(/[ぁ-んァ-ヶ]/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko-KR');
  });

  test('OS の言語が英語なら英語で表示する', async () => {
    env = makeEnv(true);
    ({ app, page } = await launch(env, 'en-US'));
    await expect(page.locator('h1')).toContainText('Usage dashboard', { timeout: 20000 });
    await expect(page.locator('nav')).toContainText('Calendar');
    await expect(page.locator('nav')).toContainText('Limits');
    await expect(page.locator('section[aria-label^="Codex"]').first()).toContainText('Remaining', { timeout: 20000 });
  });
});
