import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { EChart, type EChartsOption } from '../components/EChart.tsx';
import { fmtAgo, fmtDateTime, fmtDuration, fmtMoney, fmtPct, fmtTokens, roundSig, windowName } from '../format.ts';
import type { EstimateView, Range } from '../../shared/api.ts';
import { ManualEntry } from '../components/ManualEntry.tsx';

export function EstimatePage() {
  const { quota, zone, money, settings, dataVersion, filters } = useApp();
  const t = useT();
  const windows = (quota?.windows ?? []).filter((w) => w.windowMinutes && w.windowMinutes > 0);
  const [key, setKey] = useState<string | null>(null);
  const [est, setEst] = useState<EstimateView | null>(null);
  const selected = key ?? filters.window ?? windows.find((w) => w.windowMinutes === 10080)?.key ?? windows[0]?.key ?? null;

  useEffect(() => {
    let alive = true;
    if (!selected) return;
    void api()
      .estimate({ windowKey: selected, pricingMode: settings.pricingMode })
      .then((e) => alive && setEst(e));
    return () => {
      alive = false;
    };
  }, [selected, settings.pricingMode, dataVersion]);

  const option = useMemo<EChartsOption | null>(() => {
    if (!est || est.observations.length === 0) return null;
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 64, right: 56, top: 30, bottom: 50 },
      xAxis: { type: 'time' },
      yAxis: [
        { type: 'value', name: t('est.chart.pct'), min: 0, max: 100 },
        { type: 'value', name: t('est.chart.localAxis'), axisLabel: { formatter: (v: number) => fmtTokens(v) }, splitLine: { show: false } },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 4 }],
      series: [
        {
          name: t('est.chart.official'),
          type: 'line',
          step: 'end',
          showSymbol: true,
          symbolSize: 4,
          data: est.observations.map((o) => [o.atMs, o.usedPercent]),
        },
        {
          name: t('est.chart.local'),
          type: 'bar',
          yAxisIndex: 1,
          itemStyle: { color: '#9fc2ef' },
          data: est.localHourly.map((h) => [h.atMs, h.tokens]),
        },
        {
          name: t('est.chart.adopted'),
          type: 'line',
          data: [],
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(60,160,90,0.10)' },
            data: est.segments.filter((s) => s.adopted).map((s) => [{ xAxis: s.startMs }, { xAxis: s.endMs }]),
          },
        },
      ],
    };
  }, [est, t]);

  const range = (r: Range | null, kind: 'tokens' | 'cost') =>
    r ? (kind === 'cost' ? `${fmtMoney(roundSig(r.low), money)}〜${fmtMoney(roundSig(r.high), money)}` : `${fmtTokens(roundSig(r.low))}〜${fmtTokens(roundSig(r.high))}`) : '—';

  const capT = est?.capacityTokens ?? est?.reference?.capacityTokens ?? null;
  const capC = est?.capacityCostNano ?? est?.reference?.capacityCostNano ?? null;
  const isRef = !!est && !est.capacityTokens && !!est.reference;
  const now = Date.now();

  return (
    <div className="layout">
      <div className="stack">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{t('est.title')}</h2>
            <label className="field">
              {t('window.label')}
              <select value={selected ?? ''} onChange={(e) => setKey(e.target.value)}>
                {windows.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.provider === 'claude' ? 'Claude' : 'Codex'} {windowName(w.windowMinutes)}
                    {w.limitId !== w.provider ? ` (${w.limitId})` : ''}
                    {w.accountKey ? ` (${w.accountKey.slice(-6)})` : ''} ({t('est.windowObs', { n: w.count.toLocaleString() })})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="note">{t('est.meaning')}</div>
          {!selected && <div className="empty">{t('quota.noWindows')}</div>}
          {est && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <span className={`badge ${est.status === 'ok' ? 'ok' : est.status === 'difficult' ? 'danger' : 'warn'}`}>{t(`est.status.${est.status}`)}</span>
                {est.statusReasons.map((r) => (
                  <span key={r} className="faint">
                    {t(`reason.${r}`)}
                  </span>
                ))}
              </div>
              <div className="metrics" style={{ marginTop: 10 }}>
                <div className="metric">
                  <div className="label">
                    {t('est.capacityCost')}
                    {isRef ? ` · ${t('est.reference')}` : ''}
                  </div>
                  <div className="big">{est.costEstimateSuppressed ? '—' : range(capC, 'cost')}</div>
                  {capC && !est.costEstimateSuppressed && (
                    <div className="faint">
                      {t('est.perPercent')}: {fmtMoney(roundSig(capC.mid / 100), money)} {t('common.equiv')}
                    </div>
                  )}
                  {est.costEstimateSuppressed && <div className="faint">{t('est.costSuppressed')}</div>}
                </div>
                <div className="metric">
                  <div className="label">
                    {t('est.capacityTokens')}
                    {isRef ? ` · ${t('est.reference')}` : ''}
                  </div>
                  <div className="big">{range(capT, 'tokens')}</div>
                  {capT && (
                    <div className="faint">
                      {t('est.perPercent')}: {fmtTokens(roundSig(capT.mid / 100))} tok
                    </div>
                  )}
                </div>
              </div>
              <dl className="kv" style={{ marginTop: 10 }}>
                <dt>{t('est.observations')}</dt>
                <dd>{est.observationCount.toLocaleString()}</dd>
                <dt>{t('est.period')}</dt>
                <dd>
                  {fmtDateTime(est.periodFromMs, zone)} 〜 {fmtDateTime(est.periodToMs, zone)}
                </dd>
                <dt>{t('est.segments')}</dt>
                <dd>
                  {t('est.adopted')} {est.adoptedCount} / {t('est.excluded')} {est.excludedCount}
                </dd>
                <dt>{t('est.spread')}</dt>
                <dd>{est.spreadRatio == null ? '—' : t('est.spreadValue', { v: Math.round(est.spreadRatio * 50) })}</dd>
                <dt>{t('est.unknownBilling')}</dt>
                <dd>{fmtPct(est.unknownBillingShare * 100)}</dd>
                <dt>{t('est.modelMix')}</dt>
                <dd>
                  {est.modelMix
                    .slice(0, 4)
                    .map((m) => `${m.model} ${Math.round(m.share * 100)}%`)
                    .join(' / ') || '—'}
                </dd>
              </dl>
            </>
          )}
        </div>
        {option && (
          <div className="card">
            <h2>{t('est.overlayTitle')}</h2>
            <EChart option={option} className="chart tall" ariaLabel={t('est.overlayTitle')} />
            <div className="faint">{t('est.overlayNote')}</div>
          </div>
        )}
        {est && est.segments.length > 0 && (
          <div className="card">
            <h2>{t('est.segments')}</h2>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('est.col.interval')}</th>
                  <th className="r">Δ%</th>
                  <th className="r">{t('est.col.tokens')}</th>
                  <th className="r">{t('measure.cost')}</th>
                  <th className="r">{t('est.col.capacityCost')}</th>
                  <th>{t('est.col.verdict')}</th>
                </tr>
              </thead>
              <tbody>
                {est.segments
                  .slice(-60)
                  .reverse()
                  .map((s) => (
                    <tr key={`${s.startMs}-${s.endMs}`}>
                      <td>
                        {fmtDateTime(s.startMs, zone)}〜{fmtDateTime(s.endMs, zone)}
                        <div className="faint">
                          {s.p1}% → {s.p2}%
                        </div>
                      </td>
                      <td className="r">{s.deltaPct}</td>
                      <td className="r">{fmtTokens(s.tokens)}</td>
                      <td className="r">{fmtMoney(s.costNano, money)}</td>
                      <td className="r">{s.capacityCostNano ? `${fmtMoney(roundSig(s.capacityCostNano.low), money)}〜${fmtMoney(roundSig(s.capacityCostNano.high), money)}` : '—'}</td>
                      <td>
                        {s.adopted ? <span className="badge ok">{t('est.adopted')}</span> : <span className="badge">{t('est.excluded')}</span>}
                        {[...s.exclusions, ...s.warnings].map((r) => (
                          <div key={r} className="faint">
                            {t(`reason.${r}`)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="stack">
        {est && (
          <div className="card">
            <h2>{t('est.paceTitle')}</h2>
            {est.pace.official ? (
              <dl className="kv stacked">
                <dt>{t('pace.official')}</dt>
                <dd>
                  {fmtPct(est.pace.official.remainingPercent)}{t('est.usedParen', { pct: fmtPct(est.pace.official.usedPercent) })}
                  <div className="faint">
                    {t(`quota.source.${est.pace.official.source}`)} · {t('quota.observed')} {fmtAgo(est.pace.official.observedAtMs, now)}
                    {est.pace.official.stale && <span className="badge warn"> {t('quota.stale')}</span>}
                  </div>
                </dd>
                <dt>{t('quota.resetIn')}</dt>
                <dd>{est.pace.resetTimePassedUnconfirmed ? t('quota.resetPassed') : fmtDuration(est.pace.timeToResetMs)}</dd>
                <dt>{t('pace.aux')}</dt>
                <dd>
                  {est.pace.auxiliary
                    ? t('est.auxValue', { low: fmtPct(est.pace.auxiliary.usedPercent.low), high: fmtPct(est.pace.auxiliary.usedPercent.high), tok: fmtTokens(est.pace.auxiliary.localTokensSince) })
                    : '—'}
                  <div className="faint">{t('est.auxNote')}</div>
                </dd>
                <dt>{t('pace.burn')}</dt>
                <dd>{est.pace.burnRatePctPerHour == null ? '—' : t('est.perHour', { v: est.pace.burnRatePctPerHour.toFixed(1) })}</dd>
                <dt>{t('pace.even')}</dt>
                <dd>{est.pace.evenPacePctPerHour == null ? '—' : t('est.perHour', { v: est.pace.evenPacePctPerHour.toFixed(2) })}</dd>
                <dt>{t('pace.exhaust')}</dt>
                <dd>
                  {est.pace.projectedExhaustion
                    ? t('est.exhaustRange', { a: fmtDateTime(est.pace.projectedExhaustion.earliestMs, zone), b: Number.isFinite(est.pace.projectedExhaustion.latestMs) ? fmtDateTime(est.pace.projectedExhaustion.latestMs, zone) : t('est.undetermined') })
                    : '—'}
                </dd>
              </dl>
            ) : (
              <div className="faint">{t('quota.noWindows')}</div>
            )}
            <div className={`note ${est.pace.outlook === 'runs_out' ? 'warn' : ''}`} style={{ marginTop: 8 }}>
              {t(`pace.outlook.${est.pace.outlook}`)}
            </div>
          </div>
        )}
        <ManualEntry />
      </div>
    </div>
  );
}
