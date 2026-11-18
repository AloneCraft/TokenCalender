import { useMemo } from 'react';
import { EChart, type EChartsOption } from './EChart.tsx';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { colorFor, fmtMeasure, formatLocale } from '../format.ts';
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
    const resetLines = data.resets.map((r) => {
      const idx = data.buckets.findIndex((b) => r.atMs >= b.startMs && r.atMs < b.endMs);
      return { xAxis: idx, lineStyle: { type: r.estimated ? 'dashed' : 'solid', color: r.estimated ? '#999' : '#d9534f' }, label: { formatter: r.estimated ? t('cal.resetEstimated') : t('tl.reset'), fontSize: 10 } };
    });
    const series: unknown[] = [...bars];
    const showCum = mode === 'cumulative' || cum.some((c) => c.cycleKnown);
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
            { left: 64, right: 56, top: '56%', height: '34%' },
          ]
        : [{ left: 64, right: 24, top: 32, bottom: 56 }],
      xAxis: showCum
        ? [
            { type: 'category', data: labels, gridIndex: 0, axisLabel: { show: false } },
            { type: 'category', data: labels, gridIndex: 1 },
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
