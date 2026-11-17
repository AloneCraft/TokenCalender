import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgePaths, installBridge, previewBridge, uninstallBridge } from '../../src/main/claudeBridge.ts';
import { parseBridgeLine } from '../../src/core/quota/claudeStatusline.ts';
import { makeTempDir, removeDir } from './helpers.ts';

let dir: string;
let home: string;
let settingsPath: string;

beforeEach(() => {
  dir = makeTempDir('tc-bridge-');
  home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  settingsPath = join(home, '.claude', 'settings.json');
});
afterEach(() => removeDir(dir));

describe('O: Claude Code の設定を同意なしに変えない', () => {
  it('変更内容の確認だけでは settings.json を変えない', () => {
    const original = JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo mine' } }, null, 2);
    writeFileSync(settingsPath, original);
    const p = bridgePaths(join(dir, 'data'), {}, home);
    const pv = previewBridge(p);
    expect(pv.installed).toBe(false);
    expect(pv.currentStatusLine).toEqual({ type: 'command', command: 'echo mine' });
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('有効にするとバックアップを作り、既存の設定を保存し、他の項目は残す。解除で元に戻す', () => {
    const original = { theme: 'dark', hooks: { Stop: [] }, statusLine: { type: 'command', command: 'echo mine' } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const p = bridgePaths(join(dir, 'data'), {}, home);
    const r = installBridge(p, 1000);
    expect(r.ok).toBe(true);
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.hooks).toEqual({ Stop: [] });
    expect(after.statusLine.command).toContain('token-calendar-bridge');
    expect(JSON.parse(readFileSync(p.originalPath, 'utf8'))).toEqual(original.statusLine);
    expect(readdirSync(p.backupDir)).toHaveLength(1);
    const u = uninstallBridge(p);
    expect(u.ok).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(original);
  });

  it('利用者が後から statusLine を変えていたら、解除しても上書きしない', () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    const p = bridgePaths(join(dir, 'data'), {}, home);
    installBridge(p);
    const changed = { statusLine: { type: 'command', command: 'echo changed-by-user' } };
    writeFileSync(settingsPath, JSON.stringify(changed));
    const u = uninstallBridge(p);
    expect(u.ok).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(changed);
  });

  it('settings.json を解釈できない場合は何も変えない', () => {
    writeFileSync(settingsPath, '{ broken');
    const p = bridgePaths(join(dir, 'data'), {}, home);
    expect(installBridge(p).ok).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ broken');
  });
});

describe('L: ステータスラインの記録で欠けた枠を 0% にしない', () => {
  it('rate_limits が無い・枠が無い場合は観測を作らない', () => {
    expect(parseBridgeLine('{"v":1,"ts":1000}', null, 'x')).toHaveLength(0);
    const obs = parseBridgeLine('{"v":1,"ts":1000,"rate_limits":{"seven_day":{"used_percentage":35.5,"resets_at":1800000000}}}', null, 'x');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ windowKind: '7d', windowMinutes: 10080, usedPercent: 35.5, resetsAtMs: 1800000000000, source: 'claude_statusline' });
  });
});
