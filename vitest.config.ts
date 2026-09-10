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
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/**/*.dom.test.ts'],
        },
      },
    ],
  },
});
