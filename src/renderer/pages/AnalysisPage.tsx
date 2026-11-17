import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api.ts';
import { commonFilter, useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { CHARTS, type ChartDef } from '../charts/registry.ts';
import { EChart } from '../components/EChart.tsx';
import { fmtMeasure, fmtTokens } from '../format.ts';
import type { AnalysisSeries, Measure } from '../../shared/api.ts';

export function AnalysisPage() {
  const app = useApp();
  const { filters, zone, money, dataVersion } = app;
  const t = useT();
  const [chartId, setChartId] = useState<ChartDef['id']>('bars');
  const def = CHARTS.find((c) => c.id === chartId)!;
  const today = DateTime.now().setZone(zone);
  const [from, setFrom] = useState(today.minus({ days: 60 }).toISODate()!);
  const [to, setTo] = useState(today.toISODate()!);
  const [step, setStep] = useState(def.defaultStepMinutes);
  const [data, setData] = useState<(AnalysisSeries & { measure: Measure }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setStep(def.defaultStepMinutes), [def]);

  useEffect(() => {
    let alive = true;
    const fromMs = DateTime.fromISO(from, { zone }).startOf('day').toMillis();
    const toMs = DateTime.fromISO(to, { zone }).plus({ days: 1 }).startOf('day').toMillis();
    setError(null);
    api()
      .analysis({ ...commonFilter(app), chartId, fromMs, toMs, stepMinutes: step, measure: filters.measure, dimension: def.usesDimension ? filters.dimension : 'none' })
      .then((d) => alive && setData({ ...d, measure: filters.measure }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };

  }, [chartId, from, to, step, filters, dataVersion, zone, app.settings.pricingMode]);

  const option = useMemo(() => (data ? def.build(data, { measure: data.measure, zone, fmt: (v) => fmtMeasure(v, data.measure, money) }) : null), [data, def, zone, money]);

  const exportCsv = () => {
    if (!data) return;
    const header = ['start', 'total', ...data.dimensionKeys];
    const lines = data.buckets.map((b) => [new Date(b.startMs).toISOString(), b.total, ...data.dimensionKeys.map((k) => b.byDim[k] ?? 0)].join(','));
    const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `token-calendar-${chartId}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <label className="field">
            {t('an.chart')}
            <select value={chartId} onChange={(e) => setChartId(e.target.value as ChartDef['id'])}>
              {CHARTS.map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.titleKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('an.from')}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            {t('an.to')}
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {(chartId === 'bars' || chartId === 'share' || chartId === 'cache_ratio') && (
            <label className="field">
              {t('an.step')}
              <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
                {[15, 60, 300, 1440, 10080].map((s) => (
                  <option key={s} value={s}>
                    {s >= 1440 ? `${s / 1440}日` : s >= 60 ? `${s / 60}時間` : `${s}分`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn" onClick={exportCsv} disabled={!data}>
            {t('an.export')}
          </button>
        </div>
      </div>
      {error && <div className="note warn">{error}</div>}
      {data && option && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{t(def.titleKey)}</h2>
            <span className="faint">
              {t('tl.periodTotal')}: {fmtMeasure(data.periodTotal, data.measure, money, false)}
              {data.measure === 'cost' && data.unpricedTokens > 0 && ` ／ ${t('cal.unpriced')} ${fmtTokens(data.unpricedTokens)} tok`}
            </span>
          </div>
          <EChart option={option} className="chart tall" ariaLabel={t(def.titleKey)} />
        </div>
      )}
    </div>
  );
}
