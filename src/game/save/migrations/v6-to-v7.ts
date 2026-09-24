import type { Migration, SaveDocument } from '../save-migrator.js';

/**
 * v6 -> v7: a craft order says what it owes the orders after it (2026-09-24).
 *
 * Hand-crafting learned to make the missing parts of a recipe first, and a
 * part made for a chain goes to the next order rather than the bag — the
 * order's `feeds`. A v6 queue was written before chains existed, so every
 * order in it was one the player asked for and owes nothing: `feeds: 0`.
 */
export const v6ToV7: Migration = Object.freeze({
  from: 6,
  to: 7,
  describe: "added state.player.crafts[].feeds, what a hand-craft owes a chain (0: nothing)",
  migrate(save: SaveDocument): SaveDocument {
    const state = objectOf(save['state']);
    const player = objectOf(state?.['player']);
    const crafts = player?.['crafts'];
    if (state === null || player === null || !Array.isArray(crafts)) return { ...save, version: 7 };
    const migrated = crafts.map((order: unknown) => {
      const fields = objectOf(order);
      return fields === null ? order : { feeds: 0, ...fields };
    });
    return { ...save, version: 7, state: { ...state, player: { ...player, crafts: migrated } } };
  },
});

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
