import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { TECHNOLOGIES } from '../../src/game/data/technologies.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';
import { TechnologyRegistry } from '../../src/game/registries/technology-registry.js';
import {
  Unlocks,
  computeUnlocks,
  recipeForBuilding,
  type UnlockContext,
} from '../../src/game/research/unlocks.js';

/**
 * Unlock application. See ironflow.md C22 task 6 and §10.
 *
 * > Unlock application is a pure function over research state so it is
 * > trivially rebuilt on load (derived, §10).
 *
 * Two properties carry that sentence and both are asserted below: the answer
 * depends on **nothing but** the set of completed technologies, and asking
 * twice gives the same answer (C22's test line: "unlock application
 * idempotence"). Everything else in this file is the content rule the tables
 * are built on — locked is the exception, and a building brings its recipe.
 */

const items = new ItemRegistry(ITEMS);
const recipes = new RecipeRegistry(RECIPES, items);
const buildings = new BuildingRegistry(BUILDINGS);
const technologies = new TechnologyRegistry(TECHNOLOGIES, items, {
  hasBuilding: (id) => buildings.has(id),
  hasRecipe: (id) => recipes.has(id),
  recipeForBuilding: (id) => recipeForBuilding({ buildings, recipes, items }, id)?.id ?? null,
});

const ctx: UnlockContext = { technologies, buildings, recipes, items };

/** `computeUnlocks`'s parameter, from a list of technology string ids. */
function done(...ids: readonly string[]): (id: number) => boolean {
  const set = new Set(ids.map((id) => technologies.get(id).technologyId));
  return (id) => set.has(id);
}

function recipeUnlocked(tables: { readonly recipes: readonly boolean[] }, id: string): boolean {
  return tables.recipes[recipes.get(id).recipeId] ?? false;
}

describe('computeUnlocks', () => {
  it('locks exactly what the tree claims, and nothing else', () => {
    const tables = computeUnlocks(ctx, done());

    // Claimed by a technology: locked until it is done.
    expect(tables.buildings[EntityType.Splitter]).toBe(false);
    expect(tables.buildings[EntityType.ElectricFurnace]).toBe(false);
    expect(tables.buildings[EntityType.Miner2]).toBe(false);
    expect(tables.buildings[EntityType.Assembler2]).toBe(false);
    expect(recipeUnlocked(tables, 'smelt_steel')).toBe(false);
    expect(recipeUnlocked(tables, 'make_frame')).toBe(false);

    // Everything else is start content, with nothing in `data/buildings.ts`
    // or `data/recipes.ts` saying so: the tech tree is the whole lock list.
    expect(tables.buildings[EntityType.Miner]).toBe(true);
    expect(tables.buildings[EntityType.Lab]).toBe(true);
    expect(tables.buildings[EntityType.Generator]).toBe(true);
    expect(recipeUnlocked(tables, 'smelt_iron')).toBe(true);
    expect(recipeUnlocked(tables, 'make_lab')).toBe(true);
    expect(recipeUnlocked(tables, 'make_data_core')).toBe(true);
  });

  it('gives a building its own recipe along with the building', () => {
    // Nothing in `data/technologies.ts` mentions `make_splitter`; unlocking
    // the splitter without it would be a menu row nobody could ever pay for.
    expect(recipeUnlocked(computeUnlocks(ctx, done()), 'make_splitter')).toBe(false);
    expect(recipeUnlocked(computeUnlocks(ctx, done('logistics_1')), 'make_splitter')).toBe(true);
  });

  it('is idempotent, and depends on nothing but which technologies are done', () => {
    // The same input twice: the tables must agree value for value. This is
    // what makes a load "restore the state, recompute the rest" rather than
    // an operation whose result depends on how the state was reached.
    const first = computeUnlocks(ctx, done('logistics_1', 'smelting_2'));
    const second = computeUnlocks(ctx, done('logistics_1', 'smelting_2'));
    expect(second).toEqual(first);

    // And the order the set was built in cannot reach the answer either.
    expect(computeUnlocks(ctx, done('smelting_2', 'logistics_1'))).toEqual(first);
  });

  it('unlocks strictly more as the tree is completed', () => {
    const none = computeUnlocks(ctx, done());
    const all = computeUnlocks(
      ctx,
      done(...technologies.all().map((technology) => technology.id)),
    );

    for (let type = 0; type < none.buildings.length; type++) {
      if (none.buildings[type] === true) expect(all.buildings[type], String(type)).toBe(true);
    }
    expect(all.buildings.every((unlocked) => unlocked)).toBe(true);
    expect(all.recipes.every((unlocked) => unlocked)).toBe(true);
  });

  it('freezes what it hands back, so nothing downstream can edit an unlock', () => {
    const tables = computeUnlocks(ctx, done());
    expect(Object.isFrozen(tables)).toBe(true);
    expect(Object.isFrozen(tables.buildings)).toBe(true);
  });
});

describe('Unlocks', () => {
  it('keeps its identity while its contents change, so holders never go stale', () => {
    const unlocks = new Unlocks(ctx);
    expect(unlocks.isBuildingIdUnlocked('splitter')).toBe(false);

    // Five systems hold this object and none of them re-reads it from
    // anywhere; a rebuild that replaced the object would leave them all
    // answering the question research had just changed the answer to.
    unlocks.rebuild(done('logistics_1'));

    expect(unlocks.isBuildingIdUnlocked('splitter')).toBe(true);
    expect(unlocks.isRecipeUnlocked(recipes.get('make_splitter').recipeId)).toBe(true);
    expect(unlocks.isRecipeUnlocked(recipes.get('smelt_steel').recipeId)).toBe(false);
  });

  it('answers yes for an id it has never heard of, rather than throwing', () => {
    // A view asks this every frame and a save may name content that has been
    // renamed (C27). "Yes" is the safe answer: it is what the game did before
    // there was a tech tree at all.
    const unlocks = new Unlocks(ctx);
    expect(unlocks.isBuildingIdUnlocked('teleporter')).toBe(true);
    expect(unlocks.isRecipeUnlocked(9999)).toBe(true);
  });
});
