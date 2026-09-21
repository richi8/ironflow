/**
 * The underground belt, and the pair that makes one. See ironflow.md §9 and
 * C23 task 2.
 *
 * §9's table has carried this row since revision 2 — "a pair of entities with
 * a validated span" — and the whole of C23's half of it is two fields:
 *
 * ```text
 *   items   the lane, exactly a belt's, but several tiles long
 *   link    the other mouth of this run, or NO_ENTITY for a lone one
 * ```
 *
 * ## One lane, however long the run is
 *
 * A belt tile's lane is `BELT_TILE_UNITS` of fixed-point positions and an item
 * leaves when it passes the end of them (`belt-system.ts`). A run of
 * underground belt is the same lane with a longer ruler: an entrance whose
 * partner is `span` tiles ahead owns `(span + 1) * BELT_TILE_UNITS` of them,
 * because the run covers the entrance's tile, the exit's tile and everything
 * between. So transit time is distance over speed with nothing added and
 * nothing saved — **an underground run is exactly as fast as the surface belt
 * it replaces** — and the density is a belt's too, since `laneAccept` keeps
 * items `BELT_SLOT_SPACING` apart whatever lane they are in.
 *
 * That is the single decision this file exists to make. The alternative — the
 * entrance holding one tile's lane and the item reappearing at the exit —
 * would make a six-tile run five tiles faster than the belt beside it, and
 * burying a line would be a *throughput* upgrade rather than a routing choice.
 *
 * ## Which mouth is which is geometry, not a field
 *
 * Both mouths store `link`, and neither stores a role. The entrance is the one
 * whose partner lies **ahead of it along its own rotation**, which is a fact
 * about two positions that cannot drift; a stored flag is a second copy of it
 * that a rotation, a load or a re-pair could disagree with. `undergroundStep`
 * is that arithmetic, written once.
 *
 * A mouth with no partner is an entrance with a span of zero, so it behaves as
 * an ordinary one-tile belt — no stalled state to explain (pillar 3), and
 * pairing is then simply a run getting longer.
 */

import type { Rotation } from '../world/coordinates.js';
import { DIRECTION_OFFSETS } from '../world/coordinates.js';

import { BELT_TILE_UNITS, type BeltItem } from './belt-entity.js';
import type { Entity, EntityId } from './entity.js';
import { NO_ENTITY } from './entity.js';
import type { EntityType } from './entity-types.js';

export interface UndergroundBeltEntity extends Entity {
  /** Front-first, exactly as a belt's. See `belt-entity.ts`'s file header. */
  items: BeltItem[];
  /** The other mouth of this run, or `NO_ENTITY` while there is only one. */
  link: EntityId;
}

/** An underground belt as `EntityStore.create` wants it: everything but the id. */
export type UndergroundBeltInit = Omit<UndergroundBeltEntity, 'id'>;

/** A freshly placed mouth: a direction, an empty lane and no partner yet. */
export function newUndergroundBelt(
  type: EntityType,
  x: number,
  y: number,
  rotation: Rotation,
): UndergroundBeltInit {
  return { type, x, y, rotation, items: [], link: NO_ENTITY };
}

/**
 * This entity as an underground belt, or null if it is something else.
 *
 * It asks the *registry*, exactly as `asLab` and `asMachine` do: "is an
 * underground belt" means "the content table gave this building an underground
 * config", so a second tier with a longer span is a table entry and this file
 * does not change (§19 rule 17).
 */
export function asUnderground(
  entity: Entity,
  buildings: { undergroundFor(type: EntityType): unknown },
): UndergroundBeltEntity | null {
  return buildings.undergroundFor(entity.type) === null ? null : (entity as UndergroundBeltEntity);
}

/**
 * How many tiles ahead of `from` the tile `(x, y)` lies, along `from`'s facing,
 * or `null` if it is not on that axis at all.
 *
 * Signed: a positive answer means the tile is downstream, so a mouth whose
 * partner scores positive is the **entrance**. Negative means upstream, which
 * makes it the exit. Zero cannot happen between two entities, because two
 * things cannot stand on one tile.
 */
export function undergroundStep(from: Entity, x: number, y: number): number | null {
  const step = DIRECTION_OFFSETS[from.rotation];
  if (step === undefined) return null;

  const dx = x - from.x;
  const dy = y - from.y;
  // Off the axis: a run is a straight line, and a partner one tile to the side
  // is a different run that happens to point the same way.
  if (dx * step.y !== dy * step.x) return null;
  return dx * step.x + dy * step.y;
}

/** Is this mouth the one items go *into*? A lone mouth is, with a span of 0. */
export function isUndergroundEntrance(mouth: UndergroundBeltEntity, partner: Entity | undefined): boolean {
  if (mouth.link === NO_ENTITY || partner === undefined) return true;
  const step = undergroundStep(mouth, partner.x, partner.y);
  return step !== null && step > 0;
}

/**
 * How long this mouth's lane is, in fixed-point units.
 *
 * `(span + 1)` tiles' worth, because the run covers both mouths' tiles as well
 * as the ground between them — see the file header. A lone mouth is one tile,
 * which is an ordinary belt.
 */
export function undergroundLaneUnits(mouth: UndergroundBeltEntity, partner: Entity | undefined): number {
  if (mouth.link === NO_ENTITY || partner === undefined) return BELT_TILE_UNITS;
  const step = undergroundStep(mouth, partner.x, partner.y);
  if (step === null || step <= 0) return BELT_TILE_UNITS;
  return (step + 1) * BELT_TILE_UNITS;
}

/**
 * Break a pair, dropping whatever was still in the tunnel.
 *
 * Called when one mouth is demolished: the survivor becomes a lone one-tile
 * belt, so anything past its own tile is **lost**. That is the same bargain a
 * belt tile makes when it is removed with items on it, said one tile further:
 * the alternative is items compacting backwards into a lane too short to hold
 * them, which would put negative positions into authoritative state (§6 R7).
 */
export function unlinkUnderground(mouth: UndergroundBeltEntity): void {
  mouth.link = NO_ENTITY;
  let kept = 0;
  for (const item of mouth.items) {
    if (item.pos < BELT_TILE_UNITS) {
      mouth.items[kept] = item;
      kept += 1;
    }
  }
  mouth.items.length = kept;
}
