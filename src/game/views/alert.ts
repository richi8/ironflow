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
 */

import type { EntityId } from '../entities/entity.js';

/** What happened. One name per kind, because a toast has to say which. */
export type AlertType = 'miner_no_resource';

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
}
