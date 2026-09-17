import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import {
  NO_RECIPE,
  RecipeRegistry,
  type RecipeDefinition,
} from '../../src/game/registries/recipe-registry.js';
import { TPS } from '../../src/game/simulation-clock.js';

/**
 * The recipe table. See ironflow.md C15 task 1 and §15.
 *
 * Two things are under test and only one of them is the class. The other is
 * the **content**: §15's smelting rows are the anchors every rate in the game
 * is derived from, so a typo in `data/recipes.ts` is a balance bug that the
 * acceptance chain would report as "the numbers are 6% out" three chunks later.
 */

const items = new ItemRegistry(ITEMS);

const SMELT_IRON: RecipeDefinition = {
  id: 'smelt_iron',
  inputs: [{ itemId: 'iron_ore', count: 1 }],
  outputs: [{ itemId: 'iron_plate', count: 1 }],
  seconds: 3.2,
  category: 'smelting',
};

function registry(...definitions: RecipeDefinition[]): RecipeRegistry {
  return new RecipeRegistry(definitions, items);
}

describe('RecipeRegistry', () => {
  it('converts seconds to whole ticks once, at build time (§6 R3)', () => {
    const recipe = registry(SMELT_IRON).get('smelt_iron');
    expect(recipe.durationTicks).toBe(96);
    expect(recipe.durationTicks).toBe(Math.round(3.2 * TPS));
    expect(Number.isInteger(recipe.durationTicks)).toBe(true);
  });

  it('resolves string item ids to runtime ids, so no system looks one up per tick', () => {
    const recipe = registry(SMELT_IRON).get('smelt_iron');
    expect(recipe.inputs).toEqual([{ itemId: items.idOf('iron_ore'), count: 1 }]);
    expect(recipe.outputs).toEqual([{ itemId: items.idOf('iron_plate'), count: 1 }]);
  });

  it('numbers recipes from 1, leaving 0 as NO_RECIPE', () => {
    const built = registry(SMELT_IRON, { ...SMELT_IRON, id: 'other' });
    expect(built.get('smelt_iron').recipeId).toBe(1);
    expect(built.get('other').recipeId).toBe(2);
    expect(built.isRecipeId(NO_RECIPE)).toBe(false);
    expect(built.isRecipeId(1)).toBe(true);
    expect(built.isRecipeId(3)).toBe(false);
    expect(() => built.byId(NO_RECIPE)).toThrow(/no recipe has runtime id 0/);
  });

  it('answers what an ingredient selects, for a machine choosing its own recipe', () => {
    const built = registry(SMELT_IRON);
    expect(built.forInput('smelting', items.idOf('iron_ore'))?.id).toBe('smelt_iron');
    expect(built.forInput('smelting', items.idOf('coal'))).toBeNull();
    // Right item, wrong machine.
    expect(built.forInput('crafting', items.idOf('iron_ore'))).toBeNull();
    expect(built.acceptsInput('smelting', items.idOf('iron_ore'))).toBe(true);
    expect(built.acceptsInput('smelting', items.idOf('coal'))).toBe(false);
  });

  it('refuses to guess when two recipes in a category want the same ingredient', () => {
    const built = registry(SMELT_IRON, {
      ...SMELT_IRON,
      id: 'smelt_iron_slowly',
      outputs: [{ itemId: 'steel', count: 1 }],
    });
    // Ambiguous, so nothing is auto-selected — but the item is still accepted,
    // because a player-chosen recipe (C16) may well want it.
    expect(built.forInput('smelting', items.idOf('iron_ore'))).toBeNull();
    expect(built.acceptsInput('smelting', items.idOf('iron_ore'))).toBe(true);
  });

  it('groups by category, which is what a machine may run', () => {
    const built = new RecipeRegistry(RECIPES, items);
    expect(built.byCategory('smelting').map((recipe) => recipe.id)).toEqual([
      'smelt_iron',
      'smelt_copper',
      'smelt_steel',
      'bake_brick',
    ]);
    expect(built.byCategory('crafting')).toEqual([]);
  });

  it.each([
    ['an unknown item', { ...SMELT_IRON, inputs: [{ itemId: 'unobtainium', count: 1 }] }, /not an item/],
    ['no ingredients', { ...SMELT_IRON, inputs: [] }, /are empty/],
    ['no products', { ...SMELT_IRON, outputs: [] }, /are empty/],
    ['a fractional count', { ...SMELT_IRON, inputs: [{ itemId: 'iron_ore', count: 1.5 }] }, /whole and above 0/],
    ['a duration of zero', { ...SMELT_IRON, seconds: 0 }, /not a duration/],
    ['a duration under a tick', { ...SMELT_IRON, seconds: 0.001 }, /under one tick/],
    ['a category nothing runs', { ...SMELT_IRON, category: 'baking' }, /which is not one/],
    [
      'the same item in and out',
      { ...SMELT_IRON, outputs: [{ itemId: 'iron_ore', count: 2 }] },
      /both an ingredient and a product/,
    ],
    [
      'an ingredient listed twice',
      { ...SMELT_IRON, inputs: [{ itemId: 'iron_ore', count: 1 }, { itemId: 'iron_ore', count: 2 }] },
      /twice/,
    ],
  ])('refuses %s', (_name, definition, message) => {
    expect(() => registry(definition as RecipeDefinition)).toThrow(message as RegExp);
  });

  it('refuses two recipes with the same id', () => {
    expect(() => registry(SMELT_IRON, { ...SMELT_IRON, seconds: 1 })).toThrow(/share the id "smelt_iron"/);
  });
});

describe('the shipped recipe table', () => {
  const built = new RecipeRegistry(RECIPES, items);

  it('matches §15 exactly — these are the numbers every rate is derived from', () => {
    const rows = built.all().map((recipe) => ({
      id: recipe.id,
      inputs: recipe.inputs.map((stack) => `${stack.count} ${items.byId(stack.itemId).id}`),
      outputs: recipe.outputs.map((stack) => `${stack.count} ${items.byId(stack.itemId).id}`),
      ticks: recipe.durationTicks,
    }));

    expect(rows).toEqual([
      { id: 'smelt_iron', inputs: ['1 iron_ore'], outputs: ['1 iron_plate'], ticks: 96 },
      { id: 'smelt_copper', inputs: ['1 copper_ore'], outputs: ['1 copper_plate'], ticks: 96 },
      { id: 'smelt_steel', inputs: ['5 iron_plate'], outputs: ['1 steel'], ticks: 480 },
      { id: 'bake_brick', inputs: ['2 stone'], outputs: ['1 brick'], ticks: 96 },
    ]);
  });

  it('produces §15’s derived ratios', () => {
    const plate = built.get('smelt_iron');
    const steel = built.get('smelt_steel');
    // 0.3125 plates a second, which is the number §15 derives 1.6 furnaces per
    // miner and 3.2 furnaces per inserter from.
    expect(TPS / plate.durationTicks).toBeCloseTo(0.3125, 6);
    // "1 plate furnace feeds 1.0 steel furnace exactly": five plates take five
    // times 96 ticks to make, and a steel takes 480.
    expect(steel.durationTicks).toBe(5 * plate.durationTicks);
  });

  it('lets every smelting ingredient pick its own recipe, so a furnace never needs telling', () => {
    for (const recipe of built.byCategory('smelting')) {
      for (const input of recipe.inputs) {
        expect(built.forInput('smelting', input.itemId)?.id).toBe(recipe.id);
      }
    }
  });
});
