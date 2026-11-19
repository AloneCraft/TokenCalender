import { describe, expect, it } from 'vitest';
import { splitByPlan } from '../../src/core/quota/planRuns.ts';

const o = (planType: string | null, id: number) => ({ planType, id });

describe('推定に使う観測は、プランが同じ連続した範囲ごとに分ける', () => {
  it('プランが変わった所で分かれ、最後の範囲が現在のプランになる', () => {
    const runs = splitByPlan([o('plus', 1), o('plus', 2), o('pro', 3), o('pro', 4)]);
    expect(runs.map((r) => [r.plan, r.obs.map((x) => x.id)])).toEqual([['plus', [1, 2]], ['pro', [3, 4]]]);
  });
  it('プランの記録が無い観測は、続いている範囲に含める（分けない）', () => {
    const runs = splitByPlan([o(null, 1), o('pro', 2), o(null, 3), o('pro', 4)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.plan).toBe('pro');
    expect(runs[0]!.obs).toHaveLength(4);
  });
  it('観測が1件でも1つの範囲になる。プランが同じなら分けない', () => {
    expect(splitByPlan([o('pro', 1)])).toHaveLength(1);
    expect(splitByPlan([o('pro', 1), o('pro', 2)])).toHaveLength(1);
  });
  it('元のプランに戻った場合も、別の範囲として数える', () => {
    expect(splitByPlan([o('pro', 1), o('plus', 2), o('pro', 3)]).map((r) => r.plan)).toEqual(['pro', 'plus', 'pro']);
  });
});
