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
    // it・tr は未登録。先頭から順に探し、最初に当たった ja を選ぶ
    expect(matchOsLanguage(['it-IT', 'tr-TR', 'ja-JP', 'en-US'])).toBe('ja');
    expect(matchOsLanguage(['fr-FR', 'ja-JP'])).toBe('fr');
  });

  it('登録の無い言語だけなら英語にする', () => {
    expect(matchOsLanguage(['it-IT', 'tr-TR'])).toBe(FALLBACK_LANG);
    expect(matchOsLanguage([])).toBe(FALLBACK_LANG);
  });

  it('中国語: 簡体字・繁体字を、OS が返す地域つきのタグ（zh-CN・zh-TW など）から選ぶ', () => {
    for (const tag of ['zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh']) expect(matchOsLanguage([tag]), tag).toBe('zh-Hans');
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) expect(matchOsLanguage([tag]), tag).toBe('zh-Hant');
  });

  it('ポルトガル語: ブラジル版の辞書を、pt の全地域（pt-PT など）で使う', () => {
    for (const tag of ['pt-BR', 'pt-PT', 'pt']) expect(matchOsLanguage([tag]), tag).toBe('pt-BR');
  });

  it('ほかの言語: 言語の部分で選ぶ（es-MX → es、de-AT → de、uk-UA → uk）', () => {
    expect(matchOsLanguage(['es-MX'])).toBe('es');
    expect(matchOsLanguage(['de-AT'])).toBe('de');
    expect(matchOsLanguage(['uk-UA'])).toBe('uk');
    expect(matchOsLanguage(['ru-RU'])).toBe('ru');
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

  it('ロシア語・ウクライナ語: 複数形が3つの形（1・2〜4・5以上）に分かれる', () => {
    // 1, 21 → one / 2〜4, 22〜24 → few / 0, 5〜20, 25 → many
    expect(translate('ru', 'src.unreadable', { count: 1 })).toBe('1 нечитаемый файл');
    expect(translate('ru', 'src.unreadable', { count: 21 })).toBe('21 нечитаемый файл');
    expect(translate('ru', 'src.unreadable', { count: 3 })).toBe('3 нечитаемых файла');
    expect(translate('ru', 'src.unreadable', { count: 5 })).toBe('5 нечитаемых файлов');
    expect(translate('ru', 'src.unreadable', { count: 11 })).toBe('11 нечитаемых файлов');
    expect(translate('uk', 'src.unreadable', { count: 2 })).toBe('2 нечитабельні файли');
    expect(translate('uk', 'src.unreadable', { count: 7 })).toBe('7 нечитабельних файлів');
  });

  it('複数形のある言語（英語・フランス語・ドイツ語・スペイン語・ポルトガル語）でも単数と複数を分ける', () => {
    expect(translate('de', 'src.unreadable', { count: 1 })).toBe('1 nicht lesbare Datei');
    expect(translate('de', 'src.unreadable', { count: 4 })).toBe('4 nicht lesbare Dateien');
    expect(translate('es', 'src.unreadable', { count: 1 })).toBe('1 archivo ilegible');
    expect(translate('pt-BR', 'src.unreadable', { count: 2 })).toBe('2 arquivos ilegíveis');
    // フランス語は 0 も単数
    expect(translate('fr', 'src.unreadable', { count: 0 })).toBe('0 fichier illisible');
  });

  it('文字の種類で辞書が違う中国語（簡体字・繁体字）が、同じ鍵に別の文を持つ', () => {
    expect(translate('zh-Hans', 'nav.settings')).toBe('设置');
    expect(translate('zh-Hant', 'nav.settings')).toBe('設定');
  });

  it('辞書に無い鍵は、鍵そのものを返す（画面が空にならない）', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('登録の無い言語コードは英語として扱う', () => {
    expect(languageOf('xx').code).toBe(FALLBACK_LANG);
  });
});
