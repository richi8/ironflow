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
import { footprintExtent, forEachFootprintTile, type Footprint } from '../entities/entity.js';
import type { ItemCounts } from '../items/item-stack.js';
import { BuildingRegistry, type BuildingDefinition } from '../registries/building-registry.js';
import { TILE_MAX, TILE_MIN, type Rotation } from '../world/coordinates.js';
import type { World } from '../world/world.js';

export interface BuildSystemOptions {
  readonly world: World;
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  /**
   * The player's items. Still `ItemCounts`: C08 built the real `SlotInventory`
   * but it keys on registered item ids, and a build cost is paid in building
   * items, which do not exist as items until C16 gives them recipes. C10's
   * player state is where this moves.
   */
  readonly inventory: ItemCounts;
}

/** A placement that would work, or the one reason it would not. */
export type PlacementResult = CommandRejectionReason | null;

export class BuildSystem {
  private readonly world: World;
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly inventory: ItemCounts;

  constructor(options: BuildSystemOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.inventory = options.inventory;
  }

  /**
   * Could this building be placed here, right now? `null` means yes.
   *
   * The order of the checks is the order of the answers a player finds useful,
   * not the order that is cheapest to compute. Affordability is last on
   * purpose: told that a tile is water *and* unaffordable, "water" is the one
   * that explains the red ghost, and "you cannot afford it" is a fact about
   * the inventory that would be just as true one tile to the left.
   */
  validate(buildingId: string, x: number, y: number, rotation: Rotation): PlacementResult {
    if (!this.buildings.has(buildingId)) return 'unknown_building';
    const definition = this.buildings.get(buildingId);
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
    this.entities.create(
      initialBuildingState(definition, x, y, BuildingRegistry.normalizeRotation(definition, rotation)),
    );
    return null;
  }

  /**
   * Demolish whatever stands on a tile, refunding what it cost.
   *
   * Any tile of the footprint works, because the occupancy index answers for
   * all of them (C05) — a player removing a 2×2 miner should not have to find
   * its north-west corner. The entity goes at the end of the tick; the refund
   * is immediate, which is the same ordering every other command effect has.
   */
  remove(x: number, y: number): PlacementResult {
    if (x < TILE_MIN || x > TILE_MAX || y < TILE_MIN || y > TILE_MAX) return 'out_of_range';

    const entity = this.entities.at(x, y);
    // Already marked this tick: the tiles are still claimed, but refunding a
    // second time would mint a free building out of a double right-click.
    if (entity === undefined || this.entities.isPendingRemoval(entity.id)) return 'nothing_there';

    this.entities.remove(entity.id);
    this.inventory.give(this.buildings.forEntityType(entity.type).buildCost);
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
