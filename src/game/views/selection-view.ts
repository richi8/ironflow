/**
 * What the player has selected. See ironflow.md C12 task 4.
 *
 * Selection is **UI state, not simulation state**: nothing in `game/` reads
 * it, no system branches on it and it is never serialized. It lives on the
 * cursor — the same object that holds what the player is pointing at and what
 * they are holding — and the controller turns it into this, which is the only
 * shape the renderer and the inspector ever see.
 *
 * It carries the footprint rather than a single tile because the outline is
 * drawn around the *building*: a 2x2 miner picked by its north corner and
 * highlighted one tile wide reads as a highlight that missed.
 */

import type { EntityId } from '../entities/entity.js';

export interface SelectionView {
  readonly entityId: EntityId;
  /** The footprint's north-west tile. */
  readonly x: number;
  readonly y: number;
  /** The footprint's size **after** rotation, in tiles. */
  readonly width: number;
  readonly height: number;
}
