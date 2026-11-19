// 公称の倍率（例: 1x / 5x / 20x）が本当かを確かめるための図。
// 同じモデル・エフォートで、プランごとの期間の「トークンあたりの消費%」を比べ、基準のプランに対する比を示す。
// 棒の上の線は、公称の倍率（橙）と、その半分（青）。比がどちらの線に近いかで読む。

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtDate, groupLabel, planLabel } from '../format.ts';
import type { PlanCompareView } from '../../shared/plan.ts';
import { BarGauge } from './Gauge.tsx';

const x = (v: number): string => `×${v >= 100 ? v.toFixed(0) : v.toFixed(1)}`;

function Scale({ low, mid, high, max, nominal, tone }: { low: number; mid: number; high: number; max: number; nominal: number | null; tone: 'ok' | 'info' | 'warn' }) {
  const marks = [
    ...(nominal != null ? [{ at: nominal, kind: 'line' as const, tone: 'warn' as const }, { at: nominal / 2, kind: 'line' as const, tone: 'info' as const }] : []),
    { at: mid, kind: 'dot' as const, tone },
  ];
  return <BarGauge max={max} band={{ low: Math.min(low, max), high: Math.min(Math.max(high, low + max * 0.01), max) }} marks={marks} tone={tone} label={`${x(mid)} [${x(low)}–${x(high)}]`} />;
}

export function PlanCompare() {
  const { dataVersion, zone } = useApp();
  const t = useT();
  const [v, setV] = useState<PlanCompareView | null>(null);
  useEffect(() => {
    let alive = true;
    void api()
      .planCompare()
      .then((d) => alive && setV(d));
    return () => {
      alive = false;
    };
  }, [dataVersion]);
  if (!v) return null;
  return (
    <div className="card stack">
      <h2>{t('plan.cmp.title')}</h2>
      <div className="faint">{t('plan.cmp.lead')}</div>
      {v.unavailable != null ? (
        <div className="note">{t('plan.cmp.none')}</div>
      ) : (
        <>
          <table className="tbl">
            <tbody>
              {v.plans.map((p) => (
                <tr key={p.plan}>
                  <td>
                    {planLabel('codex', p.plan)} {p.plan === v.basePlan && <span className="badge accent">{t('plan.cmp.base')}</span>}
                  </td>
                  <td className="faint">
                    {fmtDate(p.fromMs, zone)} – {fmtDate(p.toMs, zone)}
                  </td>
                  <td className="r num">{p.nominal != null ? `${t('plan.cmp.nominal')} ×${p.nominal}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {v.summary.map((s) => {
            const max = (s.nominal ?? 20) * 1.6;
            const rows = v.groups.filter((g) => g.byPlan.some((b) => b.plan === s.plan));
            return (
              <div key={s.plan} className="stack" style={{ gap: 6 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>
                    {planLabel('codex', s.plan)}
                    {s.nominal != null && <span className="badge est"> {t('plan.cmp.nominal')} ×{s.nominal}</span>}
                  </strong>
                  <span className="num">
                    {t('plan.cmp.best')} ({groupLabel(s.bestGroup)}) {x(s.best.mid)} <span className="faint">[{x(s.best.low)}–{x(s.best.high)}]</span>
                  </span>
                </div>
                <Scale low={s.best.low} mid={s.best.mid} high={s.best.high} max={max} nominal={s.nominal} tone="ok" />
                <div className="faint" style={{ fontSize: 11 }}>
                  <span className="m-warn">┆ {t('plan.cmp.nominal')} ×{s.nominal}</span> <span className="m-info">┆ {t('plan.cmp.half')} ×{(s.nominal ?? 0) / 2}</span>
                </div>
                {rows.map((g) => {
                  const b = g.byPlan.find((q) => q.plan === s.plan)!;
                  const measured = b.status === 'measured';
                  return (
                    <div key={g.group} className="plancmp-row" style={{ opacity: measured ? 1 : 0.5 }}>
                      <span>{groupLabel(g.group)}</span>
                      <Scale low={b.ratio.low} mid={b.ratio.mid} high={b.ratio.high} max={max} nominal={s.nominal} tone={measured ? 'info' : 'warn'} />
                      <span className="num faint">
                        {x(b.ratio.mid)} {!measured && <span className="badge">{t('plan.cmp.tentative')}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="note">{t('plan.cmp.caveat')}</div>
        </>
      )}
    </div>
  );
}
