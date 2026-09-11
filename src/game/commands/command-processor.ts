/**
 * The command queue. See ironflow.md §7 and C04 task 2.
 *
 * One object owns the entire path between "a player did something" and "a
 * system acts on it": a bounded queue, a per-tick drain cap, and the list of
 * typed rejections the controller turns into notifications.
 *
 * It lives in `game/` because §7 says commands are validated *inside* the
 * simulation. The input layer holds it only as a `CommandSink` — one method,
 * no drain, no queue inspection — so nothing outside the simulation can decide
 * when a command takes effect.
 */

import {
  validateCommandShape,
  type Command,
  type CommandRejection,
  type CommandRejectionReason,
} from './command.js';

/**
 * Commands applied per tick. §7 fixes this number.
 *
 * It bounds worst-case latency from a held-down build drag: without it, one
 * long drag across a 400-tile diagonal at 60 Hz could hand a single tick more
 * placement work than the frame budget allows, and the game would stutter in
 * exactly the moment the player is paying most attention to it.
 */
export const MAX_COMMANDS_PER_TICK = 1024;

/**
 * Commands allowed to wait in the queue.
 *
 * The drain cap alone does not bound memory: a producer faster than 1024
 * commands per tick grows the queue without limit, and the failure mode is a
 * tab that slows down over minutes with nothing to point at. Four ticks' worth
 * is far more than any real input burst, and overflow is a visible rejection
 * rather than a silent drop.
 */
export const MAX_PENDING_COMMANDS = MAX_COMMANDS_PER_TICK * 4;

/**
 * Rejections held for the controller.
 *
 * The list is drained every frame, so it only fills if nobody is listening.
 * Older entries are dropped rather than newer ones: the most recent rejection
 * is the one the player just caused and the one worth showing.
 */
export const MAX_RECORDED_REJECTIONS = 64;

/** Nothing to drain. Shared, frozen: most ticks return this. */
const NO_COMMANDS: readonly Command[] = Object.freeze([]);

/**
 * What a command producer is allowed to do.
 *
 * The input layer (§4) may not touch simulation state, and this interface is
 * the shape of that rule: you may ask, you may learn that the ask was refused
 * on the spot, and that is all.
 */
export interface CommandSink {
  enqueue(command: Command): boolean;
}

export class CommandProcessor implements CommandSink {
  private queue: Command[] = [];
  private readonly rejections: CommandRejection[] = [];
  private droppedRejections = 0;

  /** Commands waiting for the next tick. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Offer a command. Returns false if it was refused outright.
   *
   * Shape validation happens here rather than in the drain so that the input
   * layer learns immediately, and so a malformed command never occupies a
   * queue slot. Semantic validation — occupied, unaffordable — belongs to the
   * system that applies the command and happens in tick phase 1.
   */
  enqueue(command: Command): boolean {
    const malformed = validateCommandShape(command);
    if (malformed !== null) {
      this.reject(command, malformed);
      return false;
    }
    if (this.queue.length >= MAX_PENDING_COMMANDS) {
      this.reject(command, 'queue_full');
      return false;
    }
    this.queue.push(command);
    return true;
  }

  /**
   * Take up to `max` commands in queue order, leaving the rest for later ticks.
   *
   * Queue order is the order they were enqueued, which is what makes a replay
   * of the same command stream produce the same world (§6). The returned array
   * is the caller's own — the processor keeps no reference to it.
   */
  drain(max: number = MAX_COMMANDS_PER_TICK): readonly Command[] {
    if (this.queue.length === 0 || max <= 0) return NO_COMMANDS;

    if (this.queue.length <= max) {
      const batch = this.queue;
      this.queue = [];
      return batch;
    }
    return this.queue.splice(0, max);
  }

  /**
   * Record that a command did not happen, and why.
   *
   * Called by `enqueue` for malformed input and by the simulation for anything
   * a system refuses. Nothing is thrown: a refused command is an ordinary
   * outcome, and a tick that throws on bad input is a tick that stops the game.
   */
  reject(command: Command, reason: CommandRejectionReason): void {
    if (this.rejections.length >= MAX_RECORDED_REJECTIONS) {
      this.rejections.shift();
      this.droppedRejections += 1;
    }
    this.rejections.push({ command, reason });
  }

  /** How many rejections were dropped unread. Non-zero means a bug upstream. */
  get unreadRejectionsDropped(): number {
    return this.droppedRejections;
  }

  /**
   * Take the rejections recorded since the last call.
   *
   * Pull, not push: a callback into the UI from inside a tick would be a write
   * to the DOM in a simulation phase, which §13 forbids outright. The
   * controller collects these after the frame instead.
   */
  takeRejections(): readonly CommandRejection[] {
    if (this.rejections.length === 0) return NO_REJECTIONS;
    return this.rejections.splice(0, this.rejections.length);
  }
}

const NO_REJECTIONS: readonly CommandRejection[] = Object.freeze([]);
