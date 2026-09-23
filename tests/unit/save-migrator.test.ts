import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/game/save/migrations/index.js';
import { v1ToV2 } from '../../src/game/save/migrations/v1-to-v2.js';
import { SAVE_FORMAT, SAVE_VERSION } from '../../src/game/save/save-format.js';
import {
  SaveMigrationError,
  assertMigrationChain,
  migrateSave,
  type Migration,
  type SaveDocument,
} from '../../src/game/save/save-migrator.js';

/**
 * The chain, tested with a chain. See ironflow.md C27.
 *
 * The save schema has had one version, so the real registry is empty and the
 * interesting cases — three steps applied in order, a gap, a step that runs
 * twice — cannot be staged with it. They are staged with migrations written
 * here instead, which is what the `migrations` parameter on `migrateSave`
 * exists for: the machinery is what C27 builds, and machinery is testable
 * before it has any cargo.
 *
 * What the real registry gets is the two checks that matter while it is
 * empty: that it *is* a chain, and that it reaches `SAVE_VERSION`. The day
 * somebody bumps the version without writing a step, those fail.
 */

/** A save at a given version, with a crumb of state to watch move. */
function save(version: number, extra: Record<string, unknown> = {}): SaveDocument {
  return { format: SAVE_FORMAT, version, metadata: { name: 'Chain' }, state: { seed: 7, ...extra } };
}

/** A migration that appends its step to a list in the state. */
function step(from: number): Migration {
  return {
    from,
    to: from + 1,
    describe: `appended ${from} to the trail`,
    migrate: (document) => {
      const state = (document['state'] ?? {}) as Record<string, unknown>;
      const trail = Array.isArray(state['trail']) ? (state['trail'] as unknown[]) : [];
      return { ...document, state: { ...state, trail: [...trail, from] } };
    },
  };
}

const THREE: readonly Migration[] = [step(1), step(2), step(3)];

describe('a chain of migrations', () => {
  it('applies every step, in order', () => {
    const migrated = migrateSave(save(1), THREE, 4);
    expect(migrated['version']).toBe(4);
    expect((migrated['state'] as Record<string, unknown>)['trail']).toEqual([1, 2, 3]);
  });

  it('starts from the version the save claims, not from the beginning', () => {
    const migrated = migrateSave(save(3), THREE, 4);
    expect(migrated['version']).toBe(4);
    expect((migrated['state'] as Record<string, unknown>)['trail']).toEqual([3]);
  });

  it('is idempotent when re-run from its own output', () => {
    const once = migrateSave(save(1), THREE, 4);
    const twice = migrateSave(once, THREE, 4);
    expect(twice).toEqual(once);
    // The same object, in fact: a save already at the target is not copied.
    expect(twice).toBe(once);
  });

  it('leaves a current save exactly as it found it', () => {
    const current = save(4);
    expect(migrateSave(current, THREE, 4)).toBe(current);
  });

  it('sets the version itself, so a migration cannot forget to', () => {
    const forgetful: Migration = {
      from: 1,
      to: 2,
      describe: 'changed nothing and said nothing',
      migrate: (document) => document,
    };
    expect(migrateSave(save(1), [forgetful], 2)['version']).toBe(2);
  });

  it('overrules a migration that sets the wrong version', () => {
    const liar: Migration = {
      from: 1,
      to: 2,
      describe: 'claimed to be v9',
      migrate: (document) => ({ ...document, version: 9 }),
    };
    expect(migrateSave(save(1), [liar], 2)['version']).toBe(2);
  });

  it('does not mutate the document it was given', () => {
    const original = save(1);
    const before = JSON.stringify(original);
    migrateSave(original, THREE, 4);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('a chain that is not one', () => {
  it('refuses a gap', () => {
    expect(() => assertMigrationChain([step(1), step(3)], 4)).toThrow(/contiguous/);
  });

  it('refuses a duplicate step', () => {
    expect(() => assertMigrationChain([step(1), step(1)], 3)).toThrow(/contiguous/);
  });

  it('refuses a step that skips a version', () => {
    const leap: Migration = { from: 1, to: 3, describe: 'leapt', migrate: (d) => d };
    expect(() => assertMigrationChain([leap], 3)).toThrow(/a step is always one version/);
  });

  it('refuses a chain that stops short of this build', () => {
    expect(() => assertMigrationChain([step(1)], 4)).toThrow(/every version needs a step/);
  });

  it('refuses a chain that runs past this build', () => {
    expect(() => assertMigrationChain(THREE, 2)).toThrow(/above this build/);
  });

  it('refuses a version that is not one', () => {
    const wrong: Migration = { from: 0, to: 1, describe: 'from nothing', migrate: (d) => d };
    expect(() => assertMigrationChain([wrong], 2)).toThrow(/which is not one/);
  });
});

describe('a save this build cannot take', () => {
  it('refuses one from the future, clearly', () => {
    // C27 task 4. The message has to tell a player what to do, because there
    // is nothing they can do to the *file*.
    const error = attempt(() => migrateSave(save(9), THREE, 4));
    expect(error.from).toBe(9);
    expect(error.to).toBe(4);
    expect(error.message).toMatch(/schema version 9; this build reads 4\. Update IronFlow/);
  });

  it('refuses one with no usable version', () => {
    expect(attempt(() => migrateSave({ format: SAVE_FORMAT }, THREE, 4)).message).toMatch(/no usable schema version/);
    expect(attempt(() => migrateSave(save(1.5), THREE, 4)).message).toMatch(/no usable schema version/);
    expect(attempt(() => migrateSave(save(0), THREE, 4)).message).toMatch(/no usable schema version/);
  });

  it('refuses something that is not a save at all', () => {
    for (const value of [null, 'save', 42, []]) {
      expect(attempt(() => migrateSave(value, THREE, 4)).message).toMatch(/not a save file/);
    }
  });

  it('names the step that threw, rather than leaking its error', () => {
    const broken: Migration = {
      from: 1,
      to: 2,
      describe: 'renamed the ore',
      migrate: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    };
    const error = attempt(() => migrateSave(save(1), [broken], 2));
    expect(error.message).toMatch(/from v1 to v2 \(renamed the ore\)/);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('refuses a step that produced something that is not a save', () => {
    const nonsense: Migration = { from: 1, to: 2, describe: 'returned a number', migrate: () => 7 as never };
    expect(attempt(() => migrateSave(save(1), [nonsense], 2)).message).toMatch(/not a save/);
  });
});

describe('the registry this build ships', () => {
  it('is a chain that reaches the current schema version', () => {
    expect(() => assertMigrationChain(MIGRATIONS)).not.toThrow();
  });

  it('has a step for every version below the current one', () => {
    // The whole point of the check above, said in the form a reader can count:
    // v1 needs no steps, v2 needs one, v3 needs two.
    expect(MIGRATIONS.length).toBe(SAVE_VERSION - 1);
  });

  it('describes each step in words a failure message can use', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.describe.length).toBeGreaterThan(0);
      expect(migration.to).toBe(migration.from + 1);
    }
  });
});

/** Run something that must throw a `SaveMigrationError`, and hand it back. */
function attempt(run: () => unknown): SaveMigrationError {
  try {
    run();
  } catch (error) {
    if (error instanceof SaveMigrationError) return error;
    throw error;
  }
  throw new Error('nothing was thrown.');
}

describe('v1 -> v2: the hotbar layout', () => {
  it('gives a v1 save the default hotbar and keeps everything else', () => {
    const v1 = { format: 'ironflow-save', version: 1, metadata: { name: 'old', thumbnail: null }, state: { tick: 5 } };
    const v2 = v1ToV2.migrate(v1);
    expect(v2).toEqual({ ...v1, version: 2, metadata: { name: 'old', thumbnail: null, hotbar: null } });
  });

  it('leaves a malformed metadata for the validator to refuse', () => {
    expect(v1ToV2.migrate({ version: 1, metadata: 'nope' })).toEqual({ version: 2, metadata: 'nope' });
  });
});
