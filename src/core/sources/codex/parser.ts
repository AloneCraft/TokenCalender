// Codex の rollout ログ（JSONL / JSONL.zst）を1行ずつ読み、正規化イベントと公式利用率の観測へ変換する。
//
// 実ログで確認した事実（docs/data-formats.md に根拠を記録）:
// - 使用量は2種類の行で記録される。
//   token_usage_record: 応答ごとの usage と、スレッドの累積 thread_token_usage を持つ（新しい版から）。
//   event_msg/token_count: スレッドの累積 total_token_usage と、直前の応答の last_token_usage を持つ。
// - 1つのファイルの中で token_usage_record が途中から始まることがある（古い版で始めた会話を新しい版で続けた場合など）。
// - token_usage_record の usage の合計は、同じスレッドの thread_token_usage と一致する（記録自体は欠けない）。
// - token_count の累積は記録の累積より少し小さいことがあり、2種類を同じ値として突き合わせられない。
// - token_count だけのファイルで、2つの累積が交互に書かれることがある。各列の中では 増分 = last_token_usage が成り立つ。
// - 同じ累積値の token_count が繰り返し書かれることがある。
// - fork やサブエージェントでは、subagent_history_start_ordinal より前の行は親の履歴の再記録である。
//
// 方式:
// 1. 応答ごとの記録があれば、それを正とする（応答 ID を鍵にする）。スレッドごとに累積の到達点を持ち、
//    記録が途中から始まった場合や記録に抜けがある場合だけ、累積との差を「記録の無い利用」として数える。
// 2. 記録が現れるまでは token_count を使う。累積は複数の「列」として持ち、各行を
//    「列の前回値 ＋ 今回の last ＝ 今回の累積」が成り立つ列に割り当て、その列の増分だけを数える。
//    当てはまる列が無い行は新しい列として扱い、last の分だけを数える（数え過ぎを避ける）。
// 3. 記録が現れた後の token_count は使用量の計算に使わない（公式利用率の観測だけに使う）。

import type { BillingMode, ParseOutput, QualityFlag, QuotaObservation, TokenBreakdown, UsageEvent } from '../../model/types.ts';
import { windowKindFromMinutes } from '../../model/types.ts';
import { safeCount } from '../../model/tokens.ts';
import { projectIdentity, shortHash } from '../../util/hash.ts';

export const CODEX_PARSER_VERSION = 'codex-4';

/** 同時に追う token_count の列の上限 */
const MAX_SERIES = 8;

export interface CodexFileContext {
  fileKey: string;
  sourceId: string;
  /** データ元に設定された課金区分（ログから分からない場合に使う） */
  billingMode: BillingMode;
  /** データ元に設定されたアカウント（ログから分からない場合に使う） */
  accountKey: string | null;
}

/** Codex の生の使用量（キャッシュ読みは入力の内数、推論は出力の内数） */
export interface CodexRawUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CodexParserState {
  sessionId: string | null;
  parentSessionId: string | null;
  startOrdinal: number | null;
  model: string | null;
  effort: string | null;
  turnId: string | null;
  /** token_count の累積の列（各列の数え終えた到達点） */
  tcSeries: CodexRawUsage[];
  /** 応答ごとの記録の、スレッドごとの累積の到達点 */
  threads: Record<string, CodexRawUsage>;
  /** 応答ごとの記録が現れたか */
  recordsSeen: boolean;
  generation: number;
  accountKey: string | null;
  planType: string | null;
  projectKey: string | null;
  projectLabel: string | null;
  originator: string | null;
  isSubagent: boolean;
  sawMeta: boolean;
  lineIndex: number;
}

function initialState(): CodexParserState {
  return {
    sessionId: null,
    parentSessionId: null,
    startOrdinal: null,
    model: null,
    effort: null,
    turnId: null,
    tcSeries: [],
    threads: {},
    recordsSeen: false,
    generation: 0,
    accountKey: null,
    planType: null,
    projectKey: null,
    projectLabel: null,
    originator: null,
    isSubagent: false,
    sawMeta: false,
    lineIndex: 0,
  };
}

const HEAD_TYPE_RE = /"type":"([a-z_]+)"/;
const RELEVANT = new Set(['session_meta', 'turn_context', 'token_usage_record', 'event_msg']);
const RELEVANT_EVENT_MSG = /"payload":\{"type":"(token_count|task_started|task_complete|turn_aborted)"/;

interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

export function rawUsage(v: unknown): CodexRawUsage | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const input = safeCount(o.input_tokens);
  const output = safeCount(o.output_tokens);
  const total = typeof o.total_tokens === 'number' ? safeCount(o.total_tokens) : input + output;
  return {
    input,
    cached: safeCount(o.cached_input_tokens),
    cacheWrite: safeCount(o.cache_write_input_tokens),
    output,
    reasoning: safeCount(o.reasoning_output_tokens),
    total,
  };
}

function subUsage(a: CodexRawUsage, b: CodexRawUsage): CodexRawUsage {
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
    total: Math.max(0, a.total - b.total),
  };
}

function sameUsage(a: CodexRawUsage, b: CodexRawUsage): boolean {
  return a.input === b.input && a.cached === b.cached && a.output === b.output && a.reasoning === b.reasoning && a.cacheWrite === b.cacheWrite;
}

/**
 * Codex の生の使用量を、重なりのない分類へ直す。
 * - cached_input_tokens は input_tokens の内数なので、通常入力 = 入力 - キャッシュ読み。
 * - cache_write_input_tokens も入力の内数と仮定する（実ログでは常に 0 で未検証。0 でなければ印を付ける）。
 * - reasoning_output_tokens は output_tokens の内数（last_usage_includes_reasoning が false の場合だけ足す）。
 */
export function codexUsageToTokens(u: CodexRawUsage, includesReasoning: boolean, flags: QualityFlag[]): TokenBreakdown {
  if (u.cacheWrite > 0) flags.push('codex_cache_write_assumed_in_input');
  const inputUncached = Math.max(0, u.input - u.cached - u.cacheWrite);
  const output = includesReasoning ? u.output : u.output + u.reasoning;
  // 内訳の合計が報告された合計に届かない分は「分類不明」として残す（合計だけの記録がある）
  const unclassified = Math.max(0, u.total - (u.input + output));
  return {
    inputUncached,
    cacheRead: u.cached,
    cacheWrite: u.cacheWrite,
    cacheWrite5m: null,
    cacheWrite1h: null,
    output,
    reasoning: u.reasoning,
    unclassified,
    providerTotal: u.total,
  };
}

export class CodexFileParser {
  private state: CodexParserState;
  private readonly ctx: CodexFileContext;

  constructor(ctx: CodexFileContext, state?: CodexParserState | null) {
    this.ctx = ctx;
    this.state = state ? (structuredClone(state) as CodexParserState) : initialState();
  }

  getState(): CodexParserState {
    return structuredClone(this.state);
  }

  feed(line: string, offset: number, out: ParseOutput): void {
    if (line.length === 0) return;
    this.state.lineIndex++;
    const head = line.length > 240 ? line.slice(0, 240) : line;
    const type = HEAD_TYPE_RE.exec(head)?.[1];
    if (!type || !RELEVANT.has(type)) return;
    if (type === 'event_msg' && !RELEVANT_EVENT_MSG.test(head)) return;
    let o: CodexLine;
    try {
      o = JSON.parse(line) as CodexLine;
    } catch {
      out.badLines++;
      return;
    }
    const p = o.payload;
    if (!p || typeof p !== 'object') return;
    const tsMs = Date.parse(o.timestamp ?? '');
    const ordinal = typeof o.ordinal === 'number' ? o.ordinal : null;
    switch (o.type) {
      case 'session_meta':
        this.onSessionMeta(p, tsMs, out);
        break;
      case 'turn_context':
        if (typeof p.model === 'string') this.state.model = p.model;
        if (typeof p.effort === 'string') this.state.effort = p.effort;
        if (typeof p.turn_id === 'string') this.state.turnId = p.turn_id;
        break;
      case 'token_usage_record':
        this.onUsageRecord(p, tsMs, ordinal, offset, out);
        break;
      case 'event_msg':
        this.onEventMsg(p, tsMs, ordinal, offset, out);
        break;
    }
  }

  private inherited(ordinal: number | null): boolean {
    return this.state.startOrdinal != null && ordinal != null && ordinal < this.state.startOrdinal;
  }

  private onSessionMeta(p: Record<string, unknown>, tsMs: number, out: ParseOutput): void {
    // fork したファイルには親の session_meta が再記録される場合があるため、最初の1件だけを採用する。
    if (this.state.sawMeta) return;
    this.state.sawMeta = true;
    const id = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : null;
    this.state.sessionId = id;
    let parent: string | null = typeof p.parent_thread_id === 'string' ? p.parent_thread_id : null;
    const src = p.source as Record<string, unknown> | string | undefined;
    if (src && typeof src === 'object') {
      const sub = (src as Record<string, unknown>).subagent as Record<string, unknown> | undefined;
      if (sub) this.state.isSubagent = true;
      const spawn = sub?.thread_spawn as Record<string, unknown> | undefined;
      if (!parent && spawn && typeof spawn.parent_thread_id === 'string') parent = spawn.parent_thread_id;
    }
    this.state.parentSessionId = parent;
    this.state.startOrdinal = typeof p.subagent_history_start_ordinal === 'number' ? p.subagent_history_start_ordinal : null;
    const acct = typeof p.creator_account_id === 'string' && p.creator_account_id ? p.creator_account_id : null;
    this.state.accountKey = acct ? `codex:acct:${shortHash(acct)}` : this.ctx.accountKey;
    const proj = projectIdentity(typeof p.cwd === 'string' ? p.cwd : null);
    this.state.projectKey = proj.key;
    this.state.projectLabel = proj.label;
    this.state.originator = typeof p.originator === 'string' ? p.originator : null;
    if (id) {
      out.sessions.push({
        sessionKey: `codex:${id}`,
        provider: 'codex',
        sessionId: id,
        parentSessionId: parent,
        sourceId: this.ctx.sourceId,
        accountKey: this.state.accountKey,
        projectKey: proj.key,
        projectLabel: proj.label,
        originator: this.state.originator,
        billingMode: this.ctx.billingMode,
        firstTsMs: Number.isFinite(tsMs) ? tsMs : null,
        lastTsMs: Number.isFinite(tsMs) ? tsMs : null,
      });
    }
  }

  private onUsageRecord(p: Record<string, unknown>, tsMs: number, ordinal: number | null, offset: number, out: ParseOutput): void {
    const usage = rawUsage(p.usage);
    const cum = rawUsage(p.thread_token_usage);
    if (!usage || !cum || !Number.isFinite(tsMs)) return;
    if (typeof p.turn_id === 'string' && !this.inherited(ordinal)) this.state.turnId = p.turn_id;
    const st = this.state;
    const thread = typeof p.thread_id === 'string' && p.thread_id ? p.thread_id : (st.sessionId ?? 'unknown');
    if (this.inherited(ordinal)) {
      // 親から引き継いだ累積を基準にする（数えない）
      st.threads[thread] = cum;
      return;
    }
    const prevCum = subUsage(cum, usage);
    const respId = typeof p.response_id === 'string' && p.response_id ? p.response_id : null;
    const respKey = respId ? `codex:resp:${respId}` : this.cumKey(cum.total, thread);
    let fr = st.threads[thread];
    const firstForThread = fr == null;
    if (fr == null) {
      // このスレッドで最初の記録。token_count で既に数えた範囲、または引き継いだ累積を基準にする。
      // 当てはまるものが無ければ、この応答の分だけを数える（このファイルより前の利用は数えない）。
      const candidates = [...st.tcSeries, ...Object.values(st.threads)].filter((v) => v.total <= cum.total);
      const best = candidates.reduce<CodexRawUsage | null>((m, v) => (m == null || v.total > m.total ? v : m), null);
      fr = best ?? prevCum;
    }
    st.recordsSeen = true;
    if (!firstForThread && cum.total < fr.total) {
      // 同じスレッドの累積が減った: 世代が変わったとみなし、この応答の利用は数える（捨てない）。
      st.generation++;
      this.emit(usage, true, tsMs, offset, respKey, ['counter_reset'], out, respId);
      st.threads[thread] = cum;
      return;
    }
    if (cum.total <= fr.total) {
      st.threads[thread] = fr;
      return; // 既に token_count で数えた範囲
    }
    const delta = subUsage(cum, fr);
    if (sameUsage(delta, usage)) {
      this.emit(usage, true, tsMs, offset, respKey, [], out, respId);
    } else if (delta.total > usage.total && fr.total <= prevCum.total) {
      // 記録されていない利用がある（記録が途中から始まった場合など）
      const gap = subUsage(prevCum, fr);
      if (gap.total > 0) this.emit(gap, true, tsMs, offset, this.cumKey(prevCum.total, thread), ['cumulative_gap'], out, null);
      this.emit(usage, true, tsMs, offset, respKey, [], out, respId);
    } else {
      // 一部が既に token_count で数えられている。残りの差分だけを数える。
      this.emit(delta, true, tsMs, offset, this.cumKey(cum.total, thread), ['cumulative_partial_overlap'], out, null);
    }
    st.threads[thread] = cum;
  }

  private onEventMsg(p: Record<string, unknown>, tsMs: number, ordinal: number | null, offset: number, out: ParseOutput): void {
    const kind = p.type;
    if (kind === 'task_started' || kind === 'task_complete' || kind === 'turn_aborted') {
      if (this.inherited(ordinal)) return;
      const turnId = typeof p.turn_id === 'string' ? p.turn_id : this.state.turnId;
      if (!turnId || !this.state.sessionId) return;
      if (kind === 'task_started') this.state.turnId = turnId;
      const startedAt = typeof p.started_at === 'number' ? secToMs(p.started_at) : kind === 'task_started' && Number.isFinite(tsMs) ? tsMs : null;
      const completedAt = kind === 'task_started' ? null : typeof p.completed_at === 'number' ? secToMs(p.completed_at) : Number.isFinite(tsMs) ? tsMs : null;
      out.turns.push({
        turnKey: `codex:${this.state.sessionId}:${turnId}`,
        provider: 'codex',
        sessionId: this.state.sessionId,
        turnId,
        startedAtMs: startedAt,
        completedAtMs: completedAt,
        status: kind === 'task_started' ? 'running' : kind === 'task_complete' ? 'completed' : 'aborted',
      });
      return;
    }
    if (kind !== 'token_count') return;
    if (p.rate_limits && Number.isFinite(tsMs)) this.onRateLimits(p.rate_limits as Record<string, unknown>, tsMs, offset, out);
    const info = p.info as Record<string, unknown> | null | undefined;
    if (!info || !Number.isFinite(tsMs)) return;
    const total = rawUsage(info.total_token_usage);
    const last = rawUsage(info.last_token_usage);
    if (!total) return;
    const includesReasoning = info.last_usage_includes_reasoning !== false;
    const st = this.state;
    if (this.inherited(ordinal)) {
      this.touchSeries(total); // 親から引き継いだ累積を基準にする（数えない）
      return;
    }
    // 応答ごとの記録がある場合は、記録の側で数える
    if (st.recordsSeen) return;
    // 同じ累積値の再通知
    if (st.tcSeries.some((s) => s.total === total.total)) return;
    const lastTotal = last?.total ?? 0;
    // 「列の前回値 ＋ last ＝ 今回の累積」が成り立つ列を探す
    const idx = st.tcSeries.findIndex((s) => s.total + lastTotal === total.total);
    if (idx >= 0) {
      const delta = subUsage(total, st.tcSeries[idx]!);
      this.emit(delta, includesReasoning, tsMs, offset, this.cumKey(total.total, null), [], out, null);
      st.tcSeries.splice(idx, 1);
      this.touchSeries(total);
      return;
    }
    // 列が1つだけで、累積がそれより先に進んでいる: 途中の token_count が書かれなかったとみなし、差をすべて数える
    const only = st.tcSeries.length === 1 ? st.tcSeries[0]! : null;
    if (only && total.total > only.total + lastTotal) {
      const delta = subUsage(total, only);
      this.emit(delta, includesReasoning, tsMs, offset, this.cumKey(total.total, null), ['delta_differs_from_last'], out, null);
      st.tcSeries = [];
      this.touchSeries(total);
      return;
    }
    // 当てはまる列が無い: 新しい列として、last の分だけを数える（ファイルの最初・別の累積・リセット）
    const flags: QualityFlag[] = st.tcSeries.length > 0 ? ['counter_reset'] : [];
    if (last && last.total > 0 && last.total <= total.total) {
      this.emit(last, includesReasoning, tsMs, offset, this.cumKey(total.total, null), flags, out, null);
    }
    this.touchSeries(total);
  }

  /** 列を最新として記録する（古い列は上限を超えたら捨てる） */
  private touchSeries(total: CodexRawUsage): void {
    const st = this.state;
    st.tcSeries = st.tcSeries.filter((s) => s.total !== total.total);
    st.tcSeries.push(total);
    if (st.tcSeries.length > MAX_SERIES) st.tcSeries.shift();
  }

  private onRateLimits(r: Record<string, unknown>, tsMs: number, offset: number, out: ParseOutput): void {
    const limitId = typeof r.limit_id === 'string' && r.limit_id ? r.limit_id : 'codex';
    const plan = typeof r.plan_type === 'string' ? r.plan_type : null;
    if (plan) this.state.planType = plan;
    for (const slot of ['primary', 'secondary'] as const) {
      const w = r[slot] as Record<string, unknown> | null | undefined;
      if (!w || typeof w !== 'object') continue; // 枠が無い。0% とは扱わない
      const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
      const used = typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) ? w.used_percent : null;
      const resets = typeof w.resets_at === 'number' ? secToMs(w.resets_at) : null;
      const flags: string[] = [];
      if (minutes == null || minutes <= 0) flags.push('invalid_window');
      if (used == null) flags.push('missing_percent');
      const obs: QuotaObservation = {
        obsKey: `codex:${this.state.accountKey ?? 'unknown'}:${limitId}:${slot}:${minutes ?? 'x'}:${tsMs}`,
        provider: 'codex',
        accountKey: this.state.accountKey ?? this.ctx.accountKey,
        planType: plan,
        limitId,
        windowKind: windowKindFromMinutes(minutes),
        windowMinutes: minutes,
        scopeModels: null,
        observedAtMs: tsMs,
        usedPercent: used,
        resetsAtMs: resets,
        source: 'codex_log',
        precision: used != null && Number.isInteger(used) ? 1 : 0.1,
        flags,
        originRef: `${this.ctx.fileKey}@${offset}`,
      };
      out.quota.push(obs);
    }
  }

  /** 応答 ID が使えない場合の鍵。同じスレッド・同じ世代・同じ累積値なら、どのファイルから読んでも同じ鍵になる */
  private cumKey(total: number, thread: string | null): string {
    const sid = this.state.sessionId ?? this.ctx.fileKey;
    const th = thread && thread !== sid ? `${thread}:` : '';
    return `codex:cum:${sid}:${th}g${this.state.generation}:${total}`;
  }

  private emit(
    u: CodexRawUsage,
    includesReasoning: boolean,
    tsMs: number,
    offset: number,
    eventKey: string,
    flags: QualityFlag[],
    out: ParseOutput,
    responseId: unknown,
  ): void {
    if (u.total <= 0 && u.input + u.output <= 0) return;
    const st = this.state;
    const fl = [...flags];
    const tokens = codexUsageToTokens(u, includesReasoning, fl);
    if (!st.model) fl.push('model_unknown');
    const sessionId = st.sessionId ?? `file:${this.ctx.fileKey}`;
    const billing: BillingMode = st.planType ? 'subscription' : this.ctx.billingMode;
    out.events.push({
      eventKey,
      provider: 'codex',
      sourceId: this.ctx.sourceId,
      accountKey: st.accountKey ?? this.ctx.accountKey,
      sessionId,
      parentSessionId: st.parentSessionId,
      agentId: null,
      isSidechain: st.isSubagent || st.parentSessionId != null,
      turnId: st.turnId,
      requestId: typeof responseId === 'string' ? responseId : null,
      messageId: null,
      tsMs,
      model: st.model,
      effort: st.effort,
      speed: null,
      serviceTier: null,
      inferenceGeo: null,
      projectKey: st.projectKey,
      projectLabel: st.projectLabel,
      billingMode: billing,
      tokens,
      finality: 1,
      rank: 1,
      flags: fl,
      origin: { fileKey: this.ctx.fileKey, offset, parserVersion: CODEX_PARSER_VERSION },
    } satisfies UsageEvent);
  }
}

function secToMs(v: number): number {
  // 秒と思われる値（10桁程度）はミリ秒へ直す。既にミリ秒の値はそのまま。
  return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
}
