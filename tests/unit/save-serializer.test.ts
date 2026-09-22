import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { NO_RECIPE } from '../../src/game/registries/recipe-registry.js';
import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import { SAVE_FORMAT, SAVE_VERSION } from '../../src/game/save/save-format.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { TileType } from '../../src/game/world/tile.js';
import { GENERATOR_VERSION } from '../../src/game/world/world-generator.js';
import { World, type ChunkGenerator } from '../../src/game/world/world.js';

import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * The save format and the serializer, at unit scale. C24 tasks 1–3 and 5.
 *
 * The §6 R8 round trip lives in `tests/determinism/save-round-trip.test.ts`,
 * over a five-thousand-entity factory; these are the smaller questions that a
 * whole-factory hash cannot point at when it fails — which numbers a save
 * writes as names, what a world delta actually contains, and what happens to a
 * file that says something impossible.
 */

/** A world the tests can reason about tile by tile. */
function playground(): World {
  return new World(createPlaygroundGenerator());
}

/** A simulation over that world, and the generator to load it back with. */
function sandbox(seed = 7): Simulation {
  return new Simulation({ world: playground(), seed });
}

const PLAYGROUND: ChunkGenerator = createPlaygroundGenerator();

function reload(simulation: Simulation): Simulation {
  return deserialize(serialize(simulation), { worldGenerator: () => PLAYGROUND });
}

describe('the save format', () => {
  it('states a schema version and a magic string of its own', () => {
    // §14: `version` is what C27 chains migrations against, and it is not the
    // generator version — the two describe different things and move apart.
    expect(Number.isInteger(SAVE_VERSION)).toBe(true);
    expect(SAVE_VERSION).toBeGreaterThan(0);
    expect(SAVE_FORMAT).toBe('ironflow-save');
  });
});

describe('what a save writes as a number, and what it writes as a name', () => {
  it('writes item ids as numbers, with the mapping that explains them', () => {
    const simulation = sandbox();
    simulation.player.inventory.add(simulation.items.idOf('iron_ore'), 5);

    const state = serialize(simulation);
    expect(state.itemIdMap['iron_ore']).toBe(simulation.items.idOf('iron_ore'));
    expect(state.player.inventory).toEqual([[simulation.items.idOf('iron_ore'), 5]]);
  });

  it('keeps a save loading correctly after data/items.ts is reordered', () => {
    // The bug the mapping exists to prevent: renumbering turns every existing
    // save's iron plates into copper (see `item-registry.ts`).
    const simulation = sandbox();
    simulation.player.inventory.add(simulation.items.idOf('iron_plate'), 3);
    const state = serialize(simulation);

    // The same content, declared back to front. Without the mapping, id 1
    // would now mean a different item.
    const reversed = new ItemRegistry([...ITEMS].reverse());
    expect(reversed.idOf('iron_plate')).not.toBe(simulation.items.idOf('iron_plate'));

    const loaded = deserialize(state, { worldGenerator: () => PLAYGROUND });
    expect(loaded.player.inventory.count(loaded.items.idOf('iron_plate'))).toBe(3);
  });

  it('writes a machine’s recipe as its name, and reads it back as an id', () => {
    const simulation = sandbox();
    const furnace = simulation.entities.create<MachineEntity>(newMachine(EntityType.Furnace, 0, 0, EAST));
    furnace.recipe = simulation.recipes.get('smelt_iron').recipeId;

    const state = serialize(simulation);
    expect(state.entities[0]?.['recipe']).toBe('smelt_iron');

    const loaded = reload(simulation);
    const restored = loaded.entities.byType<MachineEntity>(EntityType.Furnace)[0];
    expect(restored?.recipe).toBe(loaded.recipes.get('smelt_iron').recipeId);
  });

  it('writes an empty recipe as null rather than as zero', () => {
    const simulation = sandbox();
    simulation.entities.create<MachineEntity>(newMachine(EntityType.Furnace, 0, 0, EAST));

    expect(serialize(simulation).entities[0]?.['recipe']).toBe(null);
    const loaded = reload(simulation);
    expect(loaded.entities.byType<MachineEntity>(EntityType.Furnace)[0]?.recipe).toBe(NO_RECIPE);
  });

  it('leaves an entity that is not a machine exactly as it was', () => {
    const simulation = sandbox();
    const chest = simulation.entities.create<ChestEntity>(newChest(3, 3, NORTH));
    chest.contents = [[simulation.items.idOf('coal'), 11]];

    const state = serialize(simulation);
    expect(state.entities[0]).toEqual({ ...chest });
    expect(state.entities[0]?.['recipe']).toBeUndefined();
  });

  it('writes technologies as names, in an order data/technologies.ts cannot move', () => {
    const simulation = sandbox();
    simulation.researchSystem.grant('logistics_1');
    simulation.research.queue.push(simulation.technologies.get('smelting_2').technologyId);

    const state = serialize(simulation);
    expect(state.research.unlocked).toEqual(['logistics_1']);
    expect(state.research.queue).toEqual(['smelting_2']);

    const loaded = reload(simulation);
    expect(loaded.research.isUnlocked(loaded.technologies.get('logistics_1').technologyId)).toBe(true);
    expect(loaded.research.active).toBe(loaded.technologies.get('smelting_2').technologyId);
    // And the derived tables were rebuilt from it (§10, C24 task 4): the
    // splitter `logistics_1` grants is buildable in the loaded world too.
    expect(loaded.unlocks.isBuildingIdUnlocked('splitter')).toBe(true);
  });

  it('writes entity types as the raw numbers they are promised to stay', () => {
    const simulation = sandbox();
    simulation.entities.create<MinerEntity>(newMiner(0, 0, EAST));
    expect(serialize(simulation).entities[0]?.type).toBe(EntityType.Miner);
  });
});

describe('the world delta', () => {
  it('lists only the tiles that differ from what the generator would make', () => {
    const simulation = sandbox();
    simulation.world.consumeResource(3, 13, 4);
    simulation.world.consumeResource(4, 13, 7);

    const [delta, ...rest] = serialize(simulation).chunkDeltas;
    expect(rest).toEqual([]);
    expect(delta?.cx).toBe(0);
    expect(delta?.cy).toBe(0);
    // Two tiles mined, so two amounts changed — and nothing else did.
    expect(delta?.amount.at).toEqual([localIndex(3, 13), localIndex(4, 13)]);
    expect(delta?.amount.to).toEqual([
      simulation.world.getResourceAmount(3, 13),
      simulation.world.getResourceAmount(4, 13),
    ]);
    expect(delta?.terrain.at).toEqual([]);
    expect(delta?.resource.at).toEqual([]);
  });

  it('stores indexes and values as parallel arrays, ascending (C24 task 3)', () => {
    const simulation = sandbox();
    for (const x of [5, 2, 4, 3]) simulation.world.consumeResource(x, 13, 1);

    const delta = serialize(simulation).chunkDeltas[0];
    expect(delta?.amount.at.length).toBe(delta?.amount.to.length);
    expect([...(delta?.amount.at ?? [])].sort((a, b) => a - b)).toEqual(delta?.amount.at);
  });

  it('carries a changed terrain tile and a changed resource type separately', () => {
    const simulation = sandbox();
    simulation.world.setTile(4, 4, TileType.Water);
    simulation.world.setResource(5, 5, ResourceType.Coal, 120);

    const delta = serialize(simulation).chunkDeltas[0];
    expect(delta?.terrain.at).toEqual([localIndex(4, 4)]);
    expect(delta?.terrain.to).toEqual([TileType.Water]);
    expect(delta?.resource.at).toEqual([localIndex(5, 5)]);
    expect(delta?.resource.to).toEqual([ResourceType.Coal]);

    const loaded = reload(simulation);
    expect(loaded.world.getTile(4, 4)).toBe(TileType.Water);
    expect(loaded.world.getResource(5, 5)).toBe(ResourceType.Coal);
    expect(loaded.world.getResourceAmount(5, 5)).toBe(120);
  });

  it('restores a tile whose amount changed but whose type did not', () => {
    // The mining case, and the one a naive "write both together" delta would
    // bloat: the type comes from the regenerated world chunk, the amount from
    // the file.
    const simulation = sandbox();
    const before = simulation.world.getResource(3, 13);
    simulation.world.consumeResource(3, 13, 3);

    const loaded = reload(simulation);
    expect(loaded.world.getResource(3, 13)).toBe(before);
    expect(loaded.world.getResourceAmount(3, 13)).toBe(simulation.world.getResourceAmount(3, 13));
  });

  it('restores an exhausted tile as exhausted rather than as bare ground', () => {
    const simulation = sandbox();
    const type = simulation.world.getResource(3, 13);
    simulation.world.consumeResource(3, 13, 1_000_000);
    expect(simulation.world.getResourceAmount(3, 13)).toBe(0);

    const loaded = reload(simulation);
    expect(loaded.world.getResource(3, 13)).toBe(type);
    expect(loaded.world.getResourceAmount(3, 13)).toBe(0);
  });

  it('writes nothing at all for a world chunk that was only looked at', () => {
    const simulation = sandbox();
    simulation.world.getTile(5 * CHUNK_SIZE, 0);
    expect(simulation.world.chunkCount).toBe(1);
    expect(serialize(simulation).chunkDeltas).toEqual([]);
  });

  it('keeps a dirty world chunk dirty even when nothing in it differs any more', () => {
    // `dirty` latches and decides what the *next* save writes, so it cannot be
    // re-derived from the tiles. A world chunk mined and then restored is
    // still one the save has to carry.
    const simulation = sandbox();
    const amount = simulation.world.getResourceAmount(3, 13);
    simulation.world.consumeResource(3, 13, 3);
    simulation.world.setResource(3, 13, simulation.world.getResource(3, 13), amount);

    const [delta] = serialize(simulation).chunkDeltas;
    expect(delta?.amount.at).toEqual([]);
    expect(reload(simulation).world.getChunk(0, 0).dirty).toBe(true);
  });

  it('does not generate a world chunk by saving it', () => {
    const simulation = sandbox();
    simulation.world.consumeResource(3, 13, 1);
    const before = simulation.world.chunkCount;
    serialize(simulation);
    serialize(simulation);
    expect(simulation.world.chunkCount).toBe(before);
  });
});

describe('the player and the world around them', () => {
  it('comes back standing in the same place, facing the same way', () => {
    const simulation = sandbox();
    simulation.player.setTilePosition(6, -9);
    simulation.player.subX += 37;
    simulation.player.facing = SOUTH;
    simulation.player.setMoveIntent(-1, 1);
    simulation.player.startMining(6, -10);
    simulation.player.miningTicks = 19;

    const loaded = reload(simulation);
    expect(loaded.player.subX).toBe(simulation.player.subX);
    expect(loaded.player.subY).toBe(simulation.player.subY);
    expect(loaded.player.facing).toBe(SOUTH);
    expect(loaded.player.moveIntent).toEqual({ dx: -1, dy: 1 });
    expect(loaded.player.miningTarget).toEqual({ x: 6, y: -10 });
    expect(loaded.player.miningTicks).toBe(19);
  });

  it('comes back with the hand-craft queue in the order it was left in', () => {
    const simulation = sandbox();
    simulation.player.crafts.push(
      { recipe: simulation.recipes.get('make_gear').recipeId, remaining: 4, progressTicks: 7 },
      { recipe: simulation.recipes.get('make_belt').recipeId, remaining: 2, progressTicks: 0 },
    );

    const state = serialize(simulation);
    expect(state.player.crafts.map((order) => order.recipe)).toEqual(['make_gear', 'make_belt']);

    const loaded = reload(simulation);
    expect(loaded.player.crafts).toEqual([
      { recipe: loaded.recipes.get('make_gear').recipeId, remaining: 4, progressTicks: 7 },
      { recipe: loaded.recipes.get('make_belt').recipeId, remaining: 2, progressTicks: 0 },
    ]);
  });

  it('comes back having explored exactly what it had explored', () => {
    const simulation = sandbox();
    simulation.world.explored.revealSquare(-3, 4, 1);
    const loaded = reload(simulation);
    expect(loaded.world.explored.keysAscending()).toEqual(simulation.world.explored.keysAscending());
  });
});

describe('a save that says something impossible', () => {
  it('is refused when it was written by a different world generator', () => {
    const simulation = sandbox();
    const state = { ...serialize(simulation), generatorVersion: GENERATOR_VERSION + 1 };
    expect(() => deserialize(state)).toThrow(/world generator/);
  });

  it('is refused when it names a recipe this build does not have', () => {
    const simulation = sandbox();
    simulation.entities.create<MachineEntity>(newMachine(EntityType.Furnace, 0, 0, EAST));
    const state = serialize(simulation);
    const broken = {
      ...state,
      entities: state.entities.map((entity) => ({ ...entity, recipe: 'plutonium_plate' })),
    };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/plutonium_plate/);
  });

  it('is refused when it names a technology this build does not have', () => {
    const simulation = sandbox();
    const state = serialize(simulation);
    const broken = { ...state, research: { ...state.research, queue: ['time_travel'] } };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/time_travel/);
  });

  it('is refused when a delta names a tile outside its world chunk', () => {
    const simulation = sandbox();
    simulation.world.consumeResource(3, 13, 1);
    const state = serialize(simulation);
    const delta = state.chunkDeltas[0];
    if (delta === undefined) throw new Error('the fixture produced no delta.');
    const broken = {
      ...state,
      chunkDeltas: [{ ...delta, amount: { at: [99_999], to: [0] } }],
    };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/is not one of/);
  });

  it('is refused when a delta has more indexes than values', () => {
    const simulation = sandbox();
    simulation.world.consumeResource(3, 13, 1);
    const state = serialize(simulation);
    const delta = state.chunkDeltas[0];
    if (delta === undefined) throw new Error('the fixture produced no delta.');
    const broken = { ...state, chunkDeltas: [{ ...delta, amount: { at: [0, 1], to: [0] } }] };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/indexes and/);
  });

  it('is refused when two entities claim the same tile', () => {
    const simulation = sandbox();
    simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    const state = serialize(simulation);
    const first = state.entities[0];
    if (first === undefined) throw new Error('the fixture produced no entity.');
    const broken = { ...state, entities: [first, { ...first, id: first.id + 1 }], nextEntityId: first.id + 2 };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/already held by/);
  });

  it('is refused when an entity id is at or above the saved next id (§6 R5)', () => {
    const simulation = sandbox();
    simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    const state = { ...serialize(simulation), nextEntityId: 1 };
    expect(() => deserialize(state, { worldGenerator: () => PLAYGROUND })).toThrow(/saved next id/);
  });

  it('is refused when the entity list does not ascend by id (§6 R4)', () => {
    const simulation = sandbox();
    simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    simulation.entities.create<ChestEntity>(newChest(2, 0, NORTH));
    const state = serialize(simulation);
    const broken = { ...state, entities: [...state.entities].reverse() };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/must ascend/);
  });

  it('is refused when the player is standing between subtiles', () => {
    const simulation = sandbox();
    const state = serialize(simulation);
    const broken = { ...state, player: { ...state.player, subX: 0.5 } };
    expect(() => deserialize(broken, { worldGenerator: () => PLAYGROUND })).toThrow(/whole number/);
  });

  it('is refused when the tick count is not a count', () => {
    const simulation = sandbox();
    const state = { ...serialize(simulation), tick: -1 };
    expect(() => deserialize(state, { worldGenerator: () => PLAYGROUND })).toThrow(/tick is -1/);
  });
});

describe('the loaded world does not share memory with the saved one', () => {
  it('gives a chest its own contents array', () => {
    const simulation = sandbox();
    const chest = simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    chest.contents = [[simulation.items.idOf('coal'), 2]];

    const loaded = reload(simulation);
    const restored = loaded.entities.byType<ChestEntity>(EntityType.Chest)[0];
    if (restored === undefined) throw new Error('the chest did not come back.');
    restored.contents[0] = [restored.contents[0]?.[0] ?? 0, 99];
    expect(chest.contents[0]?.[1]).toBe(2);
  });

  it('gives a loaded world its own world chunks', () => {
    const simulation = sandbox();
    simulation.world.consumeResource(3, 13, 1);
    const loaded = reload(simulation);
    loaded.world.consumeResource(3, 13, 1);
    expect(loaded.world.getResourceAmount(3, 13)).not.toBe(simulation.world.getResourceAmount(3, 13));
  });
});
