// モデル×エフォート別の「実効消費率」（公式の利用枠を、どの使い方がどれだけ減らすか）の推定。
//
// 方法:
// 1. 公式利用率が切り替わった時点（変化点）どうしを区間にする。表示が整数でも、変化点から変化点までの
//    真の増分はほぼ Δp に等しい（ずれは取得時刻の粗さだけ）。
// 2. 区間内のローカル使用量を「モデル|エフォート」別に集計し、1つの組み合わせが大半（既定 85% 以上）を
//    占める区間だけを、その組み合わせの観測として使う。複数を混ぜて使った区間からは係数を分離できないため使わない。
// 3. 同じ組み合わせが続く区間を Δp が最小幅に達するまでまとめ、比 ΣΔp / Σトークン で消費率を出す。
//    幅は区間の選び直し（ブートストラップ）で求める。区間が足りない組み合わせは値を出さない。
// 4. 入力・キャッシュ読み取り・出力の係数は、区間が十分にあり、3つの量が互いに独立に動いている場合だけ、
//    非負の最小二乗で求める。そうでなければ「不明（識別できない）」とする。
//
// API料金は使わない（サブスクの消費は非公開の係数で決まり、API単価に比例する保証が無いため）。

export interface GroupUsage {
  tokens: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  events: number;
  turns: number;
  sessions: number;
}

export interface ObsPoint {
  t: number;
  p: number;
  resetsAt: number | null;
  plan: string | null;
  precision: number;
}

export interface ChangeInterval {
  from: number;
  to: number;
  deltaPct: number;
  precision: number;
}

/** 同じ周期とみなすリセット日時のずれ（報告ごとに数秒〜数分揺れるため） */
const RESET_JITTER_MS = 30 * 60 * 1000;

/**
 * 観測列から「変化点どうし」の区間を作る。リセット・プラン変更・減少の所で区切る。
 * 返す区間は時刻順で、同じ周期の中では隙間なく連続する。
 */
export function changeIntervals(points: ObsPoint[]): ChangeInterval[] {
  const pts = points.filter((o) => Number.isFinite(o.p)).sort((a, b) => a.t - b.t);
  const out: ChangeInterval[] = [];
  let anchor: ObsPoint | null = null;
  let prev: ObsPoint | null = null;
  for (const o of pts) {
    const sameCycle =
      prev != null &&
      o.plan === prev.plan &&
      (o.resetsAt == null || prev.resetsAt == null || Math.abs(o.resetsAt - prev.resetsAt) < RESET_JITTER_MS) &&
      o.p >= prev.p;
    if (!sameCycle) {
      anchor = o;
    } else if (anchor && o.p > anchor.p) {
      out.push({ from: anchor.t, to: o.t, deltaPct: o.p - anchor.p, precision: Math.max(anchor.precision, o.precision) });
      anchor = o;
    }
    prev = o;
  }
  return out;
}

export interface RateParams {
  /** 区間内でこの割合以上を占める組み合わせを「単独で使った」とみなす */
  dominance: number;
  /** まとめた区間の最小 Δp */
  minDeltaPct: number;
  /** 「実測」と表示するのに必要な区間数と ΣΔp */
  minSegments: number;
  minTotalDelta: number;
  /** 係数（入力・キャッシュ・出力）を求めるのに必要な区間数 */
  minSegmentsForCoefficients: number;
  bootstrap: number;
}

export const DEFAULT_RATE_PARAMS: RateParams = {
  dominance: 0.85,
  minDeltaPct: 3,
  minSegments: 3,
  minTotalDelta: 10,
  minSegmentsForCoefficients: 12,
  bootstrap: 300,
};

export interface Band {
  mid: number;
  low: number;
  high: number;
}

export type RateStatus = 'measured' | 'tentative' | 'insufficient';

export interface Coefficients {
  /** 100万トークンあたりのポイント（入力＝キャッシュ書き込みを含む通常入力、キャッシュ読み取り、出力） */
  input: Band;
  cacheRead: Band;
  output: Band;
}

export interface GroupRate {
  group: string;
  model: string;
  effort: string;
  status: RateStatus;
  segments: number;
  totalDeltaPct: number;
  firstMs: number;
  lastMs: number;
  /** 100万トークンあたりの枠の消費（ポイント） */
  pctPerMTokens: Band | null;
  /** 1ターン（依頼1回）あたりの消費（ポイント） */
  pctPerTurn: Band | null;
  /** 1セッションあたりの消費（ポイント） */
  pctPerSession: Band | null;
  /** 1ターンあたりの平均トークン（この組み合わせを単独で使った区間） */
  tokensPerTurn: number | null;
  coefficients: Coefficients | null;
  coefficientNote: 'ok' | 'too_few_segments' | 'not_identifiable' | null;
  /** 基準の組み合わせに対する、100万トークンあたり消費の比 */
  relativeToBaseline: number | null;
}

export interface RateEstimate {
  intervals: number;
  /** 単独の組み合わせが大半を占めた区間 */
  dominatedIntervals: number;
  mixedIntervals: number;
  /** 利用率は増えたのにローカル使用量が無い区間（別端末・Web などの疑い） */
  unobservedIntervals: number;
  /** 混在区間も含めた全体の平均（暫定値。モデル構成によって変わる） */
  overall: { pctPerMTokens: Band | null; pctPerTurn: Band | null; totalDeltaPct: number; tokens: number; turns: number };
  baseline: string | null;
  groups: GroupRate[];
  params: RateParams;
}

interface Seg {
  group: string;
  from: number;
  to: number;
  dp: number;
  u: GroupUsage;
}

function emptyUsage(): GroupUsage {
  return { tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, events: 0, turns: 0, sessions: 0 };
}

function addUsage(a: GroupUsage, b: GroupUsage): void {
  for (const k of Object.keys(a) as (keyof GroupUsage)[]) a[k] += b[k];
}

export function splitGroup(group: string): { model: string; effort: string } {
  const i = group.lastIndexOf('|');
  return i < 0 ? { model: group, effort: 'unknown' } : { model: group.slice(0, i), effort: group.slice(i + 1) };
}

/** 同じ入力に同じ結果を返す乱数（ブートストラップの再現性のため） */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function ratioBand(segs: Seg[], num: (s: Seg) => number, den: (s: Seg) => number, scale: number, boots: number, seed: number): Band | null {
  const D = segs.reduce((a, s) => a + den(s), 0);
  if (!(D > 0)) return null;
  const mid = (segs.reduce((a, s) => a + num(s), 0) / D) * scale;
  const r = rng(seed);
  const vals: number[] = [];
  for (let b = 0; b < boots; b++) {
    let n = 0;
    let d = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[Math.floor(r() * segs.length)]!;
      n += num(s);
      d += den(s);
    }
    if (d > 0) vals.push((n / d) * scale);
  }
  vals.sort((a, b) => a - b);
  if (vals.length < 10) return { mid, low: mid, high: mid };
  return { mid, low: Math.min(mid, quantile(vals, 0.1)), high: Math.max(mid, quantile(vals, 0.9)) };
}

/** 非負の最小二乗（変数3つ。すべての有効集合を試して残差最小の解を選ぶ） */
export function nnls3(X: number[][], y: number[]): number[] | null {
  let best: { coef: number[]; rss: number } | null = null;
  for (let mask = 1; mask < 8; mask++) {
    const idx = [0, 1, 2].filter((j) => mask & (1 << j));
    const k = idx.length;
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const b = new Array<number>(k).fill(0);
    for (let r = 0; r < X.length; r++) {
      for (let a = 0; a < k; a++) {
        b[a]! += X[r]![idx[a]!]! * y[r]!;
        for (let c = 0; c < k; c++) A[a]![c]! += X[r]![idx[a]!]! * X[r]![idx[c]!]!;
      }
    }
    const sol = solve(A, b);
    if (!sol || sol.some((v) => v < 0)) continue;
    const coef = [0, 0, 0];
    idx.forEach((j, a) => (coef[j] = sol[a]!));
    let rss = 0;
    for (let r = 0; r < X.length; r++) {
      const e = y[r]! - (coef[0]! * X[r]![0]! + coef[1]! * X[r]![1]! + coef[2]! * X[r]![2]!);
      rss += e * e;
    }
    if (!best || rss < best.rss) best = { coef, rss };
  }
  return best?.coef ?? null;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** 3つの量が互いに独立に動いているか（相関が強すぎると係数を分けられない） */
function identifiable(X: number[][]): boolean {
  const cols = [0, 1, 2].map((j) => X.map((r) => r[j]!));
  const mean = cols.map((c) => c.reduce((a, v) => a + v, 0) / c.length);
  const sd = cols.map((c, j) => Math.sqrt(c.reduce((a, v) => a + (v - mean[j]!) ** 2, 0) / c.length));
  if (sd.some((s, j) => !(s > 0) || s / Math.max(Math.abs(mean[j]!), 1e-12) < 0.05)) return false;
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      let cov = 0;
      for (let r = 0; r < X.length; r++) cov += (cols[a]![r]! - mean[a]!) * (cols[b]![r]! - mean[b]!);
      const corr = cov / X.length / (sd[a]! * sd[b]!);
      if (Math.abs(corr) > 0.95) return false;
    }
  }
  return true;
}

function coefficientsFor(segs: Seg[], params: RateParams, seed: number): { c: Coefficients | null; note: GroupRate['coefficientNote'] } {
  if (segs.length < params.minSegmentsForCoefficients) return { c: null, note: 'too_few_segments' };
  const row = (s: Seg) => [(s.u.input + s.u.cacheWrite) / 1e6, s.u.cacheRead / 1e6, s.u.output / 1e6];
  const X = segs.map(row);
  if (!identifiable(X)) return { c: null, note: 'not_identifiable' };
  const base = nnls3(X, segs.map((s) => s.dp));
  if (!base) return { c: null, note: 'not_identifiable' };
  const r = rng(seed);
  const boots: number[][] = [];
  for (let b = 0; b < Math.min(params.bootstrap, 200); b++) {
    const pick = segs.map(() => segs[Math.floor(r() * segs.length)]!);
    const sol = nnls3(pick.map(row), pick.map((s) => s.dp));
    if (sol) boots.push(sol);
  }
  const band = (j: number): Band => {
    const v = boots.map((s) => s[j]!).sort((a, b) => a - b);
    const mid = base[j]!;
    return v.length < 10 ? { mid, low: mid, high: mid } : { mid, low: Math.min(mid, quantile(v, 0.1)), high: Math.max(mid, quantile(v, 0.9)) };
  };
  return { c: { input: band(0), cacheRead: band(1), output: band(2) }, note: 'ok' };
}

export interface IntervalWithUsage extends ChangeInterval {
  groups: Map<string, GroupUsage>;
}

export function estimateRates(intervals: IntervalWithUsage[], params: RateParams = DEFAULT_RATE_PARAMS): RateEstimate {
  const res: RateEstimate = {
    intervals: intervals.length,
    dominatedIntervals: 0,
    mixedIntervals: 0,
    unobservedIntervals: 0,
    overall: { pctPerMTokens: null, pctPerTurn: null, totalDeltaPct: 0, tokens: 0, turns: 0 },
    baseline: null,
    groups: [],
    params,
  };
  // 区間ごとに、大半を占める組み合わせを決める
  const tagged = intervals.map((iv) => {
    let tok = 0;
    let out = 0;
    for (const u of iv.groups.values()) {
      tok += u.tokens;
      out += u.output;
    }
    let dom: string | null = null;
    if (tok > 0) {
      for (const [g, u] of iv.groups) {
        const tokShare = u.tokens / tok;
        const outShare = out > 0 ? u.output / out : tokShare;
        if (tokShare >= params.dominance && outShare >= params.dominance) dom = g;
      }
    }
    return { iv, tok, dom };
  });
  const overallSegs: Seg[] = [];
  for (const t of tagged) {
    if (t.tok === 0) res.unobservedIntervals++;
    else if (t.dom) res.dominatedIntervals++;
    else res.mixedIntervals++;
    if (t.tok > 0) {
      const u = emptyUsage();
      for (const g of t.iv.groups.values()) addUsage(u, g);
      overallSegs.push({ group: 'all', from: t.iv.from, to: t.iv.to, dp: t.iv.deltaPct, u });
    }
  }
  res.overall.totalDeltaPct = overallSegs.reduce((a, s) => a + s.dp, 0);
  res.overall.tokens = overallSegs.reduce((a, s) => a + s.u.tokens, 0);
  res.overall.turns = overallSegs.reduce((a, s) => a + s.u.turns, 0);
  if (overallSegs.length >= params.minSegments) {
    res.overall.pctPerMTokens = ratioBand(overallSegs, (s) => s.dp, (s) => s.u.tokens, 1e6, params.bootstrap, 7);
    res.overall.pctPerTurn = ratioBand(overallSegs, (s) => s.dp, (s) => s.u.turns, 1, params.bootstrap, 11);
  }

  // 同じ組み合わせが続く区間を、Δp が最小幅に達するまでまとめる（続かない所で切る。半端は捨てる）
  const byGroup = new Map<string, Seg[]>();
  let cur: Seg | null = null;
  const flush = () => {
    if (cur && cur.dp >= params.minDeltaPct) {
      const list = byGroup.get(cur.group) ?? [];
      list.push(cur);
      byGroup.set(cur.group, list);
    }
    cur = null;
  };
  for (const t of tagged) {
    if (!t.dom) {
      flush();
      continue;
    }
    const c = cur as Seg | null;
    if (c && c.group === t.dom && c.to === t.iv.from) {
      c.to = t.iv.to;
      c.dp += t.iv.deltaPct;
      // 大半を占める組み合わせ以外の少量の利用も、この区間の消費に含まれるため合計に入れる
      for (const g of t.iv.groups.values()) addUsage(c.u, g);
    } else {
      flush();
      const uu = emptyUsage();
      for (const g of t.iv.groups.values()) addUsage(uu, g);
      cur = { group: t.dom, from: t.iv.from, to: t.iv.to, dp: t.iv.deltaPct, u: uu };
    }
    if (cur && (cur as Seg).dp >= params.minDeltaPct) flush();
  }
  flush();

  let seed = 101;
  for (const [group, segs] of byGroup) {
    const { model, effort } = splitGroup(group);
    const total = segs.reduce((a, s) => a + s.dp, 0);
    const status: RateStatus = segs.length >= params.minSegments && total >= params.minTotalDelta ? 'measured' : 'tentative';
    const turns = segs.reduce((a, s) => a + s.u.turns, 0);
    const toks = segs.reduce((a, s) => a + s.u.tokens, 0);
    const coef = coefficientsFor(segs, params, seed++);
    res.groups.push({
      group,
      model,
      effort,
      status,
      segments: segs.length,
      totalDeltaPct: total,
      firstMs: Math.min(...segs.map((s) => s.from)),
      lastMs: Math.max(...segs.map((s) => s.to)),
      pctPerMTokens: ratioBand(segs, (s) => s.dp, (s) => s.u.tokens, 1e6, params.bootstrap, seed++),
      pctPerTurn: ratioBand(segs, (s) => s.dp, (s) => s.u.turns, 1, params.bootstrap, seed++),
      pctPerSession: ratioBand(segs, (s) => s.dp, (s) => s.u.sessions, 1, params.bootstrap, seed++),
      tokensPerTurn: turns > 0 ? toks / turns : null,
      coefficients: coef.c,
      coefficientNote: coef.note,
      relativeToBaseline: null,
    });
  }
  res.groups.sort((a, b) => b.totalDeltaPct - a.totalDeltaPct);
  const base = res.groups.find((g) => g.status === 'measured' && g.pctPerMTokens);
  if (base) {
    res.baseline = base.group;
    for (const g of res.groups) {
      if (g.pctPerMTokens && base.pctPerMTokens && base.pctPerMTokens.mid > 0) g.relativeToBaseline = g.pctPerMTokens.mid / base.pctPerMTokens.mid;
    }
  }
  return res;
}
