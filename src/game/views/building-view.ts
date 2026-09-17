/**
 * One placed building, as a panel may see it. See ironflow.md §13 and C12.
 *
 * §13 writes this interface out and C12's inspector is the panel that renders
 * it. The *view* is C07's because the controller's surface is C07's: task 1
 * names `getBuildingView(id)`, and a facade with a hole in it is a facade the
 * next chunk has to widen.
 *
 * **Status must always explain a stall** (§13, pillar 3) — never a bare
 * "idle" where "no_input" is the truth. C11 makes that real for the first
 * time: a miner reports `'running'`, `'output_full'` or `'no_resource'`, and a
 * building with no system behind it — a chest — is still honestly `'idle'`.
 * C15 gives furnaces the rest.
 *
 * ## Three fields that may be null, and why that is not a hole
 *
 * §13's sketch gives `progress` and `ratePerMinute` as plain numbers and the
 * contents as bare `ItemStack`s. C12 makes the first two nullable and gives
 * the stacks a name and a capacity, for the reason §13 itself states about
 * `HudView`: **a view model carries only what exists.** A chest is not a
 * machine that is 0% of the way through something and produces 0 items a
 * minute — it has no progress and no output at all, and a panel handed zeroes
 * has no way to tell those apart, so it draws an empty bar and a dead number
 * under every crate in the factory. `null` is the difference, and it is the
 * difference the panel renders by leaving the row out.
 */

import type { EntityId } from '../entities/entity.js';
import type { MachineStatusName } from '../entities/machine-status.js';
import type { RecipeView } from './recipe-view.js';
import type { Rotation } from '../world/coordinates.js';

/**
 * The status names, straight from the enum machines actually store.
 *
 * C07 wrote this union out by hand and C11 gave the simulation a stored
 * status, at which point two lists of the same words would be two lists to
 * keep in step — and the one that drifts is the one the player reads.
 * `entities/machine-status.ts` is the table; this is its name.
 */
export type MachineStatus = MachineStatusName;

/**
 * One kind of item in a machine's buffer, ready to be drawn.
 *
 * The name is resolved by the controller because only it may ask the item
 * registry: §4 gives the UI the view models and the building table, and
 * nothing else. The capacity is what turns "12" into "12/50" — the number that
 * says whether `output_full` is about to happen, which is exactly what pillar
 * 3 wants on screen before the miner stops rather than after.
 */
export interface MachineStack {
  readonly itemId: string;
  readonly name: string;
  readonly count: number;
  /** How many of this item the buffer holds at most, or null when unbounded. */
  readonly capacity: number | null;
}

export interface MachineView {
  readonly id: EntityId;
  /** The content id, for looking up a sprite or a description. */
  readonly buildingId: string;
  readonly name: string;
  readonly status: MachineStatus;
  /**
   * 0..1 toward the next item, derived from progress ticks and never persisted
   * (§10). `null` for a building with nothing to be partway through.
   */
  readonly progress: number | null;
  /**
   * What the machine is making, or `null` for one that is making nothing and
   * for a building that makes nothing at all (C16).
   */
  readonly recipe: RecipeView | null;
  /**
   * The recipes the player may choose between, or `null` when the choice is
   * not theirs to make (C16 task 3).
   *
   * Null for a chest, which runs no recipes, and null for a furnace, which
   * reads its own input buffer and picks — offering a picker for a machine
   * that will overrule it on the next tick would be a control that lies. It
   * is the same nullability the two fields above have and for the same
   * reason: a view model carries only what exists.
   */
  readonly recipes: readonly RecipeView[] | null;
  readonly inputs: readonly MachineStack[];
  readonly outputs: readonly MachineStack[];
  /**
   * A rolling average over the last 300 ticks (C12 task 2), or `null` for a
   * building that produces nothing.
   *
   * Measured only for the machine the player has selected — see
   * `production.ts` — so it reads 0 for a machine asked about in passing.
   */
  readonly ratePerMinute: number | null;
  /**
   * The tile the next item out of a splitter will go to, or null for every
   * other building. C20.
   *
   * C17 left the splitter's panel completely empty — it has no ports, so it
   * carried no contents — and wrote down what a player would actually want to
   * see: "which way the next item is going, which is the one cursor the UI has
   * no word for yet". This is that word.
   *
   * A **tile** rather than a side index, because "side 0" is a fact about
   * `footprintTileAt`'s walk order and nothing a player can see. A coordinate
   * is something they can look at, and it is what the panel prints.
   */
  readonly nextOutput: { readonly x: number; readonly y: number } | null;
  /** The footprint's north-west tile. */
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  /**
   * Is the player close enough to take from it (C12 task 5)?
   *
   * A pre-check, which §7 permits the UI to make so it can grey out a button.
   * The simulation is still the authority: the command is refused with
   * `'out_of_reach'` whatever this says, because the player can walk away
   * between the frame that drew the button and the tick that reads the click.
   */
  readonly inReach: boolean;
}
