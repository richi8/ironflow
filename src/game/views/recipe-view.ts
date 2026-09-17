/**
 * A recipe, as the inspector's picker draws it. See ironflow.md C16 task 3.
 *
 * > Recipe picker UI in the inspector: a grid of unlocked recipes for the
 * > machine's category, with ingredient icons and rate.
 *
 * Everything in here is resolved by the controller, because everything in here
 * needs a registry the UI may not import (§4): an ingredient's *name* is the
 * item registry's, and a rate is the recipe's duration at the speed of the
 * machine that is about to run it (`registries/craft-durations.ts`). Handing
 * the panel a recipe id and letting it look the rest up would be the seam §4
 * exists to close.
 *
 * ## What is not here
 *
 * **`unlocked`.** Task 3 says "unlocked recipes", and every recipe in the game
 * is unlocked until C22 has a technology tree — so the picker lists what the
 * controller gives it, and C22 gives it fewer. A field that is `true` for
 * every row in every machine for the next six chunks is a promise the view
 * cannot keep, which is §13's rule about `HudView` applied to recipes.
 *
 * **An icon.** §11 puts eight inline SVGs in `ui/icons.ts` and no item art
 * anywhere; item sprites are the canvas atlas's and belong to C29. The
 * "ingredient icons" the task asks for are the count and the name, drawn as a
 * chip — which is what the player needs to read and what will hold a real icon
 * beside it when there is one.
 */

/** One ingredient or product of a recipe, named for a panel. */
export interface RecipePartView {
  readonly itemId: string;
  readonly name: string;
  readonly count: number;
}

export interface RecipeView {
  /** The string id the `setRecipe` command speaks (§7). */
  readonly id: string;
  /**
   * What to call it on screen: the name of what it makes.
   *
   * A recipe has no authored name — §15's table has ids and ingredients — and
   * inventing a `name` field for content would mean writing "Gear" twice, in
   * `data/items.ts` and again in `data/recipes.ts`, with no way to notice when
   * the two drift. What a player is choosing between is the *products*, so the
   * first product's item name is the honest label and the count rides along in
   * `outputs` for a recipe that makes two.
   */
  readonly name: string;
  readonly inputs: readonly RecipePartView[];
  readonly outputs: readonly RecipePartView[];
  /** Ticks one craft takes **in this machine** — the recipe at its speed. */
  readonly craftTicks: number;
  /**
   * Units of the first product per minute at full speed, for the "rate" task 3
   * asks for. Derived, like everything else here (§10).
   */
  readonly ratePerMinute: number;
  /** Is this what the machine is making now? */
  readonly selected: boolean;
}
