import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, HeatmapChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
  BrushComponent,
  ToolboxComponent,
  AriaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
  BrushComponent,
  ToolboxComponent,
  AriaComponent,
  CanvasRenderer,
]);

export type EChartsOption = echarts.EChartsCoreOption;

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** ECharts の薄い包み。高 DPI では devicePixelRatio に合わせて描く。 */
export function EChart({ option, className, onClick, ariaLabel }: { option: EChartsOption; className?: string; onClick?: (p: { dataIndex: number; seriesName?: string }) => void; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, isDark() ? 'dark' : undefined, { renderer: 'canvas', devicePixelRatio: window.devicePixelRatio });
    chart.current = c;
    c.on('click', (p) => clickRef.current?.({ dataIndex: (p as { dataIndex: number }).dataIndex, seriesName: (p as { seriesName?: string }).seriesName }));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption({ backgroundColor: 'transparent', aria: { enabled: true, label: { description: ariaLabel } }, ...option }, true);
  }, [option, ariaLabel]);

  return <div ref={ref} className={className ?? 'chart'} role="img" aria-label={ariaLabel} />;
}
