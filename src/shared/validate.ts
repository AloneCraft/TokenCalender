// 画面からの要求の検査。型・選択肢・範囲・長さを確かめ、合わなければ例外にする。
// main（IPC の入口）と問い合わせスレッドの両方で使う。

import type {
  AnalysisRequest,
  BillingMode,
  CalendarRequest,
  CommonFilter,
  DayDetailRequest,
  Dimension,
  ManualObservationInput,
  Measure,
  Settings,
  SimulateRequest,
  TimelineRequest,
} from './api.ts';

export class ValidationError extends Error {}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function obj(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${name} must be an object`);
  return v as Record<string, unknown>;
}

export function str(v: unknown, name: string, max = 512): string {
  if (typeof v !== 'string' || v.length > max) fail(`${name} must be a string (<= ${max})`);
  return v;
}

export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

export function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name} must be a number in [${min}, ${max}]`);
  return v;
}

export function oneOf<T extends string | number>(v: unknown, name: string, values: readonly T[]): T {
  if (!values.includes(v as T)) fail(`${name} must be one of ${values.join(', ')}`);
  return v as T;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(`${name} must be a boolean`);
  return v;
}

function strList(v: unknown, name: string, maxItems = 200): string[] {
  if (!Array.isArray(v) || v.length > maxItems) fail(`${name} must be an array`);
  return v.map((x, i) => str(x, `${name}[${i}]`, 256));
}

export const MEASURES: readonly Measure[] = ['tokens', 'cost', 'input', 'cache_read', 'cache_write', 'output', 'reasoning', 'events'];
export const DIMENSIONS: readonly Dimension[] = ['none', 'provider', 'model', 'project', 'token_type', 'effort', 'billing', 'account', 'sidechain'];
export const BILLING: readonly BillingMode[] = ['subscription', 'api', 'extra_credit', 'unknown'];

function zone(v: unknown): string {
  const z = str(v, 'zone', 64);
  if (!/^[A-Za-z0-9_+\-/]+$/.test(z)) fail('zone is invalid');
  return z;
}

export function commonFilter(v: unknown): CommonFilter {
  const o = obj(v, 'request');
  return {
    provider: oneOf(o.provider, 'provider', ['claude', 'codex', 'both'] as const),
    account: str(o.account, 'account', 128),
    models: strList(o.models ?? [], 'models'),
    projects: strList(o.projects ?? [], 'projects'),
    billingModes: strList(o.billingModes ?? [], 'billingModes').map((b) => oneOf(b, 'billingMode', BILLING)),
    includeSidechain: o.includeSidechain === undefined ? true : bool(o.includeSidechain, 'includeSidechain'),
    zone: zone(o.zone),
    pricingMode: oneOf(o.pricingMode ?? 'historical', 'pricingMode', ['historical', 'current'] as const),
  };
}

function windowSel(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  return str(v, name, 512);
}

export function calendarRequest(v: unknown): CalendarRequest {
  const o = obj(v, 'request');
  return {
    ...commonFilter(o),
    year: int(o.year, 'year', 2000, 2200),
    month: int(o.month, 'month', 1, 12),
    weekStart: oneOf(o.weekStart, 'weekStart', [1, 7] as const),
    measure: oneOf(o.measure, 'measure', MEASURES),
    dimension: oneOf(o.dimension, 'dimension', DIMENSIONS),
    window: windowSel(o.window, 'window'),
  };
}

export function timelineRequest(v: unknown): TimelineRequest {
  const o = obj(v, 'request');
  const g = obj(o.granularity, 'granularity');
  let granularity: TimelineRequest['granularity'];
  if (g.kind === 'days') granularity = { kind: 'days', n: int(g.n, 'n', 1, 366), m: int(g.m, 'm', 1, 3660) };
  else if (g.kind === 'five_hour') granularity = { kind: 'five_hour', m: int(g.m, 'm', 1, 2000) };
  else if (g.kind === 'calendar_week') granularity = { kind: 'calendar_week', weeks: int(g.weeks, 'weeks', 1, 520) };
  else fail('granularity.kind is invalid');
  return {
    ...commonFilter(o),
    granularity,
    measure: oneOf(o.measure, 'measure', MEASURES),
    dimension: oneOf(o.dimension, 'dimension', DIMENSIONS),
    window: windowSel(o.window, 'window'),
    overlayWindow: windowSel(o.overlayWindow, 'overlayWindow'),
    weekStart: oneOf(o.weekStart ?? 1, 'weekStart', [1, 7] as const),
  };
}

export function dayDetailRequest(v: unknown): DayDetailRequest {
  const o = obj(v, 'request');
  const date = str(o.date, 'date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('date is invalid');
  return { ...commonFilter(o), date, window: windowSel(o.window, 'window'), stepMinutes: oneOf(o.stepMinutes, 'stepMinutes', [15, 60] as const) };
}

export function analysisRequest(v: unknown): AnalysisRequest {
  const o = obj(v, 'request');
  const fromMs = num(o.fromMs, 'fromMs', 0, 8.64e15);
  const toMs = num(o.toMs, 'toMs', 0, 8.64e15);
  if (toMs <= fromMs || toMs - fromMs > 3 * 366 * 86400000) fail('range is invalid');
  return {
    ...commonFilter(o),
    chartId: oneOf(o.chartId, 'chartId', ['bars', 'weekday_hour', 'cache_ratio', 'session_size', 'ranking', 'share'] as const),
    fromMs,
    toMs,
    stepMinutes: int(o.stepMinutes, 'stepMinutes', 5, 7 * 24 * 60),
    measure: oneOf(o.measure, 'measure', MEASURES),
    dimension: oneOf(o.dimension, 'dimension', DIMENSIONS),
  };
}

export function manualObservation(v: unknown): ManualObservationInput {
  const o = obj(v, 'observation');
  return {
    provider: oneOf(o.provider, 'provider', ['claude', 'codex'] as const),
    accountKey: o.accountKey == null ? null : str(o.accountKey, 'accountKey', 128),
    limitId: str(o.limitId, 'limitId', 64),
    windowMinutes: oneOf(o.windowMinutes, 'windowMinutes', [300, 10080] as const),
    usedPercent: num(o.usedPercent, 'usedPercent', 0, 1000),
    resetsAtMs: o.resetsAtMs == null ? null : num(o.resetsAtMs, 'resetsAtMs', 0, 8.64e15),
    observedAtMs: num(o.observedAtMs, 'observedAtMs', 0, 8.64e15),
    note: o.note == null ? null : str(o.note, 'note', 500),
  };
}

export function simulateRequest(v: unknown): SimulateRequest {
  const o = obj(v, 'simulate');
  const wd = o.workWeekdays;
  if (!Array.isArray(wd) || wd.length > 7) fail('workWeekdays is invalid');
  return {
    windowKey: str(o.windowKey, 'windowKey', 512),
    group: o.group == null ? null : str(o.group, 'group', 256),
    turnsPerDay: num(o.turnsPerDay, 'turnsPerDay', 0, 10000),
    workWeekdays: [...new Set((wd as unknown[]).map((x, i) => int(x, `workWeekdays[${i}]`, 0, 6)))],
    workStartHour: int(o.workStartHour, 'workStartHour', 0, 23),
    workHours: int(o.workHours, 'workHours', 1, 24),
    zone: zone(o.zone),
  };
}

export function ratesRequest(v: unknown): { provider: 'claude' | 'codex'; fromMs: number; toMs: number } {
  const o = obj(v, 'rates');
  const fromMs = num(o.fromMs, 'fromMs', 0, 8.64e15);
  const toMs = num(o.toMs, 'toMs', 0, 8.64e15);
  if (toMs <= fromMs || toMs - fromMs > 400 * 86400000) fail('range is invalid');
  return { provider: oneOf(o.provider, 'provider', ['claude', 'codex'] as const), fromMs, toMs };
}

export function settingsPatch(v: unknown): Partial<Settings> {
  const o = obj(v, 'settings');
  const out: Partial<Settings> = {};
  if ('zone' in o) out.zone = o.zone === null ? null : zone(o.zone);
  if ('weekStart' in o) out.weekStart = oneOf(o.weekStart, 'weekStart', [1, 7] as const);
  if ('currency' in o) out.currency = oneOf(o.currency, 'currency', ['USD', 'JPY'] as const);
  if ('usdJpy' in o) out.usdJpy = num(o.usdJpy, 'usdJpy', 1, 10000);
  if ('usdJpyUpdatedAt' in o) out.usdJpyUpdatedAt = o.usdJpyUpdatedAt === null ? null : num(o.usdJpyUpdatedAt, 'usdJpyUpdatedAt', 0, 8.64e15);
  if ('pricingMode' in o) out.pricingMode = oneOf(o.pricingMode, 'pricingMode', ['historical', 'current'] as const);
  if ('theme' in o) out.theme = oneOf(o.theme, 'theme', ['system', 'light', 'dark'] as const);
  if ('language' in o) out.language = oneOf(o.language, 'language', ['system', 'ja', 'en'] as const);
  if ('demo' in o) out.demo = bool(o.demo, 'demo');
  if ('reservePct' in o) out.reservePct = num(o.reservePct, 'reservePct', 0, 50);
  if ('budgetWeekdayWeights' in o) {
    if (o.budgetWeekdayWeights === null) out.budgetWeekdayWeights = null;
    else {
      if (!Array.isArray(o.budgetWeekdayWeights) || o.budgetWeekdayWeights.length !== 7) fail('budgetWeekdayWeights is invalid');
      out.budgetWeekdayWeights = (o.budgetWeekdayWeights as unknown[]).map((x, i) => num(x, `budgetWeekdayWeights[${i}]`, 0, 10));
    }
  }
  if ('extraSources' in o) {
    if (!Array.isArray(o.extraSources) || o.extraSources.length > 50) fail('extraSources is invalid');
    out.extraSources = o.extraSources.map((x, i) => {
      const e = obj(x, `extraSources[${i}]`);
      return { provider: oneOf(e.provider, 'provider', ['claude', 'codex'] as const), path: str(e.path, 'path', 1024) };
    });
  }
  return out;
}

export function sourceUpdate(v: unknown): { sourceId: string; accountKey?: string | null; billingMode?: BillingMode; enabled?: boolean } {
  const o = obj(v, 'source');
  const out: { sourceId: string; accountKey?: string | null; billingMode?: BillingMode; enabled?: boolean } = { sourceId: str(o.sourceId, 'sourceId', 128) };
  if ('accountKey' in o) out.accountKey = o.accountKey === null ? null : str(o.accountKey, 'accountKey', 128);
  if ('billingMode' in o) out.billingMode = oneOf(o.billingMode, 'billingMode', BILLING);
  if ('enabled' in o) out.enabled = bool(o.enabled, 'enabled');
  return out;
}

export function externalUrl(v: unknown): string {
  const s = str(v, 'url', 2048);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    fail('url is invalid');
  }
  // 外部リンクは公式資料の https だけを許す
  const allowed = ['platform.claude.com', 'code.claude.com', 'developers.openai.com', 'learn.chatgpt.com', 'github.com', 'ccusage.com'];
  if (u.protocol !== 'https:' || !allowed.includes(u.hostname)) fail('url is not allowed');
  return u.toString();
}
