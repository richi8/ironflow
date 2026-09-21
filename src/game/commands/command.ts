/**
 * Every player action, as plain data. See ironflow.md §7.
 *
 * ```text
 * DOM event -> InputManager -> Command -> queue -> tick phase 1 -> validate -> apply
 * ```
 *
 * The whole union is written out here even though C04 implements none of its
 * effects, because this file is the contract between the input layer, the
 * simulation and — later — replay, save-import and a Web Worker. A union that
 * grows a member per chunk is a union every layer has to re-learn each time;
 * one that is complete on day one is something they can be written against.
 *
 * Three properties are load-bearing and each is pinned by a test:
 *
 * - **Plain serializable data.** No functions, no entity references, no DOM
 *   objects. `structuredClone` of a command must equal the command.
 * - **Validated inside the simulation**, never by the UI. The UI may pre-check
 *   to grey out a button; the simulation is the authority.
 * - **Rejected with a typed reason.** Never silently dropped — invisible
 *   rejection is the single most common "the game feels broken" bug in this
 *   genre (§7).
 */

import { isEntityId, type EntityId } from '../entities/entity.js';
import { TILE_MAX, TILE_MIN, isRotation, type Rotation } from '../world/coordinates.js';

/**
 * A stable handle to an entity.
 *
 * Declared in `entities/entity.ts` since C05, which owns the store that hands
 * these out. Re-exported here because the command union names it and the input
 * layer may import command types but not entity internals (§4).
 */
export type { EntityId };

/** The discriminated union of everything a player can ask the game to do. */
export type Command =
  | { readonly type: 'build'; readonly buildingId: string; readonly x: number; readonly y: number; readonly rotation: Rotation }
  | { readonly type: 'remove'; readonly x: number; readonly y: number }
  | { readonly type: 'rotate'; readonly entityId: EntityId }
  | { readonly type: 'setRecipe'; readonly entityId: EntityId; readonly recipeId: string | null }
  | { readonly type: 'insertItems'; readonly entityId: EntityId; readonly itemId: string; readonly amount: number }
  | { readonly type: 'takeItems'; readonly entityId: EntityId; readonly itemId: string; readonly amount: number }
  | { readonly type: 'startResearch'; readonly technologyId: string }
  /**
   * Take a technology out of the research queue. Added in C22.
   *
   * §7's union was written out complete on day one and predicted
   * `startResearch` without predicting its release, exactly as C10's
   * `mineTile` needed `stopMining`. A queue the player can add to and never
   * remove from is a queue that punishes a misclick for the next ten minutes,
   * and "start it again to cancel it" would make one button mean two things.
   * Nothing is lost by cancelling — see `systems/research-system.ts` — so this
   * is a command that cannot fail for a reason the player would have to undo.
   */
  | { readonly type: 'cancelResearch'; readonly technologyId: string }
  /**
   * Queue `count` hand-crafts of `recipeId`. Added in C21A; see the note below.
   *
   * The ingredients leave the bag when the order is queued, not when each
   * item's craft begins — so this command is the moment the player spends
   * what they are carrying, and `cancelCraft` is the only way to get it back.
   */
  | { readonly type: 'craftItem'; readonly recipeId: string; readonly count: number }
  /** Drop the order at `index` in the hand-craft queue and refund it (C21A). */
  | { readonly type: 'cancelCraft'; readonly index: number }
  | { readonly type: 'movePlayer'; readonly dx: number; readonly dy: number }
  | { readonly type: 'mineTile'; readonly x: number; readonly y: number }
  /**
   * Stop mining, whatever was being mined. Added in C10; see the note below.
   *
   * §7's union was written out complete on day one and this is the one member
   * it did not predict. `mineTile` starts a *held* action — task 4 says "hold
   * left-click" — and a held action needs a release. Encoding release as the
   * absence of a command would mean the simulation guessing from how long it
   * had been since the last `mineTile`, which makes mining depend on how often
   * the input layer happens to send one, which is frame rate. One empty
   * command is cheaper than that, and it is recorded as a deviation in the
   * plan's §7.
   */
  | { readonly type: 'stopMining' };

export type CommandType = Command['type'];

/**
 * Why a command did not happen.
 *
 * §7 gives `'occupied' | 'unaffordable' | 'out_of_range' | 'unknown_recipe' |
 * ...`; the three at the top are C04's own and the rest are §7's, kept as the
 * vocabulary later chunks extend. The controller turns one of these into a
 * notification, so each one must be a sentence a player could be shown — which
 * is why there is no `'invalid'`.
 */
export type CommandRejectionReason =
  /** The command is not well-formed data: a fractional tile, a NaN, an empty id. */
  | 'malformed'
  /** The queue was full. Only reachable by a runaway producer; see the processor. */
  | 'queue_full'
  /** Well-formed, but no system owns this command type yet. Removed as chunks land. */
  | 'not_implemented'
  /** Something already stands on at least one tile of the footprint. */
  | 'occupied'
  /** The player does not hold the build cost. */
  | 'unaffordable'
  /** Off the edge of the packable world. Build and mine reach is `out_of_reach`. */
  | 'out_of_range'
  | 'unknown_recipe'
  /* Added in C06. §7 keeps this list open for the chunk that needs a reason. */
  /** No building has this id. A stale hotkey or a hand-written command. */
  | 'unknown_building'
  /** Water, or terrain this particular building refuses. */
  | 'bad_terrain'
  /** A miner with no ore under any tile of its footprint. */
  | 'no_resource'
  /** Remove was pointed at empty ground, or at something already demolished. */
  | 'nothing_there'
  /* Added in C10. */
  /**
   * Inside the world, but too far from the player (C10 tasks 4 and 5).
   *
   * Separate from `out_of_range` on purpose. "That is outside the world" and
   * "walk closer" are different instructions, and collapsing them would leave
   * the most common rejection in the game — pointing at a tile eleven tiles
   * away — explained by a sentence about the edge of the map.
   */
  | 'out_of_reach'
  /** The player is carrying all they can of what that tile yields. */
  | 'inventory_full'
  /* Added in C12. */
  /**
   * No entity has that id any more.
   *
   * Reachable without anyone doing anything wrong: the inspector's take button
   * carries the id it was drawn with, and a machine can be demolished — by the
   * player, or by a drag that ended on it — between the frame that drew the
   * button and the tick that reads the command. Separate from
   * `'nothing_there'`, which is about a *tile* the player pointed at.
   */
  | 'unknown_entity'
  /** The machine holds none of the item that was asked for (C12 task 5). */
  | 'nothing_to_take'
  /** The machine has no input buffer, or none that accepts that item. */
  | 'not_accepted'
  /** The player's bag holds none of the item they tried to insert (C15). */
  | 'nothing_to_give'
  /* Added in C21A. */
  /**
   * §15 says that recipe needs a machine.
   *
   * Separate from `unknown_recipe`, which is about an id nothing answers to:
   * "there is no such thing" and "you cannot make that with your hands" send
   * the player to two different places.
   */
  | 'not_craftable'
  /** The hand-craft queue already holds `MAX_CRAFT_ORDERS` orders. */
  | 'craft_queue_full'
  /** There is no order at that index to cancel — nor, since C22, that technology. */
  | 'nothing_queued'
  /* Added in C22. */
  /**
   * Research has not revealed this yet.
   *
   * One reason for a building and for a recipe, because it is one sentence to
   * the player — "you have not researched that" — and because the thing they
   * do about it is the same either way. The *which technology* half is on the
   * build menu and the research panel, beside the thing itself, where it can
   * be read without a toast going past.
   */
  | 'locked'
  /** No technology has this id. A stale panel, or a hand-written command. */
  | 'unknown_technology'
  /** It is already researched; there is nothing left to do to it. */
  | 'already_researched'
  /** It is already in the research queue. */
  | 'already_queued'
  /** Something it needs is neither researched nor queued ahead of it. */
  | 'missing_prerequisites'
  /** The research queue already holds `MAX_RESEARCH_QUEUE` technologies. */
  | 'research_queue_full';

/** A command and the reason it was refused, ready to become a notification. */
export interface CommandRejection {
  readonly command: Command;
  readonly reason: CommandRejectionReason;
}

/* -------------------------------------------------------------------------- *
 * Shape validation
 * -------------------------------------------------------------------------- */

/**
 * Is this command well-formed *data*? Nothing about the game world is consulted.
 *
 * This is the half of validation that has no owning system: whether a tile
 * coordinate is an integer inside the packable range, whether an amount is a
 * positive whole number, whether an id is a non-empty string. Systems own the
 * other half — `'occupied'`, `'unaffordable'` — because only they can know it.
 *
 * It runs on `enqueue`, so a malformed command never reaches the queue. That
 * matters more than it looks: the input layer derives tile coordinates from
 * floating-point screen arithmetic, and a single `NaN` client coordinate would
 * otherwise reach `tileKey`, which throws — turning a stray pointer event into
 * a crashed tick. Rejecting it here turns the same event into a notification.
 *
 * The parameter is typed `Command`, not `unknown`. Commands in v1 are produced
 * by our own input layer, so the type system covers the *shape* and this covers
 * the *values* it cannot express. Untrusted commands arrive with C26's save
 * import, which is where a full structural guard belongs.
 */
export function validateCommandShape(command: Command): CommandRejectionReason | null {
  switch (command.type) {
    case 'build':
      if (!isName(command.buildingId)) return 'malformed';
      if (!isRotation(command.rotation)) return 'malformed';
      return isTile(command.x, command.y) ? null : 'malformed';
    case 'remove':
    case 'mineTile':
      return isTile(command.x, command.y) ? null : 'malformed';
    case 'stopMining':
      // No payload, so nothing to be malformed. Stopping something that was
      // not running is a no-op, not an error — see the simulation's arm.
      return null;
    case 'rotate':
      return isEntityId(command.entityId) ? null : 'malformed';
    case 'setRecipe':
      if (!isEntityId(command.entityId)) return 'malformed';
      // `null` is "clear the recipe", which is a legitimate instruction.
      if (command.recipeId !== null && !isName(command.recipeId)) return 'malformed';
      return null;
    case 'insertItems':
    case 'takeItems':
      if (!isEntityId(command.entityId)) return 'malformed';
      if (!isName(command.itemId)) return 'malformed';
      return isCount(command.amount) ? null : 'malformed';
    case 'startResearch':
    case 'cancelResearch':
      return isName(command.technologyId) ? null : 'malformed';
    case 'craftItem':
      if (!isName(command.recipeId)) return 'malformed';
      return isCount(command.count) ? null : 'malformed';
    case 'cancelCraft':
      // Zero is the order being made right now, so this is the one index in
      // the game that is allowed to be it.
      return Number.isInteger(command.index) && command.index >= 0 ? null : 'malformed';
    case 'movePlayer':
      // Deliberately only "is a number", which C10 kept: only the *sign* of
      // each component is read, because the command carries a direction and
      // never a distance. Speed belongs to the simulation (§7), so there is
      // nothing here for a magnitude to be wrong about.
      return Number.isFinite(command.dx) && Number.isFinite(command.dy) ? null : 'malformed';
    default:
      // Unreachable through the type system, reachable from untyped JavaScript
      // and from a future member someone forgets to handle. Rejecting beats
      // accepting: an unknown command that passes validation reaches a system.
      return 'malformed';
  }
}

function isTile(x: number, y: number): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && x >= TILE_MIN && x <= TILE_MAX && y >= TILE_MIN && y <= TILE_MAX
  );
}

/** A registry key: non-empty, and not whitespace someone will never find. */
function isName(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
