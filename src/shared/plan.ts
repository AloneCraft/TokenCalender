// 利用枠の計画（ダッシュボード・消費率・シミュレーター）で画面とやり取りする型。
// 値は3種類に分けて持つ: 公式観測値（official）、ローカルログから計算した値（local）、統計による推定（Band・forecast）。

export interface Band {
  mid: number;
  low: number;
  high: number;
}

export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface PlanWindow {
  key: string;
  provider: 'claude' | 'codex';
  windowMinutes: number | null;
  planType: string | null;
  /** 公式の最新値 */
  official: {
    usedPct: number;
    remainingPct: number;
    observedAtMs: number;
    stale: boolean;
    resetsAtMs: number | null;
    source: string;
  } | null;
  /** リセット予定時刻を過ぎたが、新しい公式値はまだ無い */
  resetPassedUnconfirmed: boolean;
  /** 最後の公式値より後のローカル使用量と、そこから計算した暫定の増加（ポイント） */
  local: { tokensSinceOfficial: number; addedPct: Band | null };
  /** 目標残量を引いた、使ってよい残り（ポイント） */
  usablePct: number | null;
  forecast: {
    cyclesUsed: number;
    confidence: Confidence;
    finalPct: Band | null;
    remainingAtReset: Band | null;
    exhaustion: { likelyMs: number | null; earliestMs: number | null } | null;
    probabilityLasts: number | null;
    recentPace: { pctPerHour: number; exhaustionMs: number | null } | null;
    reasons: string[];
  } | null;
  budget: {
    reservePct: number;
    allocatablePct: number;
    today: { budgetPct: number; usedPct: number | null; leftPct: number | null } | null;
    days: { date: string; startMs: number; endMs: number; weight: number; budgetPct: number; usedPct: number | null }[];
    todayStatus: 'over' | 'near' | 'ok' | 'unknown';
  } | null;
  /** 今の周期の推移（公式値） */
  path: { t: number; p: number }[];
  cycleStartMs: number | null;
}

export interface GroupRateView {
  group: string;
  model: string;
  effort: string;
  status: 'measured' | 'tentative' | 'insufficient';
  segments: number;
  totalDeltaPct: number;
  firstMs: number;
  lastMs: number;
  pctPerMTokens: Band | null;
  pctPerTurn: Band | null;
  pctPerSession: Band | null;
  tokensPerTurn: number | null;
  coefficients: { input: Band; cacheRead: Band; output: Band } | null;
  coefficientNote: 'ok' | 'too_few_segments' | 'not_identifiable' | null;
  relativeToBaseline: number | null;
}

export interface RatesView {
  provider: 'claude' | 'codex';
  windowKey: string | null;
  windowMinutes: number | null;
  fromMs: number;
  toMs: number;
  intervals: number;
  dominatedIntervals: number;
  mixedIntervals: number;
  unobservedIntervals: number;
  overall: { pctPerMTokens: Band | null; pctPerTurn: Band | null; totalDeltaPct: number; tokens: number; turns: number };
  baseline: string | null;
  groups: GroupRateView[];
  /** 期間内の使用量の構成（トークンの割合） */
  usageMix: { group: string; share: number; tokens: number; turns: number }[];
  /** 公式値が無く、推定できない理由 */
  unavailable: 'no_official_window' | 'no_observations' | null;
}

export interface ProviderPlan {
  provider: 'claude' | 'codex';
  rates: RatesView;
  /** 直近24時間でいちばん使った組み合わせ（「今のモデル」） */
  currentGroup: string | null;
  /** 基準にした枠（週枠があれば週枠） */
  capacityWindowKey: string | null;
  /** 組み合わせごとの、残り（目標残量を引いた後）で可能な作業量 */
  capacity: { group: string; status: GroupRateView['status']; turns: Band | null; sessions: Band | null; mtokens: Band | null }[];
  /** 全体平均（暫定）での作業量 */
  overallCapacity: { turns: Band | null; mtokens: Band | null };
  /** 普段のペース（作業した1時間あたりの消費）で、あと何時間作業できるか */
  activeHours: { pctPerActiveHour: number | null; hoursLeft: Band | null };
  /** 直近7日の実績と、同じトークン量を別の組み合わせで使った場合の消費（条件付きの試算） */
  whatIf: { days: number; actualPct: number | null; tokens: number; byGroup: { group: string; pct: Band | null }[] };
}

export interface PlanOverview {
  generatedAtMs: number;
  reservePct: number;
  windows: PlanWindow[];
  /** 次に作業を妨げる可能性がある枠 */
  binding: { key: string; reason: 'already_exhausted' | 'exhausts_first' | 'least_margin'; atMs: number | null } | null;
  providers: ProviderPlan[];
  demo: boolean;
}

export interface SimulateRequest {
  windowKey: string;
  group: string | null;
  turnsPerDay: number;
  workWeekdays: number[];
  workStartHour: number;
  workHours: number;
  zone: string;
}

export interface SimulateResult {
  windowKey: string;
  group: string | null;
  pctPerTurn: Band | null;
  usedNow: number | null;
  resetsAtMs: number | null;
  points: { t: number; mid: number; low: number; high: number }[];
  finalPct: Band | null;
  exhaustionMs: { mid: number | null; earliest: number | null } | null;
  /** 推定が無いなどで計算できない理由 */
  unavailable: string | null;
}
