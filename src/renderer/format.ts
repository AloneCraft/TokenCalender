// 数値・金額・日時の表示。金額は nano-dollar の整数で受け取り、表示の直前で通貨へ直す。

import type { Currency, Measure } from '../shared/api.ts';

export interface MoneyCtx {
  currency: Currency;
  usdJpy: number;
}

const compactJa = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
const intJa = new Intl.NumberFormat('ja-JP');

export function fmtTokens(n: number, compact = true): string {
  if (!Number.isFinite(n)) return '—';
  return compact ? compactJa.format(n) : intJa.format(Math.round(n));
}

export function fmtMoney(nano: number, m: MoneyCtx, compact = false): string {
  if (!Number.isFinite(nano)) return '—';
  const usd = nano / 1e9;
  if (m.currency === 'JPY') {
    const yen = usd * m.usdJpy;
    return compact && Math.abs(yen) >= 10000 ? `¥${compactJa.format(yen)}` : `¥${intJa.format(Math.round(yen))}`;
  }
  if (compact && Math.abs(usd) >= 10000) return `$${compactJa.format(usd)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: usd < 100 ? 2 : 0 })}`;
}

export function fmtMeasure(v: number, measure: Measure, m: MoneyCtx, compact = true): string {
  if (measure === 'cost') return fmtMoney(v, m, compact);
  if (measure === 'events') return intJa.format(v);
  return fmtTokens(v, compact);
}

/** 推定値は細かすぎる桁を出さない（有効数字2桁） */
export function roundSig(v: number, digits = 2): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const p = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
}

export function fmtPct(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function fmtDateTime(ms: number | null, zone: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('ja-JP', { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(ms: number | null, zone: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('ja-JP', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let s = Math.abs(Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const str = d > 0 ? `${d}日${h}時間` : h > 0 ? `${h}時間${m}分` : m > 0 ? `${m}分` : `${s}秒`;
  return neg ? `-${str}` : str;
}

export function fmtAgo(ms: number | null, now = Date.now()): string {
  if (ms == null) return '—';
  // ログの時刻が端末の時計よりわずかに先のことがある。負の値は「たった今」とする
  if (now - ms < 1000) return 'たった今';
  return `${fmtDuration(now - ms)}前`;
}

/** 枠の長さの表示名（300 → 5時間枠、10080 → 週枠、43200 → 30日枠） */
export function windowName(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return '期間不明の枠';
  if (minutes === 300) return '5時間枠';
  if (minutes === 10080) return '週枠';
  if (minutes % 1440 === 0) return `${minutes / 1440}日枠`;
  if (minutes % 60 === 0) return `${minutes / 60}時間枠`;
  return `${minutes}分枠`;
}

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 系列の色。色だけに頼らないよう、凡例と数値も併記する */
const PALETTE = ['#2f7ed8', '#e07b39', '#3aa57a', '#8e6cc7', '#c9506b', '#9a8c2e', '#3a9fb8', '#7a7a7a', '#b06a3b', '#5468b5'];
export const PROVIDER_COLOR: Record<string, string> = { claude: '#d97757', codex: '#3a7bd5' };

export function colorFor(key: string, index: number): string {
  return PROVIDER_COLOR[key] ?? PALETTE[index % PALETTE.length]!;
}
