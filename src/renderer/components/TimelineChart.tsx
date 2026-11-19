import { useMemo } from 'react';
import { EChart, type EChartsOption } from './EChart.tsx';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { colorFor, fmtMeasure, formatLocale } from '../format.ts';
import { isDayBuckets, layoutBands } from '../../shared/cycleLayout.ts';
import type { Measure, TimelineBucket, TimelineResponse } from '../../shared/api.ts';

/** 上段: 区間ごとの棒、下段: 周期内累積（リセットで 0 に戻る）。同じ横軸を共有する。 */
export function TimelineChart({
  data,
  measure,
  mode,
  onPick,
}: {
  data: TimelineResponse;
  measure: Measure;
  mode: 'daily' | 'cumulative';
  onPick?: (b: TimelineBucket) => void;
}) {
  const { money, zone } = useApp();
  const t = useT();
  const option = useMemo<EChartsOption>(() => {
    const labels = data.buckets.map((b) =>
      new Date(b.startMs).toLocaleString(formatLocale(), { timeZone: zone, month: 'numeric', day: 'numeric', ...(b.endMs - b.startMs < 86400000 ? { hour: '2-digit' } : {}) }),
    );
    const fmt = (v: number) => fmtMeasure(v, measure, money);
    const keys = data.dimensionKeys.length ? data.dimensionKeys : ['all'];
    const bars = keys.map((k, i) => ({
      name: k,
      type: 'bar',
      stack: 'u',
      xAxisIndex: 0,
      yAxisIndex: 0,
      itemStyle: { color: colorFor(k, i) },
      data: data.buckets.map((b) => (b.future ? null : (b.byDim[k] ?? (keys.length === 1 ? b.total : 0)))),
    }));
    const cum = data.buckets.map((b) => b.cumulative);
    // 線は周期の境目だけを示す。文字は帯の見出しに集約し、リセットごとに重ねて出さない。
    const resetLines = data.resets.map((r) => {
      const idx = data.buckets.findIndex((b) => r.atMs >= b.startMs && r.atMs < b.endMs);
      return { xAxis: idx, lineStyle: { type: r.estimated ? 'dashed' : 'solid', color: r.estimated ? '#999' : '#d9534f' }, label: { show: false } };
    });
    const series: unknown[] = [...bars];
    const showCum = mode === 'cumulative' || cum.some((c) => c.cycleKnown);

    // 周期の帯（リセットからリセットまで）。日単位なら、日付を毎日出し、その下に周期の何日目かを添える。
    const dayMode = showCum && isDayBuckets(data.buckets);
    const bands = showCum ? layoutBands(data.buckets, data.cycles) : [];
    const dayNo: (number | null)[] = data.buckets.map(() => null);
    for (const b of bands) for (let i = b.from; i < b.to; i++) dayNo[i] = b.firstDayNo + (i - b.from);
    const firstOfMonth = (i: number) => i === 0 || new Date(data.buckets[i]!.startMs).toLocaleString('en-US', { timeZone: zone, day: 'numeric' }) === '1';
    // 1段目: 日、2段目: 周期の何日目か、3段目: 月（月初と左端だけ。隣の日付とぶつからないよう別の段に出す）
    const axisText = (i: number) => {
      const d = new Date(data.buckets[i]!.startMs);
      const month = firstOfMonth(i) ? d.toLocaleString(formatLocale(), { timeZone: zone, month: 'short' }) : '';
      return `${d.toLocaleString('en-US', { timeZone: zone, day: 'numeric' })}\n{n|${dayNo[i] ?? ' '}}${month ? `\n{m|${month}}` : ''}`;
    };
    const bandAreas = bands.map((b, k) => {
      // 見出しは帯の幅に収める。開始日は、周期の頭が画面に見えているときだけ添える。
      const days = t('tl.cycleDays', { n: b.cells });
      const text = b.early ? t('tl.cycleEarly', { n: b.cells }) : b.firstDayNo === 1 && b.to - b.from >= 5 ? `${labels[b.from]}〜 ${days}` : days;
      const fill = b.early ? 'rgba(217,83,79,0.14)' : k % 2 === 0 ? 'rgba(90,120,180,0.10)' : 'rgba(90,120,180,0.02)';
      return [
        {
          xAxis: b.from - 0.5,
          name: text,
          itemStyle: { color: fill, borderType: b.estimated ? 'dashed' : 'solid', borderColor: b.early ? 'rgba(217,83,79,0.7)' : 'rgba(120,130,150,0.55)', borderWidth: 1 },
          label: { show: true, position: 'insideTop', formatter: text, fontSize: 10, color: b.early ? '#d9534f' : '#667', fontWeight: b.early ? 'bold' : 'normal' },
        },
        { xAxis: b.to - 0.5 },
      ];
    });
    if (showCum) {
      series.push(
        {
          name: t('cal.prior'),
          type: 'bar',
          stack: 'c',
          xAxisIndex: 1,
          yAxisIndex: 1,
          itemStyle: { color: '#9fc2ef' },
          data: cum.map((c, i) => (data.buckets[i]!.future || !c.cycleKnown ? null : { value: c.prior, itemStyle: c.cycleEstimated ? { decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: 0.8 } } : undefined })),
        },
        {
          name: t('cal.increment'),
          type: 'bar',
          stack: 'c',
          xAxisIndex: 1,
          yAxisIndex: 1,
          itemStyle: { color: '#2f6fd0' },
          data: cum.map((c, i) => (data.buckets[i]!.future || !c.cycleKnown ? null : c.increment)),
          markLine: { symbol: 'none', data: resetLines, silent: true },
          markArea: { silent: true, data: bandAreas },
        },
      );
      if (data.buckets.some((b) => b.overlayCumulative)) {
        series.push({
          name: t('tl.overlay'),
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 2,
          showSymbol: false,
          lineStyle: { type: 'dotted', width: 2 },
          data: data.buckets.map((b) => (b.future || !b.overlayCumulative?.cycleKnown ? null : b.overlayCumulative.cumulative)),
        });
      }
    }
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmt(v) : '—'),
      },
      legend: { type: 'scroll', top: 0 },
      grid: showCum
        ? [
            { left: 64, right: 56, top: 32, height: '36%' },
            { left: 64, right: 56, top: '56%', height: dayMode ? '28%' : '34%' },
          ]
        : [{ left: 64, right: 24, top: 32, bottom: 56 }],
      xAxis: showCum
        ? [
            { type: 'category', data: labels, gridIndex: 0, axisLabel: { show: false } },
            dayMode
              ? {
                  type: 'category',
                  data: labels,
                  gridIndex: 1,
                  // 約120日までは全部の日付を出す。それより長いときは自動で間引く。
                  axisLabel: {
                    interval: data.buckets.length <= 120 ? 0 : 'auto',
                    fontSize: 10,
                    margin: 6,
                    formatter: (_v: string, i: number) => axisText(i),
                    rich: { n: { fontSize: 9, color: '#8a93a6', lineHeight: 14 }, m: { fontSize: 9, color: '#555', fontWeight: 'bold', lineHeight: 14 } },
                  },
                }
              : { type: 'category', data: labels, gridIndex: 1 },
          ]
        : [{ type: 'category', data: labels }],
      yAxis: showCum
        ? [
            { type: 'value', gridIndex: 0, name: t('tl.bars'), axisLabel: { formatter: fmt } },
            { type: 'value', gridIndex: 1, name: t('tl.cumulative'), axisLabel: { formatter: fmt } },
            { type: 'value', gridIndex: 1, position: 'right', axisLabel: { formatter: fmt }, splitLine: { show: false } },
          ]
        : [{ type: 'value', axisLabel: { formatter: fmt } }],
      dataZoom: [
        { type: 'inside', xAxisIndex: showCum ? [0, 1] : [0] },
        { type: 'slider', xAxisIndex: showCum ? [0, 1] : [0], height: 18, bottom: 4 },
      ],
      series,
    };
  }, [data, measure, mode, money, zone, t]);
  return (
    <EChart
      option={option}
      className="chart tall"
      ariaLabel={t('tl.bars')}
      onClick={(p) => {
        const b = data.buckets[p.dataIndex];
        if (b && onPick) onPick(b);
      }}
    />
  );
}
