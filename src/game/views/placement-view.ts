/**
 * The pending placement under the cursor. See ironflow.md C06 task 7.
 *
 * C06 assembled this in the composition root and noted that it belongs to the
 * controller. It does now — with one boundary that the move made visible: a
 * `GhostView` carries a `SpriteId`, and §4 forbids `game/**` from knowing what
 * a sprite is. So this view stops at the building's content id and the
 * composition root turns that into something to draw, which is the same split
 * `renderer/entity-view.ts` already makes for placed entities.
 *
 * `valid` and `reason` come from the simulation's own placement check, so the
 * red tint and the rejection toast can never disagree (§7).
 */

import type { CommandRejectionReason } from '../commands/command.js';
import type { Rotation } from '../world/coordinates.js';

export interface PlacementView {
  readonly buildingId: string;
  /** The footprint's north-west tile. */
  readonly x: number;
  readonly y: number;
  /** Extent in tiles, already swapped for an odd rotation (C05 decision 4). */
  readonly width: number;
  readonly height: number;
  readonly rotation: Rotation;
  readonly valid: boolean;
  /** Why not, when `valid` is false. Null when the placement would be accepted. */
  readonly reason: CommandRejectionReason | null;
}
