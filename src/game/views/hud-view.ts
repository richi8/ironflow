/**
 * The HUD's snapshot of the game. See ironflow.md §13 and C07 task 4.
 *
 * A frozen value, not a live reference (§13). Handing the HUD the `ItemCounts`
 * it is reading would be the fastest way to end up with a HUD that can spend
 * the player's iron, and every field here is a number or a string for the same
 * reason: there is nothing in a `HudView` to mutate.
 *
 * **What is not here is as deliberate as what is.** There is no power ratio and
 * no research progress, because there is no power system until C21 and no
 * research until C22, and a field that is always `null` is a promise the view
 * model cannot keep. The HUD draws those two tiles from §11's icon set and
 * shows them as offline; when C21 lands it adds the field and the tile reads it.
 */

/** One kind of item the player is holding. */
export interface HudItemCount {
  readonly itemId: string;
  /** The player-facing name, which is content (C06) and one day translated. */
  readonly name: string;
  readonly count: number;
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
}
