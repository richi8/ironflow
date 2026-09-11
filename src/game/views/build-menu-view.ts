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
   * Always true until C22 gives the game a technology tree. It is here rather
   * than added later because §13 lists "locked/unlocked" as part of what the
   * build menu shows, and a menu that gains a whole visual state in C22 is a
   * menu that gets re-laid-out then instead of now.
   */
  readonly unlocked: boolean;
  readonly selected: boolean;
  /** 1–9 for an entry the number row reaches, null for the rest. */
  readonly hotkey: number | null;
}

export interface BuildMenuView {
  readonly entries: readonly BuildMenuEntry[];
  /** What the cursor is holding, or null for an empty hand. */
  readonly selectedBuildingId: string | null;
  /** The rotation the held building would be placed with. */
  readonly rotation: Rotation;
}
