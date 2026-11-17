import type { MessageKey } from './ja.ts';

// 英語の文言（拡張用）。未訳の鍵は日本語で表示される。
export const en: Partial<Record<MessageKey, string>> = {
  'nav.calendar': 'Calendar',
  'nav.timeline': 'Timeline',
  'nav.analysis': 'Analysis',
  'nav.estimate': 'Estimate',
  'nav.sources': 'Sources',
  'nav.settings': 'Settings',
  'provider.both': 'Both',
  'unit.day': 'Day',
  'unit.week': 'Week',
  'unit.fiveHour': '5 hours',
  'measure.tokens': 'Tokens',
  'measure.cost': 'API cost equivalent',
  'mode.daily': 'Daily usage',
  'mode.cumulative': 'Cumulative within reset cycle',
  'recent.title': 'Recent usage',
  'quota.title': 'Usage limits (official)',
  'est.title': 'Effective capacity estimate',
  'est.meaning': 'An estimate for your current model mix and usage. Not an official limit.',
  'common.demoBanner': 'Demo mode: fictional data, not your actual usage.',
  'common.apiEquivalent': 'API cost equivalent (not a bill)',
};
