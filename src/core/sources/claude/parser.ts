// Claude Code のセッションログ（JSONL）を1行ずつ読み、正規化イベントへ変換する。
//
// 実ログで確認した事実（docs/data-formats.md に根拠を記録）:
// - 1回の応答は、内容ブロックごとに複数行へ同じ message.id / usage で書かれる。
// - 途中経過の行は stop_reason が null で、output_tokens だけが小さい。最終行は stop_reason を持つ。
// - 会話の再開などで、同じ message.id の行が別ファイルにも写される。
// - 応答の行には promptId が無い。直前のユーザー行（ツール結果の行を含む）の promptId がターンを示す。
// - サブエージェントのファイルの promptId は、親のターンの promptId と一致する。

import type { BillingMode, ParseOutput, QualityFlag, TokenBreakdown, UsageEvent } from '../../model/types.ts';
import { safeCount } from '../../model/tokens.ts';
import { projectIdentity } from '../../util/hash.ts';

export const CLAUDE_PARSER_VERSION = 'claude-2';

export interface ClaudeFileContext {
  fileKey: string;
  sourceId: string;
  isSubagentFile: boolean;
  accountKey: string | null;
  billingMode: BillingMode;
}

export interface ClaudeParserState {
  lastPromptId: string | null;
}

const RANK_FINAL = 1e15;

interface ClaudeLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  promptId?: string;
  requestId?: string;
  isSidechain?: boolean;
  agentId?: string;
  cwd?: string;
  effort?: string;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
}

const TOP_TYPE_RE = /"type":"([A-Za-z_-]+)"/;

export function topLevelType(line: string): string | null {
  return TOP_TYPE_RE.exec(line.length > 4000 ? line.slice(0, 4000) : line)?.[1] ?? null;
}

const PROMPT_ID_RE = /"promptId":"([^"]+)"/;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;
const SESSION_RE = /"sessionId":"([^"]+)"/;

export class ClaudeFileParser {
  private state: ClaudeParserState;
  private readonly ctx: ClaudeFileContext;

  constructor(ctx: ClaudeFileContext, state?: ClaudeParserState | null) {
    this.ctx = ctx;
    this.state = state ? { ...state } : { lastPromptId: null };
  }

  getState(): ClaudeParserState {
    return { ...this.state };
  }

  /** 1行を処理する。offset はファイル内のバイト位置（行の先頭）。 */
  feed(line: string, offset: number, out: ParseOutput): void {
    if (line.length === 0) return;
    // 大きな行（ツール結果など）を毎回 JSON として解釈しないよう、先に文字列で振り分ける。
    // ユーザー行は parentUuid / isSidechain / promptId / type が message より前に書かれる（実ログで確認）ため、
    // 最初に現れる "type" で判定できる。応答の行は message が type より前にあるため、
    // 文字列で候補を絞った後に JSON を解釈して最上位の type を確かめる。
    const topType = topLevelType(line);
    if (topType === 'user') {
      if (line.includes('"promptId"')) this.handleUserLine(line, out);
      return;
    }
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return;
    let o: ClaudeLine;
    try {
      o = JSON.parse(line) as ClaudeLine;
    } catch {
      out.badLines++;
      return;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) return;
    this.handleAssistant(o, offset, out);
  }

  private handleUserLine(line: string, out: ParseOutput): void {
    const pid = PROMPT_ID_RE.exec(line)?.[1];
    if (!pid) return;
    if (pid === this.state.lastPromptId) return;
    this.state.lastPromptId = pid;
    const sessionId = SESSION_RE.exec(line)?.[1];
    const ts = Date.parse(TIMESTAMP_RE.exec(line)?.[1] ?? '');
    if (!sessionId) return;
    // サブエージェントのファイルでは、親ターンの開始時刻を上書きしない。
    if (this.ctx.isSubagentFile) return;
    out.turns.push({
      turnKey: `claude:${sessionId}:${pid}`,
      provider: 'claude',
      sessionId,
      turnId: pid,
      startedAtMs: Number.isFinite(ts) ? ts : null,
      completedAtMs: null,
      status: 'running',
    });
  }

  private handleAssistant(o: ClaudeLine, offset: number, out: ParseOutput): void {
    const m = o.message!;
    if (m.model === '<synthetic>') return; // API を呼んでいない合成メッセージ
    const u = m.usage!;
    const tsMs = Date.parse(o.timestamp ?? '');
    if (!Number.isFinite(tsMs)) {
      out.badLines++;
      return;
    }
    const sessionId = o.sessionId ?? 'unknown';
    const flags: QualityFlag[] = [];

    const tokens = claudeUsageToTokens(u, flags);
    if (u.fallback_credit != null) flags.push('fallback_credit_present');

    let eventKey: string;
    if (m.id) {
      eventKey = `claude:msg:${m.id}`;
      if (!o.requestId) flags.push('no_request_id');
    } else {
      eventKey = `claude:pos:${this.ctx.fileKey}:${offset}`;
      flags.push('no_message_id');
    }

    const finality: 0 | 1 = m.stop_reason != null ? 1 : 0;
    if (!finality) flags.push('partial');
    const project = projectIdentity(o.cwd);
    const turnId = this.state.lastPromptId;

    const ev: UsageEvent = {
      eventKey,
      provider: 'claude',
      sourceId: this.ctx.sourceId,
      accountKey: this.ctx.accountKey,
      sessionId,
      parentSessionId: null,
      agentId: o.agentId ?? null,
      isSidechain: o.isSidechain === true,
      turnId,
      requestId: o.requestId ?? null,
      messageId: m.id ?? null,
      tsMs,
      model: m.model ?? null,
      effort: typeof o.effort === 'string' ? o.effort : null,
      speed: typeof u.speed === 'string' ? u.speed : null,
      serviceTier: typeof u.service_tier === 'string' ? u.service_tier : null,
      inferenceGeo: typeof u.inference_geo === 'string' ? u.inference_geo : null,
      projectKey: project.key,
      projectLabel: project.label,
      billingMode: this.ctx.billingMode,
      tokens,
      finality,
      // 同じ応答の途中経過では output_tokens だけが単調に増える（実ログで確認）。
      // そのため「最終値か」を最優先し、同じ段階なら出力が進んだ記録を採用する。
      rank: finality * RANK_FINAL + tokens.output,
      flags,
      origin: { fileKey: this.ctx.fileKey, offset, parserVersion: CLAUDE_PARSER_VERSION },
    };
    out.events.push(ev);

    out.sessions.push({
      sessionKey: `claude:${sessionId}`,
      provider: 'claude',
      sessionId,
      parentSessionId: null,
      sourceId: this.ctx.sourceId,
      accountKey: this.ctx.accountKey,
      projectKey: project.key,
      projectLabel: project.label,
      originator: null,
      billingMode: this.ctx.billingMode,
      firstTsMs: tsMs,
      lastTsMs: tsMs,
    });

    if (turnId && finality && m.stop_reason === 'end_turn' && !ev.isSidechain) {
      out.turns.push({
        turnKey: `claude:${sessionId}:${turnId}`,
        provider: 'claude',
        sessionId,
        turnId,
        startedAtMs: null,
        completedAtMs: tsMs,
        status: 'completed',
      });
    }
  }
}

/**
 * Claude の usage を正規化する。
 * - input_tokens はキャッシュ読み書きを含まない通常入力。
 * - cache_creation_input_tokens が書き込み総数。5分・1時間の内訳は総数と一致する場合だけ採用する。
 * - thinking_tokens は output_tokens の内数。
 */
export function claudeUsageToTokens(u: Record<string, unknown>, flags: QualityFlag[]): TokenBreakdown {
  const input = safeCount(u.input_tokens);
  const cacheRead = safeCount(u.cache_read_input_tokens);
  const cacheWrite = safeCount(u.cache_creation_input_tokens);
  const output = safeCount(u.output_tokens);
  let w5: number | null = null;
  let w1: number | null = null;
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  if (cc && typeof cc === 'object') {
    const a = safeCount(cc.ephemeral_5m_input_tokens);
    const b = safeCount(cc.ephemeral_1h_input_tokens);
    if (a + b === cacheWrite) {
      w5 = a;
      w1 = b;
    } else {
      flags.push('cache_write_breakdown_mismatch');
    }
  }
  if (cacheWrite > 0 && w5 === null) flags.push('cache_write_ttl_unknown');
  const details = u.output_tokens_details as Record<string, unknown> | undefined;
  let reasoning: number | null = null;
  if (details && typeof details === 'object' && typeof details.thinking_tokens === 'number') {
    reasoning = Math.min(safeCount(details.thinking_tokens), output);
  }
  // iterations は通常1要素で最上位と同じ値。複数要素で食い違う場合は印だけ付ける（最上位を採用）。
  const iters = u.iterations;
  if (Array.isArray(iters) && iters.length > 1) {
    let sumOut = 0;
    for (const it of iters) sumOut += safeCount((it as Record<string, unknown>)?.output_tokens);
    if (sumOut !== output) flags.push('iterations_mismatch');
  }
  return {
    inputUncached: input,
    cacheRead,
    cacheWrite,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    output,
    reasoning,
    unclassified: 0,
    providerTotal: null,
  };
}
