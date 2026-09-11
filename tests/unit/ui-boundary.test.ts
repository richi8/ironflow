import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The UI boundary. See ironflow.md §4, §13 and C07's acceptance criteria.
 *
 * One of those criteria is written as a shell command:
 *
 * > `grep -r "simulation\." src/ui/` returns nothing.
 *
 * This is that grep, run by the test suite so it cannot be forgotten. It is
 * not a style check: §4 says the UI may reach `game/game-controller` and the
 * view models and nothing else, and §19 rule 8 says the UI never mutates
 * authoritative state. A panel that has a `Simulation` in its hands can break
 * both by accident, and the failure — a UI that quietly edits the game — is
 * exactly the kind that a save file preserves forever.
 *
 * The ESLint block for `src/ui/**` stops the *import*; this stops the usage,
 * including through a field, a parameter or a cast that lint cannot see.
 */

const UI_DIR = new URL('../../src/ui/', import.meta.url).pathname;

function uiSources(): { path: string; text: string }[] {
  return readdirSync(UI_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const path = join(entry.parentPath ?? UI_DIR, entry.name);
      return { path, text: readFileSync(path, 'utf8') };
    });
}

describe('src/ui boundary', () => {
  it('has UI files to check at all', () => {
    expect(uiSources().length).toBeGreaterThan(3);
  });

  it('never touches the simulation', () => {
    const offenders = uiSources().filter((file) => /\bsimulation\./i.test(file.text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('imports only the controller, the view models and plain command data', () => {
    const allowed = /^(?:\.\.\/)+game\/(?:game-controller|views\/[a-z-]+|commands\/command|items\/item-stack|registries\/building-registry)\.js$/;
    const offenders: string[] = [];

    for (const file of uiSources()) {
      for (const match of file.text.matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        // Anything inside `src/ui/` is the UI talking to itself.
        if (specifier.startsWith('./')) continue;
        if (allowed.test(specifier)) continue;
        offenders.push(`${file.path}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
