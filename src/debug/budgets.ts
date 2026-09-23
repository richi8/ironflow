/**
 * §12's performance budgets, as data. See ironflow.md §12 and C28 task 5.
 *
 * One table for the two places that judge a number against them: the F3
 * overlay, which colours a row that has crossed its target or its hard-fail
 * line, and `tests/perf/`, which fails the run on a hard fail. Written out in
 * each, they would be two copies of §12 that could disagree about what "too
 * slow" means — the arrangement `palette.ts` and its test exist to prevent
 * for colours.
 *
 * Every figure is the one in §12's table, in the unit the row names. A metric
 * with no hard-fail line there has `hard: null`; one where *more* is better
 * (frames per second, entities on screen) says so with `higherIsBetter`.
 */

export interface Budget {
  /** §12's wording, for a failure message or a tooltip. */
  readonly label: string;
  readonly target: number;
  readonly hard: number | null;
  readonly unit: 'ms' | 'MB' | 'fps' | 'entities';
  readonly higherIsBetter?: boolean;
}

export const BUDGETS = Object.freeze({
  tickMean: { label: 'Simulation tick, mean', target: 8, hard: 20, unit: 'ms' },
  tickP99: { label: 'Simulation tick, p99', target: 16, hard: 33, unit: 'ms' },
  renderMean: { label: 'Render frame, mean @ 1080p', target: 8, hard: 16, unit: 'ms' },
  fps: { label: 'Sustained FPS, reference factory', target: 60, hard: 30, unit: 'fps', higherIsBetter: true },
  onScreen: {
    label: 'Entities on screen at max zoom-out',
    target: 5_000,
    hard: null,
    unit: 'entities',
    higherIsBetter: true,
  },
  heap: { label: 'JS heap, reference factory', target: 400, hard: 800, unit: 'MB' },
  serialize: { label: 'Save serialize', target: 300, hard: 1_000, unit: 'ms' },
  saveSize: { label: 'Save file size, reference factory (gzipped)', target: 2, hard: 10, unit: 'MB' },
  load: { label: 'Load + rebuildDerived', target: 1_000, hard: 3_000, unit: 'ms' },
  worldgen: { label: 'Worldgen, 40x40 world chunks', target: 500, hard: 2_000, unit: 'ms' },
  coldStart: { label: 'Cold start to interactive', target: 1_500, hard: 4_000, unit: 'ms' },
  // §12 says "none visible" and "any > 50 ms". The overlay can only see a
  // pause as a frame that took too long, so both lines are the longest frame.
  gcPause: { label: 'GC pauses during steady play', target: 50, hard: 50, unit: 'ms' },
} satisfies Record<string, Budget>);

export type BudgetName = keyof typeof BUDGETS;

/** Where a measurement stands against its budget. */
export type Verdict = 'ok' | 'over_target' | 'hard_fail';

export function judge(budget: Budget, value: number): Verdict {
  const worse = (limit: number): boolean => (budget.higherIsBetter === true ? value < limit : value > limit);
  if (budget.hard !== null && worse(budget.hard)) return 'hard_fail';
  if (worse(budget.target)) return 'over_target';
  return 'ok';
}
