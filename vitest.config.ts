import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately.
 *
 * `sim` runs in a plain Node process with no DOM and no bundler magic. Every
 * test of `src/game/**` lives here, which is what keeps the §4 dependency rule
 * ("could this run with `document` deleted?") continuously enforced rather than
 * merely documented.
 *
 * `dom` runs in jsdom and is only for UI code and for the architecture test
 * that proves `src/game/**` does not touch the DOM even when a DOM exists.
 *
 * Benchmarks (C18 task 7) live in `tests/bench/` and run under `npm run bench`,
 * never under `npm test`: a benchmark's result depends on the machine, so
 * asserting on one would make the suite fail for reasons that have nothing to
 * do with the code. `tests/bench/baseline.json` is what makes a regression
 * *visible* — `npm run bench:compare` prints the change against it.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'sim',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/determinism/**/*.test.ts'],
          exclude: ['tests/**/*.dom.test.ts'],
          benchmark: { include: ['tests/bench/**/*.bench.ts'] },
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/**/*.dom.test.ts'],
          // The benchmarks belong to `sim` alone. Left to default, this
          // project would pick them up too and run every case a second time
          // under jsdom — twice the wall time, and two projects racing to
          // write the same baseline file.
          benchmark: { include: [] },
        },
      },
    ],
  },
});
