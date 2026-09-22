/**
 * Walking and manual gathering. See ironflow.md C10 tasks 2-4 and §8 phase 8.
 *
 * Two jobs, both of them per-tick and both of them integer arithmetic:
 *
 * ```text
 * move   one step in the held direction, per axis, blocked by terrain and by
 *        buildings that are not walkable
 * mine   one tick of progress toward the next item, or a reason to stop
 * ```
 *
 * ## Why movement resolves one axis at a time
 *
 * Trying the whole step at once and refusing it wholesale makes a player
 * walking diagonally into a wall stop dead, which reads as the game having
 * stopped listening. Resolving X and then Y means the blocked component is
 * dropped and the free one still applies, so the player slides along the wall —
 * the behaviour every game in this genre has, and two `if`s rather than a
 * collision solver.
 *
 * ## Why a blocked player can always move
 *
 * If the player is *already* standing somewhere they could not step into — a
 * building placed on top of them, a save from a world whose terrain changed —
 * every candidate position is refused and the player is stuck forever. So when
 * the current position is itself invalid, movement is unrestricted until they
 * are out. It is three lines against a soft-lock with no way back.
 */

import type { EntityStore } from '../entities/entity-store.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import {
  MINE_TICKS_PER_ITEM,
  MINE_RANGE_TILES,
  PLAYER_RADIUS_SUBTILES,
  PlayerState,
  facingFor,
  facingToward,
  stepFor,
  subtileToTile,
} from '../player/player-state.js';
import type { ItemRegistry } from '../registries/item-registry.js';
import { resourceItemId } from '../world/resource.js';
import { isPassable } from '../world/tile.js';
import { TILE_MAX, TILE_MIN } from '../world/coordinates.js';
import type { World } from '../world/world.js';

export interface PlayerSystemOptions {
  readonly world: World;
  readonly entities: EntityStore;
  /** Content, for the one question movement asks of it: is this walkable? */
  readonly buildings: BuildingRegistry;
  readonly player: PlayerState;
  readonly items: ItemRegistry;
}

export class PlayerSystem {
  private readonly world: World;
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly player: PlayerState;
  private readonly items: ItemRegistry;

  constructor(options: PlayerSystemOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.player = options.player;
    this.items = options.items;
  }

  /** Phase 8. Movement first, then mining, so reach is judged where they land. */
  tick(): void {
    this.move();
    this.mine();
  }

  /**
   * Can the player start mining this tile? `null` means yes, and the caller
   * has already decided the coordinates are well-formed.
   *
   * Shared by the `mineTile` command and by the per-tick check that stops
   * mining when a condition stops holding, so "why did it not start" and "why
   * did it stop" can never be answered by two different sets of rules.
   */
  checkMineable(x: number, y: number): 'out_of_reach' | 'no_resource' | 'inventory_full' | null {
    if (!this.player.isWithinRange(x, y, MINE_RANGE_TILES)) return 'out_of_reach';

    const itemId = this.yieldOf(x, y);
    if (itemId === null) return 'no_resource';
    return this.player.inventory.spaceFor(itemId) > 0 ? null : 'inventory_full';
  }

  /* ---------------------------------------------------------------- *
   * Movement
   * ---------------------------------------------------------------- */

  private move(): void {
    const player = this.player;
    const intent = player.moveIntent;
    if (!player.isMoving) return;

    player.facing = facingFor(intent, player.facing);

    const step = stepFor(intent);
    // See the file header: a player standing somewhere invalid must be able to
    // walk out of it, or they are stuck for the life of the save.
    const free = !this.canStandAt(player.subX, player.subY);

    if (step.dx !== 0 && (free || this.canStandAt(player.subX + step.dx, player.subY))) {
      player.subX += step.dx;
    }
    if (step.dy !== 0 && (free || this.canStandAt(player.subX, player.subY + step.dy))) {
      player.subY += step.dy;
    }
  }

  /**
   * Could the player's box sit centred here?
   *
   * Every tile the box touches must be passable terrain carrying nothing solid
   * — a belt, a splitter or a tunnel mouth is walkable and does not block, and
   * which buildings those are is content's answer rather than this file's (see
   * `BuildingDefinition.walkable`). `World.getTile` generates a world chunk on
   * a miss, which is exactly C10's "cannot walk off into an ungenerated void":
   * the collision test is what pulls the world into existence ahead of the
   * player.
   *
   * The box is half-open on its far edges — `+ radius - 1` — so a player whose
   * edge lands exactly on a tile boundary is not considered to be touching the
   * tile beyond it. That is `Math.floor`'s convention, and the same one the
   * picker uses for footprints.
   */
  private canStandAt(subX: number, subY: number): boolean {
    const minX = subtileToTile(subX - PLAYER_RADIUS_SUBTILES);
    const maxX = subtileToTile(subX + PLAYER_RADIUS_SUBTILES - 1);
    const minY = subtileToTile(subY - PLAYER_RADIUS_SUBTILES);
    const maxY = subtileToTile(subY + PLAYER_RADIUS_SUBTILES - 1);

    // The edge of the packable world is a wall, not a crash: `tileKey` throws
    // outside it, and the occupancy lookup below would be the thing that threw.
    if (minX < TILE_MIN || maxX > TILE_MAX || minY < TILE_MIN || maxY > TILE_MAX) return false;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!isPassable(this.world.getTile(x, y))) return false;
        const entity = this.entities.at(x, y);
        if (entity !== undefined && !this.buildings.isWalkable(entity.type)) return false;
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Mining
   * ---------------------------------------------------------------- */

  /**
   * One tick of manual mining.
   *
   * The stop conditions are checked *before* progress is added, so a player who
   * walks out of reach or fills their bag stops accumulating that same tick
   * rather than one item later. Progress is discarded rather than banked: half
   * a lump of iron is not a thing the player can be given, and keeping it would
   * make walking away and back a way to mine in instalments the UI cannot show.
   */
  private mine(): void {
    const player = this.player;
    const target = player.miningTarget;
    if (target === null) return;

    if (this.checkMineable(target.x, target.y) !== null) {
      player.stopMining();
      return;
    }

    player.facing = facingToward(player, target.x, target.y);
    player.miningTicks += 1;
    if (player.miningTicks < MINE_TICKS_PER_ITEM) return;

    player.miningTicks -= MINE_TICKS_PER_ITEM;

    const itemId = this.yieldOf(target.x, target.y);
    // Re-asked rather than carried down from the check above: nothing else runs
    // between the two, but the day something does, the alternative is ore taken
    // out of the world and never put anywhere.
    if (itemId === null || this.player.inventory.spaceFor(itemId) < 1) {
      player.stopMining();
      return;
    }

    const taken = this.world.consumeResource(target.x, target.y, 1);
    if (taken === 0) {
      player.stopMining();
      return;
    }
    player.inventory.add(itemId, taken);
  }

  /**
   * The runtime item id a tile would yield, or null if it would yield nothing.
   *
   * Null covers all three ways a tile can be barren — no resource type, an
   * exhausted amount, and a resource whose `itemId` is `null` — because from
   * the mining code's point of view they are the same fact, and C09 made
   * "mineable" mean `getResourceAmount(x, y) > 0` everywhere.
   */
  private yieldOf(x: number, y: number): number | null {
    if (this.world.getResourceAmount(x, y) <= 0) return null;
    const stringId = resourceItemId(this.world.getResource(x, y));
    if (stringId === null || !this.items.has(stringId)) return null;
    return this.items.idOf(stringId);
  }
}
