/**
 * Paying for a building out of the player's real inventory. See ironflow.md
 * §15 and C20 task 1.
 *
 * ```text
 * C06  build cost paid from ItemCounts, a second bag keyed by string
 * C08  SlotInventory arrives, keyed by the registry's numeric ids
 * C16  "C20 merges the two"                      — deferred, and said so
 * C20  building items are items; this is the merge
 * ```
 *
 * The two containers existed for one reason: a build cost is paid in a `miner`
 * or a `chest`, and those were not registered items, so they could not go in a
 * `SlotInventory`. §15's building recipes make them items — an assembler makes
 * a belt exactly as it makes a gear — and the second bag has nothing left to
 * hold.
 *
 * ## Why a view and not a replacement
 *
 * A build cost is authored in `data/buildings.ts` as `{ itemId: 'chest' }`,
 * because that is how a human writes content; an inventory counts in the
 * numeric ids a hot loop compares (see `registries/item-registry.ts` on why
 * there are two vocabularies at all). Something has to translate, and the only
 * question is where. `HandSystem` already does it inline, one `idOf` per
 * command, which is right for three call sites and wrong for a build cost that
 * is checked by the ghost every frame, by the build menu every frame and by
 * the tick that places the building.
 *
 * So this is the translation, once, with the `ItemCounts` surface the build
 * system and the controller already speak. It owns no items: every count comes
 * from the player's bag and every change lands in it.
 *
 * ## What changed for the player
 *
 * A bag with slots can be **full**, and the old one could not. Three
 * consequences, all deliberate:
 *
 * - `give` — the refund for demolishing — can now fail to fit. `BuildSystem`
 *   asks first and refuses the removal rather than voiding the refund, which
 *   is the rule C16's `setRecipe` set: nothing is ever deleted (§7).
 * - An item the registry has never heard of is worth zero rather than being
 *   quietly held. A build cost naming one is a content bug, and the registry's
 *   own validation catches it at startup; here it is simply unaffordable.
 * - The thirty slots the player carries are now shared between ore and
 *   buildings, which is a **balance number** and the point: a player who fills
 *   their bag with plates has to put them somewhere before they can carry a
 *   hundred belts.
 */

import type { SlotInventory } from './inventory.js';
import type { ItemStack } from './item-stack.js';
import type { ItemRegistry } from '../registries/item-registry.js';

export class BuildMaterials {
  private readonly inventory: SlotInventory;

  private readonly items: ItemRegistry;

  constructor(inventory: SlotInventory, items: ItemRegistry) {
    this.inventory = inventory;
    this.items = items;
  }

  /**
   * The runtime id of a string id, or `null` for one no registry knows.
   *
   * `null` rather than a throw because every caller here is answering a
   * question about the player's stock, and "none" is the honest answer to
   * "how many `sprocket` do you have" — see the file header.
   */
  private idOf(itemId: string): number | null {
    return this.items.has(itemId) ? this.items.idOf(itemId) : null;
  }

  /** How many of one item the player holds. Zero for anything unknown. */
  count(itemId: string): number {
    const runtimeId = this.idOf(itemId);
    return runtimeId === null ? 0 : this.inventory.count(runtimeId);
  }

  /** Add items. Returns how many fitted, which may be fewer than asked for. */
  add(itemId: string, amount: number): number {
    const runtimeId = this.idOf(itemId);
    return runtimeId === null ? 0 : this.inventory.add(runtimeId, amount);
  }

  /** Remove up to `amount`. Returns how many were actually removed. */
  remove(itemId: string, amount: number): number {
    const runtimeId = this.idOf(itemId);
    return runtimeId === null ? 0 : this.inventory.remove(runtimeId, amount);
  }

  /** Could `cost` be paid in full right now? */
  canAfford(cost: readonly ItemStack[]): boolean {
    for (const stack of cost) {
      if (this.count(stack.itemId) < stack.count) return false;
    }
    return true;
  }

  /**
   * Would `refund` fit, all of it, if it were handed over now?
   *
   * Asked before a demolition, because a slot inventory can be full and a
   * refund that only half fitted would delete the other half. Summed per item
   * id rather than per stack: a refund is a build cost and `RecipeRegistry`'s
   * rule — one entry per item — holds for `buildCost` too, but adding the
   * counts costs nothing and makes the answer right either way.
   */
  hasRoomFor(refund: readonly ItemStack[]): boolean {
    for (const stack of refund) {
      const runtimeId = this.idOf(stack.itemId);
      if (runtimeId === null) return false;
      if (this.inventory.spaceFor(runtimeId) < stack.count) return false;
    }
    return true;
  }

  /**
   * Pay `cost` in full, or change nothing and return false.
   *
   * All-or-nothing, exactly as C06's bag was: a partial payment would take the
   * iron plates for a building that is never placed, and the player would have
   * no way to tell where they went.
   */
  take(cost: readonly ItemStack[]): boolean {
    if (!this.canAfford(cost)) return false;
    for (const stack of cost) {
      this.remove(stack.itemId, stack.count);
    }
    return true;
  }

  /**
   * Hand `cost` back. Returns false and changes nothing if it will not all
   * fit — see `hasRoomFor`, which is what a caller asks first.
   */
  give(cost: readonly ItemStack[]): boolean {
    if (!this.hasRoomFor(cost)) return false;
    for (const stack of cost) {
      this.add(stack.itemId, stack.count);
    }
    return true;
  }

  /**
   * Everything the player is carrying, by string id, sorted.
   *
   * The HUD's row source. Sorted by string id so the rows never reorder under
   * the player's cursor as counts change — the guarantee C06's bag made by
   * sorting its keys, kept now that the counts come from a slot inventory
   * whose own `toJSON` is ordered by runtime id.
   */
  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [runtimeId, count] of this.inventory.toJSON()) {
      out[this.items.byId(runtimeId).id] = count;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
