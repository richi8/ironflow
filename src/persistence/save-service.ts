/**
 * The policy between the game and a `SaveRepository`. See ironflow.md C25.
 *
 * ```text
 *   main.ts ── serialize() ──> SaveService ──> SaveRepository ──> IndexedDB
 *                                  │
 *                                  └── TabLock: is this tab the writer?
 * ```
 *
 * The repository stores what it is given. This decides *what* to give it: the
 * `SaveFile` wrapper §14 defines, the id a slot lives under, whether this tab
 * is allowed to write at all, and which row of §14's failure table an
 * exception belongs to. Four small decisions with two callers — the save menu
 * and the autosave — which is what keeps them out of both.
 *
 * It deliberately knows nothing about `Simulation`. The caller hands it a
 * `SerializedGameState` and gets one back; turning that into a running world
 * is `save-serializer.ts`'s job and pausing the loop around it is the
 * composition root's. That boundary is what lets every test in this chunk run
 * without a game.
 */

import type { SerializedGameState } from '../game/save/save-format.js';
import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../game/save/save-format.js';

import {
  SaveError,
  asSaveError,
  type SaveKind,
  type SaveRepository,
  type SaveSlot,
} from './save-repository.js';
import type { TabLock } from './tab-lock.js';

/** What a caller has to supply to write a slot. */
export interface SaveRequest {
  readonly name: string;
  readonly kind: SaveKind;
  readonly state: SerializedGameState;
  /** The tick the snapshot was taken at — §14's playtime. */
  readonly playtimeTicks: number;
}

export interface SaveServiceOptions {
  readonly repository: SaveRepository;
  /**
   * The multi-tab lock (C25 task 6). Omitted, every write is allowed — which
   * is the right answer for a test, and for a browser with no
   * `BroadcastChannel`.
   */
  readonly lock?: TabLock | undefined;
  /** Wall clock, for `createdAt`. The one place a save is allowed a real one. */
  readonly now?: () => number;
}

export class SaveService {
  private readonly repository: SaveRepository;
  private readonly lock: TabLock | null;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: SaveServiceOptions) {
    this.repository = options.repository;
    this.lock = options.lock ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /** Every slot, newest first. Never reads a save body (C25 task 2). */
  async list(): Promise<readonly SaveSlot[]> {
    try {
      return await this.repository.list();
    } catch (cause) {
      throw asSaveError(cause);
    }
  }

  /**
   * Write a slot. Refuses when another tab holds the lock.
   *
   * The refusal is a `SaveError('locked')` rather than a silent no-op,
   * because §7's rule about commands is the same rule here: an invisible
   * rejection is how a player discovers three hours later that nothing was
   * being saved.
   */
  async write(id: string, request: SaveRequest): Promise<SaveSlot> {
    if (this.lock !== null && !this.lock.isPrimary()) {
      // Only wait if the answer has not come back yet; a settled `secondary`
      // is a decision, not a delay.
      const state = await this.lock.ready();
      if (state !== 'primary') {
        throw new SaveError('locked', 'Another tab is the one saving this game.');
      }
    }

    const file: SaveFile = {
      format: SAVE_FORMAT,
      version: SAVE_VERSION,
      metadata: {
        name: request.name,
        createdAt: this.now(),
        playtimeTicks: request.playtimeTicks,
        // §14 lists a thumbnail as optional and C25 task 2 leaves the decision
        // here: no. A data URL of the canvas is tens of kilobytes per slot
        // against a whole factory's 150 kB, it cannot be produced from
        // `game/` at all, and the save menu reads perfectly well without one.
        thumbnail: null,
      },
      state: request.state,
    };

    try {
      return await this.repository.save(id, file, request.kind);
    } catch (cause) {
      throw asSaveError(cause);
    }
  }

  /** Read a slot's file back. The caller deserializes it. */
  async read(id: string): Promise<SaveFile> {
    try {
      return await this.repository.load(id);
    } catch (cause) {
      throw asSaveError(cause);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.repository.delete(id);
    } catch (cause) {
      throw asSaveError(cause);
    }
  }

  async rename(id: string, name: string): Promise<SaveSlot> {
    try {
      return await this.repository.rename(id, name.trim() === '' ? 'Untitled' : name.trim());
    } catch (cause) {
      throw asSaveError(cause);
    }
  }

  /**
   * A fresh key for a manual save.
   *
   * Wall clock plus a counter, rather than a count of existing slots: a slot
   * numbered by position is a slot that collides the moment one in the middle
   * is deleted, and the collision silently overwrites a factory.
   */
  newManualId(): string {
    this.sequence += 1;
    return `manual-${this.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  /** May this tab write right now? The save menu greys its buttons on it. */
  canWrite(): boolean {
    return this.lock === null || this.lock.isPrimary();
  }

  /** Become the writing tab (C25 task 6). The other tab stands down. */
  takeOver(): void {
    this.lock?.takeOver();
  }

  close(): void {
    this.repository.close();
    this.lock?.close();
  }
}
