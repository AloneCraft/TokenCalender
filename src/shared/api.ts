// 画面（renderer）と裏側（main / 別スレッド）で共有する型。
// 画面に渡すのは集計済みの値だけで、ログ本文やファイルパスは渡さない（データ元画面のフォルダー名を除く）。

import type { PlanOverview, RatesView, SimulateRequest, SimulateResult } from './plan.ts';
export type * from './plan.ts';

export type Provider = 'claude' | 'codex';
export type ProviderSel = Provider | 'both';
export type Measure = 'tokens' | 'cost' | 'input' | 'cache_read' | 'cache_write' | 'output' | 'reasoning' | 'events';
export type Dimension = 'none' | 'provider' | 'model' | 'project' | 'token_type' | 'effort' | 'billing' | 'account' | 'sidechain';
export type PricingMode = 'historical' | 'current';
export type Currency = 'USD' | 'JPY';
export type BillingMode = 'subscription' | 'api' | 'extra_credit' | 'unknown';

export interface CommonFilter {
  provider: ProviderSel;
  /** 'all' または accountKey（'unknown' はアカウント不明） */
  account: string;
  models: string[];
  projects: string[];
  billingModes: BillingMode[];
  includeSidechain: boolean;
  zone: string;
  pricingMode: PricingMode;
}

/** 周期内累積に使う枠。null の場合は累積を表示できない */
export type WindowSelector = string | null;

// ---------- カレンダー ----------

export interface CalendarRequest extends CommonFilter {
  year: number;
  month: number;
  weekStart: 1 | 7;
  measure: Measure;
  dimension: Dimension;
  window: WindowSelector;
}

export interface CumulativeCell {
  cycleKnown: boolean;
  cycleEstimated: boolean;
  prior: number | null;
  increment: number | null;
  cumulative: number | null;
  resetInBucket: boolean;
  oldCycleUsage: number;
}

export interface DayCell {
  date: string;
  startMs: number;
  endMs: number;
  inMonth: boolean;
  future: boolean;
  /** 記録の範囲外（最初の記録より前）。使用量 0 とは区別する */
  noData: boolean;
  total: number;
  byDim: Record<string, number>;
  events: number;
  tokens: number;
  unpricedEvents: number;
  unpricedTokens: number;
  flaggedEvents: number;
  partialEvents: number;
  cumulative: CumulativeCell;
  /** この日にリセット（公式観測による）があったか */
  resetMarks: { atMs: number; estimated: boolean }[];
}

export interface CalendarResponse {
  cells: DayCell[];
  /** 表示範囲（月）の縦軸の最大値。日ごとに拡大しない */
  maxDaily: number;
  maxCumulative: number;
  /** 月の合計（元イベントから計算） */
  monthTotal: number;
  monthUnpricedTokens: number;
  monthUnpricedEvents: number;
  dimensionKeys: string[];
  windowLabel: string | null;
  cycleNote: 'observed' | 'partly_estimated' | 'unknown';
  dataAsOfMs: number | null;
  demo: boolean;
}

// ---------- 時系列 ----------

export type TimelineGranularity = { kind: 'days'; n: number; m: number } | { kind: 'five_hour'; m: number } | { kind: 'calendar_week'; weeks: number };

export interface TimelineRequest extends CommonFilter {
  granularity: TimelineGranularity;
  measure: Measure;
  dimension: Dimension;
  window: WindowSelector;
  /** 5時間刻みで週枠の累積も重ねる場合の枠 */
  overlayWindow: WindowSelector;
  weekStart: 1 | 7;
}

export interface TimelineBucket {
  key: string;
  startMs: number;
  endMs: number;
  total: number;
  byDim: Record<string, number>;
  unpricedTokens: number;
  events: number;
  cumulative: CumulativeCell;
  overlayCumulative: CumulativeCell | null;
  future: boolean;
}

export interface TimelineResponse {
  buckets: TimelineBucket[];
  dimensionKeys: string[];
  periodTotal: number;
  periodUnpricedTokens: number;
  /** 5時間刻みの区切りの根拠 */
  fiveHourBasis: 'official' | 'analytic' | null;
  resets: { atMs: number; estimated: boolean }[];
  windowLabel: string | null;
  demo: boolean;
}

// ---------- 日の詳細 ----------

export interface DayDetailRequest extends CommonFilter {
  date: string;
  window: WindowSelector;
  stepMinutes: 15 | 60;
}

export interface TurnSummary {
  provider: Provider;
  sessionId: string;
  turnId: string | null;
  startedAtMs: number | null;
  lastAtMs: number;
  model: string | null;
  projectLabel: string | null;
  tokens: number;
  costNano: number;
  unpricedTokens: number;
  requests: number;
  subagentRequests: number;
}

export interface DayDetailResponse {
  date: string;
  slots: { startMs: number; total: number; byModel: Record<string, number> }[];
  byModel: { model: string; tokens: number; costNano: number; priced: boolean }[];
  turns: TurnSummary[];
  cycles: { startMs: number; endMs: number; estimated: boolean; usageInDay: number; tokensInDay: number }[];
  totals: { tokens: number; costNano: number; unpricedTokens: number; input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
}

// ---------- 直近の利用 ----------

export type TurnState = 'running' | 'partial' | 'recorded' | 'waiting';

export interface RecentUsage {
  provider: Provider;
  sessionId: string;
  turnId: string | null;
  model: string | null;
  models: string[];
  projectLabel: string | null;
  startedAtMs: number | null;
  lastUpdatedMs: number;
  state: TurnState;
  turn: UsageTotals;
  session: UsageTotals;
  subagents: { agentId: string | null; tokens: number; requests: number }[];
  requests: number;
  dataSource: string;
  ingestedAtMs: number | null;
}

export interface UsageTotals {
  tokens: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costNano: number;
  unpricedTokens: number;
  priced: boolean;
}

export interface RecentResponse {
  items: RecentUsage[];
  generatedAtMs: number;
  liveNote: 'usage_recorded_after_response';
  demo: boolean;
}

// ---------- 公式利用率・推定 ----------

export type QuotaSourceState = 'ok' | 'not_configured' | 'unsupported' | 'unauthenticated' | 'failed' | 'no_window' | 'no_data';

export interface WindowInfo {
  key: string;
  provider: Provider;
  accountKey: string | null;
  limitId: string;
  windowMinutes: number | null;
  windowKind: '5h' | '7d' | 'other' | 'unknown';
  scopeModels: string | null;
  count: number;
  lastObservedAt: number;
}

export interface Range {
  mid: number;
  low: number;
  high: number;
}

export interface LatestObservation {
  usedPercent: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
  source: 'codex_log' | 'claude_statusline' | 'manual' | 'codex_app_server';
  planType: string | null;
  stale: boolean;
}

export interface QuotaOverview {
  windows: (WindowInfo & { latest: LatestObservation | null })[];
  sources: { source: string; status: QuotaSourceState; detail: string | null; updatedAt: number | null }[];
  /** プロバイダーごとに、5時間枠が観測されていない場合 true（「対象枠なし」または未取得） */
  noFiveHour: Record<Provider, boolean>;
  demo: boolean;
}

export interface EstimateSegmentView {
  startMs: number;
  endMs: number;
  p1: number;
  p2: number;
  deltaPct: number;
  tokens: number;
  costNano: number;
  unpricedTokens: number;
  capacityTokens: Range | null;
  capacityCostNano: Range | null;
  adopted: boolean;
  exclusions: string[];
  warnings: string[];
}

export interface EstimateView {
  windowKey: string;
  windowLabel: string;
  status: 'no_observations' | 'preparing' | 'ok' | 'difficult';
  statusReasons: string[];
  observationCount: number;
  adoptedCount: number;
  excludedCount: number;
  periodFromMs: number | null;
  periodToMs: number | null;
  capacityTokens: Range | null;
  capacityCostNano: Range | null;
  reference: { capacityTokens: Range | null; capacityCostNano: Range | null } | null;
  spreadRatio: number | null;
  costEstimateSuppressed: boolean;
  segments: EstimateSegmentView[];
  pace: {
    official: { usedPercent: number; remainingPercent: number; observedAtMs: number; ageMs: number; stale: boolean; source: string; resetsAtMs: number | null } | null;
    resetTimePassedUnconfirmed: boolean;
    timeToResetMs: number | null;
    auxiliary: { addedPercent: Range; usedPercent: Range; localTokensSince: number } | null;
    burnRatePctPerHour: number | null;
    projectedExhaustion: { earliestMs: number; latestMs: number } | null;
    outlook: 'lasts' | 'runs_out' | 'borderline' | 'unknown';
    evenPacePctPerHour: number | null;
  };
  /** 公式利用率の推移（重ね図用） */
  observations: { atMs: number; usedPercent: number | null; resetsAtMs: number | null; source: string }[];
  /** 同じ期間のローカル使用量（1時間刻み） */
  localHourly: { atMs: number; tokens: number; costNano: number }[];
  unknownBillingShare: number;
  modelMix: { model: string; share: number }[];
  demo: boolean;
}

export interface ManualObservationInput {
  provider: Provider;
  accountKey: string | null;
  limitId: string;
  windowMinutes: number;
  usedPercent: number;
  resetsAtMs: number | null;
  observedAtMs: number;
  note: string | null;
}

// ---------- 分析 ----------

export interface AnalysisRequest extends CommonFilter {
  chartId: string;
  fromMs: number;
  toMs: number;
  stepMinutes: number;
  measure: Measure;
  dimension: Dimension;
}

export interface AnalysisSeries {
  buckets: { startMs: number; total: number; byDim: Record<string, number> }[];
  dimensionKeys: string[];
  matrix?: number[][];
  periodTotal: number;
  unpricedTokens: number;
}

// ---------- 状態・設定 ----------

export interface SourceStatus {
  sourceId: string;
  provider: Provider;
  kind: string;
  label: string | null;
  rootPath: string;
  status: string;
  detail: string | null;
  fileCount: number;
  lastScanAt: number | null;
  accountKey: string | null;
  billingMode: BillingMode;
  enabled: boolean;
  filesWithErrors: number;
  badLines: number;
}

export interface IngestStatus {
  phase: 'idle' | 'scanning' | 'watching';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  eventsInserted: number;
  eventsUpdated: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastChangeAt: number | null;
  errors: number;
}

export interface AppStatus {
  ingest: IngestStatus;
  sources: SourceStatus[];
  accounts: { accountKey: string; provider: Provider; label: string | null }[];
  eventCount: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
  models: { provider: Provider; model: string; tokens: number }[];
  projects: { key: string; label: string; tokens: number }[];
  demo: boolean;
  dbPath: string;
}

export interface Settings {
  zone: string | null;
  weekStart: 1 | 7;
  currency: Currency;
  usdJpy: number;
  usdJpyUpdatedAt: number | null;
  pricingMode: PricingMode;
  theme: 'system' | 'light' | 'dark';
  /** system = OS の言語設定に合わせる（日本語なら日本語、それ以外は英語） */
  language: 'system' | 'ja' | 'en';
  demo: boolean;
  extraSources: { provider: Provider; path: string }[];
  /** リセット時に残しておきたい利用枠（ポイント） */
  reservePct: number;
  /** 1日ごとの予算の曜日の重み（月=0…日=6）。null なら過去の実績から求める */
  budgetWeekdayWeights: number[] | null;
}

export const DEFAULT_SETTINGS: Settings = {
  zone: null,
  weekStart: 1,
  currency: 'USD',
  usdJpy: 150,
  usdJpyUpdatedAt: null,
  pricingMode: 'historical',
  theme: 'system',
  language: 'system',
  demo: false,
  extraSources: [],
  reservePct: 5,
  budgetWeekdayWeights: null,
};

export interface BridgePreview {
  settingsPath: string;
  exists: boolean;
  currentStatusLine: unknown;
  proposedStatusLine: unknown;
  scriptPath: string;
  outputPath: string;
  installed: boolean;
  backupPath: string | null;
  note: string;
}

export interface ExportResult {
  ok: boolean;
  path: string | null;
  rows: number;
  message: string | null;
}

/** preload が画面へ公開する API */
export interface TokenCalendarApi {
  getStatus(): Promise<AppStatus>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  calendar(req: CalendarRequest): Promise<CalendarResponse>;
  timeline(req: TimelineRequest): Promise<TimelineResponse>;
  dayDetail(req: DayDetailRequest): Promise<DayDetailResponse>;
  recent(req: { zone: string; pricingMode: PricingMode; limit: number }): Promise<RecentResponse>;
  quotaOverview(): Promise<QuotaOverview>;
  estimate(req: { windowKey: string; pricingMode: PricingMode }): Promise<EstimateView>;
  analysis(req: AnalysisRequest): Promise<AnalysisSeries>;
  planOverview(req: { zone: string }): Promise<PlanOverview>;
  rates(req: { provider: Provider; fromMs: number; toMs: number }): Promise<RatesView>;
  simulate(req: SimulateRequest): Promise<SimulateResult>;
  addManualObservation(o: ManualObservationInput): Promise<{ ok: boolean; message: string | null }>;
  deleteManualObservation(id: number): Promise<{ ok: boolean }>;
  listManualObservations(): Promise<{ id: number; provider: Provider; limitId: string; windowMinutes: number | null; usedPercent: number | null; resetsAtMs: number | null; observedAtMs: number; note: string | null }[]>;
  updateSource(req: { sourceId: string; accountKey?: string | null; billingMode?: BillingMode; enabled?: boolean }): Promise<{ ok: boolean }>;
  addSource(req: { provider: Provider; path: string }): Promise<{ ok: boolean; message: string | null }>;
  pickFolder(): Promise<string | null>;
  rescan(): Promise<{ ok: boolean }>;
  detectWsl(): Promise<{ distro: string; provider: Provider; path: string }[]>;
  exportData(req: { format: 'csv' | 'json'; kind: 'events' | 'daily' | 'quota' }): Promise<ExportResult>;
  importData(): Promise<{ ok: boolean; inserted: number; skipped: number; message: string | null }>;
  deleteAppData(): Promise<{ ok: boolean }>;
  bridgePreview(): Promise<BridgePreview>;
  bridgeInstall(): Promise<{ ok: boolean; message: string | null }>;
  bridgeUninstall(): Promise<{ ok: boolean; message: string | null }>;
  openExternal(url: string): Promise<void>;
  onDataChanged(cb: (info: { at: number }) => void): () => void;
  onIngestProgress(cb: (p: IngestStatus) => void): () => void;
}
