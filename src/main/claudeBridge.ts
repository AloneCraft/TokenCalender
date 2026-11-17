// Claude Code のステータスラインから、利用枠（rate_limits）の必要項目だけを本アプリへ渡す連携。
//
// 守ること:
// - 利用者が画面で変更内容を確認し、さらに確認ダイアログで同意した場合だけ settings.json を変更する。
// - 変更前に settings.json をバックアップし、既存の statusLine は保存して連携スクリプトから呼び出す（共存）。
// - 解除時は、現在の statusLine が本アプリの設定のままである場合だけ元に戻す（利用者が後で変えた設定は上書きしない）。
// - 連携スクリプトはすべての失敗を握りつぶして終了コード 0 で終わり、Claude Code の通常利用を妨げない。
// - 書き出すのは時刻と rate_limits（利用率・リセット時刻）だけ。会話・パス・費用などは書き出さない。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgePreview } from '../shared/api.ts';

const MARKER = 'token-calendar-bridge';

export interface BridgePaths {
  bridgeDir: string;
  scriptPath: string;
  outputPath: string;
  originalPath: string;
  backupDir: string;
  settingsPath: string;
}

export function bridgePaths(userDataDir: string, env: NodeJS.ProcessEnv = process.env, home = env.TOKEN_CALENDAR_HOME || homedir()): BridgePaths {
  const bridgeDir = join(userDataDir, 'bridge');
  const isWin = process.platform === 'win32';
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(home, '.claude');
  return {
    bridgeDir,
    scriptPath: join(bridgeDir, isWin ? `${MARKER}.ps1` : `${MARKER}.sh`),
    outputPath: join(bridgeDir, 'claude-statusline.jsonl'),
    originalPath: join(bridgeDir, 'original-statusline.json'),
    backupDir: join(bridgeDir, 'backups'),
    settingsPath: join(configDir, 'settings.json'),
  };
}

function psScript(outputPath: string, originalPath: string): string {
  return `# ${MARKER}: Claude Code のステータスラインから rate_limits だけを記録する（Token Calendar）
# 失敗しても何も出さずに終了し、Claude Code の動作を妨げない。
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
try {
  $j = $raw | ConvertFrom-Json
  if ($null -ne $j.rate_limits) {
    $rl = @{}
    foreach ($k in @('five_hour', 'seven_day')) {
      $w = $j.rate_limits.$k
      if ($null -ne $w) { $rl[$k] = @{ used_percentage = $w.used_percentage; resets_at = $w.resets_at } }
    }
    $rec = @{ v = 1; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); session_id = $j.session_id; model = $j.model.id; rate_limits = $rl }
    $line = ($rec | ConvertTo-Json -Compress -Depth 5)
    [System.IO.File]::AppendAllText('${outputPath.replace(/'/g, "''")}', $line + [Environment]::NewLine)
  }
} catch {}
try {
  $orig = Get-Content -Raw -LiteralPath '${originalPath.replace(/'/g, "''")}' | ConvertFrom-Json
  if ($null -ne $orig -and $orig.command) {
    $raw | & cmd.exe /d /s /c $orig.command
  }
} catch {}
exit 0
`;
}

function shScript(outputPath: string, originalPath: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# ${MARKER}: Claude Code のステータスラインから rate_limits だけを記録する（Token Calendar）
# 失敗しても何も出さずに終了し、Claude Code の動作を妨げない。
raw=$(cat)
ts=$(($(date +%s) * 1000))
rl=$(printf '%s' "$raw" | awk 'BEGIN{RS="\\001"} { i = index($0, "\\"rate_limits\\":"); if (i == 0) exit; s = substr($0, i + 14); d = 0; out = ""; for (k = 1; k <= length(s); k++) { c = substr(s, k, 1); if (c == "{") d++; if (d > 0) out = out c; if (c == "}") { d--; if (d == 0) break } } print out }' 2>/dev/null)
if [ -n "$rl" ]; then
  printf '{"v":1,"ts":%s,"rate_limits":%s}\\n' "$ts" "$rl" >> ${q(outputPath)} 2>/dev/null
fi
if [ -f ${q(originalPath)} ]; then
  cmd=$(sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\(.*\\)".*/\\1/p' ${q(originalPath)} 2>/dev/null | sed 's/\\\\"/"/g')
  if [ -n "$cmd" ]; then printf '%s' "$raw" | sh -c "$cmd" 2>/dev/null; fi
fi
exit 0
`;
}

function readSettings(path: string): { exists: boolean; json: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(path)) return { exists: false, json: {}, error: null };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { exists: true, json: null, error: 'settings.json の形式を解釈できません' };
    return { exists: true, json: j as Record<string, unknown>, error: null };
  } catch (e) {
    return { exists: true, json: null, error: `settings.json を読めません: ${String((e as Error).message)}` };
  }
}

function proposedStatusLine(p: BridgePaths): Record<string, unknown> {
  const command =
    process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${p.scriptPath}"`
      : `sh "${p.scriptPath}"`;
  return { type: 'command', command, padding: 0 };
}

function isOurs(statusLine: unknown): boolean {
  return !!statusLine && typeof statusLine === 'object' && String((statusLine as Record<string, unknown>).command ?? '').includes(MARKER);
}

export function previewBridge(p: BridgePaths): BridgePreview {
  const s = readSettings(p.settingsPath);
  const current = s.json?.statusLine ?? null;
  return {
    settingsPath: p.settingsPath,
    exists: s.exists,
    currentStatusLine: current,
    proposedStatusLine: proposedStatusLine(p),
    scriptPath: p.scriptPath,
    outputPath: p.outputPath,
    installed: isOurs(current),
    backupPath: null,
    note: s.error
      ? s.error
      : current && !isOurs(current)
        ? '既存のステータスライン表示は保存し、連携スクリプトから呼び出して共存させます（Windows では cmd.exe 経由。動作は未検証）。'
        : 'Claude Code のデスクトップ版でステータスラインが動作するかは未確認です。動作しない場合は手動記録を使ってください。',
  };
}

export function installBridge(p: BridgePaths, now = Date.now()): { ok: boolean; message: string | null; backupPath: string | null } {
  const s = readSettings(p.settingsPath);
  if (!s.json) return { ok: false, message: s.error, backupPath: null };
  mkdirSync(p.bridgeDir, { recursive: true });
  mkdirSync(p.backupDir, { recursive: true });
  let backupPath: string | null = null;
  if (s.exists) {
    backupPath = join(p.backupDir, `settings.json.${now}.bak`);
    copyFileSync(p.settingsPath, backupPath);
  }
  const current = s.json.statusLine;
  if (current && !isOurs(current)) writeFileSync(p.originalPath, JSON.stringify(current, null, 2), 'utf8');
  writeFileSync(p.scriptPath, process.platform === 'win32' ? '﻿' + psScript(p.outputPath, p.originalPath) : shScript(p.outputPath, p.originalPath), 'utf8');
  const next = { ...s.json, statusLine: proposedStatusLine(p) };
  mkdirSync(join(p.settingsPath, '..'), { recursive: true });
  writeFileSync(p.settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { ok: true, message: null, backupPath };
}

export function uninstallBridge(p: BridgePaths): { ok: boolean; message: string | null } {
  const s = readSettings(p.settingsPath);
  if (!s.json) return { ok: false, message: s.error };
  if (!isOurs(s.json.statusLine)) {
    return { ok: false, message: '現在のステータスライン設定は本アプリのものではないため、変更しませんでした。' };
  }
  const next: Record<string, unknown> = { ...s.json };
  if (existsSync(p.originalPath)) {
    try {
      next.statusLine = JSON.parse(readFileSync(p.originalPath, 'utf8'));
    } catch {
      return { ok: false, message: '保存していた元の設定を読めません。バックアップから手動で戻してください。' };
    }
  } else {
    delete next.statusLine;
  }
  writeFileSync(p.settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { ok: true, message: null };
}
