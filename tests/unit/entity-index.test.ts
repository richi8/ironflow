import { describe, expect, it } from 'vitest';

import { newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { newChest } from '../../src/game/entities/chest-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { newMiner } from '../../src/game/entities/miner-entity.js';
import { newUndergroundBelt, type UndergroundBeltEntity } from '../../src/game/entities/underground-belt-entity.js';
import { BELT_TILE_UNITS } from '../../src/game/entities/belt-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type TileBounds } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { EntityIndex, INDEX_CELL } from '../../src/renderer/entity-index.js';
import { describeBeltItems, describeEntities } from '../../src/renderer/entity-view.js';
import { overlapsBounds } from '../../src/renderer/layers/entity-layer.js';

/**
 * C29 — describing only what is near the screen. See ironflow.md §16 path 3.
 *
 * The whole claim is that the index changes *how much* is described and
 * never *what*: for any rectangle, the entities it hands back are exactly the
 * ones a walk over the whole store would have kept. That is tested against
 * the walk itself.
 */

function simulation(): Simulation {
  return new Simulation({ world: new World((cx, cy) => createChunk(cx, cy)) });
}

/** A scatter of one- to three-tile buildings, straddling cell edges on purpose. */
function scatter(sim: Simulation): void {
  const furnace = sim.buildings.get('furnace');
  const assembler = sim.buildings.get('assembler');
  let n = 0;
  for (let y = -70; y < 70; y += 5) {
    for (let x = -70; x < 70; x += 4) {
      n += 1;
      if (n % 4 === 0) sim.entities.create(newMachine(assembler.entityType, x, y, NORTH));
      else if (n % 4 === 1) sim.entities.create(newMachine(furnace.entityType, x, y, NORTH));
      else if (n % 4 === 2) sim.entities.create(newChest(x, y, NORTH));
      else sim.entities.create(newBelt(x, y, EAST));
    }
  }
}

const RECTANGLES: readonly TileBounds[] = [
  { minX: -10, minY: -10, maxX: 10, maxY: 10 },
  // Edges on a cell boundary, and one tile either side of one.
  { minX: INDEX_CELL - 1, minY: 0, maxX: INDEX_CELL, maxY: 3 },
  { minX: -INDEX_CELL, minY: -INDEX_CELL - 2, maxX: -INDEX_CELL + 1, maxY: -INDEX_CELL + 2 },
  { minX: -200, minY: -200, maxX: 200, maxY: 200 },
  { minX: 500, minY: 500, maxX: 510, maxY: 510 },
];

describe('EntityIndex', () => {
  it.each(RECTANGLES.map((bounds) => [JSON.stringify(bounds), bounds] as const))(
    'finds exactly what a full walk would, over %s',
    (_name, bounds) => {
      const sim = simulation();
      scatter(sim);
      const all = describeEntities(sim.entities, sim.buildings).filter((entity) => overlapsBounds(entity, bounds));
      const within = describeEntities(sim.entities, sim.buildings, 0, { within: { index: new EntityIndex(), bounds } });
      expect(within.map((entity) => entity.id).sort((a, b) => a - b)).toEqual(all.map((entity) => entity.id).sort((a, b) => a - b));
    },
  );

  it('rebuilds when something is built or removed, and not otherwise', () => {
    const sim = simulation();
    scatter(sim);
    const index = new EntityIndex();
    const bounds = RECTANGLES[0] as TileBounds;
    const count = (): number => {
      let n = 0;
      index.forEachIn(sim.entities, sim.buildings, bounds, () => (n += 1));
      return n;
    };

    const before = count();
    count();
    expect(index.rebuilds).toBe(1);

    const chest = sim.entities.create(newChest(1, 1, NORTH));
    expect(count()).toBe(before + 1);
    expect(index.rebuilds).toBe(2);

    sim.entities.remove(chest.id);
    sim.entities.cleanup();
    expect(count()).toBe(before);
    expect(index.rebuilds).toBe(3);
  });

  it('starts over for a different store — a loaded save', () => {
    const index = new EntityIndex();
    const bounds = RECTANGLES[3] as TileBounds;
    const first = simulation();
    first.entities.create(newChest(0, 0, NORTH));
    const second = simulation();
    second.entities.create(newChest(5, 5, NORTH));
    second.entities.create(newChest(6, 5, NORTH));
    const seen: number[] = [];
    index.forEachIn(first.entities, first.buildings, bounds, (entity) => seen.push(entity.x));
    index.forEachIn(second.entities, second.buildings, bounds, (entity) => seen.push(entity.x));
    expect(seen).toEqual([0, 5, 6]);
  });

  it('draws nothing for an empty rectangle', () => {
    const sim = simulation();
    scatter(sim);
    const seen: number[] = [];
    new EntityIndex().forEachIn(sim.entities, sim.buildings, { minX: 1, minY: 1, maxX: 0, maxY: 0 }, (entity) => seen.push(entity.id));
    expect(seen).toEqual([]);
  });
});

describe('belt items near the screen', () => {
  it('are the same items a full walk finds on the carriers in view', () => {
    const sim = simulation();
    const iron = sim.items.idOf('iron_ore');
    for (let x = -40; x < 40; x++) {
      const belt = sim.entities.create<BeltEntity>(newBelt(x, 0, EAST));
      belt.items.push({ itemId: iron, pos: 64 }, { itemId: iron, pos: 192 });
    }
    const bounds: TileBounds = { minX: -5, minY: -5, maxX: 5, maxY: 5 };
    const within = describeBeltItems(sim.entities, sim.buildings, sim.items, { within: { index: new EntityIndex(), bounds } });
    const all = describeBeltItems(sim.entities, sim.buildings, sim.items).filter(
      (item) => item.x + 0.5 >= bounds.minX && item.x + 0.5 < bounds.maxX + 1,
    );
    expect(within).toHaveLength(22);
    expect(within.map((item) => item.x).sort((a, b) => a - b)).toEqual(all.map((item) => item.x).sort((a, b) => a - b));
  });

  it('include a tunnel’s items at an exit in view whose entrance is not (C23)', () => {
    const sim = simulation();
    const type = sim.buildings.get('underground_belt').entityType;
    const entrance = sim.entities.create<UndergroundBeltEntity>(newUndergroundBelt(type, 0, 0, EAST));
    const exit = sim.entities.create<UndergroundBeltEntity>(newUndergroundBelt(type, 5, 0, EAST));
    entrance.link = exit.id;
    exit.link = entrance.id;
    // The lane runs six tiles; this item is in the exit's tile.
    entrance.items.push({ itemId: sim.items.idOf('coal'), pos: 5 * BELT_TILE_UNITS + 128 });

    const index = new EntityIndex();
    const exitOnly: TileBounds = { minX: 4, minY: -2, maxX: 8, maxY: 2 };
    const both: TileBounds = { minX: -2, minY: -2, maxX: 8, maxY: 2 };
    expect(describeBeltItems(sim.entities, sim.buildings, sim.items, { within: { index, bounds: exitOnly } })).toHaveLength(1);
    // Both mouths in view: described once, by the entrance.
    expect(describeBeltItems(sim.entities, sim.buildings, sim.items, { within: { index, bounds: both } })).toHaveLength(1);
    expect(describeBeltItems(sim.entities, sim.buildings, sim.items)).toHaveLength(1);
  });

  it('ignore buildings that carry nothing', () => {
    const sim = simulation();
    sim.entities.create(newMiner(0, 0, NORTH));
    expect(sim.entities.byType(EntityType.Miner)).toHaveLength(1);
    const bounds: TileBounds = { minX: -5, minY: -5, maxX: 5, maxY: 5 };
    expect(describeBeltItems(sim.entities, sim.buildings, sim.items, { within: { index: new EntityIndex(), bounds } })).toEqual([]);
  });
});
