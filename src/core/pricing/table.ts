// 組み込みの API 料金表（USD / 100万トークン）。
// 値は文字列の十進数で持ち、計算時に整数へ直す（浮動小数点を使わない）。
//
// 取得日: 2026-11-18。過去の適用期間は確認できていないため effectiveFrom は null（= 不明）。
// そのため、過去の利用には「現在の単価による参考換算」として表示する。
// 根拠:
//   Claude ... https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI ... https://developers.openai.com/api/docs/pricing
// verified=false の行は、ページ本文の初期表示で確認できず、要約や他の段から導いた値。

import type { Provider } from '../model/types.ts';

export interface PriceRates {
  input: string;
  output: string;
  cacheRead: string;
  /** Claude の5分キャッシュ書き込み。OpenAI では 30分書き込み */
  cacheWrite5m?: string;
  /** Claude の1時間キャッシュ書き込み。OpenAI では 12時間書き込み */
  cacheWrite1h?: string;
}

export interface PriceEntry {
  id: string;
  provider: Provider;
  /** 完全一致するモデル ID。日付付きの ID（例: -20251001）も一致とみなす */
  models: string[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  standard: PriceRates;
  /** 長文脈の割増。入力（キャッシュ読み書きを含む）がしきい値を超えた要求に適用 */
  longContext?: { thresholdInputTokens: number; rates: PriceRates };
  /** 高速モード（Claude の speed = "fast"） */
  fast?: PriceRates;
  /** 地域指定 inference_geo = "us" の倍率（分数で表す） */
  usGeoMultiplier?: { num: number; den: number };
  sourceUrl: string;
  fetchedAt: string;
  origin: 'official' | 'manual';
  verified: boolean;
  note?: string;
}

const CLAUDE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI_URL = 'https://developers.openai.com/api/docs/pricing';
const FETCHED = '2026-11-18';

/** Claude: 5分書き込み = 入力×1.25、1時間書き込み = 入力×2（公式の倍率）。高速モードにも同じ倍率が重なる。 */
function claudeFast(input: string, output: string, cacheReadMultiplier: string): PriceRates {
  const i = Number(input);
  return {
    input,
    output,
    cacheRead: decimalMul(input, cacheReadMultiplier),
    cacheWrite5m: String(i * 1.25),
    cacheWrite1h: String(i * 2),
  };
}

/** 小さな十進数の掛け算（表の値を作るときだけ使う。結果は文字列で保持する） */
function decimalMul(a: string, b: string): string {
  const scale = 1e6;
  return String(Math.round(Number(a) * Number(b) * scale) / scale);
}

function claude(
  id: string,
  models: string[],
  input: string,
  w5: string,
  w1: string,
  read: string,
  output: string,
  extra: Partial<PriceEntry> = {},
): PriceEntry {
  return {
    id,
    provider: 'claude',
    models,
    effectiveFrom: null,
    effectiveTo: null,
    standard: { input, output, cacheRead: read, cacheWrite5m: w5, cacheWrite1h: w1 },
    usGeoMultiplier: { num: 11, den: 10 },
    sourceUrl: CLAUDE_URL,
    fetchedAt: FETCHED,
    origin: 'official',
    verified: true,
    ...extra,
  };
}

function openai(
  id: string,
  input: string,
  output: string,
  cached: string,
  write30m: string | undefined,
  long: { input: string; output: string; cached: string; write30m?: string } | null,
  verified: boolean,
  note?: string,
): PriceEntry {
  return {
    id,
    provider: 'codex',
    models: [id],
    effectiveFrom: null,
    effectiveTo: null,
    standard: { input, output, cacheRead: cached, ...(write30m ? { cacheWrite5m: write30m } : {}) },
    ...(long
      ? {
          longContext: {
            thresholdInputTokens: 272_000,
            rates: { input: long.input, output: long.output, cacheRead: long.cached, ...(long.write30m ? { cacheWrite5m: long.write30m } : {}) },
          },
        }
      : {}),
    sourceUrl: OPENAI_URL,
    fetchedAt: FETCHED,
    origin: 'official',
    verified,
    ...(note ? { note } : {}),
  };
}

export const BUILTIN_PRICES: PriceEntry[] = [
  // ---- Claude ----
  claude('claude-fable-5-2', ['claude-fable-5-2', 'claude-mythos-5-2'], '8', '10', '16', '0.20', '40', {
    fast: claudeFast('16', '80', '0.025'),
  }),
  claude('claude-fable-5-1', ['claude-fable-5-1', 'claude-mythos-5-1'], '10', '12.50', '20', '0.25', '50'),
  claude('claude-fable-5', ['claude-fable-5', 'claude-mythos-5'], '10', '12.50', '20', '1', '50'),
  claude('claude-opus-5-5', ['claude-opus-5-5'], '4', '5', '8', '0.20', '20', { fast: claudeFast('8', '40', '0.05') }),
  claude('claude-opus-5', ['claude-opus-5'], '5', '6.25', '10', '0.50', '25', { fast: claudeFast('10', '50', '0.1') }),
  claude('claude-opus-4-8', ['claude-opus-4-8'], '5', '6.25', '10', '0.50', '25', { fast: claudeFast('10', '50', '0.1') }),
  claude('claude-opus-4-5-to-4-7', ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'], '5', '6.25', '10', '0.50', '25'),
  claude('claude-opus-4-0-4-1', ['claude-opus-4-1', 'claude-opus-4'], '15', '18.75', '30', '1.50', '75'),
  claude('claude-sonnet-5-5', ['claude-sonnet-5-5'], '2', '2.50', '4', '0.10', '10'),
  claude('claude-sonnet-5', ['claude-sonnet-5'], '2', '2.50', '4', '0.20', '10'),
  claude('claude-sonnet-4', ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], '3', '3.75', '6', '0.30', '15'),
  claude('claude-haiku-5-5', ['claude-haiku-5-5'], '0.10', '0.125', '0.20', '0.01', '0.50', {
    longContext: {
      thresholdInputTokens: 100_000,
      rates: { input: '0.50', cacheWrite5m: '0.625', cacheWrite1h: '1', cacheRead: '0.05', output: '2.50' },
    },
  }),
  claude('claude-haiku-4-5', ['claude-haiku-4-5'], '1', '1.25', '2', '0.10', '5'),

  // ---- OpenAI（Codex） ----
  openai('gpt-6.2-astra', '8.00', '40.00', '0.40', '10.00', { input: '16.00', output: '60.00', cached: '0.80', write30m: '20.00' }, true),
  openai('gpt-6.2-sol', '2.00', '10.00', '0.10', '2.50', { input: '4.00', output: '15.00', cached: '0.20', write30m: '5.00' }, true),
  openai('gpt-6-astra', '10.00', '50.00', '1.00', '12.50', { input: '20.00', output: '75.00', cached: '2.00', write30m: '25.00' }, true),
  openai('gpt-6.1-sol', '2.00', '10.00', '0.10', '2.50', { input: '4.00', output: '15.00', cached: '0.20', write30m: '5.00' }, true),
  openai(
    'gpt-6.1-terra',
    '1.00',
    '5.00',
    '0.05',
    '1.25',
    { input: '2.00', output: '7.50', cached: '0.10', write30m: '2.50' },
    false,
    '標準価格は Flex 価格（$0.50 / $2.50）の2倍と一致する要約値。ページ初期表示では未確認',
  ),
  openai(
    'gpt-6-luna',
    '0.10',
    '0.50',
    '0.01',
    '0.125',
    { input: '0.20', output: '0.75', cached: '0.02', write30m: '0.25' },
    false,
    '標準価格は Flex 価格の2倍と一致する要約値。ページ初期表示では未確認',
  ),
  openai('gpt-6-sol', '2.00', '10.00', '0.20', '2.50', { input: '4.00', output: '15.00', cached: '0.40', write30m: '5.00' }, false, '要約値。未確認'),
  openai('gpt-5.3-codex', '1.75', '14.00', '0.175', undefined, null, false, '要約値。未確認'),
];
