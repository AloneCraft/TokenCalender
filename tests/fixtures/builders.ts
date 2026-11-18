// 試験用の匿名ログを組み立てる。値は手計算できる小さな数にしている。
// 実在の会話・パス・ID は含まない。

export function claudeUser(opts: { promptId: string; sessionId: string; ts: string; toolResult?: boolean; sidechain?: boolean; bigContentChars?: number }): string {
  // bigContentChars: ツール結果のような大きな本文（多バイト文字・引用符を含む）を作る
  const big = opts.bigContentChars ? '結果 "quoted" \\ '.repeat(Math.ceil(opts.bigContentChars / 14)).slice(0, opts.bigContentChars) : null;
  const content = opts.toolResult || big ? [{ type: 'tool_result', tool_use_id: 'toolu_x', content: big ?? 'ok' }] : 'prompt text';
  return JSON.stringify({
    parentUuid: null,
    isSidechain: opts.sidechain === true,
    promptId: opts.promptId,
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${opts.promptId}-${opts.ts}`,
    timestamp: opts.ts,
    cwd: '/work/project-a',
    sessionId: opts.sessionId,
    version: '2.1.325',
  });
}

export interface ClaudeUsageOpts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  w5?: number;
  w1?: number;
  thinking?: number;
  speed?: string;
  geo?: string;
  noBreakdown?: boolean;
}

export function claudeAssistant(opts: {
  msgId: string | null;
  requestId?: string | null;
  sessionId: string;
  ts: string;
  model?: string;
  stop?: string | null;
  usage: ClaudeUsageOpts;
  sidechain?: boolean;
  agentId?: string;
  effort?: string;
}): string {
  const u = opts.usage;
  const cw = u.cacheWrite ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: u.input ?? 0,
    cache_creation_input_tokens: cw,
    cache_read_input_tokens: u.cacheRead ?? 0,
    output_tokens: u.output ?? 0,
    service_tier: 'standard',
    inference_geo: u.geo ?? 'global',
    speed: u.speed ?? 'standard',
  };
  if (!u.noBreakdown) usage.cache_creation = { ephemeral_5m_input_tokens: u.w5 ?? cw, ephemeral_1h_input_tokens: u.w1 ?? 0 };
  if (u.thinking != null) usage.output_tokens_details = { thinking_tokens: u.thinking };
  // 項目の並び順は実ログに合わせる（message が最上位の type より前にある）
  const line: Record<string, unknown> = {
    parentUuid: 'p',
    isSidechain: opts.sidechain === true,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    message: {
      model: opts.model ?? 'claude-opus-5-5',
      ...(opts.msgId ? { id: opts.msgId } : {}),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: opts.stop === undefined ? 'end_turn' : opts.stop,
      usage,
    },
    requestId: opts.requestId === undefined ? `req_${opts.msgId}` : opts.requestId,
    type: 'assistant',
    uuid: `a-${opts.msgId}-${opts.ts}`,
    timestamp: opts.ts,
    effort: opts.effort ?? 'medium',
    cwd: '/work/project-a',
    sessionId: opts.sessionId,
  };
  return JSON.stringify(line);
}

// ---------------- Codex ----------------

export interface CodexUsage {
  input: number;
  cached?: number;
  output: number;
  reasoning?: number;
}

function codexVec(u: CodexUsage): Record<string, number> {
  return {
    input_tokens: u.input,
    cached_input_tokens: u.cached ?? 0,
    cache_write_input_tokens: 0,
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning ?? 0,
    total_tokens: u.input + u.output,
  };
}

export function addUsage(a: CodexUsage, b: CodexUsage): CodexUsage {
  return {
    input: a.input + b.input,
    cached: (a.cached ?? 0) + (b.cached ?? 0),
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

let ordinalCounter = 0;
export function resetOrdinal(n = 0): void {
  ordinalCounter = n;
}
function wrap(ts: string, type: string, payload: unknown, ordinal?: number): string {
  return JSON.stringify({ timestamp: ts, ordinal: ordinal ?? ordinalCounter++, type, payload });
}

export function codexMeta(opts: { id: string; ts: string; parent?: string; startOrdinal?: number; account?: string }, ordinal?: number): string {
  return wrap(
    opts.ts,
    'session_meta',
    {
      id: opts.id,
      session_id: opts.id,
      timestamp: opts.ts,
      cwd: '/work/project-b',
      originator: 'codex_cli',
      cli_version: '0.169.0',
      source: opts.parent ? { subagent: { thread_spawn: { parent_thread_id: opts.parent, depth: 1 } } } : 'cli',
      ...(opts.parent ? { parent_thread_id: opts.parent } : {}),
      ...(opts.startOrdinal != null ? { subagent_history_start_ordinal: opts.startOrdinal } : {}),
      ...(opts.account ? { creator_account_id: opts.account } : {}),
      base_instructions: { text: 'instructions' },
    },
    ordinal,
  );
}

export function codexTurnContext(opts: { ts: string; turnId: string; model: string; effort?: string }, ordinal?: number): string {
  return wrap(opts.ts, 'turn_context', { turn_id: opts.turnId, model: opts.model, effort: opts.effort ?? 'high', summary: 'none' }, ordinal);
}

export function codexTaskStarted(opts: { ts: string; turnId: string }, ordinal?: number): string {
  return wrap(opts.ts, 'event_msg', { type: 'task_started', turn_id: opts.turnId, started_at: Date.parse(opts.ts) / 1000 }, ordinal);
}

export function codexTaskComplete(opts: { ts: string; turnId: string }, ordinal?: number): string {
  return wrap(opts.ts, 'event_msg', { type: 'task_complete', turn_id: opts.turnId, completed_at: Date.parse(opts.ts) / 1000 }, ordinal);
}

export function codexRecord(
  opts: { ts: string; threadId: string; turnId: string; responseId: string; usage: CodexUsage; thread: CodexUsage },
  ordinal?: number,
): string {
  return wrap(
    opts.ts,
    'token_usage_record',
    {
      thread_id: opts.threadId,
      turn_id: opts.turnId,
      session_id: opts.threadId,
      response_id: opts.responseId,
      usage: codexVec(opts.usage),
      turn_token_usage: codexVec(opts.usage),
      thread_token_usage: codexVec(opts.thread),
    },
    ordinal,
  );
}

export interface RateWindow {
  used: number;
  minutes: number;
  resetsAtSec: number;
}

export function codexTokenCount(
  opts: { ts: string; total: CodexUsage | null; last?: CodexUsage | null; primary?: RateWindow | null; secondary?: RateWindow | null; plan?: string | null },
  ordinal?: number,
): string {
  const rl =
    opts.primary === undefined && opts.secondary === undefined
      ? null
      : {
          limit_id: 'codex',
          limit_name: null,
          primary: opts.primary ? { used_percent: opts.primary.used, window_minutes: opts.primary.minutes, resets_at: opts.primary.resetsAtSec } : null,
          secondary: opts.secondary
            ? { used_percent: opts.secondary.used, window_minutes: opts.secondary.minutes, resets_at: opts.secondary.resetsAtSec }
            : null,
          credits: null,
          plan_type: opts.plan === undefined ? 'pro' : opts.plan,
        };
  return wrap(
    opts.ts,
    'event_msg',
    {
      type: 'token_count',
      info: opts.total
        ? {
            total_token_usage: codexVec(opts.total),
            last_token_usage: opts.last ? codexVec(opts.last) : codexVec(opts.total),
            last_usage_includes_reasoning: true,
            model_context_window: 258400,
          }
        : null,
      rate_limits: rl,
    },
    ordinal,
  );
}

export function codexResponseItem(ts: string, ordinal?: number): string {
  return wrap(ts, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '"type":"token_usage_record"' }] }, ordinal);
}
