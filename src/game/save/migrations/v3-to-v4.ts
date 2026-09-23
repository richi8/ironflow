import type { Migration, SaveDocument } from '../save-migrator.js';

import { STACK_SIZES_AT_V3, UNKNOWN_STACK_SIZE } from './v2-to-v3.js';

/**
 * v3 -> v4: chests became grids of positioned stacks, like the bag (2026-09-23).
 *
 * v3 wrote a chest's `contents` as `[itemId, count]` totals, ascending by item
 * id. v4 writes `[slot, itemId, count]` per occupied slot. The totals are
 * dealt into slots a stack at a time in the order they were written, exactly
 * as v2 -> v3 did for the bag, with the same frozen stack sizes: nothing
 * changed stack size between the two.
 *
 * `4` is the chest's `EntityType`, written as a literal because a migration
 * is about the file as it was, and `entity-types.ts` promises the number never
 * moves anyway. Anything malformed is left for the validator to refuse.
 */
const CHEST_TYPE = 4;

export const v3ToV4: Migration = Object.freeze({
  from: 3,
  to: 4,
  describe: 'chest contents became positioned stacks: [slot, itemId, count]',
  migrate(save: SaveDocument): SaveDocument {
    const state = save['state'];
    if (!isRecord(state) || !Array.isArray(state['entities'])) return { ...save, version: 4 };

    const names = new Map<number, string>();
    const table = state['itemIdMap'];
    if (isRecord(table)) {
      for (const [name, id] of Object.entries(table)) if (typeof id === 'number') names.set(id, name);
    }

    const entities = (state['entities'] as unknown[]).map((entity) => {
      if (!isRecord(entity) || entity['type'] !== CHEST_TYPE || !Array.isArray(entity['contents'])) return entity;
      const cells = dealt(entity['contents'] as unknown[], names);
      return cells === null ? entity : { ...entity, contents: cells };
    });
    return { ...save, version: 4, state: { ...state, entities } };
  },
});

/** Pairs dealt into slots a stack at a time, or null for anything that is not pairs. */
function dealt(pairs: readonly unknown[], names: ReadonlyMap<number, string>): [number, number, number][] | null {
  const cells: [number, number, number][] = [];
  for (const entry of pairs) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [itemId, count] = entry as unknown[];
    if (typeof itemId !== 'number' || typeof count !== 'number' || !(count > 0)) return null;
    const stackSize = STACK_SIZES_AT_V3[names.get(itemId) ?? ''] ?? UNKNOWN_STACK_SIZE;
    for (let left = count; left > 0; left -= stackSize) {
      cells.push([cells.length, itemId, Math.min(left, stackSize)]);
    }
  }
  return cells;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
