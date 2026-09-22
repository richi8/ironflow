/**
 * Saves in the browser. See ironflow.md C25 tasks 1, 2 and 5, and §14.
 *
 * About a hundred and fifty lines of promisified requests and no wrapper
 * library, which §3's dependency policy asks for in as many words: an
 * IndexedDB wrapper is tedious rather than hard, and the tedious part is
 * exactly the part that has to be read to know whether a quota failure
 * destroyed the previous save.
 *
 * ## Two object stores (task 2)
 *
 * ```text
 *   metadata   id -> SaveSlot          name, tick, playtime, size, timestamps
 *   saves      id -> { compressed, bytes }
 * ```
 *
 * Split because "listing must not deserialize save blobs": fifty factories is
 * fifty megabytes of `getAll` if the name lives beside the state, and the save
 * menu asks for the list every time it opens. Keeping them apart makes the
 * listing a read of fifty small records and makes the acceptance criterion —
 * fifty saves in under 50 ms — a property of the schema rather than of a
 * lucky cache.
 *
 * ## Why one transaction covers both stores
 *
 * §14: "`QuotaExceededError` on save — surface it, offer export-to-file, do
 * not destroy the existing save by writing a truncated one." A transaction
 * that spans both puts is how that is guaranteed rather than hoped for: if the
 * body put is refused the whole transaction **aborts**, the metadata put is
 * rolled back with it, and what is on disk is exactly the save that was there
 * before. Two separate transactions would leave the slot advertising a
 * playtime whose factory no longer exists.
 *
 * ## Nothing is awaited inside a transaction
 *
 * An IndexedDB transaction commits as soon as its request queue drains, so an
 * `await` on anything that is not one of its own requests closes it and the
 * next `put` throws `TransactionInactiveError`. Compression therefore happens
 * *before* the transaction opens and decoding *after* it finishes — which is
 * also why `save` and `load` each take exactly one trip.
 */

import type { SaveFile } from '../game/save/save-format.js';

import { decodeSave, encodeSave, type EncodedSave, type SaveBytes } from './save-codec.js';
import {
  SaveError,
  asSaveError,
  slotMetadata,
  type SaveKind,
  type SaveRepository,
  type SaveSlot,
} from './save-repository.js';

/** The database, and the two stores inside it. */
export const DATABASE_NAME = 'ironflow';
export const DATABASE_VERSION = 1;
const META_STORE = 'metadata';
const BODY_STORE = 'saves';

/** What a body record holds. The slot beside it holds everything else. */
interface BodyRecord {
  readonly id: string;
  readonly compressed: boolean;
  readonly bytes: SaveBytes;
}

export interface IndexedDbSaveRepositoryOptions {
  /**
   * The IndexedDB implementation. Defaults to `globalThis.indexedDB`, and is
   * injected so the failure paths §14 lists — unavailable, quota, corrupt —
   * can be tested without a browser. C25's tests supply a small fake.
   */
  readonly factory?: IDBFactory | undefined;
  readonly databaseName?: string;
  /** Wall clock, for `updatedAt`. Injected so a test can pin a timestamp. */
  readonly now?: () => number;
}

export class IndexedDbSaveRepository implements SaveRepository {
  private readonly db: IDBDatabase;
  private readonly now: () => number;
  private closed = false;

  private constructor(db: IDBDatabase, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /**
   * Open the database, or say why not.
   *
   * §14's first row: "IndexedDB unavailable (private mode, blocked) — detect
   * at startup, tell the player clearly, keep the game playable." Detecting it
   * means *trying*, because Safari in private mode has an `indexedDB` object
   * that errors on open, so a `typeof` check answers the wrong question.
   */
  static async open(options: IndexedDbSaveRepositoryOptions = {}): Promise<IndexedDbSaveRepository> {
    const factory = options.factory ?? safeGlobalFactory();
    if (factory === null) {
      throw new SaveError('unavailable', 'This browser has no IndexedDB.');
    }

    const name = options.databaseName ?? DATABASE_NAME;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let open: IDBOpenDBRequest;
      try {
        open = factory.open(name, DATABASE_VERSION);
      } catch (cause) {
        reject(new SaveError('unavailable', 'IndexedDB refused to open.', { cause }));
        return;
      }
      open.onupgradeneeded = () => {
        const upgrading = open.result;
        if (!upgrading.objectStoreNames.contains(META_STORE)) upgrading.createObjectStore(META_STORE, { keyPath: 'id' });
        if (!upgrading.objectStoreNames.contains(BODY_STORE)) upgrading.createObjectStore(BODY_STORE, { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new SaveError('unavailable', 'IndexedDB refused to open.', { cause: open.error }));
      // Another tab is holding the old schema open. C25 task 6 warns about
      // that tab; here it is simply a database we cannot have.
      open.onblocked = () => reject(new SaveError('unavailable', 'Another tab is blocking a database upgrade.'));
    });

    return new IndexedDbSaveRepository(db, options.now ?? (() => Date.now()));
  }

  async list(): Promise<readonly SaveSlot[]> {
    const rows = await this.run(META_STORE, 'readonly', (store) => store.getAll() as IDBRequest<SaveSlot[]>);
    // Newest first, with the id as the tie-break so the order is total and a
    // list does not reshuffle between two openings of the panel.
    return rows
      .slice()
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async save(id: string, save: SaveFile, kind: SaveKind): Promise<SaveSlot> {
    // Before the transaction: see the header. Compression is async and would
    // close a transaction that was already open.
    const encoded = await encodeSave(save);
    const previous = await this.peek(id);
    const at = this.now();
    const slot: SaveSlot = {
      id,
      kind,
      version: save.version,
      playtimeTicks: save.metadata.playtimeTicks,
      createdAt: previous?.createdAt ?? save.metadata.createdAt,
      updatedAt: at,
      name: save.metadata.name,
      bytes: encoded.bytes.byteLength,
      compressed: encoded.compressed,
      thumbnail: save.metadata.thumbnail,
    };
    const body: BodyRecord = { id, compressed: encoded.compressed, bytes: encoded.bytes };

    await this.transact([META_STORE, BODY_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).put(slot);
      tx.objectStore(BODY_STORE).put(body);
    });
    return slot;
  }

  async load(id: string): Promise<SaveFile> {
    const [slot, body] = await this.transact([META_STORE, BODY_STORE], 'readonly', (tx) => {
      const meta = tx.objectStore(META_STORE).get(id) as IDBRequest<SaveSlot | undefined>;
      const record = tx.objectStore(BODY_STORE).get(id) as IDBRequest<BodyRecord | undefined>;
      return () => [meta.result, record.result] as const;
    });

    if (slot === undefined || body === undefined) {
      throw new SaveError('not_found', `There is no save under "${id}".`);
    }
    // Decoding is outside the transaction, and a failure here leaves the blob
    // exactly where it was — §14: "refuse and keep the corrupt blob for export
    // rather than deleting it."
    const encoded: EncodedSave = { bytes: toBytes(body.bytes), compressed: body.compressed === true };
    const file = await decodeSave(encoded);
    // The listing is what the player picked from, so the file answers with the
    // name they saw rather than the one it was written under.
    return { ...file, metadata: { ...file.metadata, ...slotMetadata(slot) } };
  }

  /** The stored bytes, whatever they turn out to be. See `SaveRepository`. */
  async loadRaw(id: string): Promise<EncodedSave> {
    const body = await this.run(BODY_STORE, 'readonly', (store) => store.get(id) as IDBRequest<BodyRecord | undefined>);
    if (body === undefined) throw new SaveError('not_found', `There is no save under "${id}".`);
    return { bytes: toBytes(body.bytes), compressed: body.compressed === true };
  }

  async delete(id: string): Promise<void> {
    await this.transact([META_STORE, BODY_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(BODY_STORE).delete(id);
    });
  }

  async rename(id: string, name: string): Promise<SaveSlot> {
    const previous = await this.peek(id);
    if (previous === undefined) throw new SaveError('not_found', `There is no save under "${id}".`);
    const slot: SaveSlot = { ...previous, name };
    await this.transact([META_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).put(slot);
    });
    return slot;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** One slot's metadata, without its body. */
  private async peek(id: string): Promise<SaveSlot | undefined> {
    return this.run(META_STORE, 'readonly', (store) => store.get(id) as IDBRequest<SaveSlot | undefined>);
  }

  /** A single-request transaction, which is most of them. */
  private async run<T>(store: string, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.transact([store], mode, (tx) => {
      const request = body(tx.objectStore(store));
      return () => request.result;
    });
  }

  /**
   * Run `body` in one transaction and settle when the transaction does.
   *
   * The result is read from a thunk rather than from the request's promise so
   * that it is taken **after** `oncomplete`: a value read from a request whose
   * transaction later aborted is a value that was never stored.
   */
  private async transact<T>(
    stores: readonly string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => (() => T) | void,
  ): Promise<T> {
    if (this.closed) throw new SaveError('unavailable', 'The save database has been closed.');
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(stores.slice(), mode);
      } catch (cause) {
        reject(asSaveError(cause, 'unavailable'));
        return;
      }
      let read: (() => T) | void;
      try {
        read = body(tx);
      } catch (cause) {
        // A synchronous throw from `put` — quota is reported this way by some
        // builds — must still abort rather than leave the transaction open.
        try {
          tx.abort();
        } catch {
          // Already aborting. Nothing to do, and nothing to hide: the
          // rejection below is the failure the caller acts on.
        }
        reject(asSaveError(cause));
        return;
      }
      tx.oncomplete = () => resolve(read === undefined ? (undefined as T) : read());
      tx.onabort = () => reject(asSaveError(tx.error));
      tx.onerror = () => reject(asSaveError(tx.error));
    });
  }
}

/** `globalThis.indexedDB`, or null where reaching for it throws. */
function safeGlobalFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    // Some hardened configurations throw on the property access itself.
    return null;
  }
}

/**
 * A stored body as bytes, whatever shape structured clone handed back.
 *
 * The cast is the one place this file asserts something the type system
 * cannot check: what came out of the store is what `encodeSave` put in, which
 * is never backed by a `SharedArrayBuffer` — see `SaveBytes`.
 */
function toBytes(value: unknown): SaveBytes {
  if (value instanceof Uint8Array) return value as SaveBytes;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new SaveError('corrupt', 'The stored save is not a byte array.');
}
