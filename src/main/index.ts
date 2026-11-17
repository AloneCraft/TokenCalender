// Electron 本体。ウィンドウの作成、安全設定、画面からの要求の受付（入力検査つき）を担う。
// ログの解析・集計は別スレッドで行い、ここでは重い処理をしない。

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '../shared/appInfo.ts';
import type { AppStatus, ExportResult, IngestStatus, Settings } from '../shared/api.ts';
import * as v from '../shared/validate.ts';
import { WorkerHub } from './workers.ts';
import { bridgePaths, installBridge, previewBridge, uninstallBridge } from './claudeBridge.ts';
import { toCsv } from './csv.ts';

const here = dirname(fileURLToPath(import.meta.url));

app.setName(APP_NAME);
if (!app.requestSingleInstanceLock()) app.quit();

// 開発・試験では TOKEN_CALENDAR_DATA_DIR でデータの置き場所を変えられる
const dataDir = process.env.TOKEN_CALENDAR_DATA_DIR ?? app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'token-calendar.sqlite');
const demoDbPath = join(dataDir, 'demo.sqlite');
const bp = bridgePaths(dataDir);
mkdirSync(bp.bridgeDir, { recursive: true });

let win: BrowserWindow | null = null;

const hub = new WorkerHub({
  dbPath,
  demoDbPath,
  bridgeDir: bp.bridgeDir,
  onChanged: (at) => win?.webContents.send('tc:changed', { at }),
  onProgress: (p: IngestStatus) => win?.webContents.send('tc:progress', p),
  onError: (msg) => console.error('[worker]', msg),
});

function rendererUrl(): string | null {
  return process.env.ELECTRON_RENDERER_URL ?? null;
}

/** 本アプリの画面からの要求だけを受け付ける */
function checkSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  const dev = rendererUrl();
  const ok = url.startsWith('file://') || (dev != null && url.startsWith(dev));
  if (!ok || !win || e.sender.id !== win.webContents.id) throw new Error('forbidden sender');
}

function handle(channel: string, fn: (params: unknown) => unknown): void {
  ipcMain.handle(`tc:${channel}`, async (e, params) => {
    checkSender(e);
    return await fn(params);
  });
}

function registerIpc(): void {
  const forward = ['calendar', 'timeline', 'dayDetail', 'recent', 'quotaOverview', 'estimate', 'analysis', 'addManualObservation', 'deleteManualObservation', 'listManualObservations', 'updateSource', 'getSettings'];
  for (const m of forward) handle(m, (p) => hub.call(m, p ?? null));

  handle('setSettings', async (p) => {
    const patch = v.settingsPatch(p);
    const s = await hub.call<Settings>('setSettings', patch);
    if ('extraSources' in patch) hub.rescan();
    return s;
  });
  handle('getStatus', async () => {
    const s = await hub.call<Omit<AppStatus, 'ingest' | 'dbPath'>>('getStatus', null);
    return { ...s, ingest: hub.progress, dbPath };
  });
  handle('rescan', () => {
    hub.rescan();
    return { ok: true };
  });
  handle('addSource', async (p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const provider = v.oneOf(o.provider, 'provider', ['claude', 'codex'] as const);
    const path = v.str(o.path, 'path', 1024);
    if (!existsSync(path)) return { ok: false, message: 'not_found' };
    const r = await hub.call('addSource', { provider, path });
    hub.rescan();
    return r;
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('detectWsl', () => detectWsl());
  handle('exportData', (p) => exportData(p));
  handle('importData', () => importData());
  handle('deleteAppData', () => deleteAppData());
  handle('bridgePreview', () => previewBridge(bp));
  handle('bridgeInstall', async () => {
    const pv = previewBridge(bp);
    // 画面での確認に加え、OS の確認ダイアログでも同意を得る
    const r = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['変更する', 'やめる'],
      defaultId: 1,
      cancelId: 1,
      title: 'Claude Code の設定変更',
      message: `${pv.settingsPath} の statusLine を変更します。`,
      detail: `変更前の設定はバックアップします。\n変更後: ${JSON.stringify(pv.proposedStatusLine)}`,
    });
    if (r.response !== 0) return { ok: false, message: 'cancelled' };
    const res = installBridge(bp);
    await hub.call('setBridgeStatus', { status: res.ok ? 'no_data' : 'failed', detail: res.backupPath ? `backup: ${res.backupPath}` : res.message });
    hub.rescan();
    return { ok: res.ok, message: res.ok ? res.backupPath : res.message };
  });
  handle('bridgeUninstall', async () => {
    const r = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['元に戻す', 'やめる'],
      defaultId: 1,
      cancelId: 1,
      title: 'Claude Code の設定を元に戻す',
      message: `${bp.settingsPath} の statusLine を連携前の状態に戻します。`,
    });
    if (r.response !== 0) return { ok: false, message: 'cancelled' };
    const res = uninstallBridge(bp);
    if (res.ok) await hub.call('setBridgeStatus', { status: 'not_configured', detail: null });
    return res;
  });
  handle('openExternal', async (p) => {
    await shell.openExternal(v.externalUrl(p));
  });
}

async function exportData(p: unknown): Promise<ExportResult> {
  const o = (p ?? {}) as Record<string, unknown>;
  const format = v.oneOf(o.format, 'format', ['csv', 'json'] as const);
  const kind = v.oneOf(o.kind, 'kind', ['events', 'daily', 'quota'] as const);
  const settings = await hub.call<Settings>('getSettings', null);
  const zone = settings.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = await dialog.showSaveDialog(win!, { defaultPath: `token-calendar-${kind}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (r.canceled || !r.filePath) return { ok: false, path: null, rows: 0, message: 'cancelled' };
  const rows = await hub.call<Record<string, unknown>[]>('exportRows', { kind, zone, pricingMode: settings.pricingMode });
  const body =
    format === 'json'
      ? JSON.stringify({ app: APP_NAME, kind, exportedAt: new Date().toISOString(), note: 'api_cost_equivalent_usd は API 料金換算の参考額であり、実際の請求額ではありません', rows }, null, 1)
      : toCsv(rows);
  writeFileSync(r.filePath, body, 'utf8');
  return { ok: true, path: r.filePath, rows: rows.length, message: null };
}

async function importData(): Promise<unknown> {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, inserted: 0, skipped: 0, message: 'cancelled' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
  } catch {
    return { ok: false, inserted: 0, skipped: 0, message: 'invalid_file' };
  }
  const o = parsed as { kind?: string; rows?: unknown };
  if (o.kind !== 'events') return { ok: false, inserted: 0, skipped: 0, message: 'not_events_export' };
  const res = await hub.call('importEvents', { rows: o.rows });
  win?.webContents.send('tc:changed', { at: Date.now() });
  return res;
}

async function deleteAppData(): Promise<{ ok: boolean }> {
  const r = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['削除する', 'やめる'],
    defaultId: 1,
    cancelId: 1,
    title: 'アプリのデータを削除',
    message: 'このアプリが作った集計データ（DB）を削除します。元の Claude / Codex のログは削除しません。',
    detail: '削除した後、ログからもう一度読み込みます。手動記録した利用率は元に戻せません。',
  });
  if (r.response !== 0) return { ok: false };
  await hub.stop();
  for (const f of readdirSync(dataDir)) {
    if (/^(token-calendar|demo)\.sqlite(-wal|-shm)?$/.test(f)) rmSync(join(dataDir, f), { force: true });
  }
  hub.start();
  win?.webContents.send('tc:changed', { at: Date.now() });
  return { ok: true };
}

function detectWsl(): Promise<{ distro: string; provider: 'claude' | 'codex'; path: string }[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const names = stdout
        .toString('utf16le')
        .split(/\r?\n/)
        .map((s) => s.replace(/\0/g, '').trim())
        .filter((s) => s && !s.startsWith('docker-desktop'));
      const found: { distro: string; provider: 'claude' | 'codex'; path: string }[] = [];
      for (const d of names) {
        const home = `\\\\wsl.localhost\\${d}\\home`;
        let users: string[] = [];
        try {
          users = readdirSync(home);
        } catch {
          continue;
        }
        for (const u of users) {
          const c = join(home, u, '.claude', 'projects');
          if (existsSync(c)) found.push({ distro: d, provider: 'claude', path: c });
          const x = join(home, u, '.codex');
          if (existsSync(join(x, 'sessions'))) found.push({ distro: d, provider: 'codex', path: x });
        }
      }
      resolve(found);
    });
  });
}

function applySecurity(): void {
  // 画面の読み込み元は本アプリのファイルだけ。外部通信は行わない。
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'" + (rendererUrl() ? ' ws://localhost:* http://localhost:*' : ''),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(v.externalUrl(url));
    } catch {
      /* 許可していない外部リンクは開かない */
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const dev = rendererUrl();
  if (dev) void win.loadURL(dev);
  else void win.loadFile(join(here, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applySecurity();
  registerIpc();
  hub.start();
  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  void hub.stop().finally(() => app.quit());
});
