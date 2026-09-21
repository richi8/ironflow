/**
 * Placing and removing buildings. See ironflow.md C06 tasks 4 and 6.
 *
 * Every rule about *whether* something may be built lives here, and every fact
 * about *what* is being built lives in `data/buildings.ts` (§19 rule 17). The
 * consequence worth stating: this file has no `if (building.id === 'miner')`
 * in it and never will — the miner's ore requirement is a boolean on its
 * definition, and the day a second building needs ore under it, nothing here
 * changes.
 *
 * ## One validation path, two callers
 *
 * `validate` answers the same question for the tick that applies a `build`
 * command and for the frame that paints the ghost, which is what keeps the
 * red-tinted preview and the rejection notice from ever disagreeing. §7 says
 * the simulation is the authority and the UI may only pre-check; here the UI's
 * pre-check *is* the authority's answer, asked ahead of time and without
 * changing anything.
 */

import type { CommandRejectionReason } from '../commands/command.js';
import type { EntityStore } from '../entities/entity-store.js';
import { initialBuildingState } from '../entities/building-init.js';
import {
  NO_ENTITY,
  footprintExtent,
  forEachFootprintTile,
  type Entity,
  type Footprint,
} from '../entities/entity.js';
import {
  asUnderground,
  isUndergroundEntrance,
  unlinkUnderground,
  type UndergroundBeltEntity,
} from '../entities/underground-belt-entity.js';
import { DIRECTION_OFFSETS } from '../world/coordinates.js';
import type { BuildMaterials } from '../items/build-materials.js';
import type { Unlocks } from '../research/unlocks.js';
import { BuildingRegistry, type BuildingDefinition } from '../registries/building-registry.js';
import { TILE_MAX, TILE_MIN, type Rotation } from '../world/coordinates.js';
import type { World } from '../world/world.js';

export interface BuildSystemOptions {
  readonly world: World;
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  /**
   * The player's items, as a build cost names them. Since C20 this is a view
   * over their one real bag rather than a second container — see
   * `items/build-materials.ts`.
   */
  readonly inventory: BuildMaterials;
  /**
   * What research has revealed (C22). A live holder, not a snapshot: a
   * technology completed in phase 7 must make its building placeable on the
   * next command, which is C22's second acceptance criterion.
   */
  readonly unlocks: Unlocks;
}

/** A placement that would work, or the one reason it would not. */
export type PlacementResult = CommandRejectionReason | null;

export class BuildSystem {
  private readonly world: World;
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly inventory: BuildMaterials;
  private readonly unlocks: Unlocks;

  constructor(options: BuildSystemOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.inventory = options.inventory;
    this.unlocks = options.unlocks;
  }

  /**
   * Could this building be placed here, right now? `null` means yes.
   *
   * The order of the checks is the order of the answers a player finds useful,
   * not the order that is cheapest to compute. C22's lock comes first for that
   * reason: a building research has not revealed is refused the same way on
   * every tile, so nothing about the ground under it is worth saying. Affordability is last on
   * purpose: told that a tile is water *and* unaffordable, "water" is the one
   * that explains the red ghost, and "you cannot afford it" is a fact about
   * the inventory that would be just as true one tile to the left.
   */
  validate(buildingId: string, x: number, y: number, rotation: Rotation): PlacementResult {
    if (!this.buildings.has(buildingId)) return 'unknown_building';
    const definition = this.buildings.get(buildingId);
    // Before anything about the ground: a locked building is refused wherever
    // it is pointed, so "research that first" is the whole answer rather than
    // the second half of one about terrain (C22).
    if (!this.unlocks.isBuildingUnlocked(definition.entityType)) return 'locked';
    const facing = BuildingRegistry.normalizeRotation(definition, rotation);

    // Bounds first, and before anything touches the occupancy index: a tile
    // outside the packable range makes `tileKey` throw, and a placement
    // hanging off the edge of the world must be a rejection, not a dead tick.
    if (!withinWorld(x, y, definition, facing)) return 'out_of_range';

    let reason: PlacementResult = null;
    forEachFootprintTile(x, y, definition.size, facing, (tileX, tileY) => {
      if (reason !== null) return;
      const occupant = this.entities.at(tileX, tileY);
      // A building marked for removal earlier this tick still holds its tiles
      // until the cleanup phase (C05), and saying "occupied" is the honest
      // answer — the tile is not free until the tick that frees it has ended.
      if (occupant !== undefined) {
        reason = 'occupied';
        return;
      }
      if (!definition.placement.onTerrain.includes(this.world.getTile(tileX, tileY))) {
        reason = 'bad_terrain';
      }
    });
    if (reason !== null) return reason;

    if (definition.placement.requiresResource === true && !this.hasResource(x, y, definition, facing)) {
      return 'no_resource';
    }

    // C23. The one rule in this file about a *pair*: a mouth laid in line with
    // an unfinished run and out of its reach is refused, because the player is
    // plainly finishing that run and two stubs that look joined and carry
    // nothing is the silent failure §7 exists to prevent.
    if (definition.underground !== undefined) {
      const partner = this.findUndergroundPartner(definition.underground.maxSpan, x, y, facing);
      if (partner !== null && partner.distance > definition.underground.maxSpan) return 'span_too_long';
    }

    return this.inventory.canAfford(definition.buildCost) ? null : 'unaffordable';
  }

  /**
   * Validate, pay, and place. Called only from the command phase of a tick.
   *
   * Nothing is charged for a placement that does not happen: `validate` runs
   * first and in full, so a refusal leaves the inventory and the entity store
   * exactly as they were.
   */
  place(buildingId: string, x: number, y: number, rotation: Rotation): PlacementResult {
    const reason = this.validate(buildingId, x, y, rotation);
    if (reason !== null) return reason;

    const definition = this.buildings.get(buildingId);
    this.inventory.take(definition.buildCost);
    // What kind of state a new building starts with is `building-init.ts`'s
    // job, not this file's: a miner's progress counter and buffer are no more
    // a placement rule than its sprite is (see the file header).
    const facing = BuildingRegistry.normalizeRotation(definition, rotation);
    const placed = this.entities.create(initialBuildingState(definition, x, y, facing));

    // C23. A mouth laid behind an unfinished run completes it. `validate` has
    // already refused the out-of-reach case, so anything found here is in
    // range — which is what makes pairing an effect rather than a second
    // decision that could disagree with the one the ghost showed.
    if (definition.underground !== undefined) {
      const partner = this.findUndergroundPartner(definition.underground.maxSpan, x, y, facing);
      if (partner !== null && partner.distance <= definition.underground.maxSpan) {
        const mouth = asUnderground(placed, this.buildings);
        if (mouth !== null) {
          mouth.link = partner.mouth.id;
          partner.mouth.link = placed.id;
        }
      }
    }
    return null;
  }

  /**
   * Demolish whatever stands on a tile, refunding what it cost.
   *
   * Any tile of the footprint works, because the occupancy index answers for
   * all of them (C05) — a player removing a 2×2 miner should not have to find
   * its north-west corner. The entity goes at the end of the tick; the refund
   * is immediate, which is the same ordering every other command effect has.
   *
   * ## The refund is checked before the building is
   *
   * C20 made the player's bag the one that has slots, so a refund can now fail
   * to fit. A demolition that half-refunded would delete the rest, and §7's
   * rule is that nothing is ever silently deleted — the same rule C16's
   * `setRecipe` follows. So a full bag refuses the removal, with the reason
   * the player can act on, and the building stays standing.
   *
   * It also means the *contents* of what is demolished are still lost, which
   * is the one thing this does not fix: a chest full of plates goes with the
   * chest. That is C20's noted gap, not a decision.
   */
  remove(x: number, y: number): PlacementResult {
    if (x < TILE_MIN || x > TILE_MAX || y < TILE_MIN || y > TILE_MAX) return 'out_of_range';

    const entity = this.entities.at(x, y);
    // Already marked this tick: the tiles are still claimed, but refunding a
    // second time would mint a free building out of a double right-click.
    if (entity === undefined || this.entities.isPendingRemoval(entity.id)) return 'nothing_there';

    // Deliberately not gated on research (C22): a building that is standing
    // there may always be taken down, whatever the tech tree has to say. The
    // only way to be holding a locked building's item is to have had one
    // before it was locked, which no save can currently produce — and if one
    // ever does, refusing to demolish would be a building the player could
    // neither use nor remove.
    const refund = this.buildings.forEntityType(entity.type).buildCost;
    if (!this.inventory.hasRoomFor(refund)) return 'inventory_full';

    // C23. The survivor of a demolished pair becomes a lone mouth, and what
    // was still in the tunnel goes with the tunnel — the same bargain a belt
    // tile makes when it is removed with items on it, said one tile further.
    // Done now rather than in cleanup, because the removal was ordered in
    // phase 1 and phase 5 must not find a run whose far end is a ghost.
    const mouth = asUnderground(entity, this.buildings);
    if (mouth !== null && mouth.link !== NO_ENTITY) {
      const partner = this.entities.get(mouth.link);
      const other = partner === undefined ? null : asUnderground(partner, this.buildings);
      if (other !== null) unlinkUnderground(other);
      unlinkUnderground(mouth);
    }

    this.entities.remove(entity.id);
    this.inventory.give(refund);
    return null;
  }

  /**
   * The nearest unpaired mouth this placement would join, or null for none.
   *
   * Scans **backwards** along the facing — the direction items would arrive
   * from — one tile at a time, and stops at the first thing that ends the
   * search:
   *
   * ```text
   *   an unpaired mouth facing the same way   the candidate; report it
   *   a mouth that is already half of a run   a wall: a finished run is not
   *                                           something to reach across
   *   nothing, for the whole window           no run is being finished here
   * ```
   *
   * The window is `2 * maxSpan`, which is the one arbitrary number in this
   * file and is written down rather than hidden: within a second run's length
   * of an unfinished run, in line with it and facing the same way, the player
   * is finishing it and deserves to be told the span is too long. Beyond that
   * they are starting a new one somewhere else on the same line, and refusing
   * would make a long straight belt route impossible to bury in two hops.
   */
  private findUndergroundPartner(
    maxSpan: number,
    x: number,
    y: number,
    facing: Rotation,
  ): { readonly mouth: UndergroundBeltEntity; readonly distance: number } | null {
    const step = DIRECTION_OFFSETS[facing];
    if (step === undefined) return null;

    const window = 2 * maxSpan;
    for (let distance = 1; distance <= window; distance++) {
      const tileX = x - step.x * distance;
      const tileY = y - step.y * distance;
      if (tileX < TILE_MIN || tileX > TILE_MAX || tileY < TILE_MIN || tileY > TILE_MAX) return null;

      const occupant: Entity | undefined = this.entities.at(tileX, tileY);
      if (occupant === undefined || this.entities.isPendingRemoval(occupant.id)) continue;

      const mouth = asUnderground(occupant, this.buildings);
      if (mouth === null || mouth.rotation !== facing) continue;
      // A finished run is a wall. Without this, a third mouth laid past a
      // complete pair would re-pair with its entrance and orphan its exit.
      if (mouth.link !== NO_ENTITY) return null;
      // A lone mouth counts as an entrance (see its entity file), so this is
      // always true here — asserted rather than assumed, because the day a
      // mouth can be unpaired and still an exit is the day this breaks.
      if (!isUndergroundEntrance(mouth, undefined)) return null;
      return { mouth, distance };
    }
    return null;
  }

  private hasResource(x: number, y: number, definition: BuildingDefinition, facing: Rotation): boolean {
    return countResourceTiles(this.world, x, y, definition.size, facing) > 0;
  }
}

/**
 * How many tiles of a footprint have ore left on them.
 *
 * Shared with the ghost preview, which shows the count while a miner is held
 * (C11 task 4): "may this be placed" and "how much will it cover" are the same
 * question asked with different precision, and answering them in two places is
 * how a green ghost ends up promising four tiles over a patch with three.
 */
export function countResourceTiles(
  world: World,
  x: number,
  y: number,
  footprint: Footprint,
  facing: Rotation,
): number {
  let count = 0;
  forEachFootprintTile(x, y, footprint, facing, (tileX, tileY) => {
    if (world.getResourceAmount(tileX, tileY) > 0) count += 1;
  });
  return count;
}

/** Does the whole footprint fit inside the coordinates a tile key can pack? */
function withinWorld(x: number, y: number, definition: BuildingDefinition, facing: Rotation): boolean {
  const extent = footprintExtent(definition.size, facing);
  return (
    x >= TILE_MIN &&
    y >= TILE_MIN &&
    x + extent.width - 1 <= TILE_MAX &&
    y + extent.height - 1 <= TILE_MAX
  );
}
