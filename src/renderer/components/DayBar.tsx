// 日付マスの縦棒（SVG）。重いチャートを日数分作らないための軽量描画。
// 色だけに頼らず、推定周期は斜線、未取得は網掛けで示す。

import type { DayCell } from '../../shared/api.ts';
import { colorFor } from '../format.ts';

const H = 56;
const W = 18;

export function BarDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <pattern id="hatch-est" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="var(--bar-prior)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--surface)" strokeWidth="1.5" />
        </pattern>
        <pattern id="hatch-nodata" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--nodata)" strokeWidth="1.5" />
        </pattern>
      </defs>
    </svg>
  );
}

export function DayBar({ cell, mode, max, dimKeys }: { cell: DayCell; mode: 'daily' | 'cumulative'; max: number; dimKeys: string[] }) {
  if (cell.future) return <svg width={W} height={H} aria-hidden="true" />;
  if (cell.noData) {
    return (
      <svg width={W} height={H} aria-hidden="true">
        <rect x="1" y={H - 14} width={W - 2} height="14" fill="url(#hatch-nodata)" stroke="var(--nodata)" strokeDasharray="2 2" />
      </svg>
    );
  }
  const scale = (v: number) => (max > 0 ? Math.max(v > 0 ? 1.5 : 0, (v / max) * (H - 2)) : 0);
  if (mode === 'cumulative') {
    const c = cell.cumulative;
    if (!c.cycleKnown || c.cumulative == null) {
      return (
        <svg width={W} height={H} aria-hidden="true">
          <line x1="2" y1={H - 1} x2={W - 2} y2={H - 1} stroke="var(--text-3)" strokeDasharray="2 2" />
        </svg>
      );
    }
    const hp = scale(c.prior ?? 0);
    const hi = scale(c.increment ?? 0);
    return (
      <svg width={W} height={H} aria-hidden="true">
        <rect x="2" y={H - hp} width={W - 4} height={hp} fill={c.cycleEstimated ? 'url(#hatch-est)' : 'var(--bar-prior)'} />
        <rect x="2" y={H - hp - hi} width={W - 4} height={hi} fill="var(--bar-inc)" strokeDasharray={c.cycleEstimated ? '2 1' : undefined} stroke={c.cycleEstimated ? 'var(--text-2)' : 'none'} />
      </svg>
    );
  }
  // 日別: 内訳を積み上げる
  let y = H;
  const parts = dimKeys.length > 0 ? dimKeys : Object.keys(cell.byDim);
  return (
    <svg width={W} height={H} aria-hidden="true">
      {parts.map((k, i) => {
        const v = cell.byDim[k] ?? 0;
        if (v <= 0) return null;
        const h = scale(v);
        y -= h;
        return <rect key={k} x="2" y={y} width={W - 4} height={h} fill={colorFor(k, i)} />;
      })}
    </svg>
  );
}
