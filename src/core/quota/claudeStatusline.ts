// Claude Code のステータスライン連携（bridge/ のスクリプト）が書き出した記録を読み、公式利用率の観測へ変換する。
//
// 公式資料（https://code.claude.com/docs/en/statusline、2026-11-18 確認）:
// - rate_limits.five_hour / seven_day の used_percentage（0〜100）と resets_at（Unix 秒）。
// - rate_limits は契約者（Pro / Max 等）のみ、かつセッションの最初の応答の後にだけ現れる。
// - 各枠は個別に欠けることがあり、resets_at を過ぎた枠は削除される。
// したがって、項目が無いことを 0% とは扱わない。

import type { QuotaObservation } from '../model/types.ts';

export const STATUSLINE_PARSER_VERSION = 'claude-statusline-1';

export interface BridgeRecord {
  v?: number;
  ts?: number;
  session_id?: string;
  model?: string;
  rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined>;
}

const WINDOWS: { key: string; kind: '5h' | '7d'; minutes: number }[] = [
  { key: 'five_hour', kind: '5h', minutes: 300 },
  { key: 'seven_day', kind: '7d', minutes: 10080 },
];

export function parseBridgeLine(line: string, accountKey: string | null, originRef: string): QuotaObservation[] {
  let r: BridgeRecord;
  try {
    r = JSON.parse(line) as BridgeRecord;
  } catch {
    return [];
  }
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return [];
  const rl = r.rate_limits;
  if (!rl || typeof rl !== 'object') return [];
  const out: QuotaObservation[] = [];
  for (const w of WINDOWS) {
    const v = rl[w.key];
    if (!v || typeof v !== 'object') continue;
    const used = typeof v.used_percentage === 'number' && Number.isFinite(v.used_percentage) ? v.used_percentage : null;
    const resets = typeof v.resets_at === 'number' && Number.isFinite(v.resets_at) ? Math.round(v.resets_at * 1000) : null;
    if (used == null && resets == null) continue;
    out.push({
      obsKey: `claude-sl:${accountKey ?? 'unknown'}:${w.key}:${r.ts}`,
      provider: 'claude',
      accountKey,
      planType: null,
      limitId: 'claude',
      windowKind: w.kind,
      // 期間は項目名（five_hour / seven_day）から決めている
      windowMinutes: w.minutes,
      scopeModels: null,
      observedAtMs: r.ts,
      usedPercent: used,
      resetsAtMs: resets,
      source: 'claude_statusline',
      precision: 1,
      flags: ['window_from_field_name', 'precision_unknown', ...(used == null ? ['missing_percent'] : [])],
      originRef,
    });
  }
  return out;
}
