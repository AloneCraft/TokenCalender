import { createContext, useContext } from 'react';
import { ja, type MessageKey } from './ja.ts';
import { en } from './en.ts';

export type Lang = 'ja' | 'en';

export function translate(lang: Lang, key: MessageKey | string): string {
  if (lang === 'en') {
    const v = en[key as MessageKey];
    if (v) return v;
  }
  return (ja as Record<string, string>)[key] ?? key;
}

export const LangContext = createContext<Lang>('ja');

export function useT(): (key: MessageKey | string) => string {
  const lang = useContext(LangContext);
  return (key) => translate(lang, key);
}
