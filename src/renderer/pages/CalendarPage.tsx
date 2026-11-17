import { useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api.ts';
import { commonFilter, useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { BarDefs, DayBar } from '../components/DayBar.tsx';
import { colorFor, fmtMeasure, fmtMoney, fmtTokens } from '../format.ts';
import type { CalendarRequest, CalendarResponse, DayCell, TimelineResponse } from '../../shared/api.ts';
import { RecentPanel } from '../components/RecentPanel.tsx';
import { QuotaPanel } from '../components/QuotaPanel.tsx';
import { DayDetail } from '../components/DayDetail.tsx';
import { TimelineChart } from '../components/TimelineChart.tsx';

interface View {
  measure: CalendarRequest['measure'];
  mode: 'daily' | 'cumulative';
}

export function CalendarPage({ onOpenEstimate }: { onOpenEstimate: () => void }) {
  const app = useApp();
  const { filters, settings, money, dataVersion, zone } = app;
  const t = useT();
  // 結果には、それを求めたときの条件（測る値・表示の種類）を持たせ、その条件で描画する。
  // 条件を切り替えた直後に、古い結果を新しい条件の書式で見せないため。
  const [data, setData] = useState<(CalendarResponse & { view: View }) | null>(null);
  const [tl, setTl] = useState<(TimelineResponse & { view: View }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const req = useMemo(
    () => ({
      ...commonFilter(app),
      year: filters.year,
      month: filters.month,
      weekStart: settings.weekStart,
      measure: filters.measure,
      dimension: filters.dimension,
      window: filters.mode === 'cumulative' ? filters.window : filters.window,
    }),

    [filters, settings.weekStart, settings.pricingMode, zone],
  );

  useEffect(() => {
    let alive = true;
    setError(null);
    setLoading(true);
    const view: View = { measure: filters.measure, mode: filters.mode };
    const done = () => alive && setLoading(false);
    if (filters.unit === 'day') {
      api()
        .calendar(req)
        .then((d) => alive && setData({ ...d, view }))
        .catch((e) => alive && setError(String(e)))
        .finally(done);
    } else {
      const granularity = filters.unit === 'week' ? { kind: 'calendar_week' as const, weeks: 26 } : { kind: 'five_hour' as const, m: 42 };
      const overlay = filters.unit === 'five_hour' ? (app.quota?.windows.find((w) => w.provider === filters.provider && w.windowMinutes === 10080)?.key ?? null) : null;
      const win = filters.unit === 'five_hour' ? (app.quota?.windows.find((w) => w.provider === filters.provider && w.windowMinutes === 300)?.key ?? null) : filters.window;
      api()
        .timeline({ ...req, granularity, window: win, overlayWindow: overlay, weekStart: settings.weekStart })
        .then((d) => alive && setTl({ ...d, view }))
        .catch((e) => alive && setError(String(e)))
        .finally(done);
    }
    return () => {
      alive = false;
    };
  }, [req, dataVersion, filters.unit, app.quota, filters.provider, filters.window, settings.weekStart]);

  const measure = data?.view.measure ?? filters.measure;
  const mode = data?.view.mode ?? filters.mode;
  const tlMeasure = tl?.view.measure ?? filters.measure;
  const tlMode = tl?.view.mode ?? filters.mode;
  const weekdays = t(settings.weekStart === 1 ? 'cal.weekdays.mon' : 'cal.weekdays.sun').split(',');
  const today = DateTime.now().setZone(zone).toISODate();
  const max = data ? (mode === 'cumulative' ? data.maxCumulative : data.maxDaily) : 0;

  const onKey = (e: React.KeyboardEvent, idx: number) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (moves[e.key] != null) {
      e.preventDefault();
      const next = gridRef.current?.querySelectorAll<HTMLButtonElement>('button.cell')[idx + moves[e.key]!];
      next?.focus();
    } else if (e.key === 'Escape') setSelected(null);
  };

  const cellLabel = (c: DayCell): string => {
    const parts = [c.date];
    if (c.noData) parts.push(t('cal.noData'));
    else if (!c.future) {
      parts.push(`${t('cal.dayTotal')} ${fmtMeasure(c.total, measure, money, false)}`);
      if (c.cumulative.cumulative != null) parts.push(`${t('cal.cumulative')} ${fmtMeasure(c.cumulative.cumulative, measure, money, false)}`);
      if (c.unpricedTokens > 0 && measure === 'cost') parts.push(`${t('cal.unpriced')} ${fmtTokens(c.unpricedTokens)}`);
      if (c.resetMarks.length) parts.push(t('cal.reset'));
      if (c.partialEvents > 0) parts.push(t('cal.incomplete'));
    }
    return parts.join('、');
  };

  return (
    <div className="layout">
      <div className="stack">
        {error && <div className="note warn">{error}</div>}
        {loading && (
          <div className="faint" role="status" aria-live="polite">
            {t('common.loading')}
          </div>
        )}
        {filters.unit === 'day' && data && (
          <div className="card">
            <BarDefs />
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="row">
                <span className="muted">{t('cal.monthTotal')}</span>
                <span className="big">{fmtMeasure(data.monthTotal, measure, money, false)}</span>
                {measure === 'cost' && <span className="faint">{t('common.apiEquivalent')}</span>}
                {measure === 'cost' && data.monthUnpricedTokens > 0 && (
                  <span className="badge warn" title={t('common.unpricedNote')}>
                    {t('cal.unpriced')}: {fmtTokens(data.monthUnpricedTokens)} tok / {data.monthUnpricedEvents.toLocaleString()}件
                  </span>
                )}
              </div>
              {mode === 'cumulative' && (
                <span className="faint">
                  {data.windowLabel ?? t('window.none')}
                  {data.cycleNote === 'partly_estimated' && <span className="badge est"> {t('cal.resetEstimated')}</span>}
                </span>
              )}
            </div>
            {mode === 'cumulative' && data.cycleNote === 'unknown' && <div className="note warn" style={{ marginBottom: 8 }}>{t('cal.cumulativeNeedsWindow')}</div>}
            <div className="cal-head">
              {weekdays.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
            <div className="cal-grid" ref={gridRef} role="grid" aria-label="calendar">
              {data.cells.map((c, i) => {
                const inc = c.cumulative;
                return (
                  <button
                    key={c.date}
                    className={`cell${c.inMonth ? '' : ' out'}${c.future ? ' future' : ''}${c.date === today ? ' today' : ''}${selected === c.date ? ' selected' : ''}`}
                    aria-label={cellLabel(c)}
                    title={cellLabel(c)}
                    tabIndex={c.date === (selected ?? today) ? 0 : -1}
                    onKeyDown={(e) => onKey(e, i)}
                    onClick={() => setSelected(c.date === selected ? null : c.date)}
                  >
                    <div className="top">
                      <span>{Number(c.date.slice(8))}</span>
                      <span className="marks">
                        {c.resetMarks.map((m) => (
                          <span key={m.atMs} className={`badge ${m.estimated ? 'est' : 'accent'}`} title={m.estimated ? t('cal.resetEstimated') : t('cal.reset')}>
                            ↺
                          </span>
                        ))}
                        {c.partialEvents > 0 && (
                          <span className="badge warn" title={t('common.partialNote')}>
                            !
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="barwrap">
                      <DayBar cell={c} mode={mode} max={max} dimKeys={data.dimensionKeys} />
                    </div>
                    <div className="vals">
                      {c.future ? (
                        <span className="sub">—</span>
                      ) : c.noData ? (
                        <span className="sub">{t('cal.noData')}</span>
                      ) : mode === 'cumulative' ? (
                        <>
                          <div>+{fmtMeasure(inc.increment ?? c.total, measure, money)}</div>
                          <div className="sub">{inc.cumulative != null ? `計 ${fmtMeasure(inc.cumulative, measure, money)}` : t('cal.cycleUnknown')}</div>
                          {inc.resetInBucket && inc.oldCycleUsage > 0 && <div className="sub">日計 {fmtMeasure(c.total, measure, money)}</div>}
                        </>
                      ) : (
                        <div>{fmtMeasure(c.total, measure, money)}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="legend">
              {mode === 'cumulative' ? (
                <>
                  <span>
                    <span className="swatch" style={{ background: 'var(--bar-prior)' }} />
                    {t('cal.prior')}
                  </span>
                  <span>
                    <span className="swatch" style={{ background: 'var(--bar-inc)' }} />
                    {t('cal.increment')}
                  </span>
                  <span>
                    <span className="swatch" style={{ background: 'url(#hatch-est)', borderStyle: 'dashed' }} />
                    {t('cal.resetEstimated')}
                  </span>
                  <span>↺ {t('cal.reset')}</span>
                </>
              ) : (
                data.dimensionKeys.slice(0, 10).map((k, i) => (
                  <span key={k}>
                    <span className="swatch" style={{ background: colorFor(k, i) }} />
                    {k}
                  </span>
                ))
              )}
              <span>! {t('cal.incomplete')}</span>
              <span>
                <span className="swatch" style={{ background: 'var(--surface)', borderStyle: 'dashed' }} />
                {t('cal.noData')}
              </span>
            </div>
            {mode === 'cumulative' && data.cycleNote === 'partly_estimated' && <div className="faint" style={{ marginTop: 6 }}>{t('cal.cycleEstimatedNote')}</div>}
          </div>
        )}
        {filters.unit !== 'day' && tl && (
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{filters.unit === 'week' ? t('tl.calendarWeek') : tl.fiveHourBasis === 'official' ? t('tl.official5h') : t('tl.analytic5h')}</h2>
              <span className="faint">
                {t('tl.periodTotal')}: {fmtMeasure(tl.periodTotal, tlMeasure, money, false)}
              </span>
            </div>
            {filters.unit === 'five_hour' && filters.provider !== 'both' && app.quota?.noFiveHour[filters.provider] && <div className="note">{t('quota.noFiveHour')}</div>}
            <TimelineChart data={tl} measure={tlMeasure} mode={tlMode} onPick={(b) => setSelected(DateTime.fromMillis(b.startMs, { zone }).toISODate())} />
          </div>
        )}
        {selected && <DayDetail date={selected} onClose={() => setSelected(null)} />}
        {measure === 'cost' && <div className="faint">{t('set.pricingNote')}</div>}
      </div>
      <div className="stack">
        <RecentPanel />
        <QuotaPanel onOpenEstimate={onOpenEstimate} />
        {measure === 'cost' && data && (
          <div className="faint">
            {fmtMoney(1e9, money)} = 1 USD{money.currency === 'JPY' ? `（1 USD = ${settings.usdJpy} 円・手動設定）` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
