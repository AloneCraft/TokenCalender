import { createContext, useContext } from 'react';
import { ja, type MessageKey } from './ja.ts';
import { en } from './en.ts';

export type Lang = 'ja' | 'en';

/** 設定の言語（system なら OS の言語）から表示言語を決める。日本語以外の OS では英語にする。 */
export function resolveLang(setting: 'system' | 'ja' | 'en', osLanguages: readonly string[] = navigator.languages ?? [navigator.language]): Lang {
  if (setting === 'ja' || setting === 'en') return setting;
  const first = osLanguages[0] ?? 'en';
  return first.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function translate(lang: Lang, key: MessageKey | string): string {
  if (lang === 'en') {
    const v = (en as Record<string, string>)[key];
    if (v) return v;
  }
  return (ja as Record<string, string>)[key] ?? key;
}

/** {name} を値で置き換える */
export function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export const LangContext = createContext<Lang>('ja');

export function useT(): (key: MessageKey | string, vars?: Record<string, string | number>) => string {
  const lang = useContext(LangContext);
  return (key, vars) => (vars ? fill(translate(lang, key), vars) : translate(lang, key));
}

export function useLang(): Lang {
  return useContext(LangContext);
}
