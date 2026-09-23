import type { Migration, SaveDocument } from '../save-migrator.js';

/**
 * v5 -> v6: the quest log joined the metadata (C31).
 *
 * A v5 save was written before the quest chain existed, so it gets `null`:
 * nothing met yet. That is not the same as nothing done — a v5 factory may
 * already have a lab running — and it does not need to be, because a step
 * latches the first time the world says it is true. The first repaint after
 * loading ticks everything the factory has already got past.
 */
export const v5ToV6: Migration = Object.freeze({
  from: 5,
  to: 6,
  describe: 'added metadata.quests, the quest steps met in this world (null: none)',
  migrate(save: SaveDocument): SaveDocument {
    const metadata = save['metadata'];
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return { ...save, version: 6 };
    return { ...save, version: 6, metadata: { quests: null, ...(metadata as Record<string, unknown>) } };
  },
});
