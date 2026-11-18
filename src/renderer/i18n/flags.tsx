// 言語の選択欄に出す国旗。Windows は国旗の絵文字を表示できない（「JP」のような2文字になる）ため、小さな SVG で描く。
// 縦横比はすべて 3:2 にそろえる（並べたときに揃って見えるように）。言語を足すときは FlagId と、ここに1つ足す。

import type { ReactElement } from 'react';
import type { FlagId } from '../../shared/i18n/languages.ts';

const W = 30;
const H = 20;

function Japan(): ReactElement {
  return (
    <>
      <rect width={W} height={H} fill="#fff" />
      <circle cx={W / 2} cy={H / 2} r={H * 0.3} fill="#bc002d" />
    </>
  );
}

function UnitedStates(): ReactElement {
  const stripe = H / 13;
  const cantonW = W * 0.4;
  const cantonH = stripe * 7;
  const stars: ReactElement[] = [];
  // 星は小さすぎて形が見えないため、白い点を規則的に並べる
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      stars.push(<circle key={`${r}-${c}`} cx={1.4 + c * 2.4 + (r % 2) * 1.2} cy={1.3 + r * 2.4} r={0.45} fill="#fff" />);
    }
  }
  return (
    <>
      <rect width={W} height={H} fill="#fff" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={i * 2 * stripe} width={W} height={stripe} fill="#b22234" />
      ))}
      <rect width={cantonW} height={cantonH} fill="#3c3b6e" />
      {stars}
    </>
  );
}

/** 太極旗: 白地に、赤と青の太極と、四隅の黒い卦（3本の線）。小さく描くため、卦の細かい形は省いて線の組で表す */
function SouthKorea(): ReactElement {
  const cx = W / 2;
  const cy = H / 2;
  const r = H * 0.25;
  // 3本の線の組。broken は真ん中が切れた線（陰）、solid は続いた線（陽）
  const bars = (kinds: ('solid' | 'broken')[]) =>
    kinds.map((k, i) => {
      const y = i * 1.5;
      return k === 'solid' ? (
        <rect key={i} x={0} y={y} width={5} height={0.9} fill="#000" />
      ) : (
        <g key={i}>
          <rect x={0} y={y} width={2} height={0.9} fill="#000" />
          <rect x={3} y={y} width={2} height={0.9} fill="#000" />
        </g>
      );
    });
  const trigram = (x: number, y: number, rot: number, kinds: ('solid' | 'broken')[]) => (
    <g transform={`translate(${x} ${y}) rotate(${rot} 2.5 1.05)`}>{bars(kinds)}</g>
  );
  return (
    <>
      <rect width={W} height={H} fill="#fff" />
      {/* 太極: 上が赤、下が青。S 字の境界は、半円2つで表す */}
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} A ${r / 2} ${r / 2} 0 0 1 ${cx} ${cy} A ${r / 2} ${r / 2} 0 0 0 ${cx - r} ${cy} Z`} fill="#cd2e3a" />
      <path d={`M ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx - r} ${cy} A ${r / 2} ${r / 2} 0 0 1 ${cx} ${cy} A ${r / 2} ${r / 2} 0 0 0 ${cx + r} ${cy} Z`} fill="#0047a0" />
      {trigram(3.2, 2.2, -35, ['solid', 'solid', 'solid'])}
      {trigram(W - 8.2, 2.2, 35, ['broken', 'solid', 'broken'])}
      {trigram(3.2, H - 6.2, 35, ['solid', 'broken', 'solid'])}
      {trigram(W - 8.2, H - 6.2, -35, ['broken', 'broken', 'broken'])}
    </>
  );
}

const FLAGS: Record<FlagId, () => ReactElement> = {
  jp: Japan,
  us: UnitedStates,
  kr: SouthKorea,
};

/** 国旗の絵。説明は隣の言語名が担うため、読み上げでは飛ばす（aria-hidden） */
export function Flag({ id, size = 20 }: { id: FlagId; size?: number }): ReactElement {
  const Body = FLAGS[id];
  return (
    <svg className="flag" width={(size * W) / H} height={size} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <Body />
      <rect width={W} height={H} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
    </svg>
  );
}
