/**
 * What storage looks like from the outside. See ironflow.md C25 task 1 and §14.
 *
 * ```text
 *   SaveService  ->  SaveRepository  ->  IndexedDB  (the browser)
 *                                    ->  a Map      (the tests)
 * ```
 *
 * One interface, two implementations, one set of contract tests run against
 * both. That is the whole reason this file exists as a file: the game is wired
 * to the interface, so every failure path below can be exercised headlessly
 * and the browser implementation is not the only thing standing between a
 * factory and a lost afternoon.
 *
 * ## Why `list()` does not return `SaveMetadata`
 *
 * C25 task 1 writes it as `list(): Promise<SaveMetadata[]>`, and the plan's
 * own task 2 is why that is not enough: "listing must not deserialize save
 * blobs", so the listing is the *only* thing the save menu sees — and a row
 * the player can click has to carry the id `load()` wants. `SaveSlot` is
 * `SaveMetadata` plus the three facts that belong to storage rather than to
 * the file: which key it is under, whether it is an autosave, and how many
 * bytes it took. See C25's deviations.
 */

import type { SaveFile, SaveMetadata } from '../game/save/save-format.js';

import type { EncodedSave } from './save-codec.js';

/**
 * Manual saves and autosaves are the same file in different slots.
 *
 * The distinction is storage policy and nothing else — §14 says autosave
 * rotates through three slots and never overwrites a manual save, and a flag
 * on the record is how the rotation knows which keys are its own.
 */
export type SaveKind = 'manual' | 'auto';

/** One row of the save list: what is known without reading the state (§14). */
export interface SaveSlot {
  /** The storage key. `load`, `delete` and `rename` all take this. */
  readonly id: string;
  readonly kind: SaveKind;
  /** The save schema version the blob was written with. */
  readonly version: number;
  /** Simulation ticks the save was taken at — its playtime (§14). */
  readonly playtimeTicks: number;
  /** Wall-clock milliseconds the file was first written. */
  readonly createdAt: number;
  /** Wall-clock milliseconds it was last written. Newest-first ordering. */
  readonly updatedAt: number;
  readonly name: string;
  /** Size of the stored body. Compressed size when `compressed`. */
  readonly bytes: number;
  /** Did `CompressionStream` exist when this was written? C25 task 3. */
  readonly compressed: boolean;
  readonly thumbnail: string | null;
}

/**
 * The metadata half of a slot, laid over the stored body's on load, so a
 * rename is seen without rewriting the body. The hotbar (v2) is not in a
 * slot — the list never needs it — so it comes from the body untouched.
 */
export function slotMetadata(slot: SaveSlot): Omit<SaveMetadata, 'hotbar'> {
  return {
    name: slot.name,
    createdAt: slot.createdAt,
    playtimeTicks: slot.playtimeTicks,
    thumbnail: slot.thumbnail,
  };
}

/**
 * Storage. C25 task 1.
 *
 * `rename` is the fifth method the plan's four did not name, and it is task
 * 7's: the save menu offers a rename, and doing it by `load` + `save` would
 * rewrite a whole factory to change a string — and would lose it if the tab
 * died between the two.
 */
export interface SaveRepository {
  /** Every slot, newest first. Must not read a single save blob (task 2). */
  list(): Promise<readonly SaveSlot[]>;
  /** Write `save` under `id`, replacing whatever was there. */
  save(id: string, save: SaveFile, kind: SaveKind): Promise<SaveSlot>;
  /** Read one back. Throws `SaveError('not_found')` if it is not there. */
  load(id: string): Promise<SaveFile>;
  /**
   * The stored bytes, undecoded. C26's export, and §14's promise about them.
   *
   * §14 says a corrupt save is "refused and kept for export rather than
   * deleted", and a corrupt save is by definition one `load` will not return
   * — so the promise is only real if something can read a slot without
   * understanding it. This is that something, and it is the *only* method
   * here that does not care what it is holding.
   */
  loadRaw(id: string): Promise<EncodedSave>;
  /** Remove one. Removing something that is not there is not an error. */
  delete(id: string): Promise<void>;
  /** Change a slot's name without touching its state. */
  rename(id: string, name: string): Promise<SaveSlot>;
  /** Release the underlying connection. Idempotent. */
  close(): void;
}

/* -------------------------------------------------------------------------- *
 * Failure
 * -------------------------------------------------------------------------- */

/**
 * Why a save operation failed, as one of §14's rows rather than as a string.
 *
 * C25 task 5: "Each one gets a specific, actionable player-facing message —
 * never a silent failure, never a bare `catch {}`." A code rather than a
 * message because the *caller* decides what to offer — a quota failure in the
 * save menu can suggest exporting (C26), the same failure during an autosave
 * can only say so — and because a message the UI has to string-match is a
 * message nobody may ever reword.
 */
export type SaveErrorCode =
  /** IndexedDB is missing or refused to open. Private mode, or blocked. */
  | 'unavailable'
  /** `QuotaExceededError`. The existing save is untouched. */
  | 'quota'
  /** No slot under that id. */
  | 'not_found'
  /** Stored bytes that are not a save of ours. Kept, never deleted (§14). */
  | 'corrupt'
  /** A save written by a newer build than this one. C27 migrates the past. */
  | 'unsupported'
  /** Another tab holds the write lock (C25 task 6). */
  | 'locked'
  /** Anything else the storage layer reported. */
  | 'io';

/** A storage failure, carrying the row of §14's table it belongs to. */
export class SaveError extends Error {
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveError';
    this.code = code;
  }
}

/**
 * The sentence a player reads. C25 task 5.
 *
 * Every one of them says what happened **and** what to do about it, because a
 * message that only names the problem is how a lost factory feels like the
 * game's fault twice.
 */
export function saveErrorMessage(error: unknown): string {
  const code = error instanceof SaveError ? error.code : 'io';
  switch (code) {
    case 'unavailable':
      return 'Storage is unavailable — private browsing blocks it. The game still runs; export your save to a file to keep it.';
    case 'quota':
      return 'Out of storage space. Your existing save is untouched — delete an old save, or export this one to a file.';
    case 'not_found':
      return 'That save is no longer there. The list has been refreshed.';
    case 'corrupt':
      return 'That save could not be read. It has been kept, not deleted, so it can still be exported.';
    case 'unsupported':
      return 'That save was written by a newer version of IronFlow. Update the game to open it.';
    case 'locked':
      return 'Another tab has this game open and is the one saving. Close it, or take over from this tab.';
    default:
      return 'Saving failed. Your existing save is untouched — try again, or export to a file.';
  }
}

/**
 * Any thrown thing as a `SaveError`, with `QuotaExceededError` recognised.
 *
 * The quota check is by `name` rather than by `instanceof DOMException`,
 * because the exception arrives through an IndexedDB *event* whose `error` is
 * whatever the browser built — and because a repository must behave the same
 * under a fake one in the tests as under Chrome. Firefox's legacy
 * `NS_ERROR_DOM_QUOTA_REACHED` is the same answer by another name.
 */
export function asSaveError(cause: unknown, fallback: SaveErrorCode = 'io'): SaveError {
  if (cause instanceof SaveError) return cause;
  const name = cause instanceof Error ? cause.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new SaveError('quota', 'The browser refused the write: storage quota exceeded.', { cause });
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new SaveError(fallback, detail === '' ? 'Storage failed.' : detail, { cause });
}
