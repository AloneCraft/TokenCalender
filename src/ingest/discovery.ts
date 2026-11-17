// ログの保存先（データ元）を探す。元のログは読むだけで、変更・削除はしない。
//
// Claude Code: CLAUDE_CONFIG_DIR（設定フォルダー）配下の projects/、既定の ~/.claude/projects/、
//              ~/.config/claude/projects/（存在する場合）。ccusage 独自の複数指定規則は使わない。
// Codex: CODEX_HOME（既定 ~/.codex）配下の sessions/ と archived_sessions/。

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { Provider } from '../core/model/types.ts';
import { shortHash } from '../core/util/hash.ts';

export type SourceKind = 'auto' | 'manual' | 'wsl' | 'bridge';
export type SourceRole = 'claude_projects' | 'codex_sessions' | 'codex_archived' | 'claude_statusline';

export interface SourceDef {
  sourceId: string;
  provider: Provider;
  kind: SourceKind;
  role: SourceRole;
  rootPath: string;
  label: string;
  /** Codex の sessions と archived_sessions を対応付けるための CODEX_HOME */
  homeKey?: string;
}

export interface FileInfo {
  path: string;
  fileKey: string;
  size: number;
  mtimeMs: number;
  compressed: boolean;
  isSubagent: boolean;
}

export type SourceScanStatus = 'ok' | 'missing' | 'permission_denied' | 'error';

export interface SourceScan {
  status: SourceScanStatus;
  detail: string | null;
  files: FileInfo[];
}

export function sourceIdFor(role: SourceRole, rootPath: string): string {
  return `${role}:${shortHash(resolve(rootPath).toLowerCase(), 12)}`;
}

export function fileKeyFor(path: string): string {
  return shortHash(resolve(path).toLowerCase(), 20);
}

export function defaultSourceDefs(env: NodeJS.ProcessEnv = process.env, home: string = env.TOKEN_CALENDAR_HOME || homedir()): SourceDef[] {
  const defs: SourceDef[] = [];
  const seen = new Set<string>();
  const add = (d: Omit<SourceDef, 'sourceId'>) => {
    const key = resolve(d.rootPath).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    defs.push({ ...d, sourceId: sourceIdFor(d.role, d.rootPath) });
  };
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) {
    const dir = env.CLAUDE_CONFIG_DIR.trim();
    add({ provider: 'claude', kind: 'auto', role: 'claude_projects', rootPath: join(dir, 'projects'), label: 'Claude Code（CLAUDE_CONFIG_DIR）' });
  }
  add({ provider: 'claude', kind: 'auto', role: 'claude_projects', rootPath: join(home, '.claude', 'projects'), label: 'Claude Code（~/.claude）' });
  add({ provider: 'claude', kind: 'auto', role: 'claude_projects', rootPath: join(home, '.config', 'claude', 'projects'), label: 'Claude Code（~/.config/claude）' });
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(home, '.codex');
  const homeKey = shortHash(resolve(codexHome).toLowerCase(), 12);
  add({ provider: 'codex', kind: 'auto', role: 'codex_sessions', rootPath: join(codexHome, 'sessions'), label: 'Codex（sessions）', homeKey });
  add({ provider: 'codex', kind: 'auto', role: 'codex_archived', rootPath: join(codexHome, 'archived_sessions'), label: 'Codex（archived_sessions）', homeKey });
  return defs;
}

/** 利用者が追加した保存先。Claude は projects フォルダー、Codex は CODEX_HOME を指定する。 */
export function manualSourceDefs(provider: Provider, path: string, kind: SourceKind = 'manual'): SourceDef[] {
  if (provider === 'claude') {
    const root = basename(path) === 'projects' ? path : join(path, 'projects');
    return [{ sourceId: sourceIdFor('claude_projects', root), provider, kind, role: 'claude_projects', rootPath: root, label: `Claude Code（${path}）` }];
  }
  const homeKey = shortHash(resolve(path).toLowerCase(), 12);
  return [
    { sourceId: sourceIdFor('codex_sessions', join(path, 'sessions')), provider, kind, role: 'codex_sessions', rootPath: join(path, 'sessions'), label: `Codex（${path}）`, homeKey },
    {
      sourceId: sourceIdFor('codex_archived', join(path, 'archived_sessions')),
      provider,
      kind,
      role: 'codex_archived',
      rootPath: join(path, 'archived_sessions'),
      label: `Codex archived（${path}）`,
      homeKey,
    },
  ];
}

function wantedFile(role: SourceRole, name: string): { ok: boolean; compressed: boolean } {
  if (role === 'claude_projects' || role === 'claude_statusline') return { ok: name.endsWith('.jsonl'), compressed: false };
  if (name.endsWith('.jsonl.zst')) return { ok: name.startsWith('rollout-'), compressed: true };
  if (name.endsWith('.jsonl')) return { ok: name.startsWith('rollout-'), compressed: false };
  return { ok: false, compressed: false };
}

export async function scanSource(def: SourceDef): Promise<SourceScan> {
  const files: FileInfo[] = [];
  try {
    const st = await stat(def.rootPath);
    if (!st.isDirectory()) return { status: 'missing', detail: 'フォルダーではありません', files };
  } catch (e) {
    return errorScan(e, files);
  }
  let deniedCount = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') {
        deniedCount++;
        return;
      }
      throw e;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile()) {
        const w = wantedFile(def.role, ent.name);
        if (!w.ok) continue;
        try {
          const s = await stat(p);
          files.push({
            path: p,
            fileKey: fileKeyFor(p),
            size: s.size,
            mtimeMs: Math.floor(s.mtimeMs),
            compressed: w.compressed,
            isSubagent: p.includes(`${sep}subagents${sep}`) || p.includes('/subagents/'),
          });
        } catch {
          deniedCount++;
        }
      }
    }
  };
  try {
    await walk(def.rootPath);
  } catch (e) {
    return errorScan(e, files);
  }
  // 同じフォルダーに平文と圧縮版がある場合は平文を優先する（同じ内容の二重読みを避ける。重複排除は鍵でも保証）
  const plain = new Set(files.filter((f) => !f.compressed).map((f) => f.path));
  const filtered = files.filter((f) => !(f.compressed && plain.has(f.path.slice(0, -'.zst'.length))));
  return {
    status: 'ok',
    detail: deniedCount > 0 ? `読めないファイル・フォルダーが ${deniedCount} 件あります` : null,
    files: filtered,
  };
}

function errorScan(e: unknown, files: FileInfo[]): SourceScan {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing', detail: null, files };
  if (code === 'EACCES' || code === 'EPERM') return { status: 'permission_denied', detail: String((e as Error).message), files };
  return { status: 'error', detail: String((e as Error).message), files };
}

/** Codex の rollout ファイル名（圧縮拡張子を除く）。sessions と archived_sessions の同一ファイル判定に使う。 */
export function rolloutBaseName(path: string): string {
  const b = basename(path);
  return b.endsWith('.zst') ? b.slice(0, -4) : b;
}
