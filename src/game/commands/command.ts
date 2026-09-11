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
  | { readonly type: 'movePlayer'; readonly dx: number; readonly dy: number }
  | { readonly type: 'mineTile'; readonly x: number; readonly y: number };

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
  | 'occupied'
  | 'unaffordable'
  | 'out_of_range'
  | 'unknown_recipe';

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
      return isName(command.technologyId) ? null : 'malformed';
    case 'movePlayer':
      // Deliberately only "is a number". Whether movement is a unit direction
      // or a tile step is C10's decision, and guessing it here would either be
      // wrong or would quietly become the decision.
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
