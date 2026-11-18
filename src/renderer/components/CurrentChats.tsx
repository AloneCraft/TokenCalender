// いまのチャットの状態。文章ではなく、図記号・色・棒と輪の図で一目で分かるようにする。
// 判定の基準は src/core/chat/judge.ts（自分の過去30日のチャットとの比較）。

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtAgo, fmtTokens, fmtPct } from '../format.ts';
import type { CurrentChat } from '../../shared/api.ts';
import { Icon, type IconName } from './Icons.tsx';
import { BarGauge, RingGauge, type Tone } from './Gauge.tsx';

const VERDICT: Record<CurrentChat['verdict'], { icon: IconName; tone: Tone }> = {
  smooth: { icon: 'check', tone: 'ok' },
  heavy: { icon: 'flame', tone: 'danger' },
  wasteful: { icon: 'alert', tone: 'warn' },
  unknown: { icon: 'chat', tone: 'info' },
};

function ChatCard({ c }: { c: CurrentChat }) {
  const t = useT();
  const v = VERDICT[c.verdict];
  const scale = Math.max(c.tokens, c.p90 ?? 0) * 1.15 || 1;
  const hit = c.cacheHit == null ? null : c.cacheHit * 100;
  const hitTone: Tone = hit == null ? 'info' : hit >= 70 ? 'ok' : hit >= 50 ? 'warn' : 'danger';
  return (
    <div className={`chat-card tone-${v.tone}${v.tone === 'danger' ? ' is-alert' : ''}`}>
      <div className="chat-head">
        <span className="chat-verdict">
          <Icon name={v.icon} size={22} />
          {t(`chat.verdict.${c.verdict}`)}
        </span>
        <span className="faint">
          {c.active && <span className="live-dot" title={t('chat.active')} />} {c.provider === 'claude' ? 'Claude' : 'Codex'} · {c.projectLabel ?? '—'} · {fmtAgo(c.lastUpdatedMs)}
        </span>
      </div>
      <div className="chat-grid">
        <div>
          <div className="label">
            <Icon name="chat" size={14} /> {t('chat.size')} <span className="num">{fmtTokens(c.tokens)}</span>
            <span className="faint">
              {' '}
              · {c.requests} {t('recent.requests')}
            </span>
          </div>
          <BarGauge
            max={scale}
            fill={c.tokens}
            tone={v.tone}
            marks={[
              ...(c.median != null ? [{ at: c.median, kind: 'line' as const, tone: 'info' as Tone }] : []),
              ...(c.p90 != null ? [{ at: c.p90, kind: 'line' as const, tone: 'warn' as Tone }] : []),
            ]}
            label={fmtTokens(c.tokens)}
          />
          {c.median != null && c.p90 != null && (
            <div className="chat-scale faint">
              <span className="m-info">
                ┆ {t('chat.median')} {fmtTokens(c.median)}
              </span>
              <span className="m-warn">
                ┆ {t('chat.p90')} {fmtTokens(c.p90)}
              </span>
              {c.vsMedian != null && <span className="num">×{c.vsMedian.toFixed(1)}</span>}
            </div>
          )}
        </div>
        <div className="chat-rings">
          <div className="chat-ring">
            <RingGauge value={hit ?? 0} tone={hitTone} label={hit == null ? '—' : fmtPct(hit, 0)}>
              {hit == null ? '—' : fmtPct(hit, 0)}
            </RingGauge>
            <div className="label">
              <Icon name="cache" size={14} /> {t('chat.cache')}
            </div>
          </div>
          <div className="chat-ring">
            <RingGauge value={Math.min(100, c.shareOfWeekPct)} tone="info" label={fmtPct(c.shareOfWeekPct, 0)}>
              {fmtPct(c.shareOfWeekPct, 0)}
            </RingGauge>
            <div className="label">
              <Icon name="trend" size={14} /> {t('chat.share')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CurrentChats() {
  const { dataVersion } = useApp();
  const t = useT();
  const [chats, setChats] = useState<CurrentChat[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api()
      .currentChats()
      .then((d) => alive && setChats(d));
    return () => {
      alive = false;
    };
  }, [dataVersion]);
  if (!chats || chats.length === 0) return null;
  return (
    <section className="card stack" aria-label={t('chat.title')}>
      <h2 style={{ margin: 0 }}>{t('chat.title')}</h2>
      <div className="chat-cards">
        {chats.map((c) => (
          <ChatCard key={c.provider} c={c} />
        ))}
      </div>
      <div className="faint">{t('chat.note')}</div>
    </section>
  );
}
