/**
 * Walking and manual gathering. See ironflow.md C10 tasks 2-4 and §8 phase 8.
 *
 * Two jobs, both of them per-tick and both of them integer arithmetic:
 *
 * ```text
 * move   one step in the held direction, per axis, blocked by terrain and by
 *        buildings that are not walkable
 * ride   one step along the belt under the player's feet, if there is one
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

import { BELT_TILE_UNITS, asBelt, type BeltItem } from '../entities/belt-entity.js';
import type { EntityStore } from '../entities/entity-store.js';
import { NO_ENTITY, type Entity } from '../entities/entity.js';
import { SPLITTER_LANES, asSplitter, splitterTile, type SplitterSide } from '../entities/splitter-entity.js';
import {
  asUnderground,
  isUndergroundEntrance,
  undergroundLaneUnits,
  type UndergroundBeltEntity,
} from '../entities/underground-belt-entity.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import { TPS } from '../simulation-clock.js';
import {
  MINE_TICKS_PER_ITEM,
  MINE_RANGE_TILES,
  PICKUP_RANGE_TILES,
  PLAYER_RADIUS_SUBTILES,
  PlayerState,
  SUBTILES_PER_TILE,
  facingFor,
  facingToward,
  stepFor,
  subtileToTile,
} from '../player/player-state.js';
import type { ItemRegistry } from '../registries/item-registry.js';
import { resourceItemId } from '../world/resource.js';
import { isPassable } from '../world/tile.js';
import { DIRECTION_OFFSETS, TILE_MAX, TILE_MIN, type Rotation } from '../world/coordinates.js';
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

  /** Phase 8. Movement first, then mining and pickup, so reach is judged where they land. */
  tick(): void {
    this.move();
    this.ride();
    this.mine();
    this.pickUp();
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
   * One tick of being carried by the belt underfoot.
   *
   * A belt the player can stand on and that does not move them reads as a
   * conveyor that is switched off, so standing on one drifts them along it at
   * the belt's own speed — the same speed the items on it are visibly moving,
   * because both come from `tilesPerSecond` in the content table.
   *
   * It is applied **after** the walk and adds to it rather than replacing it,
   * so the two compose the way they do in the genre: walking with the belt is
   * fast, walking against it is slow, and standing still on one is not
   * something the player can do. Each axis is still checked against
   * `canStandAt`, so a belt can carry the player along a wall but never into
   * it — a belt running into a machine stops being a ride at the last tile
   * rather than pushing the player inside it.
   *
   * The tile under the player's **centre** decides, not the four their box may
   * touch. A player half on a belt is either on it or not, and the centre is
   * the half the player is looking at; sampling every touched tile would mean
   * two belts could each claim a share of them.
   */
  private ride(): void {
    const player = this.player;
    const entity = this.entities.at(subtileToTile(player.subX), subtileToTile(player.subY));
    if (entity === undefined) return;

    const tilesPerSecond = this.buildings.carrySpeedFor(entity.type);
    if (tilesPerSecond === null) return;

    const step = DIRECTION_OFFSETS[entity.rotation];
    if (step === undefined) return;

    // Rounded to a whole subtile, once, from two content numbers — never
    // accumulated (§6 R3). At §9's 2 tiles/s this is 16 subtiles a tick,
    // exactly half a walking step.
    const carry = Math.round((tilesPerSecond * SUBTILES_PER_TILE) / TPS);
    if (carry === 0) return;

    if (step.x !== 0 && this.canStandAt(player.subX + step.x * carry, player.subY)) {
      player.subX += step.x * carry;
    }
    if (step.y !== 0 && this.canStandAt(player.subX, player.subY + step.y * carry)) {
      player.subY += step.y * carry;
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

  /* ---------------------------------------------------------------- *
   * Pickup (F)
   * ---------------------------------------------------------------- */

  /**
   * One tick of F held: take the nearest item within `PICKUP_RANGE_TILES` of
   * the player's centre, along each axis, off a belt, a splitter or the visible end of an
   * underground run, into the bag. One item a tick, and only one the bag has
   * room for, so a full bag skips iron and still takes coal.
   *
   * Distances are exact integers (§6 R3): the player is in subtiles (240 to a
   * tile) and an item in belt units (256 to a tile), so both are scaled to
   * 240 x 256 to a tile. Ties go to the first found, and carriers are visited
   * in ascending id, so the pick is the same on every machine (§6 R4).
   */
  private pickUp(): void {
    const player = this.player;
    if (!player.pickingUp) return;

    const scale = SUBTILES_PER_TILE * BELT_TILE_UNITS;
    const px = player.subX * BELT_TILE_UNITS;
    const py = player.subY * BELT_TILE_UNITS;
    const limit = PICKUP_RANGE_TILES * scale;
    let best: { items: BeltItem[]; index: number } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const lane of this.lanesNear(player.tileX, player.tileY)) {
      const step = DIRECTION_OFFSETS[lane.rotation];
      if (step === undefined) continue;
      for (let index = 0; index < lane.items.length; index++) {
        const item = lane.items[index];
        if (item === undefined) continue;
        const along = item.pos - lane.from;
        if (along < 0 || along >= BELT_TILE_UNITS) continue;
        const x = (lane.x * BELT_TILE_UNITS + alongAxis(step.x, along)) * SUBTILES_PER_TILE;
        const y = (lane.y * BELT_TILE_UNITS + alongAxis(step.y, along)) * SUBTILES_PER_TILE;
        // A square reach, so the whole of each neighbouring belt tile is in it;
        // a circle one tile across would miss the far half of the one beside.
        if (Math.abs(x - px) > limit || Math.abs(y - py) > limit) continue;
        const distance = (x - px) * (x - px) + (y - py) * (y - py);
        if (distance > bestDistance || (best !== null && distance === bestDistance)) continue;
        if (player.inventory.spaceFor(item.itemId) < 1) continue;
        best = { items: lane.items, index };
        bestDistance = distance;
      }
    }

    if (best === null) return;
    const [taken] = best.items.splice(best.index, 1);
    if (taken !== undefined) player.inventory.add(taken.itemId, 1);
  }

  /**
   * Every stretch of lane lying on the 3x3 tiles around `(cx, cy)`, which is
   * everywhere a point within one tile of the player's centre can be. Each is
   * one tile of a lane: its items with `pos` in `from..from+255` are on tile
   * `(x, y)`. An underground run shows two such stretches, one at each mouth;
   * what is between them is out of sight and out of reach.
   */
  private lanesNear(cx: number, cy: number): PickupLane[] {
    const found: Entity[] = [];
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < TILE_MIN || x > TILE_MAX || y < TILE_MIN || y > TILE_MAX) continue;
        let entity = this.entities.at(x, y);
        if (entity === undefined) continue;
        // An exit mouth's items live in its entrance's lane.
        const mouth = asUnderground(entity, this.buildings);
        if (mouth !== null) {
          const partner = this.partnerOf(mouth);
          if (!isUndergroundEntrance(mouth, partner) && partner !== undefined) entity = partner;
        }
        if (!found.includes(entity)) found.push(entity);
      }
    }
    found.sort((a, b) => a.id - b.id);

    const lanes: PickupLane[] = [];
    for (const entity of found) {
      const belt = asBelt(entity);
      if (belt !== null) {
        lanes.push({ items: belt.items, x: belt.x, y: belt.y, rotation: belt.rotation, from: 0 });
        continue;
      }
      const splitter = asSplitter(entity);
      if (splitter !== null) {
        const size = this.buildings.footprintOf(splitter.type);
        for (let side = 0; side < SPLITTER_LANES; side++) {
          const tile = splitterTile(splitter, size, side as SplitterSide);
          const items = splitter.lanes[side as SplitterSide];
          lanes.push({ items, x: tile.x, y: tile.y, rotation: splitter.rotation, from: 0 });
        }
        continue;
      }
      const mouth = asUnderground(entity, this.buildings);
      if (mouth !== null) {
        lanes.push({ items: mouth.items, x: mouth.x, y: mouth.y, rotation: mouth.rotation, from: 0 });
        const partner = this.partnerOf(mouth);
        const units = undergroundLaneUnits(mouth, partner);
        if (partner !== undefined && units > BELT_TILE_UNITS) {
          const from = units - BELT_TILE_UNITS;
          lanes.push({ items: mouth.items, x: partner.x, y: partner.y, rotation: mouth.rotation, from });
        }
      }
    }
    return lanes;
  }

  private partnerOf(mouth: UndergroundBeltEntity): Entity | undefined {
    if (mouth.link === NO_ENTITY) return undefined;
    const partner = this.entities.get(mouth.link);
    if (partner === undefined || this.entities.isPendingRemoval(partner.id)) return undefined;
    return partner;
  }
}

/** One tile's worth of a lane, for `pickUp`. See `lanesNear`. */
interface PickupLane {
  readonly items: BeltItem[];
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  /** The lane position this tile starts at: 0, or an underground exit's offset. */
  readonly from: number;
}

/**
 * Where along one axis of its tile an item sits, in belt units: `along` from
 * the entry edge when the lane runs that way, mirrored when it runs back, and
 * the middle of the tile across it.
 */
function alongAxis(step: number, along: number): number {
  if (step > 0) return along;
  if (step < 0) return BELT_TILE_UNITS - along;
  return BELT_TILE_UNITS / 2;
}
