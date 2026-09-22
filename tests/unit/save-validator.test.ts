import { describe, expect, it } from 'vitest';

import { EntityType } from '../../src/game/entities/entity-types.js';
import { SAVE_FORMAT, SAVE_VERSION } from '../../src/game/save/save-format.js';
import { deserialize } from '../../src/game/save/save-serializer.js';
import {
  MAX_ENTITIES,
  MAX_REASONS,
  SaveValidationError,
  validateSaveFile,
} from '../../src/game/save/save-validator.js';

import { factorySimulation, sampleSave } from '../fixtures/saves.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * A corpus of malformed and malicious saves. C26 tasks 3, 4 and 6.
 *
 * > A truncated file, a file with an unknown item id, a file with a
 * > 10⁹-length array, and a file with `__proto__` keys are each rejected with
 * > a clear reason and zero state mutation.
 *
 * Every case here is a save that parses as JSON and is then wrong in exactly
 * one way, because that is the shape of the bug this protects against: a file
 * that is obviously rubbish is caught by `JSON.parse`, and a file that is
 * *almost* a save is the one that gets four fields into a load before it
 * throws. Truncation happens to the bytes rather than to the document and is
 * tested where the bytes are, in `export-import.test.ts`.
 *
 * "Zero state mutation" is structural rather than asserted case by case: the
 * validator is a pure function with no game in scope, and `deserialize` builds
 * a fresh `Simulation` (C24). `save-controller.test.ts` is where the *flow* is
 * checked against a world that is actually running.
 *
 * ## How a case is written
 *
 * Paths, not casts. A save is deep, mostly optional to TypeScript and edited
 * here in ways the format forbids — so a test that navigated it by property
 * would be a page of `as unknown as` per case. `broken('state.player.facing',
 * 9)` says what the file is wrong about and nothing else.
 */

/** A real save of a world with one of everything, as `JSON.parse` returns it. */
function valid(): unknown {
  return JSON.parse(JSON.stringify(sampleSave('Corpus', factorySimulation())));
}

/** Walk a dotted path. Numeric segments index arrays. */
function get(root: unknown, path: string): unknown {
  let at: unknown = root;
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object') throw new Error(`the corpus has no ${path}.`);
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function set(root: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) throw new Error('an empty path.');
  const parent = keys.length === 0 ? root : get(root, keys.join('.'));
  if (parent === null || typeof parent !== 'object') throw new Error(`the corpus has no ${path}.`);
  (parent as Record<string, unknown>)[last] = value;
}

/** A valid save with one or more things wrong with it. */
function broken(...edits: readonly (readonly [path: string, value: unknown])[]): unknown {
  const save = valid();
  for (const [path, value] of edits) set(save, path, value);
  return save;
}

function refuse(save: unknown): SaveValidationError {
  try {
    validateSaveFile(save);
  } catch (error) {
    if (error instanceof SaveValidationError) return error;
    throw error;
  }
  throw new Error('the save was accepted.');
}

/** Every reason, as one string to match a case's own complaint against. */
function reason(save: unknown): string {
  return refuse(save).reasons.join(' | ');
}

/** The path to the first entity of a kind, so a case can spoil it. */
function entityPath(save: unknown, type: EntityType): string {
  const entities = get(save, 'state.entities');
  if (!Array.isArray(entities)) throw new Error('the corpus has no entities.');
  const index = entities.findIndex((entity: unknown) => get(entity, 'type') === type);
  if (index < 0) throw new Error(`the corpus has no entity of type ${type}.`);
  return `state.entities.${index}`;
}

/** The runtime number the corpus gave an item. */
function itemId(save: unknown, stringId: string): number {
  return get(save, `state.itemIdMap.${stringId}`) as number;
}

describe('a save this build wrote', () => {
  it('is accepted, and comes back equal', () => {
    const save = sampleSave('Corpus', factorySimulation());
    expect(validateSaveFile(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it('is rebuilt rather than handed back', () => {
    const parsed = valid();
    const validated = validateSaveFile(parsed);
    expect(validated).not.toBe(parsed);
    expect(validated.state).not.toBe(get(parsed, 'state'));
    expect(validated.state.entities).not.toBe(get(parsed, 'state.entities'));
  });

  it('drops a field nobody validated', () => {
    // The point of constructing field by field (task 4): a save with an extra
    // key loads without it, rather than carrying it into the game.
    const validated = validateSaveFile(broken(['trailer', { anything: 'at all' }], ['state.trailer', 7]));
    expect('trailer' in validated).toBe(false);
    expect('trailer' in validated.state).toBe(false);
  });

  it('keeps a field an entity carries that this file has never heard of', () => {
    // The other side of the same rule: an entity's fields are whatever its
    // chunk gave it, so they are checked rather than listed.
    const path = entityPath(valid(), EntityType.Belt);
    const validated = validateSaveFile(broken([`${path}.futureField`, 12]));
    const belt = validated.state.entities.find((entity) => entity.type === EntityType.Belt);
    expect(belt?.['futureField']).toBe(12);
  });

  it('still loads into a world after being validated', () => {
    const validated = validateSaveFile(valid());
    const simulation = deserialize(validated.state, { worldGenerator: () => createPlaygroundGenerator() });
    expect(simulation.getTick()).toBe(validated.state.tick);
    expect(simulation.entities.size).toBe(validated.state.entities.length);
  });
});

describe('the wrapper', () => {
  it.each([
    ['null', null],
    ['a string', 'ironflow-save'],
    ['a number', 42],
    ['an array', []],
  ])('refuses %s', (_label, value) => {
    expect(reason(value)).toMatch(/not an object/);
  });

  it('refuses a document with another format', () => {
    expect(reason(broken(['format', 'factorio-blueprint']))).toMatch(/not an IronFlow save/);
  });

  it('refuses a save from a future schema version', () => {
    expect(reason(broken(['version', SAVE_VERSION + 1]))).toMatch(new RegExp(`schema version ${SAVE_VERSION + 1}`));
  });

  it('accepts the version and format it writes', () => {
    expect(validateSaveFile(valid()).version).toBe(SAVE_VERSION);
    expect(validateSaveFile(valid()).format).toBe(SAVE_FORMAT);
  });

  it('refuses metadata that is not metadata', () => {
    expect(reason(broken(['metadata.playtimeTicks', -5]))).toMatch(/playtimeTicks/);
    expect(reason(broken(['metadata.name', 7]))).toMatch(/save name/);
    expect(reason(broken(['metadata.thumbnail', { src: 'x' }]))).toMatch(/thumbnail/);
  });
});

describe('prototype pollution', () => {
  it('refuses a polluting key at the root', () => {
    const save = JSON.parse(`{"__proto__": {"polluted": true}, "format": "${SAVE_FORMAT}"}`);
    expect(reason(save)).toMatch(/"__proto__" key/);
  });

  it('refuses one inside an entity', () => {
    const save = valid();
    const path = entityPath(save, EntityType.Chest);
    const entity = JSON.stringify(get(save, path));
    set(save, path, JSON.parse(`${entity.slice(0, -1)}, "__proto__": {"x": 1}}`));
    expect(reason(save)).toMatch(/"__proto__" key/);
  });

  it('refuses one in the item id table', () => {
    expect(reason(broken(['state.itemIdMap', JSON.parse('{"iron_ore": 1, "constructor": 2}')]))).toMatch(
      /"constructor" key/,
    );
  });

  it('leaves Object.prototype alone either way', () => {
    const save = JSON.parse('{"__proto__": {"pwned": true}}');
    expect(() => validateSaveFile(save)).toThrow(SaveValidationError);
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
  });
});

describe('ids this build does not have', () => {
  it('refuses an unknown item id in a container', () => {
    const chest = entityPath(valid(), EntityType.Chest);
    expect(reason(broken([`${chest}.contents`, [[9999, 1]]]))).toMatch(/item 9999, which this build has no item for/);
  });

  it('refuses an item number whose name this build has dropped', () => {
    // The mapping reserves numbers for deleted content (see `item-registry`),
    // so a save may *name* an item nobody has — and may not put one in a
    // chest, because nothing could ever look it up again.
    const chest = entityPath(valid(), EntityType.Chest);
    expect(
      reason(broken(['state.itemIdMap.unobtainium', 900], [`${chest}.contents`, [[900, 3]]])),
    ).toMatch(/item 900, which this build has no item for/);
  });

  it('accepts a mapping that names an item this build has dropped', () => {
    expect(validateSaveFile(broken(['state.itemIdMap.unobtainium', 900])).state.itemIdMap['unobtainium']).toBe(900);
  });

  it('refuses an unknown item in the player bag', () => {
    expect(reason(broken(['state.player.inventory', [[4242, 1]]]))).toMatch(/4242/);
  });

  it('refuses an unknown item in an inserter hand', () => {
    const inserter = entityPath(valid(), EntityType.Inserter);
    expect(reason(broken([`${inserter}.heldItem`, 4242]))).toMatch(/item 4242/);
  });

  it('refuses an unknown item on a belt', () => {
    const belt = entityPath(valid(), EntityType.Belt);
    expect(reason(broken([`${belt}.items`, [{ itemId: 4242, pos: 100 }]]))).toMatch(/item 4242/);
  });

  it('refuses an item id table that gives two items one number', () => {
    const save = valid();
    expect(reason(broken(['state.itemIdMap.coal', itemId(save, 'iron_ore')]))).toMatch(/the id \d+/);
  });

  it('refuses an unknown recipe on a machine', () => {
    const furnace = entityPath(valid(), EntityType.Furnace);
    expect(reason(broken([`${furnace}.recipe`, 'antimatter']))).toMatch(
      /"antimatter", which this build has no recipe for/,
    );
  });

  it('refuses an unknown technology anywhere in the research state', () => {
    expect(reason(broken(['state.research.queue', ['time_travel']]))).toMatch(/time_travel/);
    expect(reason(broken(['state.research.unlocked', ['time_travel']]))).toMatch(/time_travel/);
    expect(reason(broken(['state.research.progress', [['time_travel', 4]]]))).toMatch(/time_travel/);
  });

  it('refuses an unknown recipe in the craft queue', () => {
    expect(
      reason(broken(['state.player.crafts', [{ recipe: 'antimatter', remaining: 1, progressTicks: 0 }]])),
    ).toMatch(/antimatter/);
  });

  it('refuses an unknown entity type', () => {
    expect(reason(broken(['state.entities.0.type', 97]))).toMatch(/type 97/);
  });

  it('refuses a generator version from the future', () => {
    const save = valid();
    const version = get(save, 'state.generatorVersion') as number;
    expect(reason(broken(['state.generatorVersion', version + 1]))).toMatch(/generatorVersion/);
  });
});

describe('numbers that are not numbers', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a fraction', 4.5],
    ['a string', '12'],
    ['-0', -0],
  ])('refuses %s as a coordinate', (_label, value) => {
    expect(reason(broken(['state.entities.0.x', value]))).toMatch(/the x of entity/);
  });

  it('refuses a coordinate outside the world', () => {
    expect(reason(broken(['state.entities.0.x', 40_000]))).toMatch(/outside/);
  });

  it('refuses a rotation that is not a quarter-turn', () => {
    expect(reason(broken(['state.entities.0.rotation', 7]))).toMatch(/rotation/);
  });

  it('refuses a non-finite rng position', () => {
    expect(reason(broken(['state.rngPosition', Number.NaN]))).toMatch(/rngPosition/);
  });

  it('refuses a negative tick count', () => {
    expect(reason(broken(['state.tick', -1]))).toMatch(/tick/);
  });

  it('refuses a player standing off the packable world', () => {
    expect(reason(broken(['state.player.subX', 1e12]))).toMatch(/subX/);
  });

  it('refuses a count that is not a count', () => {
    const chest = entityPath(valid(), EntityType.Chest);
    for (const count of [0, -4, 1.5]) {
      expect(reason(broken([`${chest}.contents`, [[1, count]]]))).toMatch(/a count in|an item id in/);
    }
  });

  it('refuses a non-finite number in a field no chunk has written yet', () => {
    expect(reason(broken(['state.entities.0.futureField', Number.POSITIVE_INFINITY]))).toMatch(/futureField/);
  });
});

describe('capacities', () => {
  it('refuses a chest holding more than its slots', () => {
    const save = valid();
    const chest = entityPath(save, EntityType.Chest);
    expect(reason(broken([`${chest}.contents`, [[itemId(save, 'iron_ore'), 1_000_000]]]))).toMatch(
      /needs \d+ slots of \d+/,
    );
  });

  it('refuses a furnace buffer above its ceiling', () => {
    const save = valid();
    const furnace = entityPath(save, EntityType.Furnace);
    expect(reason(broken([`${furnace}.input`, [[itemId(save, 'iron_ore'), 100_000]]]))).toMatch(/that buffer holds/);
  });

  it('refuses an inventory that lists an item twice', () => {
    const save = valid();
    const chest = entityPath(save, EntityType.Chest);
    const id = itemId(save, 'iron_plate');
    expect(
      reason(broken([`${chest}.contents`, [[id, 2], [id, 3]]])),
    ).toMatch(/must ascend and never repeat/);
  });

  it('refuses a craft queue longer than the player can hold', () => {
    const orders = Array.from({ length: 40 }, () => ({ recipe: 'make_gear', remaining: 1, progressTicks: 0 }));
    expect(reason(broken(['state.player.crafts', orders]))).toMatch(/craft queue/);
  });
});

describe('arrays', () => {
  /** A 10⁹-length array that costs nothing to make. Sparse, and still an array. */
  function huge(): unknown[] {
    const array: unknown[] = [];
    array.length = 1_000_000_000;
    return array;
  }

  it('refuses a 10⁹-length entity list', () => {
    expect(reason(broken(['state.entities', huge()]))).toMatch(
      new RegExp(`1000000000 entries; the limit is ${MAX_ENTITIES}`),
    );
  });

  it('refuses a 10⁹-length array inside an entity', () => {
    const belt = entityPath(valid(), EntityType.Belt);
    expect(reason(broken([`${belt}.items`, huge()]))).toMatch(/the limit is/);
  });

  it('refuses a 10⁹-length explored set', () => {
    expect(reason(broken(['state.exploredChunks', huge()]))).toMatch(/the limit is/);
  });

  it('refuses a research queue that is not an array', () => {
    expect(reason(broken(['state.research.queue', 'mining_1']))).toMatch(/not an array/);
  });

  it('refuses a nest deeper than a save may go', () => {
    let nest: Record<string, unknown> = {};
    const root = nest;
    for (let depth = 0; depth < 20; depth++) {
      const next: Record<string, unknown> = {};
      nest['inner'] = next;
      nest = next;
    }
    expect(reason(broken(['state.entities.0.deep', root]))).toMatch(/nests more than/);
  });
});

describe('entity identity and occupancy', () => {
  it('refuses an id at or above the next id', () => {
    const save = valid();
    expect(reason(broken(['state.nextEntityId', get(save, 'state.entities.0.id')]))).toMatch(
      /at or above the saved next id/,
    );
  });

  it('refuses ids that do not ascend', () => {
    const save = valid();
    const entities = get(save, 'state.entities') as unknown[];
    set(save, 'state.entities', [entities[1], entities[0], ...entities.slice(2)]);
    expect(reason(save)).toMatch(/must ascend and never repeat/);
  });

  it('refuses two entities on one tile', () => {
    const save = valid();
    expect(
      reason(
        broken(
          ['state.entities.1.x', get(save, 'state.entities.0.x')],
          ['state.entities.1.y', get(save, 'state.entities.0.y')],
        ),
      ),
    ).toMatch(/already occupies/);
  });

  it('refuses a building whose footprint leaves the world', () => {
    // A 2×2 miner anchored on the last tile has three tiles nothing can name.
    const miner = entityPath(valid(), EntityType.Miner);
    expect(reason(broken([`${miner}.x`, 32767], [`${miner}.y`, 32767]))).toMatch(/reaches past the edge of the world/);
  });
});

describe('the world', () => {
  it('refuses an explored key that is not one', () => {
    expect(reason(broken(['state.exploredChunks', [-4]]))).toMatch(/explored/);
    expect(reason(broken(['state.exploredChunks', [2 ** 40]]))).toMatch(/not a world-chunk key/);
  });

  it('refuses explored keys out of order', () => {
    expect(reason(broken(['state.exploredChunks', [100, 10]]))).toMatch(/must ascend/);
  });

  it('refuses a delta whose lists disagree', () => {
    const empty = { at: [], to: [] };
    expect(
      reason(
        broken(['state.chunkDeltas', [{ cx: 0, cy: 0, terrain: { at: [0, 1], to: [0] }, resource: empty, amount: empty }]]),
      ),
    ).toMatch(/2 indexes and 1 values/);
  });

  it('refuses a delta index outside the world chunk', () => {
    const empty = { at: [], to: [] };
    expect(
      reason(
        broken(['state.chunkDeltas', [{ cx: 0, cy: 0, terrain: { at: [5000], to: [0] }, resource: empty, amount: empty }]]),
      ),
    ).toMatch(/outside 0\.\./);
  });

  it('refuses a terrain value that is not a terrain type', () => {
    const empty = { at: [], to: [] };
    expect(
      reason(
        broken(['state.chunkDeltas', [{ cx: 0, cy: 0, terrain: { at: [0], to: [99] }, resource: empty, amount: empty }]]),
      ),
    ).toMatch(/not a terrain type/);
  });

  it('refuses a resource amount a world chunk could not store', () => {
    const empty = { at: [], to: [] };
    expect(
      reason(
        broken(['state.chunkDeltas', [{ cx: 0, cy: 0, terrain: empty, resource: empty, amount: { at: [0], to: [70000] } }]]),
      ),
    ).toMatch(/amounts of world chunk/);
  });

  it('refuses the same world chunk twice', () => {
    const empty = { at: [], to: [] };
    const delta = { cx: 1, cy: 1, terrain: empty, resource: empty, amount: empty };
    expect(reason(broken(['state.chunkDeltas', [delta, delta]]))).toMatch(/twice/);
  });
});

describe('the message', () => {
  it('lists every independent problem it found', () => {
    const error = refuse(
      broken(['format', 'nope'], ['state.research.queue', ['time_travel']], ['state.player.facing', 9]),
    );
    expect(error.reasons.length).toBeGreaterThanOrEqual(3);
    expect(error.message).toMatch(/refused for \d+ reasons/);
  });

  it('stops listing before the message becomes a wall', () => {
    const edits: (readonly [string, unknown])[] = [
      ['format', 7],
      ['version', 'one'],
      ['metadata', null],
    ];
    for (const key of ['player', 'entities', 'chunkDeltas', 'exploredChunks', 'research']) {
      edits.push([`state.${key}`, 'broken']);
    }
    expect(refuse(broken(...edits)).reasons.length).toBeLessThanOrEqual(MAX_REASONS + 1);
  });

  it('says what is wrong in words a player could act on', () => {
    expect(refuse(broken(['state.research.queue', ['time_travel']])).message).toMatch(
      /technology "time_travel", which this build does not have/,
    );
  });

  it('never says the state could not be read on top of the reason why', () => {
    expect(refuse(broken(['state.research.queue', ['time_travel']])).reasons).toHaveLength(1);
  });
});
