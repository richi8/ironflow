import { describe, expect, it } from 'vitest';

import { EntityStore, type FootprintLookup } from '../../src/game/entities/entity-store.js';
import {
  FIRST_ENTITY_ID,
  NO_ENTITY,
  assertSerializable,
  footprintExtent,
  footprintTiles,
  isEntityId,
  type Entity,
  type EntityId,
  type Footprint,
} from '../../src/game/entities/entity.js';
import { ENTITY_TYPE_COUNT, EntityType, entityTypeName, isEntityType } from '../../src/game/entities/entity-types.js';
import { Simulation } from '../../src/game/simulation.js';
import { createCheckerboardGenerator } from '../../src/game/world/world-generator.js';
import { World } from '../../src/game/world/world.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';

/**
 * The entity store. See ironflow.md C05.
 *
 * What is being protected here is not the store's API — it is the four
 * promises the rest of the simulation gets to build on, each of which is
 * invisible until it is broken and expensive by then:
 *
 * 1. **Iteration order is id-ascending and stays that way** through any
 *    interleaving of creates and removes (§6 R4). A system that iterates in a
 *    different order after a reload produces a different factory.
 * 2. **Occupancy is exact**, on every tile of a multi-tile footprint, at every
 *    rotation. A leaked tile is a square of the map that can never be built on
 *    again, and nothing points at the placement that leaked it.
 * 3. **Removal is deferred to cleanup**, so what a system sees does not depend
 *    on which phase ran first (§8).
 * 4. **Entities are plain data.** The round trip below is the whole reason C24
 *    is cheap; the moment one entity holds a `Map`, saving stops being free.
 */

/** §15's building sizes, for the types these tests use. */
const SIZES: Readonly<Record<number, Footprint>> = {
  [EntityType.Miner]: { width: 2, height: 2 },
  [EntityType.Assembler]: { width: 3, height: 3 },
  [EntityType.Splitter]: { width: 1, height: 2 },
  [EntityType.Lab]: { width: 3, height: 2 },
};

/** Sized like the content bible where it matters, 1×1 everywhere else. */
const footprints: FootprintLookup = (type) => SIZES[type] ?? { width: 1, height: 1 };

function store(): EntityStore {
  return new EntityStore({ footprintOf: footprints });
}

function place(
  target: EntityStore,
  type: EntityType,
  x: number,
  y: number,
  rotation: Rotation = NORTH,
): Entity {
  return target.create({ type, x, y, rotation });
}

/** Ids in the order `forEach` visits them. */
function order(target: EntityStore): EntityId[] {
  const ids: EntityId[] = [];
  target.forEach((entity) => ids.push(entity.id));
  return ids;
}

function isAscending(ids: readonly number[]): boolean {
  for (let i = 1; i < ids.length; i++) {
    const previous = ids[i - 1];
    const current = ids[i];
    if (previous === undefined || current === undefined || current <= previous) return false;
  }
  return true;
}

describe('EntityType', () => {
  it('covers §15s eleven buildings and rejects anything else', () => {
    expect(ENTITY_TYPE_COUNT).toBe(11);
    expect(isEntityType(EntityType.Radar)).toBe(true);
    expect(isEntityType(ENTITY_TYPE_COUNT)).toBe(false);
    expect(isEntityType(-1)).toBe(false);
    expect(isEntityType(1.5)).toBe(false);
  });

  it('names every type, and throws rather than returning undefined', () => {
    for (let type = 0; type < ENTITY_TYPE_COUNT; type++) {
      expect(entityTypeName(type)).toMatch(/^[a-z_]+$/);
    }
    expect(() => entityTypeName(ENTITY_TYPE_COUNT)).toThrow(RangeError);
  });
});

describe('entity ids', () => {
  it('reserves 0 for "no entity", so a valid id is never falsy', () => {
    expect(NO_ENTITY).toBe(0);
    expect(FIRST_ENTITY_ID).toBe(1);
    expect(isEntityId(NO_ENTITY)).toBe(false);
    expect(isEntityId(FIRST_ENTITY_ID)).toBe(true);
    expect(isEntityId(-1)).toBe(false);
    expect(isEntityId(1.5)).toBe(false);
  });

  it('starts at the first id and counts up', () => {
    const s = store();
    expect(s.nextId).toBe(FIRST_ENTITY_ID);
    expect(place(s, EntityType.Chest, 0, 0).id).toBe(1);
    expect(place(s, EntityType.Chest, 1, 0).id).toBe(2);
    expect(s.nextId).toBe(3);
  });

  it('resumes from a restored counter, because a save carries it (§6 R5)', () => {
    const s = new EntityStore({ footprintOf: footprints, nextId: 4096 });
    expect(place(s, EntityType.Chest, 0, 0).id).toBe(4096);
  });

  it('refuses a restored counter that is not an id', () => {
    expect(() => new EntityStore({ nextId: 0 })).toThrow(RangeError);
    expect(() => new EntityStore({ nextId: -3 })).toThrow(RangeError);
  });
});

describe('EntityStore iteration order', () => {
  it('visits entities in ascending id order', () => {
    const s = store();
    for (let x = 0; x < 8; x++) place(s, EntityType.Chest, x, 0);
    expect(order(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stays strictly ascending across 20,000 creates and 5,000 removes', () => {
    const s = store();
    const created: EntityId[] = [];

    // A 200x100 block of 1x1 chests: 20,000 entities, every one on its own tile.
    for (let i = 0; i < 20_000; i++) {
      created.push(place(s, EntityType.Chest, i % 200, Math.floor(i / 200)).id);
    }
    expect(s.size).toBe(20_000);

    // Removed in an order that has nothing to do with id order, so a compaction
    // that reorders or loses an entity shows up rather than cancelling out.
    for (let i = 0; i < 5_000; i++) {
      const index = (i * 7919) % 20_000;
      const id = created[index];
      if (id !== undefined) s.remove(id);
    }
    const removed = s.cleanup();

    expect(removed.length).toBe(5_000);
    expect(isAscending(removed)).toBe(true);
    expect(s.size).toBe(15_000);

    const ids = order(s);
    expect(ids.length).toBe(15_000);
    expect(isAscending(ids)).toBe(true);
    expect(isAscending(s.byType(EntityType.Chest).map((e) => e.id))).toBe(true);

    // And creating after a compaction keeps the array ascending, rather than
    // appending an id that is lower than something still in the middle of it.
    const next = place(s, EntityType.Chest, 0, 500);
    expect(next.id).toBe(20_001);
    expect(isAscending(order(s))).toBe(true);
  });

  it('interleaves creates and removes without disturbing the order', () => {
    const s = store();
    const ids: EntityId[] = [];
    for (let round = 0; round < 50; round++) {
      ids.push(place(s, EntityType.Chest, round, 0).id);
      ids.push(place(s, EntityType.Belt, round, 1).id);
      if (round % 3 === 0) {
        const victim = ids[round];
        if (victim !== undefined) s.remove(victim);
      }
      s.cleanup();
      expect(isAscending(order(s))).toBe(true);
    }
  });

  it('does not visit an entity created during the pass that created it', () => {
    const s = store();
    place(s, EntityType.Chest, 0, 0);
    let visits = 0;
    s.forEach((entity) => {
      visits += 1;
      if (entity.x === 0) place(s, EntityType.Chest, 5, 5);
    });
    expect(visits).toBe(1);
    expect(s.size).toBe(2);
  });
});

describe('EntityStore byType', () => {
  it('returns only that type, in id order', () => {
    const s = store();
    place(s, EntityType.Belt, 0, 0);
    place(s, EntityType.Chest, 1, 0);
    place(s, EntityType.Belt, 2, 0);

    expect(s.byType(EntityType.Belt).map((e) => e.id)).toEqual([1, 3]);
    expect(s.byType(EntityType.Chest).map((e) => e.id)).toEqual([2]);
    expect(s.byType(EntityType.Lab)).toEqual([]);
  });

  it('drops removed entities from their bucket at cleanup and no sooner', () => {
    const s = store();
    const first = place(s, EntityType.Belt, 0, 0);
    place(s, EntityType.Belt, 1, 0);

    s.remove(first.id);
    expect(s.byType(EntityType.Belt).map((e) => e.id)).toEqual([1, 2]);
    s.cleanup();
    expect(s.byType(EntityType.Belt).map((e) => e.id)).toEqual([2]);
  });

  it('refuses a type that is not one', () => {
    expect(() => store().byType(ENTITY_TYPE_COUNT as EntityType)).toThrow(RangeError);
  });
});

describe('footprint geometry', () => {
  it('swaps the extent for odd rotations and leaves even ones alone', () => {
    const size: Footprint = { width: 3, height: 2 };
    expect(footprintExtent(size, NORTH)).toEqual({ width: 3, height: 2 });
    expect(footprintExtent(size, EAST)).toEqual({ width: 2, height: 3 });
    expect(footprintExtent(size, SOUTH)).toEqual({ width: 3, height: 2 });
    expect(footprintExtent(size, WEST)).toEqual({ width: 2, height: 3 });
  });

  it('anchors every rotation at the north-west tile', () => {
    for (const rotation of [NORTH, EAST, SOUTH, WEST] as const) {
      const tiles = footprintTiles(10, 4, { width: 3, height: 2 }, rotation);
      expect(tiles[0]).toEqual({ x: 10, y: 4 });
      expect(tiles.length).toBe(6);
    }
  });

  it('covers exactly the area of the footprint, with no repeats', () => {
    const tiles = footprintTiles(0, 0, { width: 3, height: 2 }, EAST);
    const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(6);
    expect(tiles.every((t) => t.x >= 0 && t.x < 2 && t.y >= 0 && t.y < 3)).toBe(true);
  });
});

describe('EntityStore occupancy', () => {
  it('answers at() on the single tile of a 1x1 entity', () => {
    const s = store();
    const chest = place(s, EntityType.Chest, 3, 4);
    expect(s.at(3, 4)).toBe(chest);
    expect(s.at(4, 4)).toBeUndefined();
    expect(s.at(3, 5)).toBeUndefined();
  });

  it('claims every tile of a 2x2, 3x3 and 3x2 footprint in all four rotations', () => {
    for (const type of [EntityType.Miner, EntityType.Assembler, EntityType.Lab]) {
      for (const rotation of [NORTH, EAST, SOUTH, WEST] as const) {
        const s = store();
        const entity = place(s, type, 10, 20, rotation);
        const expected = footprintTiles(10, 20, SIZES[type] ?? { width: 1, height: 1 }, rotation);

        for (const tile of expected) {
          expect(s.at(tile.x, tile.y), `${entityTypeName(type)} r${rotation} at ${tile.x},${tile.y}`).toBe(entity);
        }
        // And nothing outside it: one ring around the footprint must be free.
        const extent = footprintExtent(SIZES[type] ?? { width: 1, height: 1 }, rotation);
        for (let dy = -1; dy <= extent.height; dy++) {
          for (let dx = -1; dx <= extent.width; dx++) {
            const inside = dx >= 0 && dy >= 0 && dx < extent.width && dy < extent.height;
            if (inside) continue;
            expect(s.at(10 + dx, 20 + dy), `${entityTypeName(type)} r${rotation} leaked ${dx},${dy}`).toBeUndefined();
          }
        }
      }
    }
  });

  it('puts a rotated 1x2 splitter side by side rather than end to end', () => {
    const s = store();
    const splitter = place(s, EntityType.Splitter, 15, 9, EAST);
    expect(s.at(15, 9)).toBe(splitter);
    expect(s.at(16, 9)).toBe(splitter);
    expect(s.at(15, 10)).toBeUndefined();
  });

  it('works west and north of the origin, where a packed key could go wrong', () => {
    const s = store();
    const miner = place(s, EntityType.Miner, -5, -3);
    expect(s.at(-5, -3)).toBe(miner);
    expect(s.at(-4, -2)).toBe(miner);
    expect(s.at(-6, -3)).toBeUndefined();
  });

  it('refuses a placement that overlaps an existing footprint, and changes nothing', () => {
    const s = store();
    place(s, EntityType.Miner, 0, 0); // covers (0,0)..(1,1)
    const before = order(s);

    expect(() => place(s, EntityType.Chest, 1, 1)).toThrow(/occupied/);
    expect(order(s)).toEqual(before);
    // The failed create consumed no id and claimed no tile.
    expect(s.nextId).toBe(2);
    expect(s.at(2, 2)).toBeUndefined();
    expect(place(s, EntityType.Chest, 2, 2).id).toBe(2);
  });

  it('refuses a placement whose footprint would leave the packable world', () => {
    const s = store();
    expect(() => place(s, EntityType.Miner, 32767, 0)).toThrow(RangeError);
    expect(s.size).toBe(0);
  });

  it('frees every tile at cleanup, so the space is buildable again', () => {
    const s = store();
    const assembler = place(s, EntityType.Assembler, 4, 4);
    s.remove(assembler.id);

    // Still there for the rest of the tick.
    expect(s.at(6, 6)).toBe(assembler);
    s.cleanup();

    for (const tile of footprintTiles(4, 4, { width: 3, height: 3 }, NORTH)) {
      expect(s.at(tile.x, tile.y)).toBeUndefined();
    }
    expect(place(s, EntityType.Assembler, 4, 4).id).toBe(2);
  });
});

describe('EntityStore deferred removal', () => {
  it('leaves everything visible until cleanup runs', () => {
    const s = store();
    const chest = place(s, EntityType.Chest, 0, 0);

    s.remove(chest.id);
    expect(s.has(chest.id)).toBe(true);
    expect(s.get(chest.id)).toBe(chest);
    expect(s.at(0, 0)).toBe(chest);
    expect(order(s)).toEqual([chest.id]);
    expect(s.isPendingRemoval(chest.id)).toBe(true);
    expect(s.pendingRemovalCount).toBe(1);

    expect(s.cleanup()).toEqual([chest.id]);
    expect(s.has(chest.id)).toBe(false);
    expect(s.get(chest.id)).toBeUndefined();
    expect(s.at(0, 0)).toBeUndefined();
    expect(order(s)).toEqual([]);
    expect(s.pendingRemovalCount).toBe(0);
  });

  it('shows every later phase of the same tick the same thing the first one saw', () => {
    const s = store();
    const a = place(s, EntityType.Belt, 0, 0);
    place(s, EntityType.Belt, 1, 0);

    // Phase 5 removes a belt; phase 6 must still find it, or what an inserter
    // does depends on the phase order rather than on the state of the world.
    const seenByPhase5: EntityId[] = [];
    s.forEach((e) => {
      seenByPhase5.push(e.id);
      if (e.id === a.id) s.remove(e.id);
    });
    const seenByPhase6 = order(s);

    expect(seenByPhase6).toEqual(seenByPhase5);
    expect(s.cleanup()).toEqual([a.id]);
    expect(order(s)).toEqual([2]);
  });

  it('treats removing an unknown or already-marked entity as a no-op', () => {
    const s = store();
    const chest = place(s, EntityType.Chest, 0, 0);

    s.remove(9999);
    expect(s.pendingRemovalCount).toBe(0);

    s.remove(chest.id);
    s.remove(chest.id);
    expect(s.pendingRemovalCount).toBe(1);
    expect(s.cleanup()).toEqual([chest.id]);

    s.remove(chest.id);
    expect(s.cleanup()).toEqual([]);
  });

  it('never reuses an id after a removal (§6 R5)', () => {
    const s = store();
    const first = place(s, EntityType.Chest, 0, 0);
    s.remove(first.id);
    s.cleanup();

    const second = place(s, EntityType.Chest, 0, 0);
    expect(second.id).toBe(first.id + 1);
    expect(s.get(first.id)).toBeUndefined();
    expect(s.nextId).toBe(3);
  });

  it('returns a shared empty list when there is nothing to remove', () => {
    const s = store();
    place(s, EntityType.Chest, 0, 0);
    expect(s.cleanup()).toEqual([]);
    expect(s.cleanup()).toBe(s.cleanup());
  });
});

describe('entities are plain serializable data', () => {
  /** A machine-shaped entity: the kind of thing C15 will actually store. */
  interface FurnaceEntity extends Entity {
    progressTicks: number;
    readonly input: { itemId: string; count: number }[];
    recipeId: string | null;
  }

  it('round-trips through structuredClone and JSON unchanged', () => {
    const s = store();
    const furnace = s.create<FurnaceEntity>({
      type: EntityType.Furnace,
      x: -12,
      y: 7,
      rotation: WEST,
      progressTicks: 43,
      input: [{ itemId: 'iron_ore', count: 3 }],
      recipeId: 'iron_plate',
    });

    expect(structuredClone(furnace)).toEqual(furnace);
    expect(JSON.parse(JSON.stringify(furnace))).toEqual(furnace);
  });

  it('round-trips every entity in a populated store', () => {
    const s = store();
    place(s, EntityType.Miner, 0, 0);
    place(s, EntityType.Belt, 5, 5, EAST);
    place(s, EntityType.Assembler, 10, 10, SOUTH);

    s.forEach((entity) => {
      expect(structuredClone(entity)).toEqual(entity);
      expect(JSON.parse(JSON.stringify(entity))).toEqual(entity);
    });
  });

  it('refuses the field types that survive a clone and not a save', () => {
    const s = store();
    const base = { type: EntityType.Chest, x: 0, y: 0, rotation: NORTH } as const;

    expect(() => s.create({ ...base, slots: new Map() } as never)).toThrow(/plain/);
    expect(() => s.create({ ...base, seen: new Set() } as never)).toThrow(/plain/);
    expect(() => s.create({ ...base, bytes: new Uint8Array(4) } as never)).toThrow(/plain/);
    expect(() => s.create({ ...base, tick: () => 1 } as never)).toThrow(/plain data/);
    expect(() => s.create({ ...base, at: new Date(0) } as never)).toThrow(/plain/);
    expect(() => s.create({ ...base, recipe: undefined } as never)).toThrow(/undefined/);
    expect(s.size).toBe(0);
  });

  it('refuses the numbers §6 R7 bans, at any depth', () => {
    const s = store();
    const base = { type: EntityType.Chest, x: 0, y: 0, rotation: NORTH } as const;

    expect(() => s.create({ ...base, rate: Number.NaN } as never)).toThrow(/finite/);
    expect(() => s.create({ ...base, rate: Infinity } as never)).toThrow(/finite/);
    expect(() => s.create({ ...base, offset: -0 } as never)).toThrow(/-0/);
    expect(() => s.create({ ...base, items: [{ x: -0 }] } as never)).toThrow(/-0/);
  });

  it('refuses a reference cycle, which a save cannot express', () => {
    const cyclic: Record<string, unknown> = { count: 1 };
    cyclic['self'] = cyclic;
    expect(() => assertSerializable(cyclic)).toThrow(/cycle/);
  });

  it('accepts the shapes an entity legitimately holds', () => {
    expect(() =>
      assertSerializable({
        id: 1,
        buffers: [{ itemId: 'coal', count: 0 }, []],
        recipeId: null,
        enabled: false,
        label: '',
      }),
    ).not.toThrow();
  });
});

describe('EntityStore input validation', () => {
  it('refuses a type or rotation outside the enums', () => {
    const s = store();
    expect(() => s.create({ type: 99 as EntityType, x: 0, y: 0, rotation: NORTH })).toThrow(RangeError);
    expect(() => s.create({ type: EntityType.Chest, x: 0, y: 0, rotation: 4 as Rotation })).toThrow(RangeError);
  });

  it('refuses fractional tiles, which would silently collide with another tile', () => {
    const s = store();
    expect(() => s.create({ type: EntityType.Chest, x: 0.5, y: 0, rotation: NORTH })).toThrow(RangeError);
  });

  it('refuses a footprint lookup that is not whole tiles', () => {
    const broken = new EntityStore({ footprintOf: () => ({ width: 0, height: 2 }) });
    expect(() => broken.create({ type: EntityType.Chest, x: 0, y: 0, rotation: NORTH })).toThrow(RangeError);
  });
});

describe('the simulation cleanup phase', () => {
  it('applies deferred removals once per tick, and not before', () => {
    const entities = store();
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()), entities });
    const chest = place(entities, EntityType.Chest, 2, 2);

    entities.remove(chest.id);
    expect(entities.has(chest.id)).toBe(true);

    simulation.tick();

    expect(entities.has(chest.id)).toBe(false);
    expect(entities.at(2, 2)).toBeUndefined();
    expect(entities.pendingRemovalCount).toBe(0);
  });

  it('gives a simulation its own store when none is supplied', () => {
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()) });
    expect(simulation.entities.size).toBe(0);
    expect(() => simulation.tick()).not.toThrow();
  });
});
