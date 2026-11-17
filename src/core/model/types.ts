// 正規化後のデータ型。
// 「ログ使用量」「公式利用率」「推定」は別の型で表し、互いに混ぜない。
// API料金換算は取り込み時に PricingEngine で計算し、ログ使用量とは別の列（cost_nano）に保存する。

export type Provider = 'claude' | 'codex';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];

/**
 * 正規化したトークン内訳。
 * inputUncached / cacheRead / cacheWrite / output の4つは重なりがない。
 * reasoning は output の内数、cacheWrite5m / cacheWrite1h は cacheWrite の内訳であり、合計に足さない。
 */
export interface TokenBreakdown {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  output: number;
  reasoning: number | null;
  /** 内訳が分からないトークン（合計だけが記録されていた分）。合計に含めるが、料金は換算できない */
  unclassified: number;
  /** プロバイダーが報告した合計（参考値。Claude には無い） */
  providerTotal: number | null;
}

/** 利用の課金区分。根拠がない場合は unknown のままにする。 */
export type BillingMode = 'subscription' | 'api' | 'extra_credit' | 'unknown';
export const BILLING_MODES: readonly BillingMode[] = ['subscription', 'api', 'extra_credit', 'unknown'];

/** データ品質の印。集計から除外する理由ではなく、根拠の弱さを示す。 */
export type QualityFlag =
  | 'no_request_id'
  | 'no_message_id'
  | 'partial'
  | 'cache_write_breakdown_mismatch'
  | 'cache_write_ttl_unknown'
  | 'iterations_mismatch'
  | 'conflicting_copies'
  | 'fallback_credit_present'
  | 'counter_reset'
  | 'cumulative_gap'
  | 'cumulative_partial_overlap'
  | 'delta_differs_from_last'
  | 'codex_cache_write_assumed_in_input'
  | 'model_unknown'
  | 'timestamp_from_file';

export interface EventOrigin {
  fileKey: string;
  offset: number;
  parserVersion: string;
}

export interface UsageEvent {
  /** 重複排除の鍵。同じ利用は、どのファイルから読んでも同じ鍵になる */
  eventKey: string;
  provider: Provider;
  sourceId: string;
  accountKey: string | null;
  sessionId: string;
  parentSessionId: string | null;
  agentId: string | null;
  isSidechain: boolean;
  turnId: string | null;
  requestId: string | null;
  messageId: string | null;
  /** 利用の時刻（UTC ミリ秒） */
  tsMs: number;
  model: string | null;
  effort: string | null;
  speed: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  projectKey: string | null;
  projectLabel: string | null;
  billingMode: BillingMode;
  tokens: TokenBreakdown;
  /** 1 = 最終値、0 = 途中経過 */
  finality: 0 | 1;
  /** 同じ鍵の記録どうしを比べる順位。大きい方を採用する（根拠は docs/data-formats.md） */
  rank: number;
  flags: QualityFlag[];
  origin: EventOrigin;
}

export type TurnStatus = 'running' | 'completed' | 'aborted' | 'unknown';

export interface TurnRecord {
  turnKey: string;
  provider: Provider;
  sessionId: string;
  turnId: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  status: TurnStatus;
}

export interface SessionRecord {
  sessionKey: string;
  provider: Provider;
  sessionId: string;
  parentSessionId: string | null;
  sourceId: string;
  accountKey: string | null;
  projectKey: string | null;
  projectLabel: string | null;
  originator: string | null;
  billingMode: BillingMode;
  firstTsMs: number | null;
  lastTsMs: number | null;
}

export type QuotaSourceKind = 'codex_log' | 'claude_statusline' | 'manual' | 'codex_app_server';
export type WindowKind = '5h' | '7d' | 'other' | 'unknown';

/** 公式の利用枠の観測1件。usedPercent が null の観測は「欠損」であり 0% ではない。 */
export interface QuotaObservation {
  obsKey: string;
  provider: Provider;
  accountKey: string | null;
  planType: string | null;
  limitId: string;
  windowKind: WindowKind;
  windowMinutes: number | null;
  /** null = 全モデル共通の枠 */
  scopeModels: string | null;
  observedAtMs: number;
  usedPercent: number | null;
  resetsAtMs: number | null;
  source: QuotaSourceKind;
  /** 利用率の刻み幅（整数で返る場合は 1） */
  precision: number;
  flags: string[];
  originRef: string | null;
}

export interface ParseOutput {
  events: UsageEvent[];
  turns: TurnRecord[];
  sessions: SessionRecord[];
  quota: QuotaObservation[];
  badLines: number;
}

export function emptyParseOutput(): ParseOutput {
  return { events: [], turns: [], sessions: [], quota: [], badLines: 0 };
}

export function windowKindFromMinutes(minutes: number | null | undefined): WindowKind {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return 'unknown';
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  return 'other';
}
