import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { commonFilter, useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { Seg } from '../components/Seg.tsx';
import { useBusy } from '../busy.ts';
import { TimelineChart } from '../components/TimelineChart.tsx';
import { fmtMeasure, fmtTokens, windowKeyLabel } from '../format.ts';
import type { Measure, TimelineGranularity, TimelineResponse } from '../../shared/api.ts';

type Kind = 'days' | 'five_hour' | 'calendar_week';

/** 日付を連続して並べる時系列ページ。上段は区間ごとの使用量、下段はリセットで 0 に戻る周期内累積。 */
export function TimelinePage() {
  const app = useApp();
  const { filters, money, dataVersion, quota, settings } = app;
  const t = useT();
  const [kind, setKind] = useState<Kind>('days');
  const [n, setN] = useState(1);
  const [m, setM] = useState(90);
  const [m5, setM5] = useState(40);
  const [weeks, setWeeks] = useState(26);
  const [overlay, setOverlay] = useState(true);
  // 結果を求めたときの測る値で描画する（切り替え直後に古い結果を新しい書式で見せない）
  const [data, setData] = useState<(TimelineResponse & { measure: Measure }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useBusy('timeline', loading);

  const provider = filters.provider;
  const w5h = provider !== 'both' ? (quota?.windows.find((w) => w.provider === provider && w.windowMinutes === 300)?.key ?? null) : null;
  const wWeek = filters.window ?? (provider !== 'both' ? (quota?.windows.find((w) => w.provider === provider && w.windowMinutes === 10080)?.key ?? null) : null);

  useEffect(() => {
    let alive = true;
    const granularity: TimelineGranularity =
      kind === 'days' ? { kind: 'days', n, m } : kind === 'five_hour' ? { kind: 'five_hour', m: m5 } : { kind: 'calendar_week', weeks };
    setError(null);
    setLoading(true);
    api()
      .timeline({
        ...commonFilter(app),
        granularity,
        measure: filters.measure,
        dimension: filters.dimension,
        window: kind === 'five_hour' ? w5h : wWeek,
        overlayWindow: kind === 'five_hour' && overlay ? wWeek : null,
        weekStart: settings.weekStart,
      })
      .then((d) => alive && setData({ ...d, measure: filters.measure }))
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };

  }, [kind, n, m, m5, weeks, overlay, filters, dataVersion, w5h, wWeek, settings.weekStart, settings.pricingMode, app.zone]);

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <span className="muted">{t('tl.granularity')}</span>
          <Seg<Kind>
            label="granularity"
            value={kind}
            options={[
              ['days', t('tl.days')],
              ['five_hour', t('tl.fiveHour')],
              ['calendar_week', t('tl.calendarWeek')],
            ]}
            onChange={setKind}
          />
          {kind === 'days' && (
            <>
              <label className="field">
                {t('tl.n')}
                <input type="number" min={1} max={366} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} style={{ width: 64 }} />
              </label>
              <label className="field">
                {t('tl.m')}
                <input type="number" min={1} max={3660} value={m} onChange={(e) => setM(Math.max(1, Number(e.target.value) || 1))} style={{ width: 72 }} />
              </label>
            </>
          )}
          {kind === 'five_hour' && (
            <>
              <label className="field">
                {t('tl.m5')}
                <input type="number" min={1} max={2000} value={m5} onChange={(e) => setM5(Math.max(1, Number(e.target.value) || 1))} style={{ width: 72 }} />
              </label>
              <label className="field">
                <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                {t('tl.overlay')}
              </label>
            </>
          )}
          {kind === 'calendar_week' && (
            <label className="field">
              {t('tl.weeks')}
              <input type="number" min={1} max={520} value={weeks} onChange={(e) => setWeeks(Math.max(1, Number(e.target.value) || 1))} style={{ width: 72 }} />
            </label>
          )}
        </div>
        {provider === 'both' && <div className="note" style={{ marginTop: 8 }}>{t('cal.cumulativeNeedsWindow')} {t('tl.bothNote')}</div>}
        {kind === 'calendar_week' && <div className="faint" style={{ marginTop: 6 }}>{t('tl.weekNote')}</div>}
      </div>
      {error && <div className="note warn">{error}</div>}
      {data && (
        <div className={loading ? 'card is-stale' : 'card'}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>
              {kind === 'five_hour' ? (data.fiveHourBasis === 'official' ? t('tl.official5h') : t('tl.analytic5h')) : (data.windowLabel ? (windowKeyLabel(wWeek) ?? data.windowLabel) : t('tl.bars'))}
            </h2>
            <span className="faint">
              {t('tl.periodTotal')}: <span className="num">{fmtMeasure(data.periodTotal, data.measure, money, false)}</span>
              {data.measure === 'cost' && data.periodUnpricedTokens > 0 && ` ／ ${t('cal.unpriced')} ${fmtTokens(data.periodUnpricedTokens)} tok`}
            </span>
          </div>
          {kind === 'five_hour' && provider !== 'both' && quota?.noFiveHour[provider] && <div className="note">{t('quota.noFiveHour')}</div>}
          <TimelineChart data={data} measure={data.measure} mode="cumulative" />
          <div className="legend">
            <span>{t('tl.legendObserved')}</span>
            <span>{t('tl.legendEstimated')}</span>
            <span>{t('tl.legendBands')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
