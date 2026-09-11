import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The two blocks that matter are the last two.
 *
 * They turn the §4 dependency rules and the §6 R1 determinism rule from prose
 * in ironflow.md into something that fails the build. Everything above them is
 * ordinary hygiene.
 */

/** Layers the simulation core is forbidden to reach into (ironflow.md §4). */
const FORBIDDEN_LAYERS = ['renderer', 'ui', 'input', 'persistence', 'debug', 'platform'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  /* ---------------------------------------------------------------------- *
   * §4 — the simulation core may not know the browser exists.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/game/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FORBIDDEN_LAYERS.flatMap((l) => [`**/${l}`, `**/${l}/**`]).concat(['**/main', '**/main.ts']),
              message:
                'ironflow.md §4: src/game/** must not import renderer, ui, input, persistence, debug or platform code. ' +
                'Depend on an injected interface instead, and wire it up in main.ts.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'document',
          'window',
          'navigator',
          'location',
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'HTMLCanvasElement',
          'CanvasRenderingContext2D',
          'Image',
          'fetch',
        ].map((name) => ({
          name,
          message: `ironflow.md §4: "${name}" is a browser API and must not appear in src/game/**. Inject a dependency instead.`,
        })),
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'ironflow.md §6 R2: use the seeded PRNG from game/rng.ts. Math.random breaks determinism.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'ironflow.md §6 R1: wall-clock time is not authoritative state. Use the tick counter.',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'ironflow.md §6 R1: wall-clock time is not authoritative state. Inject a clock if you need timing.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'ironflow.md §6 R1: no wall-clock time in the simulation core.',
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- *
   * §4 — the renderer reads simulation state; it never writes to it.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ui', '**/ui/**', '**/persistence', '**/persistence/**'],
              message: 'ironflow.md §4: the renderer must not depend on UI or persistence code.',
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- *
   * §4 — input produces intent. It may name commands and tile space, and it
   * may not reach into the renderer, the UI or the simulation's internals.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/input/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer', '**/renderer/**', '**/ui', '**/ui/**', '**/persistence', '**/persistence/**', '**/debug', '**/debug/**'],
              message:
                'ironflow.md §4: src/input/** must not import renderer, ui, persistence or debug code. ' +
                'Declare the interface the input layer needs and let main.ts wire an implementation to it.',
            },
          ],
        },
      ],
    },
  },

  /* Tests and config files legitimately touch everything. */
  {
    files: ['tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
);
