// 表示言語の登録表と翻訳。画面（renderer）と本体（main）の両方で使う。
//
// 言語を追加する手順（詳しくは docs/i18n.md）:
// 1. messages/<code>.ts に、ja.ts と同じ鍵をすべて持つ辞書を作る（鍵が欠けると型検査で止まる）
// 2. 下の LANGUAGES に1行足す（言語名はその言語の文字で書く）
// 3. 国旗が未登録なら FlagId と src/renderer/i18n/flags.tsx に足す
// 試験（tests/unit/i18n.test.ts）が、鍵の過不足・空の訳・差し込み {name} の食い違いを見つける。

import { ja, type MessageKey } from './messages/ja.ts';
import { en } from './messages/en.ts';
import { ko } from './messages/ko.ts';
import { zhHans } from './messages/zh-Hans.ts';
import { zhHant } from './messages/zh-Hant.ts';
import { es } from './messages/es.ts';
import { ptBR } from './messages/pt-BR.ts';
import { fr } from './messages/fr.ts';
import { de } from './messages/de.ts';
import { ru } from './messages/ru.ts';
import { uk } from './messages/uk.ts';

export type { MessageKey };

/** 言語の複数形の分類（Intl.PluralRules が返す値） */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
/** 数で形が変わる文の鍵（例: 'src.unreadable.one'）。無い言語では元の鍵の文を使う */
export type PluralKey = `${MessageKey}.${PluralCategory}`;
/** 1言語分の辞書。元の鍵はすべて必須、複数形の鍵は必要な言語だけが持つ */
export type Messages = Record<MessageKey, string> & Partial<Record<PluralKey, string>>;

/** 国旗の識別子（ISO 3166-1 の2文字・小文字）。絵は src/renderer/i18n/flags.tsx にある */
export type FlagId = 'jp' | 'us' | 'kr' | 'cn' | 'tw' | 'es' | 'br' | 'fr' | 'de' | 'ru' | 'ua';

export interface LanguageDef {
  /** BCP 47 の言語タグ（例: ja, en, zh-Hans, pt-BR） */
  code: string;
  /**
   * この言語として扱う OS の言語タグ（小文字）。前方一致で見る（'zh-tw' は 'zh-TW'・'zh-TW-u-…' に一致）。
   * コードそのものは書かなくてよい。例: zh-Hant は ['zh-tw', 'zh-hk', 'zh-mo']、pt-BR は ['pt']。
   */
  osTags?: readonly string[];
  /** その言語の文字で書いた言語名（選択欄に出す） */
  nativeName: string;
  /** 英語での言語名（補助の表示と並べ替えに使う） */
  englishName: string;
  /** 数字・日付の書式に使う地域つきのタグ */
  locale: string;
  /** 文字の向き。rtl の言語を足すときは画面の左右反転の対応も必要 */
  dir: 'ltr' | 'rtl';
  /** 範囲の区切り（例: 7〜24%、7–24%）。言語ごとに慣用が違う */
  rangeSeparator: string;
  flag: FlagId;
  messages: Messages;
}

export const LANGUAGES = [
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese', locale: 'ja-JP', dir: 'ltr', rangeSeparator: '〜', flag: 'jp', messages: ja },
  { code: 'en', nativeName: 'English', englishName: 'English', locale: 'en-US', dir: 'ltr', rangeSeparator: '–', flag: 'us', messages: en },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean', locale: 'ko-KR', dir: 'ltr', rangeSeparator: '~', flag: 'kr', messages: ko },
  // 中国語は、文字の種類（簡体字・繁体字）で辞書が違う。OS は zh-CN / zh-TW のような地域つきで返すため osTags で結ぶ。
  // 種類の指定が無い zh は、簡体字にする。
  { code: 'zh-Hans', osTags: ['zh-cn', 'zh-sg', 'zh'], nativeName: '简体中文', englishName: 'Chinese (Simplified)', locale: 'zh-CN', dir: 'ltr', rangeSeparator: '～', flag: 'cn', messages: zhHans },
  { code: 'zh-Hant', osTags: ['zh-tw', 'zh-hk', 'zh-mo'], nativeName: '繁體中文', englishName: 'Chinese (Traditional)', locale: 'zh-TW', dir: 'ltr', rangeSeparator: '～', flag: 'tw', messages: zhHant },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish', locale: 'es-ES', dir: 'ltr', rangeSeparator: '–', flag: 'es', messages: es },
  // ポルトガル語は、ブラジル版の辞書を、ポルトガル（pt-PT）など pt の全地域で使う
  { code: 'pt-BR', osTags: ['pt'], nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', locale: 'pt-BR', dir: 'ltr', rangeSeparator: '–', flag: 'br', messages: ptBR },
  { code: 'fr', nativeName: 'Français', englishName: 'French', locale: 'fr-FR', dir: 'ltr', rangeSeparator: '–', flag: 'fr', messages: fr },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German', locale: 'de-DE', dir: 'ltr', rangeSeparator: '–', flag: 'de', messages: de },
  { code: 'ru', nativeName: 'Русский', englishName: 'Russian', locale: 'ru-RU', dir: 'ltr', rangeSeparator: '–', flag: 'ru', messages: ru },
  { code: 'uk', nativeName: 'Українська', englishName: 'Ukrainian', locale: 'uk-UA', dir: 'ltr', rangeSeparator: '–', flag: 'ua', messages: uk },
] as const satisfies readonly LanguageDef[];

export type LangCode = (typeof LANGUAGES)[number]['code'];
/** 設定の値。system は OS の言語に合わせる */
export type LanguageSetting = 'system' | LangCode;

export const LANG_CODES: readonly LangCode[] = LANGUAGES.map((l) => l.code);
/** OS の言語に合う辞書が無いときに使う言語 */
export const FALLBACK_LANG: LangCode = 'en';
/** 辞書の元（すべての鍵を持つ言語） */
export const SOURCE_LANG: LangCode = 'ja';

const BY_CODE = new Map<string, LanguageDef>(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

export function languageOf(code: string): LanguageDef {
  return BY_CODE.get(code.toLowerCase()) ?? BY_CODE.get(FALLBACK_LANG)!;
}

export function isLangCode(v: unknown): v is LangCode {
  return typeof v === 'string' && BY_CODE.has(v.toLowerCase());
}

/** 言語ごとの、OS の言語タグに当てる候補（コードと osTags。小文字）。*/
const MATCH_KEYS: { key: string; lang: LangCode }[] = LANGUAGES.flatMap((l) => {
  const d = l as LanguageDef;
  return [d.code, ...(d.osTags ?? [])].map((k) => ({ key: k.toLowerCase(), lang: l.code as LangCode }));
});

/**
 * OS の言語の並び（優先順）から、登録されている言語を選ぶ。
 * 各タグは、言語のコード・osTags と前方一致で比べ（zh-TW は zh-tw に、ja-JP は ja に一致）、
 * 複数に当たったら長い方（より具体的な方）を採る。例: zh-Hant-TW は zh-tw でなく zh を選ばない。
 * どれにも当たらなければ次のタグへ進み、最後まで無ければ FALLBACK_LANG。
 */
export function matchOsLanguage(osLanguages: readonly string[]): LangCode {
  for (const raw of osLanguages) {
    const tag = raw.replace('_', '-').toLowerCase();
    let best: { len: number; lang: LangCode } | null = null;
    for (const m of MATCH_KEYS) {
      if ((tag === m.key || tag.startsWith(m.key + '-')) && (!best || m.key.length > best.len)) best = { len: m.key.length, lang: m.lang };
    }
    if (best) return best.lang;
  }
  return FALLBACK_LANG;
}

export function resolveLanguage(setting: string | null | undefined, osLanguages: readonly string[]): LangCode {
  if (setting && setting !== 'system' && isLangCode(setting)) return languageOf(setting).code as LangCode;
  return matchOsLanguage(osLanguages);
}

/** {name} を値で置き換える */
export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, n: number): string {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r.select(n);
}

/**
 * 翻訳する。vars に数値の count があれば、言語の複数形の規則で `<鍵>.<one|other|…>` を先に探す
 * （例: en の 'src.unreadable.one' と 'src.unreadable.other'）。
 * 訳が無ければ FALLBACK_LANG、次に SOURCE_LANG、最後に鍵そのものを返す。
 */
export function translate(lang: string, key: string, vars?: Record<string, string | number>): string {
  const def = languageOf(lang);
  const dicts = [def.messages, languageOf(FALLBACK_LANG).messages, languageOf(SOURCE_LANG).messages] as Record<string, string>[];
  let text: string | undefined;
  if (vars && typeof vars.count === 'number') {
    const cat = pluralCategory(def.locale, vars.count);
    text = (def.messages as Record<string, string>)[`${key}.${cat}`];
  }
  if (text == null) for (const d of dicts) if (d[key]) { text = d[key]; break; }
  if (text == null) text = key;
  return vars ? fill(text, vars) : text;
}
