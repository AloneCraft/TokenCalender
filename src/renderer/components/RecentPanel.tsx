import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtAgo, fmtMoney, fmtTime, fmtTokens } from '../format.ts';
import type { RecentResponse, RecentUsage, UsageTotals } from '../../shared/api.ts';

const STATE_BADGE: Record<string, string> = { running: 'accent', partial: 'warn', recorded: 'ok', waiting: '' };

export function RecentPanel() {
  const { zone, settings, money, dataVersion } = useApp();
  const t = useT();
  const [data, setData] = useState<RecentResponse | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    void api()
      .recent({ zone, pricingMode: settings.pricingMode, limit: 4 })
      .then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [zone, settings.pricingMode, dataVersion]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const totals = (u: UsageTotals) => (
    <>
      <div className="big">{fmtTokens(u.tokens)}</div>
      <div className="faint">
        {u.priced ? `${fmtMoney(u.costNano, money)} ${t('common.equiv')}` : u.costNano > 0 ? `${fmtMoney(u.costNano, money)}＋${t('cal.unpriced')}` : t('cal.unpriced')}
      </div>
    </>
  );

  const item = (r: RecentUsage, first: boolean) => (
    <div className="recent-item" key={`${r.provider}:${r.sessionId}:${r.turnId}`} data-testid={first ? 'recent-first' : undefined}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="badge">{r.provider === 'claude' ? 'Claude' : 'Codex'}</span> <span className="num">{r.model ?? '—'}</span>
        </span>
        <span className={`badge ${STATE_BADGE[r.state] ?? ''}`}>{t(`recent.state.${r.state}`)}</span>
      </div>
      <div className="faint">
        {r.projectLabel ?? '—'} ・ {r.sessionId.slice(0, 8)} ・ {fmtTime(r.startedAtMs, zone)}〜{fmtTime(r.lastUpdatedMs, zone)}（{fmtAgo(r.lastUpdatedMs, now)}）
      </div>
      {first && (
        <>
          <div className="metrics" style={{ marginTop: 6 }}>
            <div className="metric">
              <div className="label">{t('recent.turn')}</div>
              {totals(r.turn)}
            </div>
            <div className="metric">
              <div className="label">{t('recent.session')}</div>
              {totals(r.session)}
            </div>
          </div>
          <div className="faint" style={{ marginTop: 4 }}>
            {t('measure.input')} {fmtTokens(r.turn.input)} ・ {t('measure.cache_read')} {fmtTokens(r.turn.cacheRead)} ・ {t('measure.cache_write')} {fmtTokens(r.turn.cacheWrite)} ・{' '}
            {t('measure.output')} {fmtTokens(r.turn.output)}
            {r.turn.reasoning > 0 ? `（${t('measure.reasoning')} ${fmtTokens(r.turn.reasoning)}）` : ''} ・ {r.requests} {t('recent.requests')}
          </div>
          {r.subagents.length > 0 && (
            <div className="faint">
              {t('recent.subagents')}: {r.subagents.map((s) => `${(s.agentId ?? '?').slice(0, 6)} ${fmtTokens(s.tokens)}`).join(' / ')}
            </div>
          )}
          {r.models.length > 1 && <div className="faint">{r.models.join(', ')}</div>}
        </>
      )}
      {!first && (
        <div className="faint num">
          {fmtTokens(r.turn.tokens)} ・ {r.turn.priced ? `${fmtMoney(r.turn.costNano, money)} ${t('common.equiv')}` : t('cal.unpriced')}
        </div>
      )}
    </div>
  );

  return (
    <section className="card" aria-labelledby="recent-h">
      <h2 id="recent-h">{t('recent.title')}</h2>
      {!data ? (
        <div className="faint">{t('common.loading')}</div>
      ) : data.items.length === 0 ? (
        <div className="faint">{t('recent.none')}</div>
      ) : (
        data.items.map((r, i) => item(r, i === 0))
      )}
      <div className="faint" style={{ marginTop: 8 }}>
        {t('recent.source')} ・ {t('common.freshness')}: {data?.items[0]?.ingestedAtMs ? fmtAgo(data.items[0].ingestedAtMs, now) : '—'}
      </div>
      <div className="faint">{t('recent.liveNote')}</div>
    </section>
  );
}
