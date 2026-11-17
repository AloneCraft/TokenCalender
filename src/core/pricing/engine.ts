// API 料金換算。結果は「実際の請求額」ではなく「同じトークン量を API 単価で払った場合の参考額」。
//
// 金額の単位: 1兆分の1ドル（pico-dollar）を BigInt で計算し、集計用に 10億分の1ドル（nano-dollar）の整数へ丸める。
// 丸めは1件ごとに最大 0.5 nano-dollar で、100万件でも合計 0.0005 ドル以内に収まる。

import type { Provider, TokenBreakdown } from '../model/types.ts';
import { BUILTIN_PRICES, type PriceEntry, type PriceRates } from './table.ts';

export interface PricingInput {
  provider: Provider;
  model: string | null;
  tsMs: number;
  speed: string | null;
  inferenceGeo: string | null;
  tokens: TokenBreakdown;
}

export type PricingMode = 'historical' | 'current';

export interface PricingResult {
  priced: boolean;
  /** 金額（nano-dollar の整数）。priced = false のときは 0 だが「0ドル」ではなく「未換算」を意味する */
  nanoUsd: number;
  entryId: string | null;
  /** 換算に置いた仮定（例: キャッシュ書き込みの保持時間が不明なので5分とみなした） */
  assumptions: string[];
  /** 適用期間が不明な単価を使ったか */
  referenceOnly: boolean;
}

const PICO_PER_USD_PER_MTOK = 1_000_000n; // $1/MTok = 1e-6 $/token = 1e6 pico-$/token

/** "0.125" のような十進数文字列を、1トークンあたりの pico-dollar（BigInt）へ直す。 */
export function ratePicoPerToken(perMTok: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(perMTok.trim());
  if (!m) throw new Error(`invalid rate: ${perMTok}`);
  const whole = BigInt(m[1]!);
  const fracStr = (m[2] ?? '').padEnd(6, '0');
  if (fracStr.length > 6 && /[1-9]/.test(fracStr.slice(6))) throw new Error(`rate too precise: ${perMTok}`);
  return whole * PICO_PER_USD_PER_MTOK + BigInt(fracStr.slice(0, 6));
}

export class PricingEngine {
  private readonly entries: PriceEntry[];

  constructor(overrides: PriceEntry[] = []) {
    // 手動設定を先に並べ、組み込みより優先する
    this.entries = [...overrides, ...BUILTIN_PRICES];
  }

  /** 適用期間つきの単価があるか（無ければ「利用時点」と「現在」の換算は同じになる） */
  hasDatedEntries(): boolean {
    return this.entries.some((e) => e.effectiveFrom != null || e.effectiveTo != null);
  }

  findEntry(provider: Provider, model: string | null, tsMs: number, mode: PricingMode): PriceEntry | null {
    if (!model) return null;
    for (const e of this.entries) {
      if (e.provider !== provider) continue;
      if (!e.models.some((m) => modelMatches(m, model))) continue;
      if (mode === 'historical') {
        if (e.effectiveFrom && tsMs < Date.parse(e.effectiveFrom)) continue;
        if (e.effectiveTo && tsMs >= Date.parse(e.effectiveTo)) continue;
      } else if (e.effectiveTo && Date.now() >= Date.parse(e.effectiveTo)) {
        continue;
      }
      return e;
    }
    return null;
  }

  price(input: PricingInput, mode: PricingMode = 'historical'): PricingResult {
    const entry = this.findEntry(input.provider, input.model, input.tsMs, mode);
    if (!entry) return { priced: false, nanoUsd: 0, entryId: null, assumptions: [], referenceOnly: false };
    // 内訳の分からないトークンを含む場合は、単価を決められないため換算しない（0 ドルではなく未換算）
    if (input.tokens.unclassified > 0) return { priced: false, nanoUsd: 0, entryId: entry.id, assumptions: ['unclassified_tokens'], referenceOnly: false };
    const assumptions: string[] = [];
    const t = input.tokens;
    const promptTokens = t.inputUncached + t.cacheRead + t.cacheWrite;
    let rates: PriceRates = entry.standard;
    if (input.speed === 'fast') {
      if (entry.fast) rates = entry.fast;
      else assumptions.push('fast_rate_unknown_used_standard');
    } else if (entry.longContext && promptTokens > entry.longContext.thresholdInputTokens) {
      rates = entry.longContext.rates;
    }
    let pico = 0n;
    pico += BigInt(t.inputUncached) * ratePicoPerToken(rates.input);
    pico += BigInt(t.output) * ratePicoPerToken(rates.output);
    pico += BigInt(t.cacheRead) * ratePicoPerToken(rates.cacheRead);
    if (t.cacheWrite > 0) {
      if (t.cacheWrite5m != null && t.cacheWrite1h != null && rates.cacheWrite5m && rates.cacheWrite1h) {
        pico += BigInt(t.cacheWrite5m) * ratePicoPerToken(rates.cacheWrite5m);
        pico += BigInt(t.cacheWrite1h) * ratePicoPerToken(rates.cacheWrite1h);
      } else if (rates.cacheWrite5m) {
        pico += BigInt(t.cacheWrite) * ratePicoPerToken(rates.cacheWrite5m);
        assumptions.push('cache_write_ttl_assumed_shortest');
      } else {
        pico += BigInt(t.cacheWrite) * ratePicoPerToken(rates.input);
        assumptions.push('cache_write_priced_as_input');
      }
    }
    if (input.inferenceGeo === 'us' && entry.usGeoMultiplier) {
      pico = (pico * BigInt(entry.usGeoMultiplier.num)) / BigInt(entry.usGeoMultiplier.den);
    }
    if (!entry.verified) assumptions.push('price_unverified');
    return {
      priced: true,
      nanoUsd: picoToNano(pico),
      entryId: entry.id,
      assumptions,
      referenceOnly: entry.effectiveFrom == null,
    };
  }
}

export function picoToNano(pico: bigint): number {
  const nano = (pico + 500n) / 1000n;
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount out of safe range');
  return Number(nano);
}

export function nanoToUsd(nano: number): number {
  return nano / 1e9;
}

export function modelMatches(pattern: string, model: string): boolean {
  if (model === pattern) return true;
  // 日付付きの ID（例: claude-haiku-4-5-20251001）
  return model.startsWith(pattern + '-20') && /^-\d{8}$/.test(model.slice(pattern.length));
}
