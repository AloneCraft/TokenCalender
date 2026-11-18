// 多言語対応の基盤の試験。言語を足したときに、訳し漏れ・差し込みの食い違い・言語の選び方の誤りを見つける。

import { describe, expect, it } from 'vitest';
import { FALLBACK_LANG, LANGUAGES, SOURCE_LANG, isLangCode, languageOf, matchOsLanguage, resolveLanguage, translate } from '../../src/shared/i18n/languages.ts';
import { ja } from '../../src/shared/i18n/messages/ja.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const PLURAL = /\.(zero|one|two|few|many|other)$/;

describe('辞書', () => {
  for (const lang of LANGUAGES) {
    it(`${lang.code}: すべての鍵に空でない訳がある`, () => {
      for (const key of Object.keys(ja)) {
        const v = (lang.messages as Record<string, string>)[key];
        // 元の辞書で意図的に空の鍵（表示しない注記）は、訳も空でよい
        if ((ja as Record<string, string>)[key] === '') continue;
        expect(v, `${lang.code} ${key}`).toBeTruthy();
      }
    });

    it(`${lang.code}: 差し込み {name} が元の文と同じ`, () => {
      for (const [key, value] of Object.entries(lang.messages as Record<string, string>)) {
        const baseKey = key.replace(PLURAL, '');
        const base = (ja as Record<string, string>)[baseKey];
        expect(base, `${lang.code} に元の辞書に無い鍵がある: ${key}`).toBeDefined();
        if (PLURAL.test(key)) {
          // 複数形の文は、元の文の差し込みのうち count を使う
          expect(placeholders(value), `${lang.code} ${key}`).toContain('count');
          continue;
        }
        expect(placeholders(value), `${lang.code} ${key}`).toEqual(placeholders(base!));
      }
    });
  }

  it('言語の登録: コードが重ならず、言語名と地域つきのタグがある', () => {
    const codes = LANGUAGES.map((l) => l.code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of LANGUAGES) {
      expect(l.nativeName.length).toBeGreaterThan(0);
      expect(() => new Intl.NumberFormat(l.locale)).not.toThrow();
      expect(['ltr', 'rtl']).toContain(l.dir);
    }
    expect(isLangCode(FALLBACK_LANG)).toBe(true);
    expect(isLangCode(SOURCE_LANG)).toBe(true);
  });
});

describe('OS の言語からの選び方', () => {
  it('地域つきのタグは言語の部分で探す（ja-JP → ja、en-GB → en）', () => {
    expect(matchOsLanguage(['ja-JP'])).toBe('ja');
    expect(matchOsLanguage(['en-GB'])).toBe('en');
    expect(matchOsLanguage(['ja_JP'])).toBe('ja');
  });

  it('優先順に見て、最初に登録のある言語を選ぶ', () => {
    expect(matchOsLanguage(['fr-FR', 'ja-JP', 'en-US'])).toBe('ja');
  });

  it('登録の無い言語だけなら英語にする', () => {
    expect(matchOsLanguage(['fr-FR', 'de-DE'])).toBe(FALLBACK_LANG);
    expect(matchOsLanguage([])).toBe(FALLBACK_LANG);
  });

  it('設定が system なら OS に合わせ、言語を選んでいればそれを使う', () => {
    expect(resolveLanguage('system', ['ja-JP'])).toBe('ja');
    expect(resolveLanguage('en', ['ja-JP'])).toBe('en');
    // 登録から外れた言語が設定に残っていても、OS に合わせて表示できる
    expect(resolveLanguage('xx', ['ja-JP'])).toBe('ja');
  });
});

describe('翻訳', () => {
  it('差し込みを埋める', () => {
    expect(translate('ja', 'win.days', { n: 30 })).toBe('30日枠');
    expect(translate('en', 'win.days', { n: 30 })).toBe('30-day window');
  });

  it('数で形が変わる文は、言語の規則で選ぶ（英語の 1 は単数）', () => {
    expect(translate('en', 'src.unreadable', { count: 1 })).toBe('1 unreadable file');
    expect(translate('en', 'src.unreadable', { count: 3 })).toBe('3 unreadable files');
    // 複数形の文が無い言語では、元の文を使う
    expect(translate('ja', 'src.unreadable', { count: 1 })).toBe('読めないファイル 1');
  });

  it('辞書に無い鍵は、鍵そのものを返す（画面が空にならない）', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('登録の無い言語コードは英語として扱う', () => {
    expect(languageOf('xx').code).toBe(FALLBACK_LANG);
  });
});
