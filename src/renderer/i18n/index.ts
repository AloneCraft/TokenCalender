// 画面側の翻訳の入口。辞書と言語の登録表は src/shared/i18n にある（本体の確認ダイアログと共有するため）。

import { createContext, useContext } from 'react';
import { resolveLanguage, translate as tr, type LangCode, type MessageKey } from '../../shared/i18n/languages.ts';

export type Lang = LangCode;
export { fill } from '../../shared/i18n/languages.ts';

/** OS の言語の並び（優先順）。Electron では起動時の --lang も反映される */
export function osLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** 設定の言語（system なら OS の言語）から表示言語を決める */
export function resolveLang(setting: string, os: readonly string[] = osLanguages()): Lang {
  return resolveLanguage(setting, os);
}

export function translate(lang: Lang, key: MessageKey | string, vars?: Record<string, string | number>): string {
  return tr(lang, key, vars);
}

export const LangContext = createContext<Lang>('ja');

export function useT(): (key: MessageKey | string, vars?: Record<string, string | number>) => string {
  const lang = useContext(LangContext);
  return (key, vars) => tr(lang, key, vars);
}

/**
 * 本体・問い合わせスレッドが返す結果の記号（'cancelled'、'not_ours' など）を、表示の言語の文にする。
 * 辞書に無い記号は、そのまま返す（ファイルのパスなど、記号でない値もそのまま出る）。
 */
export function useMsg(): (code: string | null | undefined) => string {
  const lang = useContext(LangContext);
  return (code) => {
    if (!code) return '';
    const key = `msg.${code}`;
    const s = tr(lang, key);
    return s === key ? code : s;
  };
}

export function useLang(): Lang {
  return useContext(LangContext);
}
