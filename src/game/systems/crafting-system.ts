/**
 * Making things by hand. See ironflow.md C21A and §15.
 *
 * ```text
 *   craftItem   phase 1   take the whole order's ingredients, queue it
 *   tick        phase 8   advance the head order, deliver one item
 *   cancelCraft phase 1   drop an order, give its ingredients back
 * ```
 *
 * This is the system C20 named as the fix for its one weak acceptance answer:
 * "the opening is given, not earned". Without it, a new game's first miner
 * *has* to be in the starting kit, because nothing else in the game can make
 * one before an assembler exists. With it, the kit is a head start rather than
 * a finished factory — and from C31 there is no kit at all: every crafting
 * recipe is hand-craftable, and a new game starts with an empty bag.
 *
 * It is a system and not three lines in `simulation.ts` for the reason
 * `HandSystem` is one: it owns two commands end to end, including their
 * refusals, and it owns a piece of authoritative state — the queue on
 * `PlayerState` — that nothing else may touch.
 *
 * ## Ingredients are spent when the order is queued
 *
 * Not per item as it comes up. Three reasons, in the order they matter:
 *
 * 1. **There is no stalled state to explain.** An order whose ingredients are
 *    taken later can find them gone — spent on something else, or inserted
 *    into a furnace — and then it sits in the queue doing nothing, which is
 *    exactly the silent stall pillar 3 forbids. Taking them up front means an
 *    order in the queue is an order that *will* complete.
 * 2. **The refusal lands on the click.** `unaffordable` is said at the moment
 *    the player presses the button, which is when they can still do something
 *    about it, rather than forty seconds into a queue.
 * 3. **It is one arithmetic, not two.** The bag is debited once and credited
 *    once (on cancel); there is no per-item bookkeeping to get wrong.
 *
 * The cost is that cancelling has to give things back, and that is the one
 * place this system can refuse to do what it is told: if the refund will not
 * fit in the bag, the cancel is **rejected outright** rather than voiding
 * items. That is `HandSystem.setRecipe`'s rule, for `setRecipe`'s reason —
 * nothing in this game is ever deleted to make an interaction convenient.
 *
 * ## What a full bag does
 *
 * The finished item has to go somewhere, and a bag can be full of something
 * else by the time a craft lands. Progress then **stops at the finish line**:
 * `progressTicks` stays at the duration, the order stays at the head of the
 * queue, and one `craft_blocked` alert says so. It is not lost and it is not
 * silent, and the moment a slot frees the item appears. This is the same
 * bargain C11's miner makes with `output_full`, one level down.
 */

import type { CommandRejectionReason } from '../commands/command.js';
import type { AlertLog } from '../alerts.js';
import { NO_ENTITY } from '../entities/entity.js';
import { MAX_CRAFT_BATCH, MAX_CRAFT_ORDERS, type PlayerState } from '../player/player-state.js';
import { CANNOT_CRAFT, type CraftDurations } from '../registries/craft-durations.js';
import type { Recipe, RecipeRegistry } from '../registries/recipe-registry.js';
import type { Unlocks } from '../research/unlocks.js';

export interface CraftingSystemOptions {
  readonly player: PlayerState;
  readonly recipes: RecipeRegistry;
  readonly crafts: CraftDurations;
  readonly alerts: AlertLog;
  /** What research has revealed (C22). A live holder — see `BuildSystem`. */
  readonly unlocks: Unlocks;
}

export class CraftingSystem {
  private readonly player: PlayerState;
  private readonly recipes: RecipeRegistry;
  private readonly durations: CraftDurations;
  private readonly alerts: AlertLog;
  private readonly unlocks: Unlocks;

  /**
   * Has the head order already complained that it cannot be delivered?
   *
   * Derived, never serialized: it exists so a blocked craft raises **one**
   * alert rather than thirty a second, which is the rule C11 set for the
   * miner that runs dry. A save that reloaded with it set would stay silent
   * about a bag that is still full, so it reloads clear and says so once more.
   */
  private blockedAnnounced = false;

  constructor(options: CraftingSystemOptions) {
    this.player = options.player;
    this.recipes = options.recipes;
    this.durations = options.crafts;
    this.alerts = options.alerts;
    this.unlocks = options.unlocks;
  }

  /**
   * Queue `count` crafts of `recipeId`, paying for all of them now.
   *
   * The refusals, in the order they are asked — which is the order a player
   * can act on them:
   *
   * ```text
   * unknown_recipe    no such thing
   * locked            research has not revealed it (C22)
   * not_craftable     §15 says that one needs a machine
   * unaffordable      you are not carrying the ingredients
   * craft_queue_full  you have too many orders already
   * ```
   *
   * `locked` is asked before `not_craftable` because it is the more general
   * answer: a recipe that is both is one the player cannot make *at all* yet,
   * and telling them to go and build a machine for it would send them to the
   * wrong place.
   */
  craft(recipeId: string, count: number): CommandRejectionReason | null {
    if (!this.recipes.has(recipeId)) return 'unknown_recipe';
    const recipe = this.recipes.get(recipeId);
    if (!this.unlocks.isRecipeUnlocked(recipe.recipeId)) return 'locked';
    if (this.durations.handTicksFor(recipe.recipeId) === CANNOT_CRAFT) return 'not_craftable';

    // Clamped rather than refused: a batch button asking for more than the cap
    // is the UI being generous, not the player being wrong, and `MAX_CRAFT_BATCH`
    // is a bound on one command rather than a rule the player has to learn.
    const wanted = Math.min(count, MAX_CRAFT_BATCH);

    const bag = this.player.inventory;
    for (const input of recipe.inputs) {
      if (bag.count(input.itemId) < input.count * wanted) return 'unaffordable';
    }

    // Merged into the tail when it is the same recipe, so a player pressing
    // the button ten times has one order of ten rather than ten of one — and
    // so the queue cap counts *kinds* of work rather than clicks.
    const tail = this.player.crafts[this.player.crafts.length - 1];
    const merging = tail !== undefined && tail.recipe === recipe.recipeId;
    if (!merging && this.player.crafts.length >= MAX_CRAFT_ORDERS) return 'craft_queue_full';

    // Nothing has moved until here, so every refusal above leaves the bag
    // exactly as it was.
    for (const input of recipe.inputs) bag.remove(input.itemId, input.count * wanted);

    if (merging && tail !== undefined) tail.remaining += wanted;
    else this.player.crafts.push({ recipe: recipe.recipeId, remaining: wanted, progressTicks: 0 });
    return null;
  }

  /**
   * Drop the order at `index` and give its ingredients back.
   *
   * **All** of them, including the one being made: its ingredients were spent
   * when the order was queued and it has produced nothing yet, so abandoning
   * it halfway costs time and never items (C16's rule for `setRecipe`, which
   * is the same interaction one machine over).
   *
   * Refused rather than partial when the refund will not fit: a cancel that
   * quietly evaporated four gears would be a worse outcome than the queue the
   * player was trying to get rid of.
   */
  cancel(index: number): CommandRejectionReason | null {
    const order = this.player.crafts[index];
    if (order === undefined) return 'nothing_queued';

    const recipe = this.recipes.byId(order.recipe);
    const bag = this.player.inventory;
    for (const input of recipe.inputs) {
      if (bag.spaceFor(input.itemId) < input.count * order.remaining) return 'inventory_full';
    }

    for (const input of recipe.inputs) bag.add(input.itemId, input.count * order.remaining);
    this.player.crafts.splice(index, 1);
    // The head may have changed, so whatever the old one had already said is
    // no longer the thing the player is being told about.
    if (index === 0) this.blockedAnnounced = false;
    return null;
  }

  /**
   * Phase 8. Advance the head order by one tick and deliver what finishes.
   *
   * One order at a time and one item per completion: the player has two
   * hands, and a queue that ran every order in parallel would make the queue
   * itself the automation. That is the assembler's job.
   */
  tick(): void {
    const order = this.player.crafts[0];
    if (order === undefined) {
      this.blockedAnnounced = false;
      return;
    }

    const recipe = this.recipes.byId(order.recipe);
    const duration = this.durations.handTicksFor(order.recipe);
    // A recipe that stopped being hand-craftable between two versions of the
    // content table. The order cannot advance and cannot silently vanish, so
    // it sits there and the panel shows it — `cancelCraft` is the way out,
    // and it still refunds. C24's migrations are where this is really solved.
    if (duration === CANNOT_CRAFT) return;

    if (order.progressTicks < duration) {
      order.progressTicks += 1;
      if (order.progressTicks < duration) return;
    }

    if (!this.deliver(recipe)) {
      if (!this.blockedAnnounced) {
        this.blockedAnnounced = true;
        this.alerts.push({
          type: 'craft_blocked',
          // A hand-craft happens where the player is standing, and it belongs
          // to no entity — so the alert carries the tile and the sentinel id,
          // which is what `NO_ENTITY` is for.
          entityId: NO_ENTITY,
          x: this.player.tileX,
          y: this.player.tileY,
        });
      }
      return;
    }

    this.blockedAnnounced = false;
    order.remaining -= 1;
    order.progressTicks = 0;
    if (order.remaining <= 0) this.player.crafts.shift();
  }

  /**
   * Put one craft's products in the bag, or nothing at all.
   *
   * All or nothing, checked before anything moves: `make_belt` produces two
   * belts, and delivering one of them would turn "the bag is full" into an
   * item that quietly went missing.
   */
  private deliver(recipe: Recipe): boolean {
    const bag = this.player.inventory;
    for (const output of recipe.outputs) {
      if (bag.spaceFor(output.itemId) < output.count) return false;
    }
    for (const output of recipe.outputs) bag.add(output.itemId, output.count);
    return true;
  }
}
