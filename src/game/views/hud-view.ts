/**
 * The HUD's snapshot of the game. See ironflow.md §13 and C07 task 4.
 *
 * A frozen value, not a live reference (§13). Handing the HUD the `ItemCounts`
 * it is reading would be the fastest way to end up with a HUD that can spend
 * the player's iron, and every field here is a number or a string for the same
 * reason: there is nothing in a `HudView` to mutate.
 *
 * **What is not here is as deliberate as what is.** There was no research
 * progress here until C22, because there was no research: a field that is
 * always `null` is a promise the view model cannot keep, so the HUD drew the
 * tile from §11's icon set and showed it as offline. C22 added the field, and
 * it is nullable for the *other* reason — nothing is being researched — which
 * is the same distinction `power` has drawn since C21.
 *
 * `power` is what that sentence looked like when it came true. It is nullable,
 * but not always null: it is null until the player builds their first pole,
 * which is a real state — there is no grid — rather than a missing system.
 */

/** One kind of item the player is holding. */
export interface HudItemCount {
  readonly itemId: string;
  /** The player-facing name, which is content (C06) and one day translated. */
  readonly name: string;
  readonly count: number;
}

/**
 * The whole grid, for the HUD's power tile (C21 task 5).
 *
 * A flattened copy of `PowerSummary` rather than the thing itself, for the
 * reason every view model is a copy: §4 lets the UI hold a view and nothing
 * from a system, and the two shapes agreeing is the controller's job.
 */
export interface HudPowerView {
  readonly supplyKw: number;
  readonly demandKw: number;
  /** The worst network's, 0..100 — the one the player has to do something about. */
  readonly satisfactionPercent: number;
  readonly networks: number;
}

/**
 * The active technology, for the HUD's research tile (C22 task 5).
 *
 * Null on `HudView` when nothing is queued, which is a real state rather than
 * a missing system — the same distinction `power` draws between "no grid yet"
 * and "no power system". The tile then reads a dash.
 */
export interface HudResearchView {
  readonly name: string;
  /** Units completed and units needed. "3 / 10" is what the tile shows. */
  readonly unitsDone: number;
  readonly units: number;
  /** 0..100, so the tile can draw a bar without dividing. */
  readonly progressPercent: number;
  /** Labs in the world, and how many turned over this tick. Explains a stall. */
  readonly labs: number;
  readonly labsWorking: number;
}

export interface HudView {
  /** Ticks elapsed. Authoritative (§10); the HUD derives a rate from it. */
  readonly tick: number;
  /** Simulated seconds, floored. `tick / TPS` and therefore exact (§6 R3). */
  readonly playtimeSeconds: number;
  readonly paused: boolean;
  /** Smoothed frames per second. Presentation only, and never serialized. */
  readonly fps: number;
  /** Buildings standing in the world, including any removed later this tick. */
  readonly entityCount: number;
  /** World chunks that exist, which is what the player has caused to be drawn. */
  readonly exploredChunks: number;
  /** Everything the player is carrying, sorted by item id so it never reorders. */
  readonly items: readonly HudItemCount[];
  readonly itemTotal: number;
  /**
   * Things that went wrong and were shown, counted for the session.
   *
   * In C07 every alert is a rejected command. From C11 a stalled machine is
   * the more interesting source, and this becomes the count the alert icon
   * has always been for.
   */
  readonly alerts: number;
  /**
   * Supply, demand and the worst network's satisfaction, or `null` when no
   * network exists yet (C21).
   *
   * Null is not "no data": it is "there is no grid", which is true of every
   * factory until its first pole goes up, and it is what keeps the tile
   * reading a dash rather than a confident 100%.
   */
  readonly power: HudPowerView | null;
  /**
   * What is being researched, or `null` when nothing is (C22).
   *
   * The field this file said would arrive — "there is no research progress,
   * because there is no research until C22, and a field that is always `null`
   * is a promise the view model cannot keep". It is now null for the same
   * reason `power` is: a factory that has queued nothing has no research
   * progress, which is a fact about the game rather than about the code.
   */
  readonly research: HudResearchView | null;
}
