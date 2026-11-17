// 画面全体で共有する状態（設定と、上部の操作帯の選択）。

import { createContext, useContext } from 'react';
import type { AppStatus, BillingMode, CommonFilter, Dimension, Measure, ProviderSel, QuotaOverview, Settings } from '../shared/api.ts';
import type { MoneyCtx } from './format.ts';

export type Unit = 'day' | 'week' | 'five_hour';
export type ViewMode = 'daily' | 'cumulative';

export interface Filters {
  provider: ProviderSel;
  account: string;
  unit: Unit;
  measure: Measure;
  mode: ViewMode;
  dimension: Dimension;
  models: string[];
  projects: string[];
  billingModes: BillingMode[];
  includeSidechain: boolean;
  year: number;
  month: number;
  /** 周期内累積に使う枠（windowKey） */
  window: string | null;
}

export interface AppCtx {
  settings: Settings;
  zone: string;
  money: MoneyCtx;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  status: AppStatus | null;
  quota: QuotaOverview | null;
  /** データが変わるたびに増える（再取得の合図） */
  dataVersion: number;
  /** 重い集計（状態表示・推定）用の合図。最短30秒に1回だけ増える */
  slowVersion: number;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppCtx missing');
  return c;
}

export function commonFilter(c: AppCtx): CommonFilter {
  return {
    provider: c.filters.provider,
    account: c.filters.account,
    models: c.filters.models,
    projects: c.filters.projects,
    billingModes: c.filters.billingModes,
    includeSidechain: c.filters.includeSidechain,
    zone: c.zone,
    pricingMode: c.settings.pricingMode,
  };
}

/** 選んだプロバイダーに合う枠（週枠を優先）。両方のときは選ばない（共通の枠として扱わない）。 */
export function defaultWindow(quota: QuotaOverview | null, provider: ProviderSel, prefer: 'week' | 'five_hour'): string | null {
  if (!quota || provider === 'both') return null;
  const ws = quota.windows.filter((w) => w.provider === provider && w.windowMinutes != null && w.windowMinutes > 0);
  const wanted = prefer === 'week' ? 10080 : 300;
  return (ws.find((w) => w.windowMinutes === wanted) ?? (prefer === 'week' ? ws.find((w) => w.windowMinutes! >= 1440) : undefined))?.key ?? null;
}
