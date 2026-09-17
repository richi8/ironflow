import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * §6's rules, checked against the source. C18 tasks 2–4, and the third
 * acceptance criterion ("no `Math.random` / `Date.now` / `performance.now`
 * anywhere under `src/game/`").
 *
 * The determinism tests beside this file catch a violation the moment it
 * *changes an outcome*. That is the important half and it is not the whole
 * job: a `Date.now()` used in a log line, or a `Map` iterated somewhere that
 * happens to be insensitive today, passes every hash comparison and is a
 * time bomb the next chunk arms. This file is the other half — the rules as
 * rules, checked by reading rather than by running, in the same shape
 * `projection-boundary.test.ts` checks §5.
 *
 * ## Why it exists when the lint config says the same thing
 *
 * `eslint.config.js` restricts these globals and properties inside
 * `src/game/**`, and that is the first line of defence. It is also a file
 * anyone can edit, one `eslint-disable` comment can silence, and one that does
 * not run under `npm test`. A violation should fail the *suite* and name the
 * rule it broke, so the two overlap on purpose: the lint rule catches it while
 * you type, this catches it if the lint rule is turned off.
 *
 * ## The three rules, and their scopes
 *
 * ```text
 * R1  no ambient nondeterminism          all of src/game/**
 * R3  no float accumulation of time      all of src/game/**
 * R4  no Map/Set iteration               the per-tick code: systems/ and
 *                                        simulation.ts
 * ```
 *
 * R4 is deliberately the narrow one, because the rule itself is: "Never
 * iterate a `Map` or `Set` **inside a simulation system**." A registry sorting
 * its keys once at startup, or `World.forEachLoadedChunk` sorting them before
 * a save, is the *fix* for R4 rather than a breach of it — and a check that
 * could not tell the two apart would be a check nobody could keep green.
 */

const REPO_ROOT = process.cwd();
const GAME_DIR = resolve(REPO_ROOT, 'src/game');

/** Per-tick code: what R4 is actually about. */
const TICK_DIRS = [resolve(GAME_DIR, 'systems')];
const TICK_FILES = [resolve(GAME_DIR, 'simulation.ts')];

interface Rule {
  readonly pattern: RegExp;
  readonly why: string;
}

/** §6 R1 and R3. Checked against every file under `src/game/`. */
const CORE_RULES: readonly Rule[] = [
  {
    pattern: /\bMath\s*\.\s*random\b/,
    why: '§6 R1/R2: randomness comes from the seeded PRNG in game/rng.ts, never from Math.random',
  },
  {
    pattern: /\bDate\s*\.\s*now\b|\bnew\s+Date\b/,
    why: '§6 R1: wall-clock time is not authoritative state — count ticks',
  },
  {
    pattern: /\bperformance\s*\.\s*now\b/,
    why: '§6 R1: the simulation may not read a clock; inject one if presentation needs timing',
  },
  {
    pattern: /\bcrypto\s*\./,
    why: '§6 R1: crypto.getRandomValues is ambient nondeterminism',
  },
  {
    pattern: /\bnavigator\s*\./,
    why: '§6 R1: navigator.* varies by machine, which is the definition of non-deterministic',
  },
  {
    pattern: /\bIntl\s*\.|\.toLocale[A-Z]\w*\(|\.localeCompare\(/,
    why: '§6 R1: locale-sensitive formatting and sorting differ between machines',
  },
  {
    // §6 R3's own example, written out: `machine.progress += dt`.
    pattern: /[+\-*/]=\s*\w*\bdt\b|\bdt\b\s*[*+]|\bdeltaTime\b/,
    why: '§6 R3: progress is counted in integer ticks and never accumulated from a float delta',
  },
];

/** §6 R4. Checked against the per-tick code only — see the file header. */
const TICK_RULES: readonly Rule[] = [
  {
    pattern: /\bObject\s*\.\s*(keys|values|entries)\s*\(/,
    why: '§6 R4: object key order is insertion order, which differs after a load — iterate an id-ordered array',
  },
  {
    pattern: /\.\s*(keys|values|entries)\s*\(\s*\)/,
    why: '§6 R4: a Map/Set iterates in insertion order, which differs after a load — iterate an id-ordered array',
  },
];

/** Strip comments, so prose explaining a rule does not trip it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function listTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTypeScript(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const gameFiles = listTypeScript(GAME_DIR);
const tickFiles = [...TICK_DIRS.flatMap(listTypeScript), ...TICK_FILES].sort();

function check(file: string, rules: readonly Rule[]): void {
  const label = relative(REPO_ROOT, file);
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const { pattern, why } of rules) {
    const match = pattern.exec(source);
    expect(match, `${label} contains "${match?.[0] ?? ''}" — ${why}`).toBeNull();
  }
}

describe('§6 R1 and R3: the simulation core has no ambient nondeterminism', () => {
  it('finds source files to check', () => {
    expect(gameFiles.length).toBeGreaterThan(20);
  });

  it.each(gameFiles.map((f) => [relative(REPO_ROOT, f), f] as const))('%s', (_label, file) => {
    check(file, CORE_RULES);
  });
});

describe('§6 R4: the per-tick code iterates arrays, never maps', () => {
  it('finds the per-tick files, so the scope is not a typo', () => {
    // The systems directory plus `simulation.ts`. If a chunk moves a system
    // out of that directory this drops silently, so the count is asserted.
    expect(tickFiles.length).toBeGreaterThanOrEqual(8);
    expect(tickFiles.some((f) => f.endsWith('simulation.ts'))).toBe(true);
  });

  it.each(tickFiles.map((f) => [relative(REPO_ROOT, f), f] as const))('%s', (_label, file) => {
    check(file, TICK_RULES);
  });
});

describe('the rules themselves', () => {
  it('match what they claim to match', () => {
    // A guard on the guards: a regex that matched nothing would let every file
    // through and this whole suite would be a very thorough way of passing.
    const samples: readonly [string, RegExp][] = [
      ['const r = Math.random();', CORE_RULES[0]?.pattern ?? /$^/],
      ['const t = Date.now();', CORE_RULES[1]?.pattern ?? /$^/],
      ['const t = performance.now();', CORE_RULES[2]?.pattern ?? /$^/],
      ['crypto.getRandomValues(buf);', CORE_RULES[3]?.pattern ?? /$^/],
      ['const ua = navigator.userAgent;', CORE_RULES[4]?.pattern ?? /$^/],
      ['names.sort((a, b) => a.localeCompare(b));', CORE_RULES[5]?.pattern ?? /$^/],
      ['machine.progress += dt;', CORE_RULES[6]?.pattern ?? /$^/],
      ['for (const k of Object.keys(map)) {}', TICK_RULES[0]?.pattern ?? /$^/],
      ['for (const k of map.keys()) {}', TICK_RULES[1]?.pattern ?? /$^/],
    ];
    for (const [sample, pattern] of samples) {
      expect(pattern.test(sample), `"${sample}" should be caught by ${String(pattern)}`).toBe(true);
    }
  });

  it('does not match the shapes that are fine', () => {
    const allowed = [
      'const value = map.get(id);',
      'for (let i = 0; i < entities.length; i++) {}',
      'this.pending.has(entity.id);',
      'const ticksPerItem = Math.round(TPS / itemsPerSecond);',
      'const width = extent.width;',
    ];
    for (const sample of allowed) {
      for (const { pattern } of [...CORE_RULES, ...TICK_RULES]) {
        expect(pattern.test(sample), `"${sample}" tripped ${String(pattern)}`).toBe(false);
      }
    }
  });
});
