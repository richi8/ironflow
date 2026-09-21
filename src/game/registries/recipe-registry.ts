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
  /**
   * May the player make this with their bare hands? See ironflow.md C21A.
   *
   * §15 names five buildings "hand-craftable without a machine (so a new game
   * is never soft-locked)" and says everything else requires an assembler.
   * That is a property of the *recipe*, so it is a column of the content
   * table rather than a list kept in a system (§19 rule 17).
   *
   * Absent means **no**, which is the right default twice over: every
   * smelting recipe needs a furnace by definition, and a recipe added in a
   * later chunk has to make the decision out loud rather than inherit one.
   */
  readonly handCraftable?: boolean;
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
  /** Can the player make this by hand (C21A)? Never optional at runtime. */
  readonly handCraftable: boolean;
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
  // C21A. Smelting is what a furnace is *for*: a hand-craftable smelting
  // recipe would make the first building in the game pointless, and §15's
  // hand-craft list is five assembled things and no plates. Refused at
  // registry build, so it is a content error on the first frame.
  if (definition.handCraftable === true && definition.category === 'smelting') {
    throw new Error(`RecipeRegistry: ${where} is smelting and cannot be hand-craftable; smelting needs a furnace.`);
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

/**
 * Whether a recipe may be run at all. See `research/unlocks.ts`, which
 * implements it, and `ALL_UNLOCKED`, which is the answer for a caller with no
 * tech tree.
 *
 * It is a parameter of the two questions a *machine* asks — "what does this
 * item make?" and "would you take this item?" — rather than a field on the
 * registry, because the registry is content and what is unlocked is state
 * (§10). Without it a furnace fed iron plates would quietly start smelting
 * steel before `smelting_2` was researched, which would make the lock a
 * suggestion.
 */
export interface RecipeGate {
  isRecipeUnlocked(recipeId: RecipeId): boolean;
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
  /** The `handCraftable` rows, in content order. See `handCraftable()`. */
  private readonly byHand: readonly Recipe[];

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
        handCraftable: definition.handCraftable === true,
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
    this.byHand = Object.freeze(built.filter((recipe) => recipe.handCraftable));
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
   *
   * A recipe the `gate` has not unlocked is not selected (C22), which is what
   * keeps a locked recipe out of a machine that picks for itself. Note the
   * **ambiguity is decided before the gate**: two recipes claiming one item
   * stay ambiguous even when research has only unlocked one of them, because
   * the ambiguity is a fact about the content table and letting a technology
   * resolve it would make a furnace change what it smelts the moment an
   * unrelated node completed.
   */
  forInput(category: RecipeCategory, itemId: ItemId, gate: RecipeGate): Recipe | null {
    if (itemId < FIRST_ITEM_ID) return null;
    const recipe = this.inputIndex.get(category)?.get(itemId) ?? null;
    if (recipe === null || !gate.isRecipeUnlocked(recipe.recipeId)) return null;
    return recipe;
  }

  /**
   * Every recipe the player's own hands can run, in content order (C21A).
   *
   * Content order because that is what keeps the craft grid from reshuffling
   * itself between two frames, and because adding a recipe puts it where the
   * content author put it — the same rule the inspector's picker follows.
   */
  handCraftable(): readonly Recipe[] {
    return this.byHand;
  }

  /**
   * True when some **unlocked** recipe in the category takes this item,
   * ambiguous or not (C22).
   *
   * The gate matters here for the same reason it matters in `forInput`, one
   * step earlier: this is what a machine that has not chosen a recipe yet
   * answers "would you take this?" with, and a furnace that accepted iron
   * plates for a smelting recipe it may not run would fill fifty slots with
   * an ingredient it can never spend — C14 task 6's failure exactly.
   */
  acceptsInput(category: RecipeCategory, itemId: ItemId, gate: RecipeGate): boolean {
    if (itemId < FIRST_ITEM_ID) return false;
    const byItem = this.inputIndex.get(category);
    if (byItem === undefined || !byItem.has(itemId)) return false;
    for (const recipe of this.byCategory(category)) {
      if (!gate.isRecipeUnlocked(recipe.recipeId)) continue;
      if (recipe.inputs.some((stack) => stack.itemId === itemId)) return true;
    }
    return false;
  }
}

const NO_RECIPES: readonly Recipe[] = Object.freeze([]);
