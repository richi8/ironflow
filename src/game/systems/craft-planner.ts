/**
 * What a hand-craft costs once the missing parts are made first (2026-09-24).
 *
 * Asking for a miner with nothing but plates in the bag used to be refused as
 * `unaffordable`. It is now a **chain**: the gears and circuits it lacks — and
 * the wire those circuits lack — are queued ahead of it, and the whole chain
 * is paid for from the bag at once. Factorio's hand-crafting does the same.
 *
 * ```text
 *   want 1 miner          4 gear, 2 circuit, 4 plate
 *   bag  40 plate, 10 copper
 *
 *   queue  make_gear    ×4   owes 4 gear     to the chain
 *          make_wire    ×3   owes 6 wire     to the chain
 *          make_circuit ×2   owes 2 circuit  to the chain
 *          make_miner   ×1   owes nothing: this is what was asked for
 *   bag    -14 plate, -3 copper, now
 * ```
 *
 * ## `feeds`: what an order owes the orders after it
 *
 * `CraftingSystem`'s rule is that an order in the queue has been paid for, and
 * a chain keeps it: the miner's four gears are paid by the gear order, which
 * was paid in plates. So a chain order's products are not the player's — the
 * first `feeds` of them go to the order that is waiting on them and never
 * touch the bag. What it makes beyond that (the one spare wire, the second
 * belt) is delivered as usual.
 *
 * A chain in the queue is therefore a run of orders with `feeds > 0` ended by
 * one with `feeds === 0`, and it lives or dies as one: see
 * `CraftingSystem.cancel`.
 *
 * ## How the plan is found
 *
 * Depth first, ingredients in bill order, each drawing on what the bag holds
 * before anything is made — and on what an earlier step of the same plan
 * makes spare, so three circuits wanting nine wire queue five wire crafts and
 * not six. An item with no hand-craftable, unlocked recipe (a plate, an ore)
 * can only come from the bag, and when the bag is short of it there is no
 * plan. A recipe already being expanded further up is never expanded again,
 * so content with a loop in it fails the plan rather than the stack.
 *
 * Integers throughout and no iteration over a hash (§6): the planner runs
 * inside the simulation, so it is deterministic by the same rules the systems
 * are.
 */

import type { ItemId } from '../registries/item-registry.js';
import { CANNOT_CRAFT, type CraftDurations } from '../registries/craft-durations.js';
import type { Recipe, RecipeGate, RecipeId, RecipeRegistry } from '../registries/recipe-registry.js';

/** One order a plan puts in the queue, upstream first. */
export interface CraftPlanStep {
  readonly recipe: RecipeId;
  /** How many crafts. */
  readonly count: number;
  /** How many of its products go to later orders instead of the bag. */
  readonly feeds: number;
}

/** A craft that can be paid for: the orders, and what leaves the bag for them. */
export interface CraftPlan {
  /** Dependencies first; the last step is the one that was asked for. */
  readonly steps: readonly CraftPlanStep[];
  /** Everything the bag pays, in the order it was first drawn on. */
  readonly take: readonly { readonly itemId: ItemId; readonly count: number }[];
}

export interface CraftPlanContext {
  readonly recipes: RecipeRegistry;
  readonly durations: CraftDurations;
  readonly unlocks: RecipeGate;
  /** How many of an item the bag holds. */
  readonly held: (itemId: ItemId) => number;
}

/** Plans `count` crafts of `recipe`, making what is missing. `null` when the bag cannot cover it. */
export function planCraft(ctx: CraftPlanContext, recipe: Recipe, count: number): CraftPlan | null {
  return new Planner(ctx).plan(recipe, count);
}

/**
 * The most crafts of `recipe` a plan exists for, up to `limit`. Zero when
 * there is none.
 *
 * A binary search, because a plan for `n` implies one for every smaller `n`
 * and the planner is cheap — a few dozen steps at worst, against a content
 * table of twenty recipes.
 */
export function maxCraftable(ctx: CraftPlanContext, recipe: Recipe, limit: number): number {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (planCraft(ctx, recipe, mid) === null) high = mid - 1;
    else low = mid;
  }
  return low;
}

/**
 * Ticks one craft of `recipe` takes by hand **from raw materials**: the craft
 * itself and every part under it, as if the bag held none of the parts and
 * all of the raw material (2026-09-24, Factorio's "total raw"). The chain is
 * the one `planCraft` would queue, whole crafts and spares included, so it is
 * how long the player would actually wait. `CANNOT_CRAFT` when there is none.
 */
export function rawCraftTicks(ctx: Omit<CraftPlanContext, 'held'>, recipe: Recipe): number {
  const plan = planCraft(
    // A part is something a recipe here makes; anything else is raw, and plenty.
    { ...ctx, held: (itemId) => (firstProducer(ctx, itemId, []) === null ? Number.MAX_SAFE_INTEGER : 0) },
    recipe,
    1,
  );
  if (plan === null) return CANNOT_CRAFT;
  let total = 0;
  for (const step of plan.steps) {
    const ticks = ctx.durations.handTicksFor(step.recipe);
    if (ticks === CANNOT_CRAFT) return CANNOT_CRAFT;
    total += ticks * step.count;
  }
  return total;
}

/**
 * The first hand-craftable, unlocked recipe, in content order, whose one
 * product is this item and which is not in `skip` — or null. Only
 * single-product recipes qualify: every crafting recipe has one, and `feeds`
 * counts a single product.
 */
function firstProducer(
  ctx: Omit<CraftPlanContext, 'held'>,
  itemId: ItemId,
  skip: readonly RecipeId[],
): Recipe | null {
  for (const recipe of ctx.recipes.handCraftable()) {
    if (recipe.outputs.length !== 1 || recipe.outputs[0]?.itemId !== itemId) continue;
    if (skip.includes(recipe.recipeId)) continue;
    if (!ctx.unlocks.isRecipeUnlocked(recipe.recipeId)) continue;
    if (ctx.durations.handTicksFor(recipe.recipeId) === CANNOT_CRAFT) continue;
    return recipe;
  }
  return null;
}

/** Products a step made beyond what it owes, which a later step may draw on. */
interface Spare {
  readonly itemId: ItemId;
  readonly step: MutableStep;
  amount: number;
}

interface MutableStep {
  readonly recipe: RecipeId;
  readonly count: number;
  feeds: number;
}

class Planner {
  private readonly ctx: CraftPlanContext;
  private readonly steps: MutableStep[] = [];
  private readonly spares: Spare[] = [];
  /** What is left in the bag of each item drawn on, in first-drawn order. */
  private readonly left = new Map<ItemId, number>();
  private readonly drawn: ItemId[] = [];
  /** Recipes being expanded right now, so a loop in the content ends the plan. */
  private readonly expanding: RecipeId[] = [];

  constructor(ctx: CraftPlanContext) {
    this.ctx = ctx;
  }

  plan(recipe: Recipe, count: number): CraftPlan | null {
    if (count < 1) return null;
    this.expanding.push(recipe.recipeId);
    for (const input of recipe.inputs) {
      if (!this.need(input.itemId, input.count * count)) return null;
    }
    this.steps.push({ recipe: recipe.recipeId, count, feeds: 0 });

    const take: { itemId: ItemId; count: number }[] = [];
    for (const itemId of this.drawn) {
      const spent = this.ctx.held(itemId) - (this.left.get(itemId) ?? 0);
      if (spent > 0) take.push({ itemId, count: spent });
    }
    return { steps: this.steps.map((step) => ({ ...step })), take };
  }

  /** Cover `amount` of an item: from spares, then the bag, then by crafting it. */
  private need(itemId: ItemId, amount: number): boolean {
    let missing = amount;

    for (const spare of this.spares) {
      if (missing === 0) break;
      if (spare.itemId !== itemId || spare.amount === 0) continue;
      const used = Math.min(spare.amount, missing);
      spare.amount -= used;
      spare.step.feeds += used;
      missing -= used;
    }

    if (missing > 0) {
      if (!this.left.has(itemId)) {
        this.left.set(itemId, this.ctx.held(itemId));
        this.drawn.push(itemId);
      }
      const inBag = this.left.get(itemId) ?? 0;
      const used = Math.min(inBag, missing);
      this.left.set(itemId, inBag - used);
      missing -= used;
    }
    if (missing === 0) return true;

    const producer = this.producerOf(itemId);
    if (producer === null) return false;
    const perCraft = producer.outputs[0]?.count ?? 0;
    if (perCraft < 1) return false;
    const crafts = Math.ceil(missing / perCraft);

    this.expanding.push(producer.recipeId);
    for (const input of producer.inputs) {
      if (!this.need(input.itemId, input.count * crafts)) return false;
    }
    this.expanding.pop();

    const step: MutableStep = { recipe: producer.recipeId, count: crafts, feeds: missing };
    this.steps.push(step);
    const extra = crafts * perCraft - missing;
    if (extra > 0) this.spares.push({ itemId, step, amount: extra });
    return true;
  }

  /** What makes an item, skipping recipes already being expanded (see `firstProducer`). */
  private producerOf(itemId: ItemId): Recipe | null {
    return firstProducer(this.ctx, itemId, this.expanding);
  }
}
