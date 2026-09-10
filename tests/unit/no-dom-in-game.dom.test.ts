import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The architecture test. See ironflow.md §4 and §17.
 *
 * This is one of the four tests that must never be deleted. It enforces the
 * question that decides where code lives:
 *
 *   > Could this run in a Node process with `document` deleted?
 *
 * It runs in jsdom *on purpose*. In a Node environment there is no DOM to begin
 * with, so the test would pass trivially and prove nothing. Here a DOM exists,
 * we take it away, and then require every simulation module to load anyway.
 *
 * Import-time absence is only half the story, so the source scan below also
 * catches browser and wall-clock APIs used inside function bodies, where an
 * import test would never reach. ESLint enforces the same rules; this test
 * means the rule survives someone running the suite without the linter.
 */

// This suite runs under jsdom, where `import.meta.url` has an http: origin and
// cannot be turned back into a path. Vitest runs from the project root, and the
// "finds simulation modules" test below fails loudly if that ever stops holding.
const REPO_ROOT = process.cwd();
const GAME_DIR = resolve(REPO_ROOT, 'src/game');

/** Browser APIs and nondeterminism, per §4 and §6 R1. */
const FORBIDDEN = [
  { pattern: /\bdocument\s*\./, why: '§4: the DOM is not available in the simulation core' },
  { pattern: /\bwindow\s*\./, why: '§4: the DOM is not available in the simulation core' },
  { pattern: /\bnavigator\s*\./, why: '§4: browser APIs are not available in the simulation core' },
  { pattern: /\blocalStorage\b/, why: '§4: storage belongs in the persistence layer' },
  { pattern: /\bindexedDB\b/, why: '§4: storage belongs in the persistence layer' },
  { pattern: /\brequestAnimationFrame\b/, why: '§4: inject a FrameScheduler instead' },
  { pattern: /\bgetContext\s*\(/, why: '§4: the simulation must never call Canvas APIs' },
  { pattern: /\bMath\s*\.\s*random\b/, why: '§6 R2: use the seeded PRNG from game/rng.ts' },
  { pattern: /\bDate\s*\.\s*now\b/, why: '§6 R1: wall-clock time is not authoritative state' },
  { pattern: /\bnew\s+Date\b/, why: '§6 R1: wall-clock time is not authoritative state' },
  { pattern: /\bperformance\s*\.\s*now\b/, why: '§6 R1: inject a clock instead' },
] as const;

/** Globals the simulation core must be able to live without. */
const REMOVED_GLOBALS = [
  'document',
  'window',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'HTMLCanvasElement',
  'CanvasRenderingContext2D',
] as const;

function listGameModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listGameModules(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Strip comments so prose about `document` does not fail the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const modules = listGameModules(GAME_DIR);

describe('src/game is free of the browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds simulation modules to check', () => {
    // Guards against the scan silently passing because it found nothing.
    expect(modules.length).toBeGreaterThan(0);
  });

  it('loads every simulation module with the DOM taken away', async () => {
    expect(typeof document).not.toBe('undefined'); // jsdom really is present

    for (const name of REMOVED_GLOBALS) {
      vi.stubGlobal(name, undefined);
    }

    for (const file of modules) {
      // A cache-busting query so the module is evaluated under the stubs rather
      // than served from a previous test's module registry.
      const url = `${pathToFileURL(file).href}?nodom=${Date.now()}`;
      await expect(
        import(/* @vite-ignore */ url),
        `${relative(REPO_ROOT, file)} must import without a DOM`,
      ).resolves.toBeDefined();
    }
  });

  it.each(modules.map((f) => [relative(REPO_ROOT, f), f] as const))(
    'uses no browser or wall-clock API: %s',
    (label, file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, why } of FORBIDDEN) {
        const match = pattern.exec(source);
        expect(match, `${label} uses "${match?.[0] ?? ''}" — ${why}`).toBeNull();
      }
    },
  );
});
