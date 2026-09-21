import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import type { ItemRegistry } from '../../src/game/registries/item-registry.js';
import type { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';
import { TechnologyRegistry } from '../../src/game/registries/technology-registry.js';
import { Unlocks } from '../../src/game/research/unlocks.js';

/**
 * An `Unlocks` that says yes to everything. See ironflow.md C22.
 *
 * Most tests in this repository are about belts, furnaces and inserters and
 * predate the tech tree entirely; what they need from research is for it not
 * to be there. This is that: an empty technology table, so `computeUnlocks`
 * has nothing to turn off and every building and recipe is available — which
 * is exactly the world those tests were written against.
 *
 * A test that is about research builds a real `Simulation` instead and goes
 * through `simulation.researchSystem`, so this fixture can never be the thing
 * that makes a locked building look buildable in the test that cares.
 */
export function openUnlocks(
  buildings: BuildingRegistry,
  recipes: RecipeRegistry,
  items: ItemRegistry,
): Unlocks {
  const technologies = new TechnologyRegistry([], items, {
    hasBuilding: () => true,
    hasRecipe: () => true,
    recipeForBuilding: () => null,
  });
  return new Unlocks({ technologies, buildings, recipes, items });
}
