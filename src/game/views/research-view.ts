/**
 * The tech tree, as the research panel draws it. See ironflow.md C22 task 5
 * and §13.
 *
 * > Research panel: tree layout, prerequisites, costs, current progress, and a
 * > queue. Locked buildings appear greyed in the build menu with their
 * > unlocking technology named.
 *
 * One frozen snapshot with every technology in it, in content order, each
 * carrying its own state — so the panel builds its DOM once from the first
 * view and updates by assignment (§13), exactly as `BuildMenu` and
 * `InventoryPanel` do. The tree's *shape* is content and never changes while
 * the game runs; what changes is five words per node.
 *
 * Everything here is resolved by the controller, because everything here needs
 * a registry the UI may not import (§4): an item's name, a building's name,
 * and the name of the technology that unlocks a thing are all content.
 */

/** Where a technology stands. The panel's whole visual vocabulary. */
export type TechnologyState =
  /** Done. Its unlocks are available. */
  | 'researched'
  /** At the head of the queue: this is what the labs are working on. */
  | 'active'
  /** In the queue, behind something else. */
  | 'queued'
  /** Not queued, and its prerequisites are done — it can be started now. */
  | 'available'
  /** Something it needs has not been researched. */
  | 'locked';

/** One line of a technology's cost, named for a panel. */
export interface ResearchCostView {
  readonly itemId: string;
  readonly name: string;
  /** How many in total. It is also the number of research units — see C22. */
  readonly count: number;
}

/** One thing a technology grants, named for a panel. */
export interface UnlockView {
  readonly kind: 'building' | 'recipe';
  readonly id: string;
  /**
   * What to call it on screen: a building's own name, or — for a recipe — the
   * name of what it makes, which is `RecipeView`'s rule and for its reason.
   */
  readonly name: string;
}

export interface TechnologyView {
  /** The string id the `startResearch` and `cancelResearch` commands speak (§7). */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** Longest path from a root. The panel draws one row per tier. */
  readonly tier: number;
  readonly state: TechnologyState;
  /** Where it sits in the queue; `0` is what the labs are on. Null if not queued. */
  readonly queuePosition: number | null;
  /** Units it takes in total, which is also how many of each science item. */
  readonly units: number;
  /** Units completed. Kept across a cancel, so it survives changing your mind. */
  readonly unitsDone: number;
  /** `unitsDone / units`, 0..1. Derived here because §4 keeps the division out of the panel. */
  readonly progress: number;
  readonly cost: readonly ResearchCostView[];
  /** Seconds one unit takes in one lab. What makes the cost a duration. */
  readonly unitSeconds: number;
  /** Prerequisite names, for the "needs" line. Names, not ids: this is display. */
  readonly prerequisites: readonly string[];
  readonly unlocks: readonly UnlockView[];
}

export interface ResearchView {
  /** Every technology, in content order. The panel's shape. See the header. */
  readonly technologies: readonly TechnologyView[];
  /** The ids in the queue, head first. What the queue column lists. */
  readonly queue: readonly string[];
  /**
   * Labs standing in the world, and how many of them turned over this tick.
   *
   * The second number is the one that explains a research bar that is not
   * moving: three labs and none working is a grid that is down or a science
   * belt that has run dry, and §13 says a panel must always explain a stall.
   */
  readonly labs: number;
  readonly labsWorking: number;
}
