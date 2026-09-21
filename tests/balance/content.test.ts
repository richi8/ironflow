import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';

/**
 * The content bible, checked against itself. See ironflow.md §15 and C20 task 1.
 *
 * C20's rule is that content is tuned **as a system, by re-deriving the table**
 * — so what these tests guard is not any one number but the correspondences
 * between the three tables. Before C20 there were none to guard: a building
 * was paid for in a string that no item table had heard of, and the two halves
 * could not disagree because they never met.
 *
 * Now they do. A building has an item, the item has a recipe, the recipe's
 * product is the building's cost, and the assembler is the machine that runs
 * it. Break any one link and a player is holding an item they cannot place, or
 * looking at a building they can never build again.
 *
 * ## What is deliberately *not* asserted here
 *
 * The numbers. `tests/unit/recipe-registry.test.ts` holds §15's table verbatim
 * and is where a changed duration fails; `tests/balance/ratios.test.ts` holds
 * the rates §15 derives from it. This file is about shape.
 *
 * Nor the colours: a building item's id *is* its palette token, so a building
 * added without one draws as the fallback grey — which
 * `tests/unit/sprite-atlas.test.ts` already fails on, from the renderer's side
 * of §4 where the palette lives.
 */

const items = new ItemRegistry(ITEMS);
const recipes = new RecipeRegistry(RECIPES, items);
const buildings = new BuildingRegistry(BUILDINGS);

/** The recipe whose product is `itemId`, or undefined. */
function recipeMaking(itemId: string): (typeof RECIPES)[number] | undefined {
  return RECIPES.find((recipe) => recipe.outputs.some((stack) => stack.itemId === itemId));
}

describe('every building is an item, and every building item is buildable', () => {
  it.each(BUILDINGS.map((building) => [building.id, building] as const))(
    '%s is paid for in a registered item',
    (_id, building) => {
      // §15: "buildCost is always a single stack of the building's own item".
      expect(building.buildCost).toHaveLength(1);
      const stack = building.buildCost[0];
      expect(stack?.itemId).toBe(building.id);
      expect(stack?.count).toBe(1);
      expect(items.has(building.id)).toBe(true);
      expect(items.get(building.id).category).toBe('building');
    },
  );

  it('has no building item that nothing places', () => {
    const placeable = new Set(BUILDINGS.map((building) => building.id));
    for (const item of ITEMS) {
      if (item.category !== 'building') continue;
      expect(placeable.has(item.id), `${item.id} is an item nothing can place`).toBe(true);
    }
  });

  it('lists building items in building order, so the two tables read as one', () => {
    expect(ITEMS.filter((item) => item.category === 'building').map((item) => item.id)).toEqual(
      BUILDINGS.map((building) => building.id),
    );
  });
});

describe('every item has somewhere to come from and somewhere to go', () => {
  /** Raw items come out of the ground; everything else needs a recipe. */
  it.each(ITEMS.filter((item) => item.category !== 'raw').map((item) => [item.id] as const))(
    '%s is made by exactly one recipe',
    (itemId) => {
      const made = RECIPES.filter((recipe) => recipe.outputs.some((stack) => stack.itemId === itemId));
      expect(made.map((recipe) => recipe.id)).toHaveLength(1);
    },
  );

  /**
   * The v1 dead ends, named rather than asserted away.
   *
   * **Empty since C21**, and that is the mechanism working. C20 listed `steel`
   * here — smeltable, wanted by nothing, with `make_frame` waiting on C22's
   * lab — and said "the day C22 lands, this test fails and tells whoever is
   * reading to delete the exception rather than leaving it to rot". C21's
   * electric furnace wanted three steel a chunk early, the test failed exactly
   * as advertised, and the exception is gone.
   *
   * The list stays because the next chunk to add a smeltable with no consumer
   * should have to write its name down here and say why.
   */
  const KNOWN_DEAD_ENDS: readonly string[] = [];

  it.each(ITEMS.map((item) => [item.id] as const))('%s is consumed by something, or is a known dead end', (itemId) => {
    const consumed = RECIPES.some((recipe) => recipe.inputs.some((stack) => stack.itemId === itemId));
    const placeable = buildings.has(itemId);
    const burns = items.get(itemId).fuelSeconds !== undefined;
    expect(consumed || placeable || burns || KNOWN_DEAD_ENDS.includes(itemId), itemId).toBe(true);
  });

  it('has a dead-end list with nothing stale on it', () => {
    for (const itemId of KNOWN_DEAD_ENDS) {
      expect(items.has(itemId), `${itemId} is not an item any more`).toBe(true);
      const consumed = RECIPES.some((recipe) => recipe.inputs.some((stack) => stack.itemId === itemId));
      expect(consumed, `${itemId} now has a consumer — take it off the list`).toBe(false);
    }
  });
});

describe('the building recipes run in a machine that exists', () => {
  it.each(BUILDINGS.map((building) => [building.id] as const))('%s has a crafting recipe', (buildingId) => {
    const recipe = recipeMaking(buildingId);
    expect(recipe, `nothing makes a ${buildingId}`).toBeDefined();
    expect(recipe?.category).toBe('crafting');
  });

  it('is runnable end to end: every ingredient of every recipe is itself obtainable', () => {
    // A breadth-first close over "what can I have?", starting from what comes
    // out of the ground. Anything left over is content the player can see in
    // the picker and never make — the soft-lock §15's hand-crafting note is
    // about, asked of the whole table at once rather than of one chain.
    const obtainable = new Set(ITEMS.filter((item) => item.category === 'raw').map((item) => item.id));
    for (let changed = true; changed; ) {
      changed = false;
      for (const recipe of RECIPES) {
        if (recipe.outputs.every((stack) => obtainable.has(stack.itemId))) continue;
        if (!recipe.inputs.every((stack) => obtainable.has(stack.itemId))) continue;
        for (const stack of recipe.outputs) obtainable.add(stack.itemId);
        changed = true;
      }
    }
    expect([...ITEMS].map((item) => item.id).filter((id) => !obtainable.has(id))).toEqual([]);
  });

  it('gives the assembler every building recipe, and the furnace none', () => {
    const craftable = new Set(recipes.byCategory('crafting').map((recipe) => recipe.id));
    for (const building of BUILDINGS) {
      expect(craftable.has(recipeMaking(building.id)?.id ?? ''), building.id).toBe(true);
    }
    for (const recipe of recipes.byCategory('smelting')) {
      const product = recipe.outputs[0];
      expect(buildings.has(items.byId(product?.itemId ?? 0).id), recipe.id).toBe(false);
    }
  });
});

describe('the v1 target, and how far off it is', () => {
  /**
   * §15's v1 target is 11 buildings, 13 materials and 20 recipes, and C21
   * moves it: the electric furnace is a twelfth building §15 never listed, so
   * the target is now 12 buildings and 21 recipes (see C21's deviations).
   *
   * ```text
   *            v1 target   C21 ships   waiting on
   * buildings         12          10   lab (C22), radar (C23)
   * materials         13          11   frame, data_core (C22's lab consumes them)
   * recipes           21          17   make_lab, make_radar, make_frame, make_data_core
   * ```
   *
   * The numbers are asserted so that the day C22 adds a lab, this test fails
   * and the reader is pointed at the table rather than at a comment.
   */
  it('ships exactly what C21 can ship, and the rest is accounted for', () => {
    expect(BUILDINGS).toHaveLength(10);
    expect(ITEMS.filter((item) => item.category !== 'building')).toHaveLength(11);
    expect(ITEMS.filter((item) => item.category === 'building')).toHaveLength(10);
    expect(RECIPES).toHaveLength(17);
    // 7 processing recipes + one per building.
    expect(RECIPES.filter((recipe) => !buildings.has(recipe.outputs[0]?.itemId ?? ''))).toHaveLength(7);
  });
});
