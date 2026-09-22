/**
 * The player character. See ironflow.md C10 task 1 and §10.
 *
 * Authoritative state, and the first piece of it that is not a building: the
 * player's position decides what can be reached, what can be mined and where a
 * building may be placed (tasks 4 and 5), so it is simulated and serialized
 * exactly like an entity's — and never interpolated in the renderer.
 *
 * ## Position is fixed-point, not a float
 *
 * §6 R3 forbids accumulating floats, and a walking player is the purest case
 * of an accumulator: `x += speed * dt`, thirty times a second, forever. §9
 * already sanctions the alternative for belt items — fixed-point integers — and
 * this file uses the same bargain. The position is an integer count of
 * **subtiles**, and every step is an exact integer addition: no drift, no
 * rounding that depends on where the player started, and a save that reloads
 * bit-identical.
 *
 * `SUBTILES_PER_TILE` is 240 rather than a power of two because 240 / TPS is
 * exactly 8: any speed that is a whole number of eighths of a tile per second
 * is an exact integer number of subtiles per tick. A power of two would make
 * 30 ticks per second a repeating fraction, and the step would have to be
 * rounded — which is the float problem again, wearing a hat.
 *
 * ## One container, at last
 *
 * The player carried two of them for eleven chunks: a `SlotInventory` of real
 * items (C08) and an `ItemCounts` bag of building materials, because a build
 * cost is paid in `miner` and `chest` and those were not registered items.
 * C20's building recipes make them items, so `materials` is gone and
 * `inventory` holds everything. What pays a build cost is a string-keyed view
 * over this one bag — see `items/build-materials.ts`.
 *
 * The consequence the player feels: the bag can be **full**. Thirty slots now
 * hold ore, plates and buildings together, which is what makes a chest
 * something to want rather than something to have.
 */

import { SlotInventory, type SerializedInventory, type StackSizeLookup } from '../items/inventory.js';
import { TPS } from '../simulation-clock.js';
import { NORTH, isRotation, type Rotation, type TileCoord } from '../world/coordinates.js';

/* -------------------------------------------------------------------------- *
 * Units
 * -------------------------------------------------------------------------- */

/**
 * How finely a tile is divided for the player's position.
 *
 * 240 = 8 x TPS. See the file header: this is what makes a whole number of
 * eighths of a tile per second an exact integer step.
 */
export const SUBTILES_PER_TILE = 240;

/**
 * Walking speed, in tiles per simulated second. A **balance number** (C20).
 *
 * Four tiles a second crosses the eight-tile build radius in two seconds, which
 * is what makes task 5's "expansion means travelling" a cost the player feels
 * without it becoming the thing they spend their session doing.
 */
export const PLAYER_SPEED_TILES_PER_SECOND = 4;

/** The exact integer step, in subtiles, that one tick of walking covers. */
export const PLAYER_STEP_SUBTILES = (PLAYER_SPEED_TILES_PER_SECOND * SUBTILES_PER_TILE) / TPS;

/**
 * The per-axis step when walking diagonally.
 *
 * `round(step / sqrt(2))`, so a diagonal covers the same ground per second as a
 * cardinal one instead of 1.41 times as much. The rounding leaves a diagonal
 * about 1.6% fast, which is invisible and — far more importantly — *the same
 * 1.6% on every machine*. Computing the true length per step would put a square
 * root in the movement path, and `Math.hypot` is not required to be correctly
 * rounded, so two engines could disagree (§6 R1).
 */
export const PLAYER_DIAGONAL_SUBTILES = Math.round(PLAYER_STEP_SUBTILES / Math.SQRT2);

/**
 * How wide the player is, in subtiles, for collision. 0.3 of a tile.
 *
 * A point-sized player would stand with half of itself inside the water it is
 * next to. A box is one number and four tile lookups, and it is what makes
 * "blocked by water and buildings" (task 3) look blocked rather than merely be
 * blocked.
 */
export const PLAYER_RADIUS_SUBTILES = Math.round(0.3 * SUBTILES_PER_TILE);

/** How far the player can reach to mine, in tiles. C10 task 4 says six. */
export const MINE_RANGE_TILES = 6;

/** How far the player can reach to build, in tiles. C10 task 5 says eight. */
export const BUILD_RANGE_TILES = 8;

/**
 * Ticks of mining per item, at §15's manual rate of 0.5 items/s.
 *
 * An integer count, never a float accumulator (§6 R3): 30 / 0.5 is 60 exactly,
 * and the acceptance criterion "fills the inventory at the specified rate" is
 * then a tick count a test can assert rather than a tolerance it has to allow.
 */
export const MINE_TICKS_PER_ITEM = TPS / 0.5;

/** Slots in the player's bag. A **balance number** (C20). */
export const PLAYER_INVENTORY_SLOTS = 30;

/**
 * How many separate orders the hand-craft queue holds. A **balance number**
 * (C21A).
 *
 * A bound rather than a design: the queue is authoritative state and it is
 * fed by a button, so a player leaning on that button must not be able to
 * grow a save file without limit. Twelve is more distinct things than the
 * game has hand-craftable recipes, so the cap can only be reached by queueing
 * the same thing in separate orders, which merging already prevents.
 */
export const MAX_CRAFT_ORDERS = 12;

/**
 * How many of one thing a single `craftItem` command may ask for. A **balance
 * number** (C21A).
 *
 * The ingredients of the whole order are taken at once (see
 * `systems/crafting-system.ts`), so this is also the bound on how much of the
 * player's bag one click can move.
 */
export const MAX_CRAFT_BATCH = 100;

/* -------------------------------------------------------------------------- *
 * Conversions
 * -------------------------------------------------------------------------- */

/** The tile containing a subtile coordinate. Correct for negatives. */
export function subtileToTile(subtile: number): number {
  return Math.floor(subtile / SUBTILES_PER_TILE);
}

/** The subtile at the centre of a tile — where the player stands on arrival. */
export function tileCentreSubtile(tile: number): number {
  return tile * SUBTILES_PER_TILE + SUBTILES_PER_TILE / 2;
}

/**
 * A subtile coordinate as a fractional tile position, for the renderer.
 *
 * Derived, not authoritative: nothing in `game/` compares these, because a
 * division is where exactness stops. The simulation compares subtiles.
 */
export function subtileToTilePosition(subtile: number): number {
  return subtile / SUBTILES_PER_TILE;
}

/* -------------------------------------------------------------------------- *
 * State
 * -------------------------------------------------------------------------- */

/** Where the player is trying to walk, as a tile-space direction of -1, 0 or 1. */
export interface MoveIntent {
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

const STILL: MoveIntent = Object.freeze({ dx: 0, dy: 0 });

/**
 * One order in the hand-craft queue: make `remaining` of `recipe`. C21A.
 *
 * Plain data, because it is authoritative state and §10 wants it in a save
 * — and a numeric `recipe` rather than a string one, for the reason every
 * other persisted reference is numeric: the string ids are content and the
 * save carries a mapping (§14).
 *
 * The ingredients of **all** `remaining` crafts have already left the bag by
 * the time an order exists. See `systems/crafting-system.ts` for why, and for
 * what cancelling one gives back.
 */
export interface CraftOrder {
  readonly recipe: number;
  /** How many are still to be made, including the one in progress. Above 0. */
  remaining: number;
  /** Integer ticks into the one being made now (§6 R3). */
  progressTicks: number;
}

/** The player, as a save file sees it. Plain data, sorted where it can be. */
export interface SerializedPlayer {
  readonly subX: number;
  readonly subY: number;
  readonly facing: Rotation;
  readonly moveX: number;
  readonly moveY: number;
  readonly miningX: number | null;
  readonly miningY: number | null;
  readonly miningTicks: number;
  readonly inventory: SerializedInventory;
  /**
   * The hand-craft queue, head first (C21A). Order is the *decision*, not an
   * accident of a container, so it is serialized as written and never sorted.
   */
  readonly crafts: readonly CraftOrder[];
}

export interface PlayerStateOptions {
  /** How big a stack of each item is. The registry's `stackSizeOf`. */
  readonly stackSizeOf: StackSizeLookup;
  /** Where the player starts, in whole tiles. They stand at its centre. */
  readonly x?: number;
  readonly y?: number;
  readonly slots?: number;
}

export class PlayerState {
  /**
   * Position, in subtiles. Authoritative (§10).
   *
   * Mutable, unlike an entity's `x`/`y` — the player is not in the occupancy
   * index, so moving it corrupts nothing. Only `PlayerSystem` writes here, and
   * only after `canStandAt` has agreed.
   */
  subX: number;
  subY: number;

  /** Which way the sprite looks. Derived from movement, but persisted: it is
   * what the player sees after a load, and recomputing it would need history. */
  facing: Rotation = NORTH;

  /**
   * The direction the player is currently walking, which **persists between
   * ticks**.
   *
   * This is the whole of C10's frame-rate independence (acceptance 4). A
   * `movePlayer` command sets a direction; every tick then moves exactly one
   * step in it. If instead each command moved the player one step, a 144 Hz
   * browser would enqueue five commands per tick and walk five times as fast —
   * and a 20 Hz one would leave a third of the ticks with no command at all.
   * See the deviation recorded in the plan's C10 section.
   */
  private intent: MoveIntent = STILL;

  /** The tile being mined, or null. Authoritative: the progress ring reads it. */
  miningX: number | null = null;
  miningY: number | null = null;

  /** Integer ticks of progress toward the next item (§6 R3). */
  miningTicks = 0;

  /**
   * What the player is making by hand, head first. Authoritative (§10), C21A.
   *
   * A plain array because that is what it is: an ordered list the player put
   * in an order on purpose. §6 R4 is about containers whose *iteration order
   * is incidental*; this one's order is the state.
   *
   * Only `CraftingSystem` writes here, and the ingredients for every order in
   * it are already out of `inventory` — so this array and the bag are two
   * halves of one fact, and nothing may edit either without the other.
   */
  readonly crafts: CraftOrder[] = [];

  /**
   * Everything the player is carrying: ore, plates, gears and buildings.
   * Slot-based (C08), and since C20 the only container they have.
   */
  readonly inventory: SlotInventory;

  constructor(options: PlayerStateOptions) {
    this.subX = tileCentreSubtile(options.x ?? 0);
    this.subY = tileCentreSubtile(options.y ?? 0);
    this.inventory = new SlotInventory({
      slots: options.slots ?? PLAYER_INVENTORY_SLOTS,
      stackSizeOf: options.stackSizeOf,
    });
  }

  /** The tile the player is standing on. */
  get tileX(): number {
    return subtileToTile(this.subX);
  }

  get tileY(): number {
    return subtileToTile(this.subY);
  }

  /** Fractional tile position, for the renderer and for view models only. */
  get x(): number {
    return subtileToTilePosition(this.subX);
  }

  get y(): number {
    return subtileToTilePosition(this.subY);
  }

  /** Is the player walking this tick? */
  get isMoving(): boolean {
    return this.intent.dx !== 0 || this.intent.dy !== 0;
  }

  get moveIntent(): MoveIntent {
    return this.intent;
  }

  /**
   * Set the direction the player walks in, from a `movePlayer` command.
   *
   * **Only the sign of each component is read.** The command carries a
   * *direction*, never a distance: speed belongs to the simulation, and a
   * command that could set it would let a fast client walk faster — which is
   * the same bug whether the fast client is a cheat or a 240 Hz monitor.
   */
  setMoveIntent(dx: number, dy: number): void {
    this.intent = { dx: unitStep(dx), dy: unitStep(dy) };
  }

  /** Put the player somewhere, in whole tiles. For setup and for C24's loader. */
  setTilePosition(x: number, y: number): void {
    this.subX = tileCentreSubtile(x);
    this.subY = tileCentreSubtile(y);
  }

  /** Start mining a tile, discarding progress if it is a different one. */
  startMining(x: number, y: number): void {
    if (this.miningX === x && this.miningY === y) return;
    this.miningX = x;
    this.miningY = y;
    this.miningTicks = 0;
  }

  /** Stop mining, wherever the progress had got to. */
  stopMining(): void {
    this.miningX = null;
    this.miningY = null;
    this.miningTicks = 0;
  }

  /** The tile being mined, or null. */
  get miningTarget(): TileCoord | null {
    if (this.miningX === null || this.miningY === null) return null;
    return { x: this.miningX, y: this.miningY };
  }

  /** How far through the current item, 0..1. Derived; for the progress ring. */
  get miningProgress(): number {
    if (this.miningTarget === null) return 0;
    return this.miningTicks / MINE_TICKS_PER_ITEM;
  }

  /**
   * Squared distance from the player to the centre of a tile, in subtiles.
   *
   * Squared and in subtiles so the comparison is exact integer arithmetic: the
   * largest value it can reach is about 2.5e14, well inside the range a float64
   * holds every integer in, so `inRange` is a genuine comparison rather than an
   * approximate one (§6 R7).
   */
  squaredSubtileDistanceTo(x: number, y: number): number {
    const dx = tileCentreSubtile(x) - this.subX;
    const dy = tileCentreSubtile(y) - this.subY;
    return dx * dx + dy * dy;
  }

  /** Is the centre of tile `(x, y)` within `rangeTiles` of the player? */
  isWithinRange(x: number, y: number, rangeTiles: number): boolean {
    const limit = rangeTiles * SUBTILES_PER_TILE;
    return this.squaredSubtileDistanceTo(x, y) <= limit * limit;
  }

  /**
   * Replace this player with a saved one. C24's load.
   *
   * The mirror of `toJSON`, field for field, and it validates every one of
   * them for the reason `ExploredChunks.restore` does: this is a door
   * untrusted data comes through, and a fractional `subX` would put the player
   * permanently between two tiles in a way nothing else in the game can
   * produce or recover from. C26 validates an *imported* save in full before
   * it reaches here; these are the invariants that must hold even for a save
   * this build wrote itself.
   *
   * `crafts` arrives with numeric recipe ids, exactly as `toJSON` writes them:
   * the translation to and from the string ids a save file carries belongs to
   * `save/save-serializer.ts`, which is the only thing here that has a recipe
   * registry to translate with.
   */
  load(saved: SerializedPlayer): void {
    this.subX = whole(saved.subX, 'subX');
    this.subY = whole(saved.subY, 'subY');

    if (!isRotation(saved.facing)) {
      throw new RangeError(`PlayerState.load: facing ${saved.facing} is not a Rotation.`);
    }
    this.facing = saved.facing;
    this.setMoveIntent(saved.moveX, saved.moveY);

    // Both or neither: a player mining a column with no row is a target the
    // rest of this class cannot express, and `miningTarget` would hide it.
    if ((saved.miningX === null) !== (saved.miningY === null)) {
      throw new RangeError('PlayerState.load: a mining target needs both coordinates or neither.');
    }
    this.miningX = saved.miningX === null ? null : whole(saved.miningX, 'miningX');
    this.miningY = saved.miningY === null ? null : whole(saved.miningY, 'miningY');
    this.miningTicks = whole(saved.miningTicks, 'miningTicks');
    if (this.miningTicks < 0) {
      throw new RangeError(`PlayerState.load: miningTicks is ${this.miningTicks}; ticks never run backwards.`);
    }

    this.inventory.load(saved.inventory);

    this.crafts.length = 0;
    for (const order of saved.crafts) {
      if (!Number.isInteger(order.remaining) || order.remaining < 1) {
        throw new RangeError(`PlayerState.load: a craft order makes ${order.remaining}; it must be a whole number above 0.`);
      }
      if (!Number.isInteger(order.progressTicks) || order.progressTicks < 0) {
        throw new RangeError(`PlayerState.load: a craft order is ${order.progressTicks} ticks in, which is not a count.`);
      }
      // Copied, for `toJSON`'s reason in reverse: the array a save was read
      // from must not become the queue a system then edits.
      this.crafts.push({ recipe: order.recipe, remaining: order.remaining, progressTicks: order.progressTicks });
    }
  }

  toJSON(): SerializedPlayer {
    return {
      subX: this.subX,
      subY: this.subY,
      facing: this.facing,
      moveX: this.intent.dx,
      moveY: this.intent.dy,
      miningX: this.miningX,
      miningY: this.miningY,
      miningTicks: this.miningTicks,
      inventory: this.inventory.toJSON(),
      // Copied, not handed over: `toJSON` is read by the determinism harness
      // and by C24's save, and neither may hold a live order it could edit.
      crafts: this.crafts.map((order) => ({
        recipe: order.recipe,
        remaining: order.remaining,
        progressTicks: order.progressTicks,
      })),
    };
  }
}

/** A saved field that has to be a whole number, or a throw naming it. */
function whole(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`PlayerState.load: ${field} is ${String(value)}; it must be a whole number (§6 R3, R7).`);
  }
  // `0 - v` never yields `-0`, and a saved `-0` would survive as a different
  // value than the `0` JSON writes it as (§6 R7).
  return value === 0 ? 0 : value;
}

/** The sign of a number as a movement component, with no `-0` (§6 R7). */
function unitStep(value: number): -1 | 0 | 1 {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * How far the player moves on each axis this tick, in subtiles.
 *
 * Exported because the movement test asserts the diagonal is the same speed as
 * a cardinal step, and asserting that against the table rather than against a
 * simulated walk is what makes the failure message say which number is wrong.
 */
export function stepFor(intent: MoveIntent): { readonly dx: number; readonly dy: number } {
  if (intent.dx === 0 && intent.dy === 0) return ZERO_STEP;
  const size = intent.dx !== 0 && intent.dy !== 0 ? PLAYER_DIAGONAL_SUBTILES : PLAYER_STEP_SUBTILES;
  return { dx: intent.dx * size, dy: intent.dy * size };
}

const ZERO_STEP = Object.freeze({ dx: 0, dy: 0 });

/**
 * The quarter-turn a movement direction should leave the player facing.
 *
 * The dominant axis wins, and a tie goes to the vertical — so walking
 * north-east faces north rather than flickering between two sprites as the
 * player nudges the keys. Nothing here knows how that looks on screen (§5); it
 * is tile-space north, and the renderer decides which way that points.
 */
export function facingFor(intent: MoveIntent, current: Rotation): Rotation {
  if (intent.dx === 0 && intent.dy === 0) return current;
  if (Math.abs(intent.dy) >= Math.abs(intent.dx)) return intent.dy < 0 ? 0 : 2;
  return intent.dx > 0 ? 1 : 3;
}

/** The quarter-turn that points from the player at a tile. For mining. */
export function facingToward(player: PlayerState, x: number, y: number): Rotation {
  const dx = tileCentreSubtile(x) - player.subX;
  const dy = tileCentreSubtile(y) - player.subY;
  if (dx === 0 && dy === 0) return player.facing;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}
