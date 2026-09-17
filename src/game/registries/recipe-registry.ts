/**
 * The recipe table, built once from `data/recipes.ts`. See ironflow.md C15
 * task 1 and §15.
 *
 * Two shapes, for the same reason `BuildingRegistry` has two: a
 * `RecipeDefinition` is what a human authors — string item ids and a duration
 * in seconds, because that is how §15's table reads — and a `Recipe` is what
 * the simulation runs on: runtime `ItemId`s and an integer tick count, both
 * resolved once here rather than per tick (§6 R3).
 *
 * ## Why recipes get runtime ids too
 *
 * A machine stores the recipe it is running, and an entity field must be plain
 * data that survives `JSON.stringify` (C05). A `RecipeId` is a number with
 * `NO_RECIPE` for "none", exactly as `heldItem` is an `ItemId` with `NO_ITEM`,
 * so the field costs four bytes and compares exactly. Unlike `ItemId` there is
 * no saved id mapping: C24 writes `byId(recipe).id` — the string — into the
 * save and reads it back through `get`, because one field per machine is not
 * worth a translation table, and a save that names its recipes is a save a
 * human can read.
 *
 * ## Auto-selection
 *
 * `forInput` answers "a furnace just received this item; what does it make?".
 * The index is built per category and an item that two recipes in the same
 * category claim maps to `null` — ambiguous, so nothing is auto-selected and
 * the player chooses (C16's `setRecipe`). That keeps the rule general rather
 * than making smelting a special case: smelting happens to be unambiguous,
 * crafting happens not to be, and neither is written down anywhere but here.
 */

import type { ItemStack } from '../items/item-stack.js';
import { TPS } from '../simulation-clock.js';
import { FIRST_ITEM_ID, type ItemId, type ItemRegistry } from './item-registry.js';

/** A recipe's runtime id. Dense, assigned in content order, never persisted raw. */
export type RecipeId = number;

/** "No recipe." Never a real recipe, so a machine's empty field is falsy. */
export const NO_RECIPE: RecipeId = 0;

/** The first id a real recipe can have. */
export const FIRST_RECIPE_ID: RecipeId = 1;

/** Which machines can run a recipe. §15 has exactly these two in v1. */
export type RecipeCategory = 'smelting' | 'crafting';

const RECIPE_CATEGORIES: readonly RecipeCategory[] = Object.freeze(['smelting', 'crafting']);

export function isRecipeCategory(value: string): value is RecipeCategory {
  return (RECIPE_CATEGORIES as readonly string[]).includes(value);
}

/** A recipe as authored in `data/recipes.ts`: string item ids, seconds. */
export interface RecipeDefinition {
  readonly id: string;
  readonly inputs: readonly ItemStack[];
  readonly outputs: readonly ItemStack[];
  readonly seconds: number;
  readonly category: RecipeCategory;
}

/** An ingredient or a product, in the ids the simulation counts in. */
export interface RecipeStack {
  readonly itemId: ItemId;
  readonly count: number;
}

/** A recipe as the simulation runs it. Frozen, built once. */
export interface Recipe {
  readonly recipeId: RecipeId;
  readonly id: string;
  readonly inputs: readonly RecipeStack[];
  readonly outputs: readonly RecipeStack[];
  readonly durationTicks: number;
  readonly category: RecipeCategory;
}

function durationTicks(definition: RecipeDefinition): number {
  return Math.round(definition.seconds * TPS);
}

function validate(definition: RecipeDefinition, items: ItemRegistry): void {
  const where = `recipe "${definition.id}"`;
  if (typeof definition.id !== 'string' || definition.id.length === 0 || definition.id.trim() !== definition.id) {
    throw new Error(`RecipeRegistry: ${JSON.stringify(definition.id)} is not a usable recipe id.`);
  }
  if (!isRecipeCategory(definition.category)) {
    throw new Error(`RecipeRegistry: ${where} has category "${definition.category}", which is not one.`);
  }
  if (!Number.isFinite(definition.seconds) || definition.seconds <= 0) {
    throw new Error(`RecipeRegistry: ${where} takes ${definition.seconds} seconds, which is not a duration.`);
  }
  if (durationTicks(definition) < 1) {
    throw new Error(`RecipeRegistry: ${where} takes ${definition.seconds} seconds, which rounds to under one tick.`);
  }
  checkStacks(definition.inputs, `${where} inputs`, items);
  checkStacks(definition.outputs, `${where} outputs`, items);
  for (const input of definition.inputs) {
    if (definition.outputs.some((output) => output.itemId === input.itemId)) {
      throw new Error(`RecipeRegistry: ${where} has "${input.itemId}" as both an ingredient and a product.`);
    }
  }
}

function checkStacks(stacks: readonly ItemStack[], where: string, items: ItemRegistry): void {
  if (stacks.length === 0) {
    throw new Error(`RecipeRegistry: ${where} are empty; a recipe both takes and makes something.`);
  }
  const seen = new Set<string>();
  for (const stack of stacks) {
    if (!items.has(stack.itemId)) {
      throw new Error(`RecipeRegistry: ${where} name "${stack.itemId}", which is not an item.`);
    }
    if (!Number.isInteger(stack.count) || stack.count < 1) {
      throw new Error(`RecipeRegistry: ${where} count ${stack.count} of "${stack.itemId}"; it must be whole and above 0.`);
    }
    if (seen.has(stack.itemId)) {
      throw new Error(`RecipeRegistry: ${where} list "${stack.itemId}" twice; fold it into one entry.`);
    }
    seen.add(stack.itemId);
  }
}

function resolve(stacks: readonly ItemStack[], items: ItemRegistry): readonly RecipeStack[] {
  return Object.freeze(
    stacks.map((stack) => Object.freeze({ itemId: items.idOf(stack.itemId), count: stack.count })),
  );
}

/** Ambiguous: more than one recipe in the category takes this item. */
const AMBIGUOUS = null;

export class RecipeRegistry {
  private readonly recipes: readonly Recipe[];
  /** Indexed by `RecipeId`; slot 0 is `NO_RECIPE` and stays empty. */
  private readonly byRecipeId: readonly (Recipe | undefined)[];
  private readonly byStringId = new Map<string, Recipe>();
  private readonly byCategoryMap = new Map<RecipeCategory, readonly Recipe[]>();
  /** category -> item -> the one recipe that item selects, or AMBIGUOUS. */
  private readonly inputIndex = new Map<RecipeCategory, Map<ItemId, Recipe | null>>();

  constructor(definitions: readonly RecipeDefinition[], items: ItemRegistry) {
    const built: Recipe[] = [];
    const dense: (Recipe | undefined)[] = [undefined];
    const categories = new Map<RecipeCategory, Recipe[]>();
    for (const definition of definitions) {
      validate(definition, items);
      if (this.byStringId.has(definition.id)) {
        throw new Error(`RecipeRegistry: two recipes share the id "${definition.id}".`);
      }
      const recipe: Recipe = Object.freeze({
        recipeId: dense.length,
        id: definition.id,
        inputs: resolve(definition.inputs, items),
        outputs: resolve(definition.outputs, items),
        durationTicks: durationTicks(definition),
        category: definition.category,
      });
      built.push(recipe);
      dense.push(recipe);
      this.byStringId.set(recipe.id, recipe);
      const bucket = categories.get(recipe.category);
      if (bucket === undefined) categories.set(recipe.category, [recipe]);
      else bucket.push(recipe);
      this.index(recipe);
    }
    this.recipes = Object.freeze(built);
    this.byRecipeId = Object.freeze(dense);
    for (const [category, bucket] of categories) this.byCategoryMap.set(category, Object.freeze(bucket));
  }

  private index(recipe: Recipe): void {
    let byItem = this.inputIndex.get(recipe.category);
    if (byItem === undefined) {
      byItem = new Map<ItemId, Recipe | null>();
      this.inputIndex.set(recipe.category, byItem);
    }
    for (const input of recipe.inputs) {
      byItem.set(input.itemId, byItem.has(input.itemId) ? AMBIGUOUS : recipe);
    }
  }

  all(): readonly Recipe[] {
    return this.recipes;
  }

  get size(): number {
    return this.recipes.length;
  }

  has(stringId: string): boolean {
    return this.byStringId.has(stringId);
  }

  get(stringId: string): Recipe {
    const recipe = this.byStringId.get(stringId);
    if (recipe === undefined) {
      throw new Error(`RecipeRegistry: no recipe with id "${stringId}".`);
    }
    return recipe;
  }

  byId(recipeId: RecipeId): Recipe {
    const recipe = this.byRecipeId[recipeId];
    if (recipe === undefined) {
      throw new Error(`RecipeRegistry: no recipe has runtime id ${recipeId}.`);
    }
    return recipe;
  }

  /** True for a real recipe's id. False for `NO_RECIPE` and for anything stale. */
  isRecipeId(value: number): value is RecipeId {
    return Number.isInteger(value) && value >= FIRST_RECIPE_ID && this.byRecipeId[value] !== undefined;
  }

  byCategory(category: RecipeCategory): readonly Recipe[] {
    return this.byCategoryMap.get(category) ?? NO_RECIPES;
  }

  /**
   * The recipe this item selects in this category, or `null` when it selects
   * none or more than one. A machine with no recipe calls this with whatever
   * it has just been handed; see `production-system.ts`.
   */
  forInput(category: RecipeCategory, itemId: ItemId): Recipe | null {
    if (itemId < FIRST_ITEM_ID) return null;
    return this.inputIndex.get(category)?.get(itemId) ?? null;
  }

  /** True when some recipe in the category takes this item, ambiguous or not. */
  acceptsInput(category: RecipeCategory, itemId: ItemId): boolean {
    if (itemId < FIRST_ITEM_ID) return false;
    return this.inputIndex.get(category)?.has(itemId) ?? false;
  }
}

const NO_RECIPES: readonly Recipe[] = Object.freeze([]);
