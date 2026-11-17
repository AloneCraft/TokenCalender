import { createHash } from 'node:crypto';

/** 識別用の短いハッシュ。パスや ID をそのまま DB に残さないために使う。 */
export function shortHash(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** プロジェクトのパスから、表示用の名前（末尾のフォルダー名）と識別用ハッシュを作る。 */
export function projectIdentity(cwd: string | null | undefined): { key: string | null; label: string | null } {
  if (!cwd || typeof cwd !== 'string') return { key: null, label: null };
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const label = parts.length > 0 ? parts[parts.length - 1]! : normalized;
  return { key: shortHash(normalized.toLowerCase()), label };
}
