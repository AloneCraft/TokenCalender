// 観測を、契約プランが同じ連続した範囲（ラン）に分ける。
// プランの記録が無い観測は、そのとき続いているランに含める（分けない）。

export function splitByPlan<T extends { planType: string | null }>(obs: T[]): { plan: string | null; obs: T[] }[] {
  const runs: { plan: string | null; obs: T[] }[] = [];
  for (const o of obs) {
    const last = runs[runs.length - 1];
    if (last && (o.planType == null || last.plan == null || o.planType === last.plan)) {
      last.obs.push(o);
      if (last.plan == null) last.plan = o.planType;
    } else runs.push({ plan: o.planType, obs: [o] });
  }
  return runs;
}

/** プランの順序（小さいほど下位）。公称の倍率は、利用者が示した 1x(plus)・5x・20x に基づく仮定。 */
export const CODEX_PLAN_ORDER = ['free', 'plus', 'prolite', 'pro'] as const;
export const CODEX_NOMINAL_MULTIPLE: Record<string, number> = { plus: 1, prolite: 5, pro: 20 };
