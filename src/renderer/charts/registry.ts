// 分析用の図の登録簿。図を増やすときは、ここに定義を1つ足す。
// 各定義は「必要な問い合わせ（chartId と既定の刻み）」と「ECharts の設定を作る関数」の組。

import type { AnalysisSeries, Measure } from '../../shared/api.ts';
import type { EChartsOption } from '../components/EChart.tsx';
import { colorFor, formatLocale } from '../format.ts';

export interface ChartContext {
  measure: Measure;
  zone: string;
  fmt: (v: number) => string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export interface ChartDef {
  id: 'bars' | 'share' | 'weekday_hour' | 'cache_ratio' | 'session_size' | 'ranking';
  titleKey: string;
  defaultStepMinutes: number;
  usesDimension: boolean;
  build: (s: AnalysisSeries, c: ChartContext) => EChartsOption;
}

const timeLabel = (ms: number, zone: string, step: number) =>
  new Date(ms).toLocaleString(formatLocale(), { timeZone: zone, month: 'numeric', day: 'numeric', ...(step < 1440 ? { hour: '2-digit', minute: '2-digit' } : {}) });

export const CHARTS: ChartDef[] = [
  {
    id: 'bars',
    titleKey: 'an.chart.bars',
    defaultStepMinutes: 1440,
    usesDimension: true,
    build: (s, c) => {
      const keys = s.dimensionKeys.length ? s.dimensionKeys : ['all'];
      return {
        tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? c.fmt(v) : '—') },
        legend: { type: 'scroll', top: 0 },
        grid: { left: 64, right: 24, top: 32, bottom: 56 },
        xAxis: { type: 'category', data: s.buckets.map((b) => timeLabel(b.startMs, c.zone, 1440)) },
        yAxis: { type: 'value', axisLabel: { formatter: c.fmt } },
        dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 4 }],
        brush: { toolbox: ['lineX', 'clear'], xAxisIndex: 0 },
        toolbox: { feature: { brush: { type: ['lineX', 'clear'] } } },
        series: keys.map((k, i) => ({ name: k, type: 'bar', stack: 's', itemStyle: { color: colorFor(k, i) }, data: s.buckets.map((b) => b.byDim[k] ?? (keys.length === 1 ? b.total : 0)) })),
      };
    },
  },
  {
    id: 'share',
    titleKey: 'an.chart.share',
    defaultStepMinutes: 1440,
    usesDimension: true,
    build: (s, c) => {
      const keys = s.dimensionKeys;
      return {
        tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—') },
        legend: { type: 'scroll', top: 0 },
        grid: { left: 56, right: 24, top: 32, bottom: 56 },
        xAxis: { type: 'category', data: s.buckets.map((b) => timeLabel(b.startMs, c.zone, 1440)) },
        yAxis: { type: 'value', max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
        dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 4 }],
        series: keys.map((k, i) => ({
          name: k,
          type: 'line',
          stack: 's',
          areaStyle: {},
          showSymbol: false,
          itemStyle: { color: colorFor(k, i) },
          data: s.buckets.map((b) => (b.total > 0 ? (b.byDim[k] ?? 0) / b.total : null)),
        })),
      };
    },
  },
  {
    id: 'weekday_hour',
    titleKey: 'an.chart.weekday_hour',
    defaultStepMinutes: 60,
    usesDimension: false,
    build: (s, c) => {
      const m = s.matrix ?? [];
      const data: [number, number, number][] = [];
      let max = 0;
      m.forEach((row, d) => row.forEach((v, h) => (data.push([h, d, v]), (max = Math.max(max, v)))));
      return {
        tooltip: { formatter: (p: { value: [number, number, number] }) => c.t('an.hourTip', { wd: c.t(`wd.${p.value[1]}`), h: p.value[0], v: c.fmt(p.value[2]) }) },
        grid: { left: 40, right: 24, top: 16, bottom: 70 },
        xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => `${i}`) },
        yAxis: { type: 'category', data: [0, 1, 2, 3, 4, 5, 6].map((i) => c.t(`wd.${i}`)) },
        visualMap: { min: 0, max: max || 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 0 },
        series: [{ type: 'heatmap', data, label: { show: false } }],
      };
    },
  },
  {
    id: 'cache_ratio',
    titleKey: 'an.chart.cache_ratio',
    defaultStepMinutes: 1440,
    usesDimension: false,
    build: (s, c) => ({
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—') },
      grid: { left: 56, right: 24, top: 24, bottom: 56 },
      xAxis: { type: 'category', data: s.buckets.map((b) => timeLabel(b.startMs, c.zone, 1440)) },
      yAxis: { type: 'value', min: 0, max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 4 }],
      series: [{ type: 'line', name: c.t('an.cacheRatioName'), data: s.buckets.map((b) => (Number.isFinite(b.total) ? b.total : null)) }],
    }),
  },
  {
    id: 'session_size',
    titleKey: 'an.chart.session_size',
    defaultStepMinutes: 1440,
    usesDimension: false,
    build: (s, c) => ({
      tooltip: { trigger: 'axis' },
      grid: { left: 56, right: 24, top: 24, bottom: 56 },
      xAxis: { type: 'category', name: c.t('an.sessionTotal'), data: s.buckets.map((b) => c.fmt(b.startMs)) },
      yAxis: { type: 'value', name: c.t('an.sessionCount') },
      series: [{ type: 'bar', data: s.buckets.map((b) => b.total) }],
    }),
  },
  {
    id: 'ranking',
    titleKey: 'an.chart.ranking',
    defaultStepMinutes: 1440,
    usesDimension: true,
    build: (s, c) => ({
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => (typeof v === 'number' ? c.fmt(v) : '—') },
      grid: { left: 180, right: 24, top: 16, bottom: 24 },
      xAxis: { type: 'value', axisLabel: { formatter: c.fmt } },
      yAxis: { type: 'category', inverse: true, data: s.dimensionKeys },
      series: [{ type: 'bar', data: s.buckets.map((b) => b.total) }],
    }),
  },
];
