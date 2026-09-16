/**
 * Things the world did that the player needs telling about. C11 task 5.
 *
 * ```text
 * system (phase 3) -> AlertLog -> controller.pump() -> GameEvent -> toast
 * ```
 *
 * The same shape as the command processor's rejection list, for the same
 * reason: §13 forbids writing to the DOM from inside a simulation phase, so a
 * system *records* and the controller collects once the frame is over. §8 says
 * it in the phase table — "events emitted during a tick are queued and
 * dispatched in cleanup, never mid-phase — a listener that mutates state
 * mid-phase is a determinism bug".
 *
 * ## Why it is not authoritative state
 *
 * Nothing in `game/` ever reads an alert back. It is a one-way report, it is
 * emptied every frame, and it is never serialized — a save that reloaded with
 * a queue of stale warnings would announce a miner that ran dry an hour ago.
 * The *condition* is what persists (`MinerEntity.status`); the alert is the
 * moment it changed.
 *
 * ## Where the alert itself lives
 *
 * `views/alert.ts`, because it is a view model and §4 lets the UI import one.
 * This file is the *log*: a mutable queue a system writes to inside a tick,
 * which is simulation plumbing and nothing the UI may hold. It is the same
 * split §7 makes between `CommandRejection` and the processor that records it.
 */

import type { Alert } from './views/alert.js';

export type { Alert, AlertType } from './views/alert.js';

/**
 * How many alerts are held before the oldest are dropped.
 *
 * Reached only if nothing drains the log — the controller empties it every
 * frame — and the same size the rejection list uses. The newest are kept
 * because the newest is what just happened.
 */
export const MAX_RECORDED_ALERTS = 64;

/** Nothing happened this frame. Shared and frozen: almost every frame. */
const NO_ALERTS: readonly Alert[] = Object.freeze([]);

export class AlertLog {
  private readonly alerts: Alert[] = [];

  private dropped = 0;

  /** Record an alert. Called from inside a tick; never dispatches anything. */
  push(alert: Alert): void {
    if (this.alerts.length >= MAX_RECORDED_ALERTS) {
      this.alerts.shift();
      this.dropped += 1;
    }
    this.alerts.push(alert);
  }

  /** How many alerts were dropped unread. Non-zero means nothing is pumping. */
  get droppedCount(): number {
    return this.dropped;
  }

  get size(): number {
    return this.alerts.length;
  }

  /** Take everything recorded since the last call, oldest first. */
  take(): readonly Alert[] {
    if (this.alerts.length === 0) return NO_ALERTS;
    return this.alerts.splice(0, this.alerts.length);
  }
}
