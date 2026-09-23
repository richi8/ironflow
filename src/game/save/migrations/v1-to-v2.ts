import type { Migration, SaveDocument } from '../save-migrator.js';

/**
 * v1 -> v2: the hotbar layout joined the metadata (2026-09-23).
 *
 * A v1 save was written before the player could arrange the hotbar, so it
 * gets `null`, which means the default layout — exactly the hotbar that save
 * was played with. A metadata that is not an object is left alone for the
 * validator to refuse in its own words; a migration fixes what it came for
 * and nothing else.
 */
export const v1ToV2: Migration = Object.freeze({
  from: 1,
  to: 2,
  describe: 'added metadata.hotbar, the player’s hotbar layout (null: the default)',
  migrate(save: SaveDocument): SaveDocument {
    const metadata = save['metadata'];
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { ...save, version: 2 };
    }
    return { ...save, version: 2, metadata: { hotbar: null, ...(metadata as Record<string, unknown>) } };
  },
});
