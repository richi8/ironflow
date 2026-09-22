/**
 * Every three minutes, into three slots. See ironflow.md C25 task 4 and §14.
 *
 * > Autosave — every 3 minutes and on `visibilitychange` to hidden, into a
 * > rotating set of 3 autosave slots, never overwriting a manual save.
 *
 * Three slots rather than one because the failure an autosave is insurance
 * against is not only a crash: it is also a mistake the player made ninety
 * seconds ago and has already saved over. Rotation costs three times the disk
 * — half a megabyte at §12's reference factory — and buys a nine-minute
 * window to notice.
 *
 * ## It is driven by the frame loop, not by `setInterval`
 *
 * §8 says the game does not run in a background tab, so a timer would go on
 * firing against a simulation that is not advancing, and an autosave taken
 * five minutes into a backgrounded tab would be three identical copies of the
 * same tick. Counting the same milliseconds the renderer counts means "every
 * three minutes" is three minutes *of play*, which is what the player would
 * mean by it.
 *
 * ## Rotation survives a reload
 *
 * `prime` reads the existing slots and starts from the oldest, so the first
 * autosave after a restart overwrites the stalest copy rather than the one
 * that was written thirty seconds before the crash — which is precisely the
 * one worth keeping.
 */

import type { SaveSlot } from './save-repository.js';

/** §14's interval. */
export const AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000;

/** §14's slot count. */
export const AUTOSAVE_SLOTS = 3;

/** The key of autosave slot `index`, 0-based. */
export function autosaveId(index: number): string {
  return `auto-${index + 1}`;
}

/** Every autosave key, in rotation order. */
export const AUTOSAVE_IDS: readonly string[] = Object.freeze(
  Array.from({ length: AUTOSAVE_SLOTS }, (_unused, index) => autosaveId(index)),
);

/**
 * Is `id` one of the rotating slots?
 *
 * Membership of the fixed list, not a prefix test: "never overwriting a manual
 * save" has to hold for a player who names their save `auto-pilot`, and a
 * `startsWith('auto-')` would quietly eat it.
 */
export function isAutosaveId(id: string): boolean {
  return AUTOSAVE_IDS.includes(id);
}

export interface AutosaveOptions {
  /** Take and store one autosave. Rejections are reported, never thrown here. */
  readonly write: (id: string) => Promise<unknown>;
  /** Told about a failed autosave, so the UI can say so once (task 5). */
  readonly onError?: (error: unknown) => void;
  readonly intervalMs?: number;
  /** The rotation. Defaults to `AUTOSAVE_IDS`; injected for tests. */
  readonly ids?: readonly string[];
}

export class Autosave {
  private readonly options: AutosaveOptions;
  private readonly ids: readonly string[];
  private readonly intervalMs: number;

  private elapsedMs = 0;
  private cursor = 0;
  private writing = false;
  private enabled = true;

  constructor(options: AutosaveOptions) {
    this.options = options;
    this.ids = options.ids ?? AUTOSAVE_IDS;
    this.intervalMs = options.intervalMs ?? AUTOSAVE_INTERVAL_MS;
  }

  /** Start the rotation at the oldest existing slot, or at an unused one. */
  prime(slots: readonly SaveSlot[]): void {
    let oldest = 0;
    let oldestAt = Infinity;
    for (let index = 0; index < this.ids.length; index++) {
      const id = this.ids[index];
      const slot = slots.find((candidate) => candidate.id === id);
      // An empty slot is older than any written one and is taken first, so a
      // fresh browser fills all three before it overwrites any.
      const at = slot === undefined ? -1 : slot.updatedAt;
      if (at < oldestAt) {
        oldestAt = at;
        oldest = index;
      }
    }
    this.cursor = oldest;
  }

  /** Stop and start the rotation. Off while storage is known to be broken. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Put the interval back to the start.
   *
   * Called after a manual save: an autosave a second later would spend three
   * minutes of insurance on a factory that is already on disk, and would push
   * the copy it overwrote out of the rotation for nothing.
   */
  reset(): void {
    this.elapsedMs = 0;
  }

  /** Milliseconds until the next autosave. The HUD could show it; nothing does yet. */
  remainingMs(): number {
    return Math.max(0, this.intervalMs - this.elapsedMs);
  }

  /** The slot the next autosave will use. */
  nextId(): string {
    return this.ids[this.cursor] ?? autosaveId(0);
  }

  /** Advance the clock by one frame. Fires a write when the interval is up. */
  update(frameMs: number): void {
    if (!this.enabled || !(frameMs > 0)) return;
    this.elapsedMs += frameMs;
    if (this.elapsedMs < this.intervalMs) return;
    this.elapsedMs = 0;
    void this.run();
  }

  /**
   * Write now. §14's `visibilitychange → hidden`, and the save menu's button.
   *
   * Resets the interval, so a manual trigger does not leave an autosave due
   * one second later.
   */
  async trigger(): Promise<void> {
    this.elapsedMs = 0;
    await this.run();
  }

  isWriting(): boolean {
    return this.writing;
  }

  /**
   * One rotation step.
   *
   * The re-entry guard matters more than it looks: a write that takes longer
   * than the interval — a slow disk, a huge factory — would otherwise stack up
   * one writer per frame, each one holding a whole serialized world.
   */
  private async run(): Promise<void> {
    if (this.writing || !this.enabled) return;
    const id = this.nextId();
    this.writing = true;
    try {
      await this.options.write(id);
      // Advance only on success, so a failing slot is retried rather than
      // skipped past — three failures in a row would otherwise leave the
      // player with three stale autosaves and no clue which.
      this.cursor = (this.cursor + 1) % this.ids.length;
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.writing = false;
    }
  }
}
