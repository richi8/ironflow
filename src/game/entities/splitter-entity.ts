/**
 * The splitter: two belt lanes side by side, and the two counters that decide
 * which way an item goes. See ironflow.md §9 and C17 tasks 1–3.
 *
 * ## It is a belt, twice over
 *
 * A splitter is one tile *deep* and two tiles *wide across the flow*, so each
 * of its two footprint tiles carries exactly one belt lane: the same four
 * slots, the same fixed-point positions, the same front-first invariant
 * (`belt-entity.ts`). An item entering a splitter is an item entering a lane,
 * and it spends one tile's worth of travel inside before it has a decision to
 * make. Nothing here re-implements movement — `belt-system.ts` advances a
 * splitter's lanes with the loop it advances a belt tile with.
 *
 * What is new is the *exit*. A belt's item has one place to go; a splitter's
 * has two, and §9 says the choice must be **deterministic round-robin on a
 * persisted counter** — not random (§6 R1 forbids it outright) and not
 * "whichever side is emptier", which sounds fairer and is not: it makes the
 * split depend on how far away the two consumers are, so the same splitter
 * feeding the same two machines balances differently depending on where the
 * player put them.
 *
 * ## Two counters, one rule
 *
 * ```text
 * outputCursor   which of the two output sides a leaving item tries first
 * inputCursor    which of the two lanes is advanced first
 * ```
 *
 * Both obey the same sentence: **a cursor advances when the thing it pointed
 * at was used.** That one rule is what makes all three of C17's acceptance
 * criteria fall out rather than being coded for one at a time.
 *
 * - *Balanced.* Both outputs free: an item takes the favoured side, the cursor
 *   moves to the other, the next item takes that one. Strict alternation, so
 *   1,000 items split 500/500 exactly.
 * - *Blocked.* One output jammed: the item tries the favoured side, fails,
 *   falls back to the other — and because the favoured side was *not* used,
 *   the cursor does not move. Every subsequent item makes the same failed try
 *   and the same successful fallback, so 100% goes down the free side at the
 *   full belt rate.
 * - *Merging.* Two lanes fed, one way out: the lane `inputCursor` favours
 *   moves first and wins the tick; the moment it gets an item out, the favour
 *   passes to the other lane. If the favoured lane is empty it gets nothing
 *   and keeps the favour, so a dead input never costs the live one a turn.
 *
 * ## Why both counters live on the entity
 *
 * §10 puts them in the authoritative column and C17's third acceptance
 * criterion is that behaviour is identical across a save/load. A cursor kept
 * in `belt-system.ts` — in a `Map` keyed by entity id, say — would be
 * rebuilt as zero on load, and a factory whose splitters all silently
 * re-synchronised on every reload is the kind of bug that is found by a player
 * comparing two screenshots. They are plain numbers on a plain object, which
 * is all C24 will need.
 */

import { DIRECTION_OFFSETS, type Rotation, type TileCoord } from '../world/coordinates.js';

import type { BeltItem } from './belt-entity.js';
import type { Entity, Footprint } from './entity.js';
import { footprintTileAt } from './entity.js';
import { EntityType } from './entity-types.js';

/** §15: two in, two out. The footprint is this wide and one tile deep. */
export const SPLITTER_LANES = 2;

/**
 * Which of the two sides something refers to.
 *
 * `0` and `1` index the footprint in `footprintTileAt` order, which is the
 * row-major order every other multi-tile building in the game is walked in
 * (C05). So side 0 is the north or west tile depending on how the splitter is
 * turned, and — this is the part that matters — lane 0, input tile 0 and
 * output tile 0 are all the same side of the same machine.
 */
export type SplitterSide = 0 | 1;

/** The other one. */
export function otherSide(side: SplitterSide): SplitterSide {
  return side === 0 ? 1 : 0;
}

export interface SplitterEntity extends Entity {
  /**
   * One belt lane per footprint tile, in side order. Each is front-first, and
   * `belt-entity.ts`'s lane functions are what put items into them.
   */
  lanes: [BeltItem[], BeltItem[]];
  /** The output side a leaving item tries first. Persisted — see the header. */
  outputCursor: SplitterSide;
  /** The lane advanced first when both want the same way out. Persisted. */
  inputCursor: SplitterSide;
}

/** A splitter as `EntityStore.create` wants it: everything but the id. */
export type SplitterInit = Omit<SplitterEntity, 'id'>;

/** The state a freshly placed splitter starts in: empty, both cursors at side 0. */
export function newSplitter(x: number, y: number, rotation: Rotation): SplitterInit {
  return {
    type: EntityType.Splitter,
    x,
    y,
    rotation,
    lanes: [[], []],
    outputCursor: 0,
    inputCursor: 0,
  };
}

/** This entity as a splitter, or null if it is something else. */
export function asSplitter(entity: Entity): SplitterEntity | null {
  return entity.type === EntityType.Splitter ? (entity as SplitterEntity) : null;
}

/**
 * The footprint tile one side occupies.
 *
 * `size` is content (`BuildingDefinition.size`), which is why it is passed in
 * rather than assumed: §10 keeps a footprint out of the entity, and the
 * registry refuses a splitter whose size is not `SPLITTER_LANES` across and
 * one deep — the property every function below depends on.
 */
export function splitterTile(splitter: SplitterEntity, size: Footprint, side: SplitterSide): TileCoord {
  return footprintTileAt(splitter.x, splitter.y, size, splitter.rotation, side);
}

/**
 * The tile items leave one side into, or null for a rotation that is not one.
 *
 * One step along the splitter's facing from that side's own tile. Because the
 * footprint is exactly one tile deep, "the tile in front of this side" needs
 * no knowledge of how the splitter is turned beyond the direction table.
 *
 * The coordinate may be outside the range the occupancy index can be asked
 * about; deciding what a tile at the edge of the world means belongs to the
 * caller, exactly as it does for `forEachOutputTile`.
 */
export function splitterOutputTile(
  splitter: SplitterEntity,
  size: Footprint,
  side: SplitterSide,
): TileCoord | null {
  return step(splitterTile(splitter, size, side), splitter.rotation, 1);
}

/** The tile items arrive at one side from. One step *behind* that side's tile. */
export function splitterInputTile(
  splitter: SplitterEntity,
  size: Footprint,
  side: SplitterSide,
): TileCoord | null {
  return step(splitterTile(splitter, size, side), splitter.rotation, -1);
}

/**
 * Which side a neighbour at `(x, y)` may feed, or `null` if it may feed none.
 *
 * **A splitter accepts items across its back edge and nowhere else.** §15 gives
 * it two inputs; this is the sentence that makes that true rather than
 * decorative. A belt running into its flank is not a third input — it is a
 * belt pointed at the side of a machine, and it backs up, which is the same
 * answer a belt gets from the side of a furnace.
 *
 * It is also what keeps two splitters nose to nose from trading an item back
 * and forth: the tile an item would come back from is on the *far* side of the
 * other machine, so it is never an input tile. `facesBack` covers the same
 * hazard for two belts; here the geometry covers it.
 */
export function splitterSideFedFrom(
  splitter: SplitterEntity,
  size: Footprint,
  x: number,
  y: number,
): SplitterSide | null {
  for (let side = 0; side < SPLITTER_LANES; side++) {
    const tile = splitterInputTile(splitter, size, side as SplitterSide);
    if (tile !== null && tile.x === x && tile.y === y) return side as SplitterSide;
  }
  return null;
}

/**
 * One tile step along `rotation`, backwards for `sign` of -1.
 *
 * The addition is what keeps §6 R7 satisfied for free: a direction component
 * of zero multiplied by -1 is `-0`, and `x + -0` is a plain `0` again.
 */
function step(from: TileCoord, rotation: Rotation, sign: 1 | -1): TileCoord | null {
  const offset = DIRECTION_OFFSETS[rotation];
  if (offset === undefined) return null;
  return { x: from.x + offset.x * sign, y: from.y + offset.y * sign };
}
