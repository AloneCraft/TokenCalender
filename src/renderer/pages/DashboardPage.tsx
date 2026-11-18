// 利用枠ダッシュボード: 最初に見る画面。「あと何%・いつまで・今日どれだけ・あと何回」に答える。
// 公式観測値・ローカルログからの値・推定を、見出しと札で区別して表示する。

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { EChart, type EChartsOption } from '../components/EChart.tsx';
import { Loading } from '../components/Loading.tsx';
import { CurrentChats } from '../components/CurrentChats.tsx';
import { Icon, type IconName } from '../components/Icons.tsx';
import { BarGauge, RatioCell, RingGauge, type Tone } from '../components/Gauge.tsx';
import { useBusy } from '../busy.ts';
import { fmtAgo, fmtDate, fmtDateTimeWd, fmtDuration, fmtInt, fmtPct, fmtRange, groupLabel, windowName } from '../format.ts';
import type { Band, PlanOverview, PlanWindow, ProviderPlan, SimulateResult } from '../../shared/api.ts';
import type { Page } from '../App.tsx';

type T = ReturnType<typeof useT>;

function bandText(b: Band | null | undefined, digits = 0, unit = ''): string {
  if (!b) return '—';
  const f = (v: number) => (digits === 0 ? fmtInt(v) : v.toFixed(digits));
  if (Math.abs(b.high - b.low) < Math.pow(10, -digits) * 0.5) return `${f(b.mid)}${unit}`;
  return `${fmtRange(f(b.low), f(b.high))}${unit}`;
}

export function DashboardPage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const app = useApp();
  const t = useT();
  const [data, setData] = useState<PlanOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      .planOverview({ zone: app.zone })
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [app.slowVersion, app.zone, app.settings.reservePct, app.settings.budgetWeekdayWeights, app.settings.demo]);

  useBusy('dashboard', !data && !error);
  if (error) return <div className="note warn">{t('common.error')}: {error}</div>;
  if (!data) return <Loading block />;

  const bindingWin = data.binding ? data.windows.find((w) => w.key === data.binding!.key) : null;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t('dash.title')}</h1>
        <span className="faint">
          {t('dash.updated')} {fmtAgo(data.generatedAtMs)} · {t('dash.reserve', { pct: data.reservePct })}
        </span>
      </div>
      <CurrentChats />
      {bindingWin && <BindingBanner data={data} win={bindingWin} t={t} zone={app.zone} />}
      {data.providers.map((p) => (
        <ProviderSection key={p.provider} plan={p} windows={data.windows.filter((w) => w.provider === p.provider)} reservePct={data.reservePct} onNavigate={onNavigate} />
      ))}
      <Legend t={t} />
    </div>
  );
}

function providerName(p: string): string {
  return p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : p;
}

function BindingBanner({ data, win, t, zone }: { data: PlanOverview; win: PlanWindow; t: T; zone: string }) {
  const b = data.binding!;
  const name = `${providerName(win.provider)} ${windowName(win.windowMinutes)}`;
  const tone = b.reason === 'already_exhausted' ? 'danger' : b.reason === 'exhausts_first' ? 'warn' : 'ok';
  // 比べる枠が1つだけのときは「いちばん余裕が少ない」とは言わない
  const liveCount = data.windows.filter((w) => w.official && !w.resetPassedUnconfirmed).length;
  const text =
    b.reason === 'already_exhausted'
      ? t('dash.binding.exhausted', { name, at: fmtDateTimeWd(b.atMs, zone) })
      : b.reason === 'exhausts_first'
        ? t('dash.binding.first', { name, at: fmtDateTimeWd(b.atMs, zone) })
        : liveCount > 1
          ? t('dash.binding.margin', { name })
          : t('dash.binding.only', { name });
  return (
    <div className={`note ${tone === 'ok' ? '' : 'warn'}`} role="status" style={tone === 'danger' ? { borderColor: 'var(--danger)', background: 'var(--danger-bg)' } : undefined}>
      <strong>{t('dash.binding.title')}</strong> {text}
    </div>
  );
}

function ProviderSection({ plan, windows, reservePct, onNavigate }: { plan: ProviderPlan; windows: PlanWindow[]; reservePct: number; onNavigate: (p: Page) => void }) {
  const app = useApp();
  const t = useT();
  const main = windows.find((w) => w.key === plan.capacityWindowKey) ?? windows.find((w) => w.official) ?? null;
  const others = windows.filter((w) => w !== main);
  const name = providerName(plan.provider);

  if (!main || !main.official) {
    return (
      <section className="card stack" aria-label={name}>
        <h2>{name}</h2>
        <p>{t('dash.noOfficial')}</p>
        <p className="muted">{plan.provider === 'claude' ? t('dash.noOfficial.claude') : t('dash.noOfficial.codex')}</p>
        {plan.rates.usageMix.length > 0 && (
          <p className="muted">
            {t('dash.recentModel')}: <strong>{groupLabel(plan.currentGroup)}</strong>
          </p>
        )}
        <div className="row">
          <button className="btn" onClick={() => onNavigate('estimate')}>
            {t('dash.addManual')}
          </button>
          {plan.provider === 'claude' && (
            <button className="btn" onClick={() => onNavigate('sources')}>
              {t('dash.setupStatusline')}
            </button>
          )}
        </div>
      </section>
    );
  }

  const o = main.official!;
  const now = Date.now();
  const fc = main.forecast;
  const cur = plan.capacity.find((c) => c.group === plan.currentGroup) ?? null;
  return (
    <section className="card stack" aria-label={`${name} ${windowName(main.windowMinutes)}`}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>
          {name} {windowName(main.windowMinutes)} {main.planType && <span className="badge">{main.planType}</span>}
        </h2>
        <span className="faint">
          {t('dash.officialAt')} {fmtAgo(o.observedAtMs)} {o.stale && <span className="badge warn">{t('dash.stale')}</span>}
        </span>
      </div>
      {main.resetPassedUnconfirmed && <div className="note warn">{t('dash.resetPassed')}</div>}

      <div className="metrics" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Metric label={t('dash.m.remaining')} tag="official" t={t} icon="battery" tone={o.remainingPct > 30 ? 'ok' : o.remainingPct > 10 ? 'warn' : 'danger'} valueInVisual visual={<RingGauge value={o.remainingPct} tone={o.remainingPct > 30 ? 'ok' : o.remainingPct > 10 ? 'warn' : 'danger'} label={fmtPct(o.remainingPct)}>{fmtPct(o.remainingPct)}</RingGauge>} value={fmtPct(o.remainingPct)} sub={main.local.addedPct && main.local.addedPct.mid >= 0.05 ? t('dash.m.remaining.local', { pct: bandText(main.local.addedPct, 1) }) : t('dash.m.remaining.used', { pct: fmtPct(o.usedPct) })} />
        <Metric label={t('dash.m.reset')} tag="official" t={t} icon="clock" valueInVisual visual={<RingGauge value={o.resetsAtMs && main.cycleStartMs ? ((now - main.cycleStartMs) / Math.max(1, o.resetsAtMs - main.cycleStartMs)) * 100 : 0} tone="info" label={o.resetsAtMs ? fmtDuration(o.resetsAtMs - now) : '—'}>{o.resetsAtMs ? fmtDuration(o.resetsAtMs - now) : '—'}</RingGauge>} value={o.resetsAtMs ? fmtDuration(o.resetsAtMs - now) : '—'} sub={fmtDateTimeWd(o.resetsAtMs, app.zone)} />
        <Metric
          label={t('dash.m.today')}
          tag="plan"
          t={t}
          value={
            main.budget?.today?.leftPct == null
              ? '—'
              : main.budget.today.leftPct < 0
                ? t('dash.m.today.over', { pct: fmtPct(-main.budget.today.leftPct, 1) })
                : fmtPct(main.budget.today.leftPct, 1)
          }
          icon="sun"
          tone={main.budget?.todayStatus === 'over' ? 'danger' : main.budget?.todayStatus === 'near' ? 'warn' : 'ok'}
          visual={(() => {
            const td = main.budget?.today;
            if (!td || td.usedPct == null) return undefined;
            const scale = Math.max(td.budgetPct, td.usedPct) * 1.15;
            const tn: Tone = main.budget?.todayStatus === 'over' ? 'danger' : main.budget?.todayStatus === 'near' ? 'warn' : 'ok';
            return (
              <BarGauge
                max={scale}
                fill={Math.min(td.usedPct, td.budgetPct)}
                over={td.usedPct > td.budgetPct ? { from: td.budgetPct, to: td.usedPct } : undefined}
                marks={[{ at: td.budgetPct, kind: 'line', tone: 'info' }]}
                tone={tn}
                label={`${fmtPct(td.usedPct, 1)} / ${fmtPct(td.budgetPct, 1)}`}
              />
            );
          })()}
          sub={main.budget?.today ? t('dash.m.today.sub', { budget: fmtPct(main.budget.today.budgetPct, 1), used: fmtPct(main.budget.today.usedPct, 1) }) : t('dash.m.today.none')}
        />
        <Metric
          label={t('dash.m.atReset')}
          tag="estimate"
          t={t}
          icon="flag"
          tone={fc?.remainingAtReset ? (fc.remainingAtReset.mid <= reservePct ? 'danger' : fc.remainingAtReset.low <= reservePct ? 'warn' : 'ok') : 'info'}
          visual={
            fc?.remainingAtReset ? (
              <BarGauge
                band={{ low: fc.remainingAtReset.low, high: Math.max(fc.remainingAtReset.high, fc.remainingAtReset.low + 1.5) }}
                marks={[
                  { at: fc.remainingAtReset.mid, kind: 'dot', tone: fc.remainingAtReset.mid <= reservePct ? 'danger' : 'ok' },
                  { at: reservePct, kind: 'line', tone: 'warn' },
                ]}
                tone={fc.remainingAtReset.mid <= reservePct ? 'danger' : fc.remainingAtReset.low <= reservePct ? 'warn' : 'ok'}
                label={bandText(fc.remainingAtReset, 0, '%')}
              />
            ) : undefined
          }
          value={fc?.remainingAtReset ? fmtPct(fc.remainingAtReset.mid) : '—'}
          sub={
            fc?.remainingAtReset
              ? `${fc.remainingAtReset.high - fc.remainingAtReset.low >= 1 ? `${bandText(fc.remainingAtReset, 0, '%')} · ` : ''}${fc.probabilityLasts != null ? t('dash.m.atReset.prob', { p: Math.round(fc.probabilityLasts * 100), n: fc.cyclesUsed }) : t('dash.m.atReset.noProb', { n: fc.cyclesUsed })}`
              : t('dash.m.atReset.none')
          }
        />
        <Metric
          label={t('dash.m.work')}
          tag="estimate"
          t={t}
          icon="bolt"
          value={cur?.turns ? t('dash.times', { n: bandText(cur.turns) }) : plan.overallCapacity.turns ? t('dash.times', { n: bandText(plan.overallCapacity.turns) }) : '—'}
          sub={
            cur?.turns
              ? t('dash.m.work.sub', { group: groupLabel(plan.currentGroup), hours: bandText(plan.activeHours.hoursLeft, 0) })
              : plan.overallCapacity.turns
                ? t('dash.m.work.overall', { hours: bandText(plan.activeHours.hoursLeft, 0) })
                : t('dash.m.work.none')
          }
        />
      </div>

      <div className="layout" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(260px, 2fr)' }}>
        <div className="stack">
          <h3>{t('dash.chart.title')}</h3>
          <CycleChart win={main} t={t} zone={app.zone} reservePct={reservePct} />
        </div>
        <div className="stack">
          <h3>{t('dash.budget.title')}</h3>
          <BudgetTable win={main} t={t} zone={app.zone} />
        </div>
      </div>

      <h3>{t('dash.models.title')}</h3>
      <ModelTable plan={plan} t={t} />
      <div className="row">
        <button className="btn" onClick={() => onNavigate('rates')}>
          {t('dash.models.more')}
        </button>
      </div>

      <Simulator win={main} plan={plan} t={t} />

      {others.length > 0 && (
        <div className="stack">
          <h3>{t('dash.otherWindows')}</h3>
          <table className="tbl">
            <tbody>
              {others.map((w) => (
                <tr key={w.key}>
                  <td>{windowName(w.windowMinutes)}</td>
                  <td className="r num">{w.official ? fmtPct(w.official.remainingPct) : '—'}</td>
                  <td>{w.official?.resetsAtMs ? `${t('dash.m.reset')} ${fmtDateTimeWd(w.official.resetsAtMs, app.zone)}` : '—'}</td>
                  <td>{w.forecast?.exhaustion?.likelyMs ? t('dash.exhaustAt', { at: fmtDateTimeWd(w.forecast.exhaustion.likelyMs, app.zone) }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, sub, tag, t, tone, icon, visual, valueInVisual }: { label: string; value: string; sub: string; tag: 'official' | 'local' | 'estimate' | 'plan'; t: T; tone?: Tone; icon?: IconName; visual?: React.ReactNode; valueInVisual?: boolean }) {
  const badge = tag === 'official' ? 'ok' : tag === 'estimate' ? 'est' : tag === 'plan' ? 'accent' : '';
  return (
    <div className={`metric tone-${tone ?? 'info'}${tone === 'danger' ? ' is-alert' : ''}`}>
      <div className="label">
        {icon && <Icon name={icon} />}
        {label} <span className={`badge ${badge}`}>{t(`dash.tag.${tag}`)}</span>
      </div>
      {valueInVisual ? (
        <div className="metric-visual">{visual}</div>
      ) : (
        <>
          <div className="big num" style={tone === 'danger' || tone === 'warn' ? { color: `var(--${tone})` } : undefined}>
            {tone === 'danger' && <Icon name="alert" size={18} />}
            {value}
          </div>
          {visual && <div className="metric-visual">{visual}</div>}
        </>
      )}
      <div className="faint">{sub}</div>
    </div>
  );
}

/** 予測の一文と、根拠つきの提案 */
function CycleChart({ win, t, zone, reservePct }: { win: PlanWindow; t: T; zone: string; reservePct: number }) {
  const option = useMemo<EChartsOption>(() => {
    const o = win.official!;
    const reset = o.resetsAtMs ?? Date.now();
    const start = win.cycleStartMs ?? win.path[0]?.t ?? Date.now();
    const now = Date.now();
    const actual = [[start, 0], ...win.path.map((p) => [p.t, p.p]), [Math.min(now, reset), o.usedPct]];
    const series: unknown[] = [{ name: t('dash.chart.actual'), type: 'line', step: 'end', data: actual, showSymbol: false, lineStyle: { width: 2.5 }, z: 5 }];
    if (win.budget && win.budget.days.length) {
      let v = o.usedPct;
      const pts: number[][] = [[now, v]];
      win.budget.days.forEach((d, i) => {
        v += i === 0 ? Math.max(0, win.budget!.today?.leftPct ?? d.budgetPct) : d.budgetPct;
        pts.push([d.endMs, Math.min(100, v)]);
      });
      series.push({ name: t('dash.chart.budget'), type: 'line', data: pts, showSymbol: false, lineStyle: { type: 'dashed', width: 1.5 } });
    }
    const fc = win.forecast;
    if (fc?.finalPct) {
      // 上限に達する見込みなら、その時刻で 100% に届く線にする（リセット時刻まで伸ばすと時刻を読み違えるため）
      const midEnd = fc.exhaustion?.likelyMs ? [fc.exhaustion.likelyMs, 100] : [reset, fc.finalPct.mid];
      const highEnd = fc.exhaustion?.earliestMs ? [fc.exhaustion.earliestMs, 100] : [reset, fc.finalPct.high];
      const mark = (coord: number[], color: string, text: string, position: string, size = 9) => ({
        coord,
        symbol: 'circle',
        symbolSize: size,
        itemStyle: { color },
        label: { show: true, formatter: text, position, distance: position === 'bottom' ? 22 : 8, color, fontSize: 12, fontWeight: 700, backgroundColor: 'rgba(255,255,255,0.92)', borderColor: color, borderWidth: 1, borderRadius: 4, padding: [3, 6] },
      });
      // 文章で説明せず、図の上に「ここで尽きる」「余裕」を直接書く
      const marks: unknown[] = [];
      if (fc.exhaustion?.likelyMs) {
        marks.push(mark([fc.exhaustion.likelyMs, 100], '#b3261e', `${t('dash.chart.exhaust')}
${fmtDateTimeWd(fc.exhaustion.likelyMs, zone)}`, 'bottom', 10));
        if (fc.exhaustion.earliestMs && fc.exhaustion.earliestMs < fc.exhaustion.likelyMs - 3600000)
          marks.push(mark([fc.exhaustion.earliestMs, 100], '#e08a00', `${t('dash.chart.earliest')} ${fmtDateTimeWd(fc.exhaustion.earliestMs, zone)}`, 'top', 7));
      } else {
        marks.push(mark([reset, fc.finalPct.mid], '#2e7d32', t('dash.chart.spare', { pct: fmtPct(fc.finalPct.mid, 0) }), 'left', 9));
      }
      series.push({ name: t('dash.chart.forecast'), type: 'line', data: [[now, o.usedPct], midEnd], showSymbol: false, lineStyle: { type: 'dotted', width: 2 }, markPoint: { silent: true, data: marks } });
      series.push({
        name: t('dash.chart.range'),
        type: 'line',
        data: [[now, o.usedPct], highEnd, null, [now, o.usedPct], [reset, fc.finalPct.low]],
        connectNulls: false,
        showSymbol: false,
        lineStyle: { type: 'dotted', width: 1, opacity: 0.6 },
      });
    }
    if (fc?.recentPace && fc.recentPace.pctPerHour > 0) {
      const end = Math.min(reset, now + ((100 - o.usedPct) / fc.recentPace.pctPerHour) * 3600000);
      series.push({ name: t('dash.chart.recent'), type: 'line', data: [[now, o.usedPct], [end, Math.min(100, o.usedPct + ((end - now) / 3600000) * fc.recentPace.pctPerHour)]], showSymbol: false, lineStyle: { type: 'dashed', width: 1 } });
    }
    const legendNames = series.map((s) => (s as { name: string }).name);
    // 上限と目標は周期の始めから終わりまでの線として描き、名前を右端に付ける（凡例には出さない）
    const guide = (name: string, y: number, color: string, type: 'solid' | 'dashed') => ({
      name,
      type: 'line',
      data: [
        [start, y],
        [reset, y],
      ],
      showSymbol: false,
      silent: true,
      lineStyle: { color, type, width: 1 },
      endLabel: { show: true, formatter: name, color, fontSize: 11 },
      tooltip: { show: false },
    });
    series.push(guide(t('dash.chart.limit'), 100, '#b3261e', 'solid'), guide(t('dash.chart.target'), 100 - reservePct, '#9a6200', 'dashed'));
    (series[0] as Record<string, unknown>).markLine = {
      symbol: 'none',
      silent: true,
      data: [{ xAxis: now, label: { formatter: t('dash.chart.now'), position: 'end' }, lineStyle: { color: '#888' } }],
    };
    return {
      // 右端に「上限」「目標」の名前を出す。言語によって長い（Objectif、Objetivo など）ため、余白を広めに取る
      grid: { left: 44, right: 64, top: 62, bottom: 30 },
      legend: { top: 0, textStyle: { fontSize: 11 }, data: legendNames },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '') },
      xAxis: { type: 'time', min: start, max: reset, axisLabel: { formatter: (v: number) => fmtDate(v, zone) } },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series,
    } as EChartsOption;
  }, [win, t, zone, reservePct]);
  return <EChart option={option} ariaLabel={t('dash.chart.title')} />;
}

function BudgetTable({ win, t, zone }: { win: PlanWindow; t: T; zone: string }) {
  if (!win.budget || win.budget.days.length === 0) return <div className="faint">{t('dash.budget.none')}</div>;
  const max = Math.max(...win.budget.days.map((d) => Math.max(d.budgetPct, d.usedPct ?? 0)), 1);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('dash.budget.day')}</th>
            <th className="r">{t('dash.budget.amount')}</th>
            <th style={{ width: '45%' }} />
          </tr>
        </thead>
        <tbody>
          {win.budget.days.map((d, i) => (
            <tr key={d.date}>
              <td>
                {fmtDate(d.startMs, zone)} {i === 0 && <span className="badge accent">{t('dash.budget.today')}</span>}
              </td>
              <td className="r num">
                {fmtPct(d.budgetPct, 1)}
                {i === 0 && d.usedPct != null && <div className="faint">{t('dash.budget.used', { pct: fmtPct(d.usedPct, 1) })}</div>}
              </td>
              <td>
                <div className="bar-track" title={fmtPct(d.budgetPct, 1)}>
                  <div className="bar-fill" style={{ width: `${(d.budgetPct / max) * 100}%`, opacity: 0.45 }} />
                </div>
                {i === 0 && d.usedPct != null && (
                  <div className="bar-track" style={{ marginTop: 2 }}>
                    <div className="bar-fill" style={{ width: `${Math.min(100, (d.usedPct / max) * 100)}%`, background: d.usedPct > d.budgetPct ? 'var(--danger)' : undefined }} />
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="faint">{t('dash.budget.note')}</div>
    </div>
  );
}

function ModelTable({ plan, t }: { plan: ProviderPlan; t: T }) {
  const rows = plan.capacity.filter((c) => c.turns);
  if (rows.length === 0) return <div className="faint">{plan.rates.unavailable ? t(`rates.unavailable.${plan.rates.unavailable}`) : t('dash.models.none')}</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{t('rates.col.group')}</th>
          <th className="r">{t('dash.models.turns')}</th>
          <th className="r">{t('rates.col.perTurn')}</th>
          <th className="r">{t('rates.col.relative')}</th>
          <th>{t('rates.col.status')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const r = plan.rates.groups.find((g) => g.group === c.group)!;
          return (
            <tr key={c.group} style={c.group === plan.currentGroup ? { background: 'var(--accent-bg)' } : undefined}>
              <td>
                {groupLabel(c.group)} {c.group === plan.currentGroup && <span className="badge accent">{t('dash.models.current')}</span>}
              </td>
              <td className="r num">{t('dash.times', { n: bandText(c.turns) })}</td>
              <td className="r num">{bandText(r.pctPerTurn, 3, '%')}</td>
              <td className="r">
                <RatioCell ratio={r.relativeToBaseline} />
              </td>
              <td>
                <span className={`badge ${r.status === 'measured' ? 'ok' : 'est'}`}>{t(`rates.status.${r.status}`)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function Simulator({ win, plan, t }: { win: PlanWindow; plan: ProviderPlan; t: T }) {
  const app = useApp();
  const groups = plan.rates.groups.filter((g) => g.pctPerTurn);
  const [group, setGroup] = useState<string | null>(plan.currentGroup && groups.some((g) => g.group === plan.currentGroup) ? plan.currentGroup : null);
  const [turns, setTurns] = useState(30);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [startHour, setStartHour] = useState(9);
  const [hours, setHours] = useState(8);
  const [res, setRes] = useState<SimulateResult | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      void api()
        .simulate({ windowKey: win.key, group, turnsPerDay: turns, workWeekdays: days, workStartHour: startHour, workHours: hours, zone: app.zone })
        .then(setRes)
        .catch(() => setRes(null));
    }, 250);
    return () => clearTimeout(id);
  }, [win.key, group, turns, days, startHour, hours, app.zone, app.slowVersion]);

  const option = useMemo<EChartsOption | null>(() => {
    if (!res || res.points.length === 0) return null;
    const path = [[win.cycleStartMs ?? res.points[0]!.t, 0], ...win.path.map((p) => [p.t, p.p]), [res.points[0]!.t, res.usedNow]];
    return {
      grid: { left: 44, right: 16, top: 30, bottom: 30 },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '') },
      xAxis: { type: 'time', min: win.cycleStartMs ?? undefined, max: res.resetsAtMs ?? undefined, axisLabel: { formatter: (v: number) => fmtDate(v, app.zone) } },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        { name: t('dash.chart.actual'), type: 'line', step: 'end', data: path, showSymbol: false, lineStyle: { width: 2.5 } },
        { name: t('sim.mid'), type: 'line', data: res.points.map((p) => [p.t, p.mid]), showSymbol: false, lineStyle: { type: 'dashed' } },
        { name: t('sim.high'), type: 'line', data: res.points.map((p) => [p.t, p.high]), showSymbol: false, lineStyle: { type: 'dotted', opacity: 0.6 } },
        { name: t('sim.low'), type: 'line', data: res.points.map((p) => [p.t, p.low]), showSymbol: false, lineStyle: { type: 'dotted', opacity: 0.6 } },
      ],
    } as EChartsOption;
  }, [res, win, t, app.zone]);

  const wdName = (i: number) => t(`wd.${i}`);
  return (
    <details className="stack">
      <summary style={{ cursor: 'pointer' }}>
        <strong>{t('sim.title')}</strong> <span className="faint">{t('sim.subtitle')}</span>
      </summary>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <label htmlFor="sim-g">{t('sim.group')}</label>
        <select id="sim-g" value={group ?? ''} onChange={(e) => setGroup(e.target.value || null)}>
          <option value="">{t('sim.overall')}</option>
          {groups.map((g) => (
            <option key={g.group} value={g.group}>
              {groupLabel(g.group)} ({bandText(g.pctPerTurn, 3, '%')} / {t('sim.perTurn')})
            </option>
          ))}
        </select>
        <label htmlFor="sim-n">{t('sim.turnsPerDay')}</label>
        <input id="sim-n" type="number" min={0} max={2000} value={turns} onChange={(e) => setTurns(Math.max(0, Number(e.target.value) || 0))} style={{ width: 90 }} />
        <span>{t('sim.days')}</span>
        <div className="row" role="group" aria-label={t('sim.days')}>
          {WEEKDAYS.map((i) => (
            <label key={i} className="row" style={{ gap: 2 }}>
              <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, i] : d.filter((x) => x !== i)))} />
              {wdName(i)}
            </label>
          ))}
        </div>
        <label htmlFor="sim-h">{t('sim.hours')}</label>
        <div className="row">
          <input id="sim-h" type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(Math.min(23, Math.max(0, Number(e.target.value) || 0)))} style={{ width: 60 }} />
          <span>{t('sim.hoursFrom')}</span>
          <input type="number" min={1} max={24} aria-label={t('sim.hoursLen')} value={hours} onChange={(e) => setHours(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 60 }} />
          <span>{t('sim.hoursLen')}</span>
        </div>
      </div>
      {res?.unavailable && <div className="note warn">{t(`sim.unavailable.${res.unavailable}`)}</div>}
      {res && !res.unavailable && res.finalPct && (
        <div className="note">
          {res.exhaustionMs?.mid
            ? t('sim.result.exhaust', { at: fmtDateTimeWd(res.exhaustionMs.mid, app.zone), early: fmtDateTimeWd(res.exhaustionMs.earliest, app.zone) })
            : t('sim.result.lasts', { pct: bandText({ mid: 100 - res.finalPct.mid, low: 100 - res.finalPct.high, high: 100 - res.finalPct.low }, 0, '%') })}
          <div className="faint">{t('sim.note')}</div>
        </div>
      )}
      {option && <EChart option={option} ariaLabel={t('sim.title')} />}
      {plan.whatIf.byGroup.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <h3>{t('sim.whatIf.title', { days: plan.whatIf.days })}</h3>
          <table className="tbl">
            <tbody>
              <tr>
                <td>{t('sim.whatIf.actual')}</td>
                <td className="r num">{plan.whatIf.actualPct != null ? fmtPct(plan.whatIf.actualPct) : '—'}</td>
              </tr>
              {plan.whatIf.byGroup.map((g) => (
                <tr key={g.group}>
                  <td>{t('sim.whatIf.if', { group: groupLabel(g.group) })}</td>
                  <td className="r num">{bandText(g.pct, 0, '%')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="faint">{t('sim.whatIf.note')}</div>
        </div>
      )}
    </details>
  );
}

function Legend({ t }: { t: T }) {
  return (
    <div className="faint" style={{ fontSize: 12 }}>
      <span className="badge ok">{t('dash.tag.official')}</span> {t('dash.legend.official')} · <span className="badge accent">{t('dash.tag.plan')}</span> {t('dash.legend.plan')} ·{' '}
      <span className="badge est">{t('dash.tag.estimate')}</span> {t('dash.legend.estimate')}
    </div>
  );
}
