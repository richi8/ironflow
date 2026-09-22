import { describe, expect, it } from 'vitest';

import { deserialize } from '../../src/game/save/save-serializer.js';
import { SaveValidationError, validateSaveFile } from '../../src/game/save/save-validator.js';
import { decodeSaveFile, encodeSaveFile } from '../../src/persistence/export-import.js';
import { SaveError } from '../../src/persistence/save-repository.js';

import { forEachNumber } from '../determinism/state-hash.js';
import { factorySimulation, sampleSave } from '../fixtures/saves.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * A thousand corrupted saves, and nothing worse than a refusal. C26 task 6.
 *
 * > A fuzz test of 1,000 randomly corrupted saves produces zero crashes and
 * > zero non-finite values in game state.
 *
 * The corpus beside this file is the *known* attacks — one hand-written case
 * per rule. This is the unknown ones: it takes a real save and breaks it in a
 * random place, a thousand times, and asserts only two things, which are the
 * two the plan asks for.
 *
 * ```text
 * every outcome is one of two    a SaveValidationError, or a save that loads
 * nothing loads to NaN           every number in the loaded state is finite
 * ```
 *
 * A `TypeError` reading a property of undefined, a `RangeError` from deep
 * inside the world, an infinite loop — each is a crash, and each fails here by
 * *escaping*, without needing a case written for it. That is the whole value
 * of a fuzz test over a corpus: the corpus proves the rules, this looks for
 * the rule nobody wrote.
 *
 * Seeded, so a failure names a mutation that can be replayed rather than one
 * that happened once on a Tuesday.
 */

const CASES = 1000;
const BYTE_CASES = 120;

/** One save, parsed, ready to be spoiled a thousand different ways. */
const ORIGINAL = JSON.parse(JSON.stringify(sampleSave('Fuzz', factorySimulation())));

/** Values a mutation may drop in. Each one has broken something in the past. */
const POISON: readonly unknown[] = Object.freeze([
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  -1,
  0.5,
  1e308,
  Number.MAX_SAFE_INTEGER + 2,
  2 ** 31,
  '',
  'iron_ore',
  '__proto__',
  null,
  true,
  {},
  [],
  [[1, 1]],
  { __proto__: { polluted: true } },
  { length: 1e9 },
]);

/** Every path to a leaf in the document, so a mutation can pick one. */
function paths(value: unknown, at = '', out: string[] = []): string[] {
  if (at !== '') out.push(at);
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    // Long arrays are sampled rather than walked: a thousand belt slots would
    // drown every other path in the pool and slow the enumeration to a crawl.
    const step = Math.max(1, Math.floor(value.length / 8));
    for (let i = 0; i < value.length; i += step) paths(value[i], `${at}.${i}`, out);
    return out;
  }
  for (const key of Object.keys(value)) paths((value as Record<string, unknown>)[key], `${at}.${key}`, out);
  return out;
}

const PATHS = paths(ORIGINAL);

function get(root: unknown, path: string): unknown {
  let at: unknown = root;
  for (const key of path.split('.').filter((part) => part !== '')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Break one thing, chosen by the seed. Returns the save and what was done. */
function corrupt(random: () => number): { readonly save: unknown; readonly what: string } {
  const save = JSON.parse(JSON.stringify(ORIGINAL));
  const path = PATHS[seededInt(random, 0, PATHS.length - 1)] ?? '.format';
  const keys = path.split('.').filter((part) => part !== '');
  const last = keys.pop() ?? 'format';
  const parent = get(save, keys.join('.'));
  if (parent === null || typeof parent !== 'object') return { save, what: 'nothing' };
  const container = parent as Record<string, unknown>;

  switch (seededInt(random, 0, 3)) {
    case 0: {
      const poison = POISON[seededInt(random, 0, POISON.length - 1)];
      container[last] = poison;
      return { save, what: `${path} = ${JSON.stringify(poison) ?? String(poison)}` };
    }
    case 1: {
      delete container[last];
      return { save, what: `delete ${path}` };
    }
    case 2: {
      // Duplicate a neighbour's value onto this key: the mutation that
      // produces two entities with one id, or two items in one slot.
      const siblings = Object.keys(container);
      const donor = siblings[seededInt(random, 0, siblings.length - 1)] ?? last;
      container[last] = JSON.parse(JSON.stringify(container[donor] ?? null));
      return { save, what: `${path} = ${keys.join('.')}.${donor}` };
    }
    default: {
      if (Array.isArray(container[last])) {
        (container[last] as unknown[]).reverse();
        return { save, what: `reverse ${path}` };
      }
      container[last] = String(container[last]);
      return { save, what: `stringify ${path}` };
    }
  }
}

describe('a thousand corrupted saves', () => {
  it('are each either refused or loadable, and never anything else', () => {
    const random = createSeededRandom(0x1f10_0d5a);
    let refused = 0;
    let accepted = 0;

    for (let attempt = 0; attempt < CASES; attempt++) {
      const { save, what } = corrupt(random);

      let validated;
      try {
        validated = validateSaveFile(save);
      } catch (error) {
        // The only failure a corrupt save is allowed to produce.
        expect(error, what).toBeInstanceOf(SaveValidationError);
        expect((error as SaveValidationError).reasons.length, what).toBeGreaterThan(0);
        refused += 1;
        continue;
      }

      // It passed, so it must *work*: a validator that accepts a save the
      // loader then throws on has moved the crash rather than prevented it.
      let simulation;
      try {
        simulation = deserialize(validated.state, { worldGenerator: () => createPlaygroundGenerator() });
      } catch (cause) {
        throw new Error(`${what}: a validated save would not load — ${String(cause)}`);
      }

      forEachNumber(validated.state, (value, where) => {
        expect(Number.isFinite(value), `${what}: ${where}`).toBe(true);
      });
      expect(Number.isFinite(simulation.rng.state), what).toBe(true);
      expect(Number.isFinite(simulation.getTick()), what).toBe(true);
      accepted += 1;
    }

    // Both outcomes have to actually happen, or the test is measuring nothing:
    // all-refused would pass with a validator that refuses everything.
    expect(refused).toBeGreaterThan(CASES / 10);
    expect(accepted).toBeGreaterThan(0);
  });

  it('survive corruption of the bytes, not just of the document', async () => {
    const random = createSeededRandom(0x0b17_f11d);
    const bytes = await encodeSaveFile(sampleSave('Fuzz', factorySimulation()));

    for (let attempt = 0; attempt < BYTE_CASES; attempt++) {
      const copy = new Uint8Array(bytes);
      switch (seededInt(random, 0, 2)) {
        case 0: {
          // A flipped bit somewhere in the file.
          const at = seededInt(random, 0, copy.byteLength - 1);
          copy[at] = (copy[at] ?? 0) ^ (1 << seededInt(random, 0, 7));
          break;
        }
        case 1: {
          // Truncation: the download that stopped halfway.
          const keep = seededInt(random, 0, copy.byteLength);
          await expectRefusal(copy.slice(0, keep));
          continue;
        }
        default: {
          // A header that says something else.
          copy.set(new TextEncoder().encode('X'), seededInt(random, 0, 12));
          break;
        }
      }
      await expectRefusal(copy);
    }
  });
});

/** Decoding corrupted bytes may fail — and may only fail as a `SaveError`. */
async function expectRefusal(bytes: Uint8Array): Promise<void> {
  try {
    await decodeSaveFile(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
  }
}
