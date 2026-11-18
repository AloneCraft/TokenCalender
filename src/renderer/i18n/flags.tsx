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

/** 五芒星の頂点（中心 cx,cy、外側の半径 r、回転 rot 度。0 度で上向き） */
function starPoints(cx: number, cy: number, r: number, rot = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = r * (i % 2 === 0 ? 1 : 0.382);
    const a = ((rot + i * 36 - 90) * Math.PI) / 180;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** 五星紅旗: 赤地に、左上の大きな黄色い星と、それを囲む4つの小さな星 */
function China(): ReactElement {
  return (
    <>
      <rect width={W} height={H} fill="#de2910" />
      <polygon points={starPoints(5, 5, 3)} fill="#ffde00" />
      <polygon points={starPoints(10, 2, 1, 20)} fill="#ffde00" />
      <polygon points={starPoints(12, 4, 1, 45)} fill="#ffde00" />
      <polygon points={starPoints(12, 7, 1, 20)} fill="#ffde00" />
      <polygon points={starPoints(10, 9, 1, 0)} fill="#ffde00" />
    </>
  );
}

/** 青天白日満地紅旗: 赤地、左上の青い四角に、白い太陽（円と12本の光） */
function Taiwan(): ReactElement {
  const rays: ReactElement[] = [];
  for (let i = 0; i < 12; i++) {
    rays.push(<rect key={i} x={7.5 - 0.5} y={5 - 4} width={1} height={2} fill="#fff" transform={`rotate(${i * 30} 7.5 5)`} />);
  }
  return (
    <>
      <rect width={W} height={H} fill="#fe0000" />
      <rect width={W / 2} height={H / 2} fill="#000095" />
      {rays}
      <circle cx={7.5} cy={5} r={2.6} fill="#000095" />
      <circle cx={7.5} cy={5} r={2.2} fill="#fff" />
    </>
  );
}

/** スペイン: 赤・黄・赤の横線（1:2:1）。国章は小さすぎるため省く */
function Spain(): ReactElement {
  return (
    <>
      <rect width={W} height={H} fill="#aa151b" />
      <rect y={H / 4} width={W} height={H / 2} fill="#f1bf00" />
    </>
  );
}

/** ブラジル: 緑地に黄色い菱形、青い円と白い帯 */
function Brazil(): ReactElement {
  const cx = W / 2;
  const cy = H / 2;
  return (
    <>
      <rect width={W} height={H} fill="#009c3b" />
      <polygon points={`${cx},1.6 ${W - 2.6},${cy} ${cx},${H - 1.6} 2.6,${cy}`} fill="#ffdf00" />
      <circle cx={cx} cy={cy} r={4.2} fill="#002776" />
      <path d={`M ${cx - 4.1} ${cy - 0.6} Q ${cx} ${cy - 2.4} ${cx + 4.1} ${cy + 0.9}`} stroke="#fff" strokeWidth={0.9} fill="none" />
    </>
  );
}

function France(): ReactElement {
  return (
    <>
      <rect width={W} height={H} fill="#fff" />
      <rect width={W / 3} height={H} fill="#0055a4" />
      <rect x={(W * 2) / 3} width={W / 3} height={H} fill="#ef4135" />
    </>
  );
}

function Germany(): ReactElement {
  return (
    <>
      <rect width={W} height={H / 3} fill="#000" />
      <rect y={H / 3} width={W} height={H / 3} fill="#dd0000" />
      <rect y={(H * 2) / 3} width={W} height={H / 3} fill="#ffce00" />
    </>
  );
}

function Russia(): ReactElement {
  return (
    <>
      <rect width={W} height={H / 3} fill="#fff" />
      <rect y={H / 3} width={W} height={H / 3} fill="#0039a6" />
      <rect y={(H * 2) / 3} width={W} height={H / 3} fill="#d52b1e" />
    </>
  );
}

function Ukraine(): ReactElement {
  return (
    <>
      <rect width={W} height={H / 2} fill="#0057b7" />
      <rect y={H / 2} width={W} height={H / 2} fill="#ffd700" />
    </>
  );
}

const FLAGS: Record<FlagId, () => ReactElement> = {
  jp: Japan,
  us: UnitedStates,
  kr: SouthKorea,
  cn: China,
  tw: Taiwan,
  es: Spain,
  br: Brazil,
  fr: France,
  de: Germany,
  ru: Russia,
  ua: Ukraine,
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
