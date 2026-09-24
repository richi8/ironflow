/**
 * The player's bag and what they are making by hand. See ironflow.md C21A, §13.
 *
 * §13 lists an `InventoryPanel` in the UI structure and no chunk before this
 * one scheduled it, so for twelve chunks everything the player mined went into
 * a counter in the corner of the HUD. This is the view model that panel reads:
 * one frozen snapshot answering the three questions it exists for — *what am I
 * carrying, what can I make of it, and what is being made now*.
 *
 * ```text
 *   GameController.getInventoryView()  ->  InventoryPanel.update(view)
 *   a frozen InventoryView                 assignment only, never a rebuild
 * ```
 *
 * ## Why the three lists are in one view and not three
 *
 * They are one question asked three ways, and they must agree. The craft grid
 * greys a recipe out because the *bag* does not hold its ingredients, and the
 * queue's refund is ingredients going back into that same bag — so two
 * snapshots taken a frame apart could show a player a recipe they can afford
 * beside a bag that says they cannot. One view, one moment.
 *
 * ## Why every registered item has a row, including the ones at zero
 *
 * `items` carries a row per item **in the game**, not per item the player
 * holds, with `count: 0` for the rest. §13's rule is that a panel builds its
 * DOM once and updates by assignment, and the panel can only do that if the
 * shape of the list is content rather than contents. The panel hides the empty
 * rows; what it never does is create and destroy elements as ore arrives.
 */

/** One kind of item in the bag, and what it costs in slots. */
export interface InventorySlotView {
  readonly itemId: string;
  /** The player-facing name, which is content (C06) and one day translated. */
  readonly name: string;
  /** How many are held. **Zero is a real row** — see the file header. */
  readonly count: number;
  /**
   * Slots these occupy, which is `ceil(count / stackSize)`.
   *
   * Derived here rather than in the panel because the stack size is the item
   * registry's and §4 forbids the UI from asking it (C06). It is also the
   * number that explains a bag that is full while looking half empty: thirty
   * slots of five different ores is not the same as thirty slots of iron.
   */
  readonly slots: number;
  /** How many fit in one slot. Shown as "142 / 200" on a part-filled stack. */
  readonly stackSize: number;
  /**
   * The building this item places, or `null`. A placeable item can be picked
   * up to build with, or dragged onto the hotbar.
   */
  readonly buildingId: string | null;
}

/**
 * One recipe the player's own hands can run, and whether they can run it now.
 *
 * A near-twin of `RecipeView`, deliberately not the same type. That one is
 * about a *machine*: it carries `selected`, because an assembler is set to one
 * recipe and left there, and its rate is that machine's speed. This one is
 * about an action taken once, so it carries `affordable` and `craftable` —
 * how many the bag could pay for — and no selection at all.
 */
export interface CraftOptionView {
  /** The string id the `craftItem` command speaks (§7). */
  readonly id: string;
  /** What to call it on screen: the name of what it makes (see `RecipeView`). */
  readonly name: string;
  /** How many come out of one craft. Two, for `make_belt`. */
  readonly yield: number;
  /** The item it makes, for the icon on its button (C32). */
  readonly productId: string;
  readonly inputs: readonly CraftPartView[];
  /** Ticks one craft takes **by hand** — the recipe at `HAND_CRAFTING_SPEED`. */
  readonly craftTicks: number;
  /**
   * Ticks one craft takes by hand from raw materials: this craft and every
   * part under it, with none of the parts in the bag (2026-09-24, Factorio's
   * "total raw"). Equal to `craftTicks` for a recipe made of raw material only.
   */
  readonly rawCraftTicks: number;
  /**
   * How many the bag could pay for right now, capped at what one command may
   * ask for — counting what the bag could make of its missing parts first
   * (2026-09-24). Zero means the button is dead, and `inputs` says which line
   * is short.
   */
  readonly craftable: number;
  /**
   * How many of the product the bag could make, parts and all, with no cap:
   * the most crafts a chain could pay for, times `yield` (2026-09-24). What
   * the button's corner and the tooltip show.
   */
  readonly makeable: number;
  /**
   * Some of `craftable` needs its missing parts crafted first: a click queues
   * them ahead of it. An ingredient held short is then not a problem.
   */
  readonly chained: boolean;
  /**
   * Has research revealed it (C22)? A locked recipe is in the list anyway and
   * the panel hides its button, because the panel's buttons are a pool built
   * from the first view (§13): a recipe left out of that view would never
   * get one, and researching it would change nothing on screen. C23 noticed
   * that; C31 made every crafting recipe hand-craftable and so hit it.
   */
  readonly unlocked: boolean;
}

/** One ingredient of a hand-craft, with what the player holds against it. */
export interface CraftPartView {
  readonly itemId: string;
  readonly name: string;
  /** How many one craft needs. */
  readonly count: number;
  /** How many the player is carrying. */
  readonly held: number;
}

/** One order in the queue, head first. */
export interface CraftQueueView {
  /** Where in the queue this is. What `cancelCraft` is given (§7). */
  readonly index: number;
  readonly recipeId: string;
  readonly name: string;
  /** The item it makes, for its icon (C32). */
  readonly productId: string;
  /** How many are still to be made, including the one in progress. */
  readonly remaining: number;
  /**
   * A part made for the order after it, in a chain (2026-09-24). Its products
   * go to that order, and cancelling it cancels the chain.
   */
  readonly forChain: boolean;
  /**
   * How far through the current item, 0..1 — or `null` for an order that is
   * not at the head, because only the head is being worked on.
   *
   * Null rather than zero, for the reason `MachineView.progress` is null for
   * a chest (§13): a queued order is not 0% of the way through something, it
   * has not started.
   */
  readonly progress: number | null;
  /**
   * The head order has finished and the bag has no room for what it made.
   *
   * The one stalled state hand-crafting has, and it is on the view because
   * §13 says a status must always explain a stall — a bar sitting at 100%
   * with nothing happening is exactly the "bare idle" that rule forbids.
   */
  readonly blocked: boolean;
}

/**
 * One position in the bag: a stack, or an empty slot (2026-09-23).
 *
 * The bag is a grid the player arranges, so the panel draws `cells` in order
 * and a stack stays where it was put.
 */
export interface InventoryCellView {
  /** The slot, 0-based. What `moveStack` is given (§7). */
  readonly index: number;
  /** Null for an empty slot; every other field then describes nothing. */
  readonly itemId: string | null;
  readonly name: string;
  readonly count: number;
  readonly stackSize: number;
  /** The building this item places, or null. */
  readonly buildingId: string | null;
}

export interface InventoryView {
  /** Every slot of the bag, in order. Always `slots` long. */
  readonly cells: readonly InventoryCellView[];
  /** Every item in the game, in content order. See the file header. */
  readonly items: readonly InventorySlotView[];
  /** Slots in the bag, and how many are occupied. */
  readonly slots: number;
  readonly usedSlots: number;
  /** Everything the player's hands can make, in content order. */
  readonly crafts: readonly CraftOptionView[];
  /** What is being made, head first. Empty most of the time. */
  readonly queue: readonly CraftQueueView[];
}
