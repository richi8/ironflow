import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { newBelt } from '../../src/game/entities/belt-entity.js';
import { newChest } from '../../src/game/entities/chest-entity.js';
import { newInserter } from '../../src/game/entities/inserter-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { newMiner } from '../../src/game/entities/miner-entity.js';
import type { Entity } from '../../src/game/entities/entity.js';
import { inputPortOf, outputPortOf, type PortContext } from '../../src/game/items/item-port.js';
import { openUnlocks } from '../fixtures/unlocks.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { ItemRegistry, NO_ITEM } from '../../src/game/registries/item-registry.js';
import { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';

/**
 * Item ports. See ironflow.md C15, and C14's report, which named this chunk as
 * the one that should unify them.
 *
 * The rules under test are the ones three systems used to each hold their own
 * copy of, and that a fourth (the furnace) would have made four:
 *
 * - **what a building offers** — its lowest item id, never insertion order;
 * - **what a building accepts** — decided by the building's own content, so
 *   "this machine does not take that" is never a list of ids in a system;
 * - **which direction it works in** — a miner offers and never accepts.
 */

const items = new ItemRegistry(ITEMS);
const buildings = new BuildingRegistry(BUILDINGS);
const recipes = new RecipeRegistry(RECIPES, items);
const ctx: PortContext = { buildings, items, recipes, unlocks: openUnlocks(buildings, recipes, items) };

const IRON_ORE = items.idOf('iron_ore');
const COPPER_ORE = items.idOf('copper_ore');
const COAL = items.idOf('coal');
const PLATE = items.idOf('iron_plate');
const BRICK = items.idOf('brick');

/** An entity, as the store would hand one back: init plus an id. */
function place<T>(init: T): T & Entity {
  return { id: 1, ...init } as T & Entity;
}

const chest = (): Entity => place(newChest(0, 0, NORTH));
const furnace = (): Entity => place(newMachine(EntityType.Furnace, 0, 0, NORTH));

describe('a chest', () => {
  it('works in both directions', () => {
    const entity = chest();
    expect(inputPortOf(entity, ctx)?.give(PLATE, 3)).toBe(3);
    expect(outputPortOf(entity, ctx)?.count(PLATE)).toBe(3);
    expect(outputPortOf(entity, ctx)?.take(PLATE, 2)).toBe(2);
    expect(outputPortOf(entity, ctx)?.peek()).toBe(PLATE);
  });

  it('offers its lowest item id, not the first thing put in it (§6 R4)', () => {
    const entity = chest();
    const port = inputPortOf(entity, ctx);
    port?.give(PLATE, 1);
    port?.give(IRON_ORE, 1);
    expect(outputPortOf(entity, ctx)?.peek()).toBe(Math.min(PLATE, IRON_ORE));
  });

  it('shows no per-item capacity, because it fills by running out of slots', () => {
    const entity = chest();
    inputPortOf(entity, ctx)?.give(PLATE, 5);
    expect(outputPortOf(entity, ctx)?.stacks()).toEqual([{ itemId: PLATE, count: 5, capacity: null }]);
  });
});

describe('a miner', () => {
  it('offers its buffer and accepts nothing at all', () => {
    const miner = place({ ...newMiner(0, 0, NORTH), resourceType: ResourceType.Iron, outputCount: 4 });
    const port = outputPortOf(miner, ctx);
    expect(port?.peek()).toBe(IRON_ORE);
    expect(port?.stacks()).toEqual([{ itemId: IRON_ORE, count: 4, capacity: 50 }]);
    expect(port?.take(IRON_ORE, 3)).toBe(3);
    expect(port?.count(COPPER_ORE)).toBe(0);
    // C12's `not_accepted`, and the reason it is still true: there is no port.
    expect(inputPortOf(miner, ctx)).toBeNull();
  });

  it('offers nothing when its buffer is empty', () => {
    const miner = place(newMiner(0, 0, NORTH));
    expect(outputPortOf(miner, ctx)?.peek()).toBe(NO_ITEM);
    expect(outputPortOf(miner, ctx)?.stacks()).toEqual([]);
  });
});

describe('a furnace', () => {
  it('routes fuel to the fuel buffer and ingredients to the input buffer', () => {
    const entity = furnace();
    const port = inputPortOf(entity, ctx);
    expect(port?.give(COAL, 2)).toBe(2);
    expect(port?.give(IRON_ORE, 3)).toBe(3);
    expect(port?.stacks()).toEqual([
      { itemId: IRON_ORE, count: 3, capacity: 50 },
      { itemId: COAL, count: 2, capacity: 50 },
    ]);
  });

  it('refuses an item no recipe of its category wants', () => {
    const entity = furnace();
    const port = inputPortOf(entity, ctx);
    expect(port?.spaceFor(BRICK)).toBe(0);
    expect(port?.give(BRICK, 1)).toBe(0);
    // And a plate *is* accepted, because `smelt_steel` takes five of them —
    // content decides, not a list of ids in the port.
    expect(port?.spaceFor(PLATE)).toBe(50);
  });

  it('stops accepting when the buffer is full, which is what stalls an inserter', () => {
    const entity = furnace();
    const port = inputPortOf(entity, ctx);
    expect(port?.give(IRON_ORE, 60)).toBe(50);
    expect(port?.spaceFor(IRON_ORE)).toBe(0);
  });

  it('offers only what it has made, never the ore it is about to smelt', () => {
    const entity = furnace();
    inputPortOf(entity, ctx)?.give(IRON_ORE, 5);
    inputPortOf(entity, ctx)?.give(COAL, 5);
    const out = outputPortOf(entity, ctx);
    expect(out?.peek()).toBe(NO_ITEM);
    expect(out?.count(IRON_ORE)).toBe(0);
  });
});

describe('the buildings with no port', () => {
  it('leaves a belt to the two systems that know where an item is on it (§9)', () => {
    const belt = place(newBelt(0, 0, NORTH));
    expect(outputPortOf(belt, ctx)).toBeNull();
    expect(inputPortOf(belt, ctx)).toBeNull();
  });

  it('lets the player take from an inserters hand but never put into it', () => {
    const inserter = place({ ...newInserter(0, 0, NORTH), heldItem: PLATE });
    expect(outputPortOf(inserter, ctx)?.stacks()).toEqual([{ itemId: PLATE, count: 1, capacity: 1 }]);
    expect(outputPortOf(inserter, ctx)?.take(PLATE, 1)).toBe(1);
    expect(inserter.heldItem).toBe(NO_ITEM);
    expect(inputPortOf(inserter, ctx)).toBeNull();
  });
});
