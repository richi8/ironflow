import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/game/save/migrations/index.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../../src/game/save/save-format.js';
import { migrateSave } from '../../src/game/save/save-migrator.js';
import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import { validateSaveFile } from '../../src/game/save/save-validator.js';
import { decodeSaveFile, encodeSaveFile } from '../../src/persistence/export-import.js';

import { forEachNumber, hashState } from '../determinism/state-hash.js';

/**
 * Every historical save still loads and still plays. See ironflow.md C27.
 *
 * > Every historical fixture save loads and plays after migration.
 *
 * `tests/fixtures/saves/v<N>.json` is a real save written by the build that
 * had schema version N, committed as a historical document and never
 * regenerated (`npm run save:fixture` refuses to overwrite one). This walks
 * whatever is in that directory, so a fixture added at the next version bump
 * is covered by the act of committing it.
 *
 * ## What a failure here means
 *
 * ```text
 * the file will not validate    the schema changed and nobody wrote the
 *                               migration — that is the point of this test
 * the world will not load       content was renamed or removed: an item id,
 *                               a recipe, a technology. The migration that
 *                               renamed it is missing
 * generatorVersion refused      worldgen changed. C27 task 3's second case:
 *                               pin the old generator or bake the terrain in,
 *                               and write down which, in the migration
 * the factory stops ticking     whatever broke is not about saves at all
 * ```
 *
 * None of those is a reason to edit the fixture. The fixture is the evidence.
 */

const FIXTURE_DIR = new URL('../fixtures/saves/', import.meta.url).pathname;

interface Fixture {
  readonly version: number;
  readonly file: string;
  readonly document: unknown;
}

function fixtures(): readonly Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => /^v\d+\.json$/.test(name))
    .map((name) => ({
      version: Number(name.slice(1, -'.json'.length)),
      file: name,
      document: JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')),
    }))
    .sort((a, b) => a.version - b.version);
}

const ALL = fixtures();

describe('the fixture set', () => {
  it('has one save per schema version this build can be handed', () => {
    // C27 task 2: "a migration without a fixture is untested by definition."
    // This is what turns that sentence into a failing test the day somebody
    // bumps SAVE_VERSION — `npm run save:fixture` is the fix.
    const versions = ALL.map((fixture) => fixture.version);
    const expected = Array.from({ length: SAVE_VERSION }, (_, index) => index + 1);
    expect(versions).toEqual(expected);
  });

  it('has a migration for every step between them', () => {
    expect(MIGRATIONS.length).toBe(SAVE_VERSION - 1);
  });

  it('holds documents that say what version they are', () => {
    for (const fixture of ALL) {
      const document = fixture.document as Record<string, unknown>;
      expect(document['format'], fixture.file).toBe(SAVE_FORMAT);
      expect(document['version'], fixture.file).toBe(fixture.version);
    }
  });
});

describe.each(ALL.map((fixture) => [fixture.file, fixture] as const))('%s', (_name, fixture) => {
  it('migrates to the current schema and validates', () => {
    const migrated = migrateSave(fixture.document);
    expect(migrated['version']).toBe(SAVE_VERSION);

    const validated = validateSaveFile(migrated);
    expect(validated.state.entities.length).toBeGreaterThan(0);
    // Not a museum piece: the fixture is a factory that was doing something.
    expect(validated.state.tick).toBeGreaterThan(0);
  });

  it('loads into a world with the generator this build ships', () => {
    // Deliberately *not* given a test generator. The fixture carries a
    // `generatorVersion`, and `deserialize` refuses one it does not recognise
    // — so this is also the tripwire for C27 task 3's second case.
    const simulation = deserialize(validateSaveFile(migrateSave(fixture.document)).state);
    expect(simulation.entities.size).toBeGreaterThan(0);
    expect(simulation.getTick()).toBeGreaterThan(0);
  });

  it('plays, and keeps every number finite', () => {
    const simulation = deserialize(validateSaveFile(migrateSave(fixture.document)).state);
    const before = simulation.getTick();
    for (let tick = 0; tick < 600; tick++) simulation.tick();

    expect(simulation.getTick()).toBe(before + 600);
    forEachNumber(serialize(simulation), (value, where) => {
      expect(Number.isFinite(value), `${fixture.file}: ${where}`).toBe(true);
    });
  });

  it('is the same factory whichever way it is loaded', () => {
    // Twice, independently: a load that depended on anything left over from
    // the last one would show up here as two different worlds.
    const first = deserialize(validateSaveFile(migrateSave(fixture.document)).state);
    const second = deserialize(validateSaveFile(migrateSave(fixture.document)).state);
    expect(hashState(second)).toBe(hashState(first));

    for (let tick = 0; tick < 300; tick++) {
      first.tick();
      second.tick();
    }
    expect(hashState(second)).toBe(hashState(first));
  });

  it('goes through the whole door: a file, decoded, migrated, validated', async () => {
    // The unit tests above call the three functions directly. This is the
    // path a player's file actually takes, and the one place migration being
    // wired into `save-codec.ts` is proved rather than assumed.
    const document = fixture.document as Record<string, unknown>;
    // The envelope carries the document's own version, which is the whole
    // point: an old file is an old file all the way down.
    const bytes = await encodeSaveFile({ ...document, version: fixture.version } as unknown as SaveFile);
    const decoded = await decodeSaveFile(bytes);
    expect(decoded.version).toBe(SAVE_VERSION);
    expect(decoded.state.entities.length).toBe(
      (((document['state'] as Record<string, unknown>)['entities'] as unknown[]) ?? []).length,
    );
  });
});
