// モデル×エフォート別の消費率。期間を選んで、その期間の公式利用率の変化とローカル使用量から推定する。

import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { Seg } from '../components/Seg.tsx';
import { useBusy } from '../busy.ts';
import { RangeBar, RatioCell } from '../components/Gauge.tsx';
import { EChart, type EChartsOption } from '../components/EChart.tsx';
import { fmtDate, fmtInt, fmtTokens, groupLabel, windowName } from '../format.ts';
import type { Band, RatesView } from '../../shared/api.ts';

type Preset = '14' | '28' | '56' | '84' | 'custom';

function band(b: Band | null | undefined, digits: number, unit = ''): string {
  if (!b) return '—';
  const f = (v: number) => v.toFixed(digits);
  return `${f(b.mid)}${unit}  [${f(b.low)}–${f(b.high)}]`;
}

export function RatesPage() {
  const app = useApp();
  const t = useT();
  const [provider, setProvider] = useState<'codex' | 'claude'>('codex');
  const [preset, setPreset] = useState<Preset>('56');
  const today = DateTime.now().setZone(app.zone);
  const [from, setFrom] = useState(today.minus({ days: 27 }).toISODate()!);
  const [to, setTo] = useState(today.toISODate()!);
  const [data, setData] = useState<RatesView | null>(null);
  const [loading, setLoading] = useState(false);
  useBusy('rates', loading);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset !== 'custom') {
      const toMs = Date.now() + 1;
      return { fromMs: toMs - Number(preset) * 86400000, toMs };
    }
    const f = DateTime.fromISO(from, { zone: app.zone }).startOf('day');
    const e = DateTime.fromISO(to, { zone: app.zone }).plus({ days: 1 }).startOf('day');
    return f.isValid && e.isValid && e > f ? { fromMs: f.toMillis(), toMs: e.toMillis() } : null;
    // app.slowVersion は「直近N週」の終わりを今の時刻へ更新するための合図
  }, [preset, from, to, app.zone, app.slowVersion]);

  useEffect(() => {
    if (!range) return;
    let alive = true;
    setLoading(true);
    api()
      .rates({ provider, fromMs: range.fromMs, toMs: range.toMs })
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(String((e as Error)?.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [provider, range]);

  const maxPerTurn = Math.max(1e-9, ...(data?.groups ?? []).map((g) => g.pctPerTurn?.high ?? 0)) * 1.1;
  const chart = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const rows = data.groups.filter((g) => g.pctPerTurn);
    if (rows.length === 0) return null;
    return {
      grid: { left: 180, right: 30, top: 30, bottom: 30 },
      tooltip: { trigger: 'item' },
      legend: { top: 0, right: 10, data: [t('rates.col.perTurn'), t('rates.chart.range')] },
      xAxis: { type: 'value', name: t('rates.chart.x'), nameLocation: 'middle', nameGap: 22, axisLabel: { formatter: '{value}%' } },
      yAxis: { type: 'category', inverse: true, data: rows.map((g) => groupLabel(g.group)) },
      series: [
        {
          name: t('rates.col.perTurn'),
          type: 'bar',
          data: rows.map((g) => ({ value: g.pctPerTurn!.mid, itemStyle: { opacity: g.status === 'measured' ? 0.9 : 0.4 } })),
        },
        {
          // 推定の幅（下限〜上限）を、棒の上に重ねた線と両端の短い縦線で示す
          name: t('rates.chart.range'),
          type: 'custom',
          z: 10,
          color: '#2e7d32',
          data: rows.map((g, i) => [g.pctPerTurn!.low, g.pctPerTurn!.high, i, g.pctPerTurn!.mid]),
          encode: { x: [0, 1], y: 2 },
          renderItem: (_p: unknown, api: { value: (i: number) => number; coord: (v: number[]) => number[]; style: (o: object) => object }) => {
            const [lx = 0, ly = 0] = api.coord([api.value(0), api.value(2)]);
            const [hx = 0, hy = 0] = api.coord([api.value(1), api.value(2)]);
            const style = { stroke: '#2e7d32', lineWidth: 2.5 };
            return {
              type: 'group',
              children: [
                { type: 'line', shape: { x1: lx, y1: ly, x2: hx, y2: hy }, style },
                { type: 'line', shape: { x1: lx, y1: ly - 7, x2: lx, y2: ly + 7 }, style },
                { type: 'line', shape: { x1: hx, y1: hy - 7, x2: hx, y2: hy + 7 }, style },
                { type: 'text', style: { text: `${api.value(3).toFixed(3)}%`, x: hx + 8, y: hy, textVerticalAlign: 'middle', fill: '#555', fontSize: 12 } },
              ],
            };
          },
          tooltip: { show: false },
        },
      ],
    } as EChartsOption;
  }, [data, t]);

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{t('rates.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>
        {t('rates.lead')}
      </p>
      <div className="toolbar" style={{ position: 'static' }}>
        <Seg
          label={t('rates.provider')}
          value={provider}
          options={[
            ['codex', 'Codex'],
            ['claude', 'Claude'],
          ]}
          onChange={setProvider}
        />
        <Seg<Preset>
          label={t('rates.period')}
          value={preset}
          options={[
            ['14', t('rates.p.14')],
            ['28', t('rates.p.28')],
            ['56', t('rates.p.56')],
            ['84', t('rates.p.84')],
            ['custom', t('rates.p.custom')],
          ]}
          onChange={setPreset}
        />
        {preset === 'custom' && (
          <>
            <label className="field">
              {t('rates.from')}
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              {t('rates.to')}
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
      </div>
      {!range && <div className="note warn">{t('rates.badRange')}</div>}
      {error && <div className="note warn">{error}</div>}
      {data && (
        <>
          {data.usageMix.length > 0 && (
            <section className="card stack">
              <h2>{t('rates.mix.title')}</h2>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('rates.col.group')}</th>
                    <th className="r">{t('rates.mix.tokens')}</th>
                    <th className="r">{t('rates.mix.turns')}</th>
                    <th style={{ width: '35%' }}>{t('rates.mix.share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usageMix.slice(0, 15).map((m) => (
                    <tr key={m.group}>
                      <td>{groupLabel(m.group)}</td>
                      <td className="r num">{fmtTokens(m.tokens)}</td>
                      <td className="r num">{fmtInt(m.turns)}</td>
                      <td>
                        <div className="bar-track" title={`${(m.share * 100).toFixed(1)}%`}>
                          <div className="bar-fill" style={{ width: `${m.share * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <div className="faint">
            {data.windowMinutes ? t('rates.basis', { window: windowName(data.windowMinutes), from: fmtDate(data.fromMs, app.zone), to: fmtDate(data.toMs - 1, app.zone) }) : ''}{' '}
            {data.intervals > 0 && t('rates.intervals', { n: data.intervals, dom: data.dominatedIntervals, mixed: data.mixedIntervals, unobs: data.unobservedIntervals })}
          </div>
          {data.groups.length > 0 && (
            <section className="card stack">
              <h2>{t('rates.table.title')}</h2>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t('rates.col.group')}</th>
                      <th>{t('rates.col.status')}</th>
                      <th className="r">{t('rates.col.perTurn')}</th>
                      <th className="r">{t('rates.col.perMTok')}</th>
                      <th className="r">{t('rates.col.perSession')}</th>
                      <th className="r">{t('rates.col.tokPerTurn')}</th>
                      <th className="r">{t('rates.col.relative')}</th>
                      <th>{t('rates.col.coef')}</th>
                      <th className="r">{t('rates.col.obs')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((g) => (
                      <tr key={g.group}>
                        <td>
                          {groupLabel(g.group)}
                          {data.baseline === g.group && <span className="badge accent"> {t('rates.baseline')}</span>}
                        </td>
                        <td>
                          <span className={`badge ${g.status === 'measured' ? 'ok' : 'est'}`}>{t(`rates.status.${g.status}`)}</span>
                        </td>
                        <td className="r num">
                          {band(g.pctPerTurn, 3, '%')}
                          {g.pctPerTurn && <RangeBar low={g.pctPerTurn.low} mid={g.pctPerTurn.mid} high={g.pctPerTurn.high} max={maxPerTurn} tone={g.status === 'measured' ? 'ok' : 'info'} label={band(g.pctPerTurn, 3, '%')} />}
                        </td>
                        <td className="r num">{band(g.pctPerMTokens, 4, '%')}</td>
                        <td className="r num">{band(g.pctPerSession, 2, '%')}</td>
                        <td className="r num">{g.tokensPerTurn != null ? fmtTokens(g.tokensPerTurn) : '—'}</td>
                        <td className="r">
                <RatioCell ratio={g.relativeToBaseline} />
              </td>
                        <td className="faint" style={{ fontSize: 12 }}>
                          {g.coefficients
                            ? t('rates.coef.values', {
                                inp: band(g.coefficients.input, 3),
                                cr: band(g.coefficients.cacheRead, 4),
                                out: band(g.coefficients.output, 2),
                              })
                            : t(`rates.coef.${g.coefficientNote ?? 'too_few_segments'}`)}
                        </td>
                        <td className="r num">
                          {fmtInt(g.segments)} / {fmtInt(g.totalDeltaPct)}%
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>{t('rates.overall')}</strong>
                      </td>
                      <td>
                        <span className="badge est">{t('rates.status.tentative')}</span>
                      </td>
                      <td className="r num">{band(data.overall.pctPerTurn, 3, '%')}</td>
                      <td className="r num">{band(data.overall.pctPerMTokens, 4, '%')}</td>
                      <td />
                      <td className="r num">{data.overall.turns > 0 ? fmtTokens(data.overall.tokens / data.overall.turns) : '—'}</td>
                      <td />
                      <td className="faint" style={{ fontSize: 12 }}>
                        {t('rates.overall.note')}
                      </td>
                      <td className="r num">{fmtInt(data.overall.totalDeltaPct)}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {chart && <EChart option={chart} ariaLabel={t('rates.table.title')} className="chart" />}
              <div className="faint" style={{ fontSize: 12 }}>
                {t('rates.method')}
              </div>
            </section>
          )}
          {data.unavailable && <div className="note warn">{t(`rates.unavailable.${data.unavailable}`)}</div>}
          {data.intervals > 0 && data.unobservedIntervals / data.intervals > 0.1 && <div className="note warn">{t('rates.unobservedWarn')}</div>}
        </>
      )}
    </div>
  );
}
