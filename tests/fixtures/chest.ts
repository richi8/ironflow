import type { GridEntry } from '../../src/game/items/inventory.js';

/**
 * A chest's contents from `[itemId, count]` totals, dealt into slots a stack
 * at a time from slot 0 — the layout a chest filled by an inserter gets.
 *
 * Chests have been grids since 2026-09-23 (`GridInventory`). Tests that set
 * up a chest think in totals — "a full chest of iron" — and this turns that
 * into the positioned form without every test doing the stack arithmetic.
 */
export function stacked(
  simulation: { readonly items: { readonly stackSizeOf: (itemId: number) => number } },
  pairs: readonly (readonly [number, number])[],
): GridEntry[] {
  const entries: GridEntry[] = [];
  for (const [itemId, count] of pairs) {
    const stackSize = simulation.items.stackSizeOf(itemId);
    for (let left = count; left > 0; left -= stackSize) {
      entries.push([entries.length, itemId, Math.min(left, stackSize)]);
    }
  }
  return entries;
}

/** How many of `itemId` a chest's contents hold, across every stack. */
export function heldIn(
  contents: readonly (readonly [number, number, number])[] | undefined,
  itemId: number,
): number {
  let total = 0;
  for (const entry of contents ?? []) if (entry[1] === itemId) total += entry[2];
  return total;
}
