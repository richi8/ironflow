/**
 * Lets Node run the project's TypeScript directly. Support for `tools/`, only.
 *
 * `src/**` is written the way the ES module specification wants it — every
 * relative import names `./thing.js`, the file that will exist after a build —
 * and Vite rewrites those back to `.ts` when it serves or bundles them. Node
 * does not: with `--experimental-transform-types` it will compile a `.ts` file
 * it is *given*, but a `./thing.js` specifier inside it still resolves to
 * `thing.js` and fails.
 *
 * `module.registerHooks` is the smallest fix: try the specifier as written,
 * and if nothing is there, try it with a `.ts` extension. It is registered
 * only for the dev tools under `tools/`; nothing in `src/` or `tests/` loads
 * it, because Vite and Vitest both already do this themselves.
 *
 * The alternative was a dependency — `tsx` or `ts-node` — for twenty lines of
 * work, which §3's dependency policy exists to refuse.
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || !specifier.endsWith('.js')) return nextResolve(specifier, context);

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
