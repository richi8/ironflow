/**
 * What is under the pointer, for the world tooltip. See ironflow.md C32.
 *
 * The inspector (C12) answers "what is this machine doing" for the one
 * machine the player clicked. This answers a smaller question for whatever
 * the pointer rests on, without a click: how much ore is left in this tile,
 * how fast this belt runs, how much a miner has left under it, what an
 * assembler is set to. It is the genre's hover readout.
 *
 * ```text
 *   GameController.getHoverView()  ->  GameUI's world tooltip
 *   a frozen HoverView, or null        a pooled box beside the pointer
 * ```
 *
 * Everything here is derived (§10): read from authoritative state when asked,
 * never stored and never saved. Tooltip text is on §6's list of things that
 * are deliberately outside the simulation, so the view carries numbers and
 * names and the UI writes the sentences.
 */

import type { MachineView } from './building-view.js';

/** The ore in one tile of ground. */
export interface ResourceHoverView {
  /** The item it mines into, which is also its name on screen. */
  readonly itemId: string;
  readonly name: string;
  /** Units left in this tile. Never zero: a depleted tile has no readout. */
  readonly amount: number;
}

/** The ore a miner's footprint still covers. */
export interface OreUnderView {
  readonly itemId: string;
  readonly name: string;
  /** Units left across the whole footprint, of the ore the miner is on. */
  readonly remaining: number;
  /** How many of its tiles still hold some. */
  readonly tiles: number;
}

/**
 * The content numbers of a building, which the inspector does not show
 * because it shows what the building is *doing*. Each is null for a building
 * the number means nothing for, by §13's rule that a view carries only what
 * exists.
 */
export interface BuildingDetailsView {
  /** A belt, splitter or underground: how fast it carries, in tiles/s. */
  readonly beltTilesPerSecond: number | null;
  /** The same as throughput: tiles/s times §9's four items per tile. */
  readonly beltItemsPerSecond: number | null;
  /** An inserter's full swing rate. */
  readonly inserterItemsPerSecond: number | null;
  /** A miner's rate while it has ore and room. */
  readonly miningItemsPerSecond: number | null;
  /** A furnace's or assembler's speed multiplier. */
  readonly craftingSpeed: number | null;
  /** A miner: what is left under it. Null on bare ground. */
  readonly oreUnder: OreUnderView | null;
}

export interface HoverView {
  /** The ground tile under the pointer. */
  readonly x: number;
  readonly y: number;
  /** The building under the pointer, as the inspector would see it, or null. */
  readonly building: MachineView | null;
  /** Its content numbers, present exactly when `building` is. */
  readonly details: BuildingDetailsView | null;
  /** The ore in the tile under the pointer, or null for none. */
  readonly resource: ResourceHoverView | null;
}
