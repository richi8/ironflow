import type { Migration, SaveDocument } from '../save-migrator.js';

/**
 * v4 -> v5: the player gained `pickingUp`, whether F is held (2026-09-23).
 *
 * A v4 save was written before F existed, so nobody was holding it: the
 * field is added as `false`. Anything malformed is left for the validator.
 */
export const v4ToV5: Migration = Object.freeze({
  from: 4,
  to: 5,
  describe: 'the player gained pickingUp (F held), false for older saves',
  migrate(save: SaveDocument): SaveDocument {
    const state = save['state'];
    if (!isRecord(state) || !isRecord(state['player'])) return { ...save, version: 5 };
    return { ...save, version: 5, state: { ...state, player: { ...state['player'], pickingUp: false } } };
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
