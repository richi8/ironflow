/**
 * A quantity of one kind of item. See ironflow.md C06 task 1.
 *
 * How every piece of content data in the game names an amount of something: a
 * build cost in `data/buildings.ts`, a recipe's inputs and outputs in
 * `data/recipes.ts`. Plain data, so it goes straight into a save.
 *
 * It used to share this file with `ItemCounts`, a string-keyed bag the player
 * carried alongside their real inventory. That bag existed for exactly one
 * reason — a build cost was paid in a `miner` or a `chest`, and those were not
 * registered items, so they could not go in a `SlotInventory` — and C20's
 * building recipes removed the reason. `items/build-materials.ts` is what
 * replaced it: the same surface, over the player's one real bag.
 */

/** A quantity of one kind of item. Plain data: it goes straight into a save. */
export interface ItemStack {
  readonly itemId: string;
  readonly count: number;
}
