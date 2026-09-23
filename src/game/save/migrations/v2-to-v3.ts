import type { Migration, SaveDocument } from '../save-migrator.js';

/**
 * v2 -> v3: the player's bag became a grid of positioned stacks (2026-09-23).
 *
 * v2 wrote the bag as `[itemId, count]` totals, ascending by item id, and the
 * bag packed them as tightly as stack sizes allowed. v3 writes each occupied
 * slot as `[slot, itemId, count]`. This deals the totals into slots in the
 * order they were written, a full stack at a time: the same layout a v2 bag
 * would have got from adding its items to an empty grid one kind at a time.
 *
 * The stack sizes are **frozen here**, as they were when v3 was written,
 * rather than read from `data/items.ts`: a migration is a statement about the
 * past, and a later stack-size change must not change what an old save turns
 * into. An id this table does not know gets 50. The validator still has the
 * last word on what comes out.
 */
export const STACK_SIZES_AT_V3: Readonly<Record<string, number>> = Object.freeze({
  iron_ore: 50,
  copper_ore: 50,
  coal: 50,
  stone: 50,
  iron_plate: 100,
  copper_plate: 100,
  steel: 100,
  brick: 100,
  gear: 100,
  copper_wire: 200,
  circuit: 200,
  miner: 50,
  belt: 100,
  splitter: 50,
  inserter: 50,
  furnace: 50,
  assembler: 50,
  chest: 50,
  generator: 50,
  power_pole: 50,
  electric_furnace: 50,
  frame: 50,
  data_core: 200,
  lab: 50,
  miner_2: 50,
  assembler_2: 50,
  radar: 50,
  underground_belt: 100,
});

export const UNKNOWN_STACK_SIZE = 50;

export const v2ToV3: Migration = Object.freeze({
  from: 2,
  to: 3,
  describe: 'player inventory became positioned stacks: [slot, itemId, count]',
  migrate(save: SaveDocument): SaveDocument {
    const state = save['state'];
    if (!isRecord(state)) return { ...save, version: 3 };
    const player = state['player'];
    const inventory = isRecord(player) ? player['inventory'] : undefined;
    if (!isRecord(player) || !Array.isArray(inventory)) return { ...save, version: 3 };

    const names = new Map<number, string>();
    const table = state['itemIdMap'];
    if (isRecord(table)) {
      for (const [name, id] of Object.entries(table)) if (typeof id === 'number') names.set(id, name);
    }

    const cells: [number, number, number][] = [];
    for (const entry of inventory) {
      // Anything that is not a pair is left for the validator to refuse.
      if (!Array.isArray(entry) || entry.length !== 2) return { ...save, version: 3 };
      const [itemId, count] = entry as unknown[];
      if (typeof itemId !== 'number' || typeof count !== 'number' || !(count > 0)) return { ...save, version: 3 };
      const stackSize = STACK_SIZES_AT_V3[names.get(itemId) ?? ''] ?? UNKNOWN_STACK_SIZE;
      for (let left = count; left > 0; left -= stackSize) {
        cells.push([cells.length, itemId, Math.min(left, stackSize)]);
      }
    }

    return { ...save, version: 3, state: { ...state, player: { ...player, inventory: cells } } };
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
