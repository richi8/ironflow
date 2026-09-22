/**
 * The test double. See ironflow.md C25 task 1.
 *
 * A `Map` where the browser has a database, and otherwise the same object: it
 * goes through `save-codec.ts`, so what it holds is the same gzipped bytes
 * with the same flag, and a contract test cannot pass here for a reason that
 * would not also hold in Chrome. A double that stored live objects would
 * "pass" a round trip that never serialized anything.
 *
 * It is also the answer to §14's first row on the *player's* side: with
 * IndexedDB blocked, the game keeps running against one of these, so the
 * factory is still saveable and exportable (C26) for as long as the tab lives.
 */

import type { SaveFile } from '../game/save/save-format.js';

import { decodeSave, encodeSave, type EncodedSave, type SaveBytes } from './save-codec.js';
import {
  SaveError,
  slotMetadata,
  type SaveKind,
  type SaveRepository,
  type SaveSlot,
} from './save-repository.js';

interface Record_ {
  readonly slot: SaveSlot;
  readonly encoded: EncodedSave;
}

export interface MemorySaveRepositoryOptions {
  /** Wall clock, for `updatedAt`. Injected so a test can pin a timestamp. */
  readonly now?: () => number;
  /**
   * Throw this instead of writing. The quota path of §14's table, with no
   * browser required — and, because `save` throws *before* it touches the
   * map, the existing save is untouched exactly as the real one guarantees.
   */
  readonly failWrites?: SaveError | null;
}

export class MemorySaveRepository implements SaveRepository {
  private readonly records = new Map<string, Record_>();
  private readonly now: () => number;

  /** Set at any time to simulate storage going wrong mid-session. */
  failWrites: SaveError | null;

  /** How many times a save body has been read. The listing must not move it. */
  bodyReads = 0;

  constructor(options: MemorySaveRepositoryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failWrites = options.failWrites ?? null;
  }

  async list(): Promise<readonly SaveSlot[]> {
    // Sorted out of the map rather than iterated in insertion order, for the
    // reason §6 R4 gives about maps: insertion order is a property of how the
    // session went, not of the data.
    return [...this.records.values()]
      .map((record) => record.slot)
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async save(id: string, save: SaveFile, kind: SaveKind): Promise<SaveSlot> {
    const encoded = await encodeSave(save);
    if (this.failWrites !== null) throw this.failWrites;
    const previous = this.records.get(id);
    const slot: SaveSlot = {
      id,
      kind,
      version: save.version,
      playtimeTicks: save.metadata.playtimeTicks,
      createdAt: previous?.slot.createdAt ?? save.metadata.createdAt,
      updatedAt: this.now(),
      name: save.metadata.name,
      bytes: encoded.bytes.byteLength,
      compressed: encoded.compressed,
      thumbnail: save.metadata.thumbnail,
    };
    this.records.set(id, { slot, encoded });
    return slot;
  }

  async load(id: string): Promise<SaveFile> {
    const record = this.records.get(id);
    if (record === undefined) throw new SaveError('not_found', `There is no save under "${id}".`);
    this.bodyReads += 1;
    const file = await decodeSave(record.encoded);
    return { ...file, metadata: { ...file.metadata, ...slotMetadata(record.slot) } };
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async rename(id: string, name: string): Promise<SaveSlot> {
    const record = this.records.get(id);
    if (record === undefined) throw new SaveError('not_found', `There is no save under "${id}".`);
    const slot: SaveSlot = { ...record.slot, name };
    this.records.set(id, { slot: slot, encoded: record.encoded });
    return slot;
  }

  close(): void {
    // Nothing to release. Declared so the two implementations are one type.
  }

  /** Corrupt a stored body, to exercise §14's "refuse and keep it" row. */
  poison(id: string, bytes: SaveBytes, compressed = false): void {
    const record = this.records.get(id);
    if (record === undefined) throw new SaveError('not_found', `There is no save under "${id}".`);
    this.records.set(id, { slot: record.slot, encoded: { bytes, compressed } });
  }
}
