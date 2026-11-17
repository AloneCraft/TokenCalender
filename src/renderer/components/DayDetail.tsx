import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { commonFilter, useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { EChart, type EChartsOption } from './EChart.tsx';
import { colorFor, fmtDateTime, fmtMoney, fmtTime, fmtTokens } from '../format.ts';
import type { DayDetailResponse } from '../../shared/api.ts';

export function DayDetail({ date, onClose }: { date: string; onClose: () => void }) {
  const app = useApp();
  const { zone, money, dataVersion, filters } = app;
  const t = useT();
  const [d, setD] = useState<DayDetailResponse | null>(null);
  const [step, setStep] = useState<15 | 60>(60);

  useEffect(() => {
    let alive = true;
    void api()
      .dayDetail({ ...commonFilter(app), date, window: filters.window, stepMinutes: step })
      .then((x) => alive && setD(x));
    return () => {
      alive = false;
    };

  }, [date, step, dataVersion, filters]);

  const option = useMemo<EChartsOption | null>(() => {
    if (!d) return null;
    const models = d.byModel.map((m) => m.model);
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtTokens(v, false) : '—') },
      legend: { type: 'scroll', top: 0 },
      grid: { left: 56, right: 16, top: 30, bottom: 28 },
      xAxis: { type: 'category', data: d.slots.map((s) => fmtTime(s.startMs, zone)) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtTokens(v) } },
      series: models.map((m, i) => ({ name: m, type: 'bar', stack: 'm', itemStyle: { color: colorFor(m, i) }, data: d.slots.map((s) => s.byModel[m] ?? 0) })),
    };
  }, [d, zone]);

  return (
    <section className="card drawer" aria-label={t('detail.title')}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>
          {t('detail.title')}: {date}
        </h2>
        <span className="row">
          <select aria-label="step" value={step} onChange={(e) => setStep(Number(e.target.value) as 15 | 60)}>
            <option value={60}>60分</option>
            <option value={15}>15分</option>
          </select>
          <button className="btn" onClick={onClose}>
            {t('detail.close')}
          </button>
        </span>
      </div>
      {!d ? (
        <div className="faint">{t('common.loading')}</div>
      ) : (
        <>
          <div className="row">
            <span className="big">{fmtTokens(d.totals.tokens, false)} tok</span>
            <span className="muted">
              {fmtMoney(d.totals.costNano, money)} {t('common.equiv')}
            </span>
            {d.totals.unpricedTokens > 0 && (
              <span className="badge warn">
                {t('cal.unpriced')} {fmtTokens(d.totals.unpricedTokens)}
              </span>
            )}
          </div>
          <div className="faint">
            {t('measure.input')} {fmtTokens(d.totals.input)} ・ {t('measure.cache_read')} {fmtTokens(d.totals.cacheRead)} ・ {t('measure.cache_write')} {fmtTokens(d.totals.cacheWrite)} ・ {t('measure.output')}{' '}
            {fmtTokens(d.totals.output)}（{t('measure.reasoning')} {fmtTokens(d.totals.reasoning)}）
          </div>
          {d.cycles.length > 0 && (
            <>
              <h3>{t('detail.cycles')}</h3>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>周期</th>
                    <th className="r">トークン</th>
                    <th className="r">{t('measure.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cycles.map((c) => (
                    <tr key={c.startMs}>
                      <td>
                        {fmtDateTime(c.startMs, zone)} 〜 {fmtDateTime(c.endMs, zone)} {c.estimated && <span className="badge est">推定周期</span>}
                      </td>
                      <td className="r">{fmtTokens(c.tokensInDay, false)}</td>
                      <td className="r">{fmtMoney(c.usageInDay, money)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <h3>{t('detail.byTime')}</h3>
          {option && <EChart option={option} ariaLabel={t('detail.byTime')} />}
          <h3>{t('detail.byModel')}</h3>
          <table className="tbl">
            <tbody>
              {d.byModel.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td className="r">{fmtTokens(m.tokens, false)}</td>
                  <td className="r">{m.priced ? fmtMoney(m.costNano, money) : t('cal.unpriced')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{t('detail.turns')}</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>時刻</th>
                <th>プロジェクト</th>
                <th>モデル</th>
                <th className="r">トークン</th>
                <th className="r">{t('measure.cost')}</th>
                <th className="r">要求</th>
              </tr>
            </thead>
            <tbody>
              {d.turns.slice(0, 100).map((x) => (
                <tr key={`${x.provider}:${x.sessionId}:${x.turnId}`}>
                  <td>
                    {fmtTime(x.startedAtMs ?? x.lastAtMs, zone)}〜{fmtTime(x.lastAtMs, zone)}
                  </td>
                  <td>
                    {x.provider === 'claude' ? 'Claude' : 'Codex'} {x.projectLabel ?? '—'}
                  </td>
                  <td>{x.model ?? '—'}</td>
                  <td className="r">{fmtTokens(x.tokens, false)}</td>
                  <td className="r">{x.unpricedTokens === x.tokens ? t('cal.unpriced') : fmtMoney(x.costNano, money)}</td>
                  <td className="r">
                    {x.requests}
                    {x.subagentRequests > 0 ? `（${t('recent.subagents')} ${x.subagentRequests}）` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
