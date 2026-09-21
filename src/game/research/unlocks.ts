/**
 * What research has made available. See ironflow.md C22 task 6 and §10.
 *
 * > Unlock application is a pure function over research state so it is
 * > trivially rebuilt on load (derived, §10).
 *
 * That sentence is this file. `computeUnlocks` takes the set of completed
 * technologies and answers, for every building and every recipe in the game,
 * whether it may be used — and it takes nothing else, touches nothing else and
 * returns plain frozen arrays. Nothing here is serialized: a save carries the
 * technologies (`research-state.ts`), and this is recomputed from them.
 *
 * ```text
 *   ResearchState (authoritative)  ->  computeUnlocks (pure)  ->  UnlockTables
 *   which technologies are done        content order, no state     boolean[]
 * ```
 *
 * ## Locked is the exception, not the rule
 *
 * The tables start **all true** and a technology that is *not* done turns its
 * own grants off. So a building or recipe that no technology claims is
 * available from the first frame, with nothing in `data/buildings.ts` or
 * `data/recipes.ts` saying so: the tech tree is the whole lock list, in one
 * place, and adding a technology is the only way to take something away.
 *
 * ## A building unlock carries its recipe
 *
 * Unlocking `splitter` without `make_splitter` would hand the player a menu
 * row they could never pay for, and writing both into every node would be two
 * content rows that have to agree. So the recipe that produces a building's
 * item is granted with the building, here, and `TechnologyRegistry` refuses a
 * tree that claims that recipe separately — the two halves of one rule.
 *
 * ## Why `Unlocks` is a holder and not the tables
 *
 * The tables are replaced wholesale when a technology completes, and five
 * systems need to ask about them every tick. Handing each of them the array
 * would mean five references to update at the moment of an unlock — the class
 * of bug where the factory is told about a technology and the build menu is
 * not. So they hold this object, whose contents change and whose identity does
 * not.
 */

import { ENTITY_TYPE_COUNT, type EntityType } from '../entities/entity-types.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import type { ItemRegistry } from '../registries/item-registry.js';
import type { Recipe, RecipeGate, RecipeId, RecipeRegistry } from '../registries/recipe-registry.js';
import type { Technology, TechnologyId, TechnologyRegistry } from '../registries/technology-registry.js';

/** Which buildings and recipes are available, as dense flags. Frozen. */
export interface UnlockTables {
  /** Indexed by `EntityType`. */
  readonly buildings: readonly boolean[];
  /** Indexed by `RecipeId`; slot 0 is `NO_RECIPE` and is never read. */
  readonly recipes: readonly boolean[];
}

/**
 * The registries `recipeForBuilding` reads. Content only — no state.
 *
 * Narrower than `UnlockContext` on purpose: the technology registry's own
 * duplicate-claim check asks this question while it is still being built, so
 * it cannot be asked to hand itself over.
 */
export interface BuildingRecipeContext {
  readonly buildings: BuildingRegistry;
  readonly recipes: RecipeRegistry;
  readonly items: ItemRegistry;
}

/** The registries `computeUnlocks` reads. Content only — no state. */
export interface UnlockContext extends BuildingRecipeContext {
  readonly technologies: TechnologyRegistry;
}

/**
 * The recipe that produces the item a building is paid for with, or null.
 *
 * "A building's item" is §15's rule that `buildCost` is always a single stack
 * of the building's own id, so the search is for a recipe whose output is that
 * item. It is a content question asked in two places — here and the registry's
 * duplicate-claim check — and answering it in one keeps them from disagreeing.
 */
export function recipeForBuilding(ctx: BuildingRecipeContext, buildingId: string): Recipe | null {
  if (!ctx.items.has(buildingId)) return null;
  const itemId = ctx.items.idOf(buildingId);
  for (const recipe of ctx.recipes.all()) {
    if (recipe.outputs.some((stack) => stack.itemId === itemId)) return recipe;
  }
  return null;
}

/**
 * What is available, given the technologies that are done. Pure.
 *
 * Called on a load, on every completed technology, and by the test that
 * asserts it is idempotent — the same input must always give the same tables,
 * whatever order the technologies were completed in.
 */
export function computeUnlocks(ctx: UnlockContext, isUnlocked: (id: TechnologyId) => boolean): UnlockTables {
  const buildings = new Array<boolean>(ENTITY_TYPE_COUNT).fill(true);
  const recipes = new Array<boolean>(ctx.recipes.size + 1).fill(true);

  // Content order, and the unlock list's own order inside it: two fixed
  // sequences, neither of them a container's insertion order (§6 R4). Nothing
  // here depends on the order — every write is an independent `false` — but a
  // pure function whose answer could depend on one is a pure function nobody
  // can reason about.
  for (const technology of ctx.technologies.all()) {
    if (isUnlocked(technology.technologyId)) continue;
    for (const unlock of technology.unlocks) {
      if (unlock.kind === 'recipe') {
        lockRecipe(recipes, ctx.recipes.get(unlock.id).recipeId);
        continue;
      }
      buildings[ctx.buildings.get(unlock.id).entityType] = false;
      const recipe = recipeForBuilding(ctx, unlock.id);
      if (recipe !== null) lockRecipe(recipes, recipe.recipeId);
    }
  }

  return Object.freeze({ buildings: Object.freeze(buildings), recipes: Object.freeze(recipes) });
}

function lockRecipe(recipes: boolean[], recipeId: RecipeId): void {
  recipes[recipeId] = false;
}

/**
 * The live answer to "may this be used?", handed to the systems that ask.
 *
 * It is a `RecipeGate`, which is the narrow interface `RecipeRegistry` takes
 * when it is asked what a machine's input buffer selects — so a furnace can
 * never auto-select a recipe the player has not researched, and an inserter
 * can never silt that furnace up with an ingredient for one.
 */
export class Unlocks implements RecipeGate {
  private readonly ctx: UnlockContext;
  private tables: UnlockTables;

  /** Built locked-for-nothing: with no technologies done, the tree's grants are off. */
  constructor(ctx: UnlockContext, isUnlocked: (id: TechnologyId) => boolean = () => false) {
    this.ctx = ctx;
    this.tables = computeUnlocks(ctx, isUnlocked);
  }

  /** Recompute from the research state. What `rebuildDerived()` means here (§10). */
  rebuild(isUnlocked: (id: TechnologyId) => boolean): void {
    this.tables = computeUnlocks(this.ctx, isUnlocked);
  }

  /** May a building of this type be placed? */
  isBuildingUnlocked(type: EntityType): boolean {
    return this.tables.buildings[type] ?? true;
  }

  /** May a building with this content id be placed? For `BuildSystem` and the menu. */
  isBuildingIdUnlocked(buildingId: string): boolean {
    if (!this.ctx.buildings.has(buildingId)) return true; // `validate` names the wrong id
    return this.isBuildingUnlocked(this.ctx.buildings.get(buildingId).entityType);
  }

  /** May this recipe be run — in a machine, or by hand? */
  isRecipeUnlocked(recipeId: RecipeId): boolean {
    return this.tables.recipes[recipeId] ?? true;
  }

  /** The tables as they stand. For tests and for the idempotence check. */
  snapshot(): UnlockTables {
    return this.tables;
  }
}

/**
 * A gate that says yes to everything.
 *
 * For fixtures and for the parts of the game that predate research: a port
 * built without a tech tree behaves exactly as it did in C21. It is a
 * constant rather than a default parameter, because a default would let a new
 * call site forget the gate and never be told.
 */
export const ALL_UNLOCKED: RecipeGate = Object.freeze({
  isRecipeUnlocked: (): boolean => true,
});

/** Every technology, as `computeUnlocks` wants to be asked. For tests. */
export function unlockedSet(technologies: readonly Technology[]): (id: TechnologyId) => boolean {
  const ids = new Set(technologies.map((technology) => technology.technologyId));
  return (id) => ids.has(id);
}
