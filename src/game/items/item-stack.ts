/**
 * Item stacks and a bag of item counts. See ironflow.md C06 tasks 1 and 6.
 *
 * **Partly scaffolding.** `ItemStack` is permanent — it is how every piece of
 * content data from here on names a quantity of something (build costs now,
 * recipe inputs and outputs from C16). `ItemCounts` is not: C08 brings the real
 * `Inventory`, with stack limits, a slot count, and the separate machine-buffer
 * variant that keeps "why is my furnace stuck" bugs out of the game. This is
 * the smallest thing that can answer the two questions C06 must ask — *can the
 * player pay for this building, and here is the refund* — without pre-empting
 * that chunk's decisions.
 *
 * Item ids are strings here. C08 gives every item a numeric runtime id and
 * moves inventories, belts and saves onto it; content data and the UI keep the
 * string form, which is what a build cost is.
 */

/** A quantity of one kind of item. Plain data: it goes straight into a save. */
export interface ItemStack {
  readonly itemId: string;
  readonly count: number;
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}.`);
  }
}

/**
 * How many of each item the player is holding.
 *
 * Backed by a `Map`, which is safe here because nothing iterates it inside a
 * tick: every question is asked about a specific item id, and the one traversal
 * — `toJSON` — sorts its keys, so two bags that reached the same contents by
 * different routes serialize identically (§6 R4, and C08's acceptance criterion
 * ahead of time). A count that reaches zero is deleted rather than kept at 0,
 * for the same reason.
 */
export class ItemCounts {
  private readonly counts = new Map<string, number>();

  /** How many of one item are held. Zero for anything never seen. */
  count(itemId: string): number {
    return this.counts.get(itemId) ?? 0;
  }

  /** Add items. Returns the amount added, which in C06 is always all of them. */
  add(itemId: string, amount: number): number {
    assertCount(amount, 'ItemCounts.add: amount');
    if (amount === 0) return 0;
    this.counts.set(itemId, this.count(itemId) + amount);
    return amount;
  }

  /**
   * Remove up to `amount` items. Returns how many were actually removed.
   *
   * Partial and honest rather than throwing, which is the rule C08 states for
   * the real inventory: a caller that asks for more than exists gets the
   * remainder and is told what it got.
   */
  remove(itemId: string, amount: number): number {
    assertCount(amount, 'ItemCounts.remove: amount');
    const held = this.count(itemId);
    const taken = Math.min(held, amount);
    if (taken === 0) return 0;
    if (taken === held) {
      this.counts.delete(itemId);
    } else {
      this.counts.set(itemId, held - taken);
    }
    return taken;
  }

  /** Could `cost` be paid in full right now? */
  canAfford(cost: readonly ItemStack[]): boolean {
    for (const stack of cost) {
      if (this.count(stack.itemId) < stack.count) return false;
    }
    return true;
  }

  /**
   * Pay `cost` in full, or change nothing and return false.
   *
   * All-or-nothing on purpose: a partial payment would take the iron plates for
   * a building that is never placed, and the player would have no way to tell
   * where they went.
   */
  take(cost: readonly ItemStack[]): boolean {
    if (!this.canAfford(cost)) return false;
    for (const stack of cost) {
      this.remove(stack.itemId, stack.count);
    }
    return true;
  }

  /** Hand `cost` back — a refund, which in v1 is always the full amount. */
  give(cost: readonly ItemStack[]): void {
    for (const stack of cost) {
      this.add(stack.itemId, stack.count);
    }
  }

  isEmpty(): boolean {
    return this.counts.size === 0;
  }

  /** Plain, sorted by item id, and therefore byte-stable across runs (§6). */
  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const itemId of [...this.counts.keys()].sort()) {
      out[itemId] = this.count(itemId);
    }
    return out;
  }
}
