// 数値・金額・日時の表示。金額は nano-dollar の整数で受け取り、表示の直前で通貨へ直す。
// 表示言語は App が setFormatLang で設定する（画面全体で1つ）。

import type { Currency, Measure } from '../shared/api.ts';

export interface MoneyCtx {
  currency: Currency;
  usdJpy: number;
}

import { languageOf, translate, type LangCode } from '../shared/i18n/languages.ts';

let LANG: LangCode = 'ja';
let LOCALE = 'ja-JP';
let compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
let intFmt = new Intl.NumberFormat(LOCALE);

export function setFormatLang(lang: LangCode): void {
  if (lang === LANG) return;
  LANG = lang;
  // 数字・日付の書き方は、言語の登録表にある地域つきのタグで決める
  LOCALE = languageOf(lang).locale;
  compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
  intFmt = new Intl.NumberFormat(LOCALE);
}

export function formatLocale(): string {
  return LOCALE;
}

const tr = (key: string, vars?: Record<string, string | number>) => translate(LANG, key, vars);

export function fmtTokens(n: number, compact = true): string {
  if (!Number.isFinite(n)) return '—';
  return compact ? compactFmt.format(n) : intFmt.format(Math.round(n));
}

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return intFmt.format(Math.round(n));
}

export function fmtMoney(nano: number, m: MoneyCtx, compact = false): string {
  if (!Number.isFinite(nano)) return '—';
  const usd = nano / 1e9;
  if (m.currency === 'JPY') {
    const yen = usd * m.usdJpy;
    return compact && Math.abs(yen) >= 10000 ? `¥${compactFmt.format(yen)}` : `¥${intFmt.format(Math.round(yen))}`;
  }
  if (compact && Math.abs(usd) >= 10000) return `$${compactFmt.format(usd)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: usd < 100 ? 2 : 0 })}`;
}

export function fmtMeasure(v: number, measure: Measure, m: MoneyCtx, compact = true): string {
  if (measure === 'cost') return fmtMoney(v, m, compact);
  if (measure === 'events') return intFmt.format(v);
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
  return new Date(ms).toLocaleString(formatLocale(), { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 曜日つきの日時（例: 11/22(日) 23:54） */
export function fmtDateTimeWd(ms: number | null, zone: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(formatLocale(), { timeZone: zone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ms: number | null, zone: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleDateString(formatLocale(), { timeZone: zone, month: 'numeric', day: 'numeric', weekday: 'short' });
}

export function fmtTime(ms: number | null, zone: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString(formatLocale(), { timeZone: zone, hour: '2-digit', minute: '2-digit' });
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
  const str = d > 0 ? tr('fmt.duration.dh', { d, h }) : h > 0 ? tr('fmt.duration.hm', { h, m }) : m > 0 ? tr('fmt.duration.m', { m }) : tr('fmt.duration.s', { s });
  return neg ? `-${str}` : str;
}

export function fmtAgo(ms: number | null, now = Date.now()): string {
  if (ms == null) return '—';
  // ログの時刻が端末の時計よりわずかに先のことがある。負の値は「たった今」とする
  if (now - ms < 1000) return tr('fmt.justNow');
  return tr('fmt.ago', { d: fmtDuration(now - ms) });
}

/** 枠の長さの表示名（300 → 5時間枠、10080 → 週枠、43200 → 30日枠） */
export function windowName(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return tr('win.unknown');
  if (minutes === 300) return tr('win.fiveHour');
  if (minutes === 10080) return tr('win.weekly');
  if (minutes % 1440 === 0) return tr('win.days', { n: minutes / 1440 });
  if (minutes % 60 === 0) return tr('win.hours', { n: minutes / 60 });
  return tr('win.minutes', { n: minutes });
}

/** 枠の鍵（provider|account|limit|minutes|scope）から表示名を作る */
export function windowKeyLabel(key: string | null): string | null {
  if (!key) return null;
  const [provider, , limitId, minutes] = key.split('|');
  const p = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : (provider ?? '');
  const m = minutes && minutes !== 'x' ? Number(minutes) : null;
  return `${p} ${windowName(m)}${limitId && limitId !== provider ? ` (${limitId})` : ''}`;
}

/** 「モデル|エフォート」を表示用に整える */
export function groupLabel(group: string | null): string {
  if (!group) return '—';
  const i = group.lastIndexOf('|');
  if (i < 0) return group;
  const effort = group.slice(i + 1);
  return effort === 'unknown' ? group.slice(0, i) : `${group.slice(0, i)} / ${effort}`;
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
