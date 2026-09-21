/**
 * One thing the world has to tell the player. See ironflow.md C11 task 5.
 *
 * A view model, in `views/` for the reason §4 puts anything here: the UI reads
 * it and the UI may not reach into `game/` for anything else. The *log* it
 * arrives in is simulation plumbing and lives in `game/alerts.ts`; this is the
 * plain, frozen fact a toast is written from — the same split §7 makes between
 * `CommandRejection` and the processor that records one.
 *
 * ## Why "a miner ran out" is the only kind
 *
 * `game-event.ts` states the rule: a member of a player-facing union needs a
 * real producer and a real consumer in the chunk that adds it (§19 rule 10).
 * C11's depletion alert has both. A stalled belt, a furnace out of fuel and an
 * overloaded power network are C13, C15 and C21's to add, each with the
 * sentence a player will read.
 *
 * ## Why C20 added two, and only two
 *
 * C20 task 5 asks for "clear stall alerts", and the temptation is an alert per
 * `MachineStatus`. Most of them would be noise: `output_full` is what a
 * *working* factory looks like the moment a chest fills, and a toast every
 * time one does would train the player to ignore the corner of the screen the
 * important ones appear in.
 *
 * The test is whether the player has to **do** something, and whether the
 * condition will clear on its own if they do not:
 *
 * ```text
 *   alert        no_resource      the patch is gone; move the miner
 *                no_fuel          feed it; it will not restart by itself
 *                no_destination   it is pointed at nothing; turn it round
 *                no_recipe        it has never been told what to make
 *                no_power         it is not on a network (C21)
 *
 *   alert        research_complete  a technology landed while you were looking
 *                                   somewhere else (C22)
 *
 *   no alert     low_power        the network is stretched, not broken; the
 *                                 HUD's power tile says so continuously
 *                output_full      the consumer will catch up, or it will not,
 *                                 and either way the panel says so
 *                no_input         the same fact one machine upstream
 *                idle / running   nothing happened
 * ```
 */

import type { EntityId } from '../entities/entity.js';

/** What happened. One name per kind, because a toast has to say which. */
export type AlertType =
  | 'miner_no_resource'
  | 'machine_no_fuel'
  /** C20: an inserter with nowhere to put what it is holding. */
  | 'inserter_no_destination'
  /** C20: a machine the player has placed and never told what to make. */
  | 'machine_no_recipe'
  /**
   * C21: a building that needs a power network and is not on one — a machine
   * with no pole in reach, or a generator with nowhere to send what it burns.
   *
   * It passes the test above on both counts: the player has to run a pole,
   * and nothing about a building standing in open ground will change on its
   * own. It is deliberately **not** raised for `low_power`, which is a
   * *working* factory that has outgrown its generators — that is the
   * `output_full` of power, it clears itself the moment demand drops, and the
   * HUD's power tile carries it instead (C21 task 5).
   */
  | 'no_power_network'
  /**
   * C21A: a hand-craft that has finished and has nowhere to go.
   *
   * It passes the test above on both counts. The player has to do something —
   * empty the bag into a chest — and nothing will change on its own: the
   * craft is *finished*, so the queue is not going to move until a slot
   * frees. It is raised once per blocked order, not once per tick, for the
   * reason the miner's is.
   */
  | 'craft_blocked'
  /**
   * C22: a technology finished.
   *
   * The one alert in the game that is not a problem, and it earns its place by
   * the same test the others pass read backwards: the player has been waiting
   * several minutes for it, it happens while they are looking somewhere else,
   * and there is something to do about it — the thing it unlocked. The toast
   * names the technology, which is what `subject` is for.
   */
  | 'research_complete';

/**
 * It carries the tile as well as the entity id because the id alone is not
 * something a player can act on: C12's inspector and C23's map both want to
 * put the camera where the problem is, and by the time a toast is read the
 * entity may have been removed.
 */
export interface Alert {
  readonly type: AlertType;
  readonly entityId: EntityId;
  readonly x: number;
  readonly y: number;
  /**
   * What it happened to, when that is not an entity on a tile (C22).
   *
   * A technology's name, and nothing else in v1. It is a plain string because
   * an alert is a frozen fact a toast is written from, and the alternative —
   * a technology id the UI would look up — is the seam §4 closes: `ui/**` may
   * not reach a registry.
   */
  readonly subject?: string;
}
