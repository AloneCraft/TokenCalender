// 数値の割合を、図で見せる小さな部品（輪と棒）。動きは CSS の transition と animation で付ける。
// 色だけに頼らないよう、状態は図記号と形（はみ出し・目盛り線）でも示す。

export type Tone = 'ok' | 'warn' | 'danger' | 'info';

const clamp = (v: number): number => Math.max(0, Math.min(100, v));

/** 輪のゲージ。value は 0〜100。中央に子要素（数値など）を置く。 */
export function RingGauge({ value, tone, children, label }: { value: number; tone: Tone; children?: React.ReactNode; label: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const v = clamp(value);
  return (
    <div className={`ring tone-${tone}`} role="img" aria-label={label}>
      <svg viewBox="0 0 80 80" width="76" height="76">
        <circle className="ring-bg" cx="40" cy="40" r={r} />
        <circle className="ring-fg" cx="40" cy="40" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} transform="rotate(-90 40 40)" />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/**
 * 横棒のゲージ。0〜100 の目盛りの上に、塗り（fill）・範囲（band）・目印（marks）を重ねる。
 * 100 を超える分は右端ではみ出して見えるよう、max を指定して縮尺を変えられる。
 */
export function BarGauge({
  fill,
  band,
  marks,
  max = 100,
  tone,
  label,
  over,
}: {
  fill?: number;
  band?: { low: number; high: number };
  marks?: { at: number; kind: 'line' | 'dot'; tone?: Tone }[];
  max?: number;
  tone: Tone;
  label: string;
  /** 基準線（予算など）を超えた分。基準線の位置から右に、危険色で伸ばす */
  over?: { from: number; to: number };
}) {
  const pos = (v: number): string => `${(Math.max(0, Math.min(max, v)) / max) * 100}%`;
  return (
    <div className={`bar-gauge tone-${tone}`} role="img" aria-label={label}>
      <div className="bg-track">
        {band && <div className="bg-band" style={{ left: pos(band.low), width: `${((Math.min(max, band.high) - Math.max(0, band.low)) / max) * 100}%` }} />}
        {fill != null && <div className="bg-fill" style={{ width: pos(fill) }} />}
        {over && <div className="bg-over" style={{ left: pos(over.from), width: `${((Math.min(max, over.to) - over.from) / max) * 100}%` }} />}
        {(marks ?? []).map((m, i) => (
          <div key={i} className={`bg-mark ${m.kind} tone-${m.tone ?? 'info'}`} style={{ left: pos(m.at) }} />
        ))}
      </div>
    </div>
  );
}

/**
 * 「基準との比」（×1.00 が基準）の数値と棒。対数の目盛り（×0.25〜×32）で、基準の位置に線を引く。
 * 基準以下は緑、基準の3倍まではふつう色、3倍を超えると危険色にする。
 */
export function RatioCell({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <>—</>;
  const LOW = -2;
  const SPAN = 7; // log2: -2 … 5
  const x = Math.max(0, Math.min(SPAN, Math.log2(Math.max(ratio, 1e-6)) - LOW));
  const tone: Tone = ratio <= 1.05 ? 'ok' : ratio <= 3 ? 'info' : 'danger';
  return (
    <span className="ratio-cell">
      <span className="num">×{ratio.toFixed(2)}</span>
      <span className="ratio-bar">
        <BarGauge max={SPAN} fill={x} tone={tone} marks={[{ at: -LOW, kind: 'line', tone: 'warn' }]} label={`×${ratio.toFixed(2)}`} />
      </span>
    </span>
  );
}
