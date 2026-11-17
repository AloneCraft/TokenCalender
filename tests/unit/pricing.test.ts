import { describe, expect, it } from 'vitest';
import { PricingEngine, ratePicoPerToken, picoToNano, modelMatches } from '../../src/core/pricing/engine.ts';
import { zeroTokens } from '../../src/core/model/tokens.ts';
import type { TokenBreakdown } from '../../src/core/model/types.ts';

const T = (p: Partial<TokenBreakdown>): TokenBreakdown => ({ ...zeroTokens(), ...p });
const usd = (nano: number) => nano / 1e9;
const engine = new PricingEngine();
const ts = Date.parse('2026-11-10T00:00:00Z');

describe('G: 料金は重なりのない分類から一度だけ計算する', () => {
  it('Claude: 5分・1時間のキャッシュ書き込み内訳ごとの単価で計算し、総数と二重にしない', () => {
    // claude-opus-5-5: 入力 $4、5分書き込み $5、1時間書き込み $8、読み取り $0.20、出力 $20（/MTok）
    const r = engine.price({
      provider: 'claude',
      model: 'claude-opus-5-5',
      tsMs: ts,
      speed: 'standard',
      inferenceGeo: 'global',
      tokens: T({ inputUncached: 1_000_000, cacheWrite: 3_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 2_000_000, cacheRead: 1_000_000, output: 1_000_000, reasoning: 400_000 }),
    });
    expect(r.priced).toBe(true);
    // 4 + 5 + 16 + 0.2 + 20 = 45.2（推論は出力の内数なので足さない）
    expect(usd(r.nanoUsd)).toBeCloseTo(45.2, 9);
  });

  it('Codex: キャッシュ読み取りは入力から除いた分だけを入力単価にする', () => {
    // gpt-6.1-sol: 入力 $2、キャッシュ $0.10、出力 $10
    const r = engine.price({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      tsMs: ts,
      speed: null,
      inferenceGeo: null,
      tokens: T({ inputUncached: 60_000, cacheRead: 40_000, output: 10_000, reasoning: 5_000 }),
    });
    // 1要求の入力は 10万トークンで、長文脈（27.2万超）の割増は付かない
    expect(usd(r.nanoUsd)).toBeCloseTo(0.12 + 0.004 + 0.1, 9);
  });

  it('長文脈の割増はしきい値を超えた要求だけに適用する（キャッシュも含めて数える）', () => {
    const small = engine.price({ provider: 'claude', model: 'claude-haiku-5-5', tsMs: ts, speed: null, inferenceGeo: null, tokens: T({ inputUncached: 50_000, cacheRead: 50_000, output: 1000 }) });
    const big = engine.price({ provider: 'claude', model: 'claude-haiku-5-5', tsMs: ts, speed: null, inferenceGeo: null, tokens: T({ inputUncached: 50_000, cacheRead: 50_001, output: 1000 }) });
    expect(usd(small.nanoUsd)).toBeCloseTo(0.005 + 0.0005 + 0.0005, 9);
    expect(usd(big.nanoUsd)).toBeCloseTo(0.025 + 50_001 * 0.05e-6 + 0.0025, 9);
  });

  it('高速モードと地域指定 us（1.1倍）を反映する', () => {
    const fast = engine.price({ provider: 'claude', model: 'claude-fable-5-2', tsMs: ts, speed: 'fast', inferenceGeo: 'us', tokens: T({ inputUncached: 1_000_000, output: 1_000_000 }) });
    expect(usd(fast.nanoUsd)).toBeCloseTo((16 + 80) * 1.1, 9);
  });

  it('大量の微小額を足しても誤差がたまらない（整数で計算する）', () => {
    let nano = 0;
    for (let i = 0; i < 100_000; i++) {
      nano += engine.price({ provider: 'codex', model: 'gpt-6-luna', tsMs: ts, speed: null, inferenceGeo: null, tokens: T({ cacheRead: 1 }) }).nanoUsd;
    }
    // $0.01/MTok × 1 トークン = 0.01 nano-$ → 1件ごとに 0 へ丸め。浮動小数点の 0.1+0.2 のような誤差は出ない
    expect(Number.isInteger(nano)).toBe(true);
    expect(ratePicoPerToken('0.0625')).toBe(62_500n);
    expect(picoToNano(1_500n)).toBe(2);
  });
});

describe('H: 未知のモデル', () => {
  it('料金が分からないモデルは 0 ドルではなく「未換算」になる', () => {
    const r = engine.price({ provider: 'codex', model: 'codex-auto-review', tsMs: ts, speed: null, inferenceGeo: null, tokens: T({ inputUncached: 1000, output: 10 }) });
    expect(r.priced).toBe(false);
    expect(r.entryId).toBeNull();
  });

  it('内訳の分からないトークンを含む場合も未換算にする', () => {
    const r = engine.price({ provider: 'codex', model: 'gpt-6.1-sol', tsMs: ts, speed: null, inferenceGeo: null, tokens: T({ unclassified: 69349 }) });
    expect(r.priced).toBe(false);
  });

  it('モデル名は完全一致か日付付きの名前だけを一致とみなす', () => {
    expect(modelMatches('claude-opus-5', 'claude-opus-5-5')).toBe(false);
    expect(modelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
  });
});
