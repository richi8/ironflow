/**
 * The build menu and the hotbar, as one snapshot. See ironflow.md C07 tasks 1–3.
 *
 * The toolbar and the build menu are two presentations of the same question —
 * *what can I build, what does it cost, and what am I holding* — so they read
 * one view model rather than two that could disagree. The toolbar shows the
 * first nine entries with their hotkeys; the menu shows all of them grouped by
 * category.
 *
 * Entry order is content order: the *n*th entry of `data/buildings.ts` is
 * hotbar slot *n*. That is C06's last acceptance criterion carried forward —
 * adding a building to the content table gives it a slot, a menu row and a
 * ghost with no code change anywhere.
 */

import type { BuildingCategory } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';

/** One line of a build cost, with what the player actually holds against it. */
export interface BuildMenuCost {
  readonly itemId: string;
  readonly count: number;
  readonly held: number;
}

export interface BuildMenuEntry {
  readonly buildingId: string;
  readonly name: string;
  readonly category: BuildingCategory;
  readonly cost: readonly BuildMenuCost[];
  /** Every line of the cost is covered by what the player holds. */
  readonly affordable: boolean;
  /**
   * Whether research has revealed this building.
   *
   * It was `true` for every row from C07 to C21 — declared early because §13
   * lists "locked/unlocked" as part of what the build menu shows, and a menu
   * that gained a whole visual state later is a menu that would have been
   * re-laid-out then instead of at the start. C22 is when it started varying,
   * and nothing about the panel's layout had to move.
   */
  readonly unlocked: boolean;
  /**
   * The technology that would reveal it, or null for one already available
   * (C22 task 5).
   *
   * A **name**, not an id: this is display text, and §4 will not let the menu
   * ask a registry what a technology is called. §13's rule about a view model
   * carrying only what exists is why it is null rather than an empty string —
   * most rows have no such technology and never will.
   */
  readonly unlockedBy: string | null;
  readonly selected: boolean;
  /** 1–9 for an entry the number row reaches, null for the rest. */
  readonly hotkey: number | null;
}

/**
 * One hotbar slot: an item the player put there, and **one stack** of it.
 *
 * Any item may sit on the bar, and the same item on several slots. The bag
 * counts items rather than keeping slots (C08), so the stacks are dealt out in
 * slot order — see `GameController.hotbarView`.
 */
export interface HotbarSlotView {
  readonly itemId: string;
  readonly name: string;
  /** This slot's stack: at most `stackSize`, and 0 when the bag has run out. */
  readonly count: number;
  readonly stackSize: number;
  /** The building this item places, or null for a material. */
  readonly building: BuildMenuEntry | null;
  /** This is the slot the hand was filled from. */
  readonly selected: boolean;
}

export interface BuildMenuView {
  readonly entries: readonly BuildMenuEntry[];
  /**
   * The hotbar, slot by slot: what the player put there, or `null` for an
   * empty slot. Always `HOTBAR_SLOTS` long.
   */
  readonly hotbar: readonly (HotbarSlotView | null)[];
  /** The building the cursor is holding, or null. */
  readonly selectedBuildingId: string | null;
  /** The material in the hand, to feed a machine with, or null. */
  readonly heldItemId: string | null;
  /** The rotation the held building would be placed with. */
  readonly rotation: Rotation;
}
