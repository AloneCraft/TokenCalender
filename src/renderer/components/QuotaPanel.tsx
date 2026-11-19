import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtAgo, fmtDateTime, fmtDuration, fmtMoney, fmtPct, fmtRange, fmtTokens, roundSig, windowName } from '../format.ts';
import type { EstimateView } from '../../shared/api.ts';
import { PaceBar } from './Gauge.tsx';
import { Icon } from './Icons.tsx';

export function QuotaPanel({ onOpenEstimate }: { onOpenEstimate: () => void }) {
  const { quota, filters, zone, settings, money, slowVersion } = useApp();
  const t = useT();
  const [est, setEst] = useState<EstimateView | null>(null);
  const now = Date.now();
  const windows = (quota?.windows ?? []).filter((w) => (filters.provider === 'both' || w.provider === filters.provider) && w.windowKind !== 'unknown');
  const primary = windows.find((w) => w.key === filters.window) ?? windows.find((w) => w.windowMinutes === 10080) ?? null;

  useEffect(() => {
    let alive = true;
    if (!primary) {
      setEst(null);
      return;
    }
    void api()
      .estimate({ windowKey: primary.key, pricingMode: settings.pricingMode })
      .then((e) => alive && setEst(e));
    return () => {
      alive = false;
    };
  }, [primary?.key, settings.pricingMode, slowVersion]);

  return (
    <section className="card" aria-labelledby="quota-h">
      <h2 id="quota-h">{t('quota.title')}</h2>
      {windows.length === 0 && <div className="faint">{t('quota.noWindows')}</div>}
      {windows
        .filter((w) => w.lastObservedAt > now - 30 * 86400000)
        .slice(0, 4)
        .map((w) => {
          const l = w.latest;
          return (
            <div key={w.key} style={{ marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  {w.provider === 'claude' ? 'Claude' : 'Codex'} {windowName(w.windowMinutes)}
                  {w.limitId !== w.provider ? `（${w.limitId}）` : ''}
                </span>
                <span className="faint">
                  {t(`quota.source.${l?.source ?? 'codex_log'}`)} · {t('quota.observed')} {fmtAgo(l?.observedAtMs ?? null, now)}
                  {l?.stale && (
                    <span className="badge warn">
                      <Icon name="clock" size={12} /> {t('quota.stale')}
                    </span>
                  )}
                </span>
              </div>
              {l?.usedPercent == null ? (
                <div className="faint">{t('quota.missing')}</div>
              ) : (
                <>
                  <PaceBar
                    usedPct={l.usedPercent}
                    stale={l.stale}
                    elapsedPct={w.windowMinutes && l.resetsAtMs ? Math.max(0, Math.min(100, (1 - (l.resetsAtMs - now) / (w.windowMinutes * 60000)) * 100)) : null}
                    label={`${l.usedPercent}%`}
                  />
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="num">{fmtPct(l.usedPercent)}</span>
                    <span className="faint">
                      {l.resetsAtMs == null
                        ? '—'
                        : l.resetsAtMs <= now
                          ? t('quota.resetPassed')
                          : `${t('quota.resetIn')} ${fmtDuration(l.resetsAtMs - now)}（${fmtDateTime(l.resetsAtMs, zone)}）`}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      {filters.provider !== 'both' && quota?.noFiveHour[filters.provider] && <div className="faint">{t('quota.noFiveHour')}</div>}
      {est && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{t('est.title')}</span>
            <span className={`badge ${est.status === 'ok' ? 'ok' : est.status === 'difficult' ? 'danger' : 'warn'} est`}>{t(`est.status.${est.status}`)}</span>
          </div>
          {(() => {
            const capC = est.capacityCostNano ?? est.reference?.capacityCostNano ?? null;
            const capT = est.capacityTokens ?? est.reference?.capacityTokens ?? null;
            if (!capC && !capT) return <div className="faint">{est.statusReasons.map((r) => t(`reason.${r}`)).join(' / ') || '—'}</div>;
            return (
              <>
                {capC && (
                  <div className="big">
                    {fmtRange(fmtMoney(roundSig(capC.low, 2), money), fmtMoney(roundSig(capC.high, 2), money))}<span className="faint">{t('common.equiv')}</span>
                  </div>
                )}
                {capT && (
                  <div className="faint">
                    {fmtRange(fmtTokens(roundSig(capT.low)), fmtTokens(roundSig(capT.high)))} tok
                  </div>
                )}
                {!est.capacityCostNano && !est.capacityTokens && <div className="faint">{t('est.reference')}</div>}
                <div className="faint">
                  {t('est.segments')}: {t('est.adopted')} {est.adoptedCount} / {t('est.excluded')} {est.excludedCount}
                </div>
              </>
            );
          })()}
          {est.pace.outlook !== 'unknown' && (
            <div className={`note ${est.pace.outlook === 'runs_out' ? 'warn' : ''}`} style={{ marginTop: 6 }}>
              <Icon name={est.pace.outlook === 'runs_out' ? 'alert' : 'check'} size={14} /> {t(`pace.outlook.${est.pace.outlook}`)} ({t('dash.tag.estimate')})
            </div>
          )}
          <div className="faint">{t('est.meaning')}</div>
          <button className="btn" style={{ marginTop: 6 }} onClick={onOpenEstimate}>
            {t('nav.estimate')} →
          </button>
        </div>
      )}
    </section>
  );
}
