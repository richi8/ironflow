/**
 * The player, as the UI and the renderer are allowed to see them. See C10 and §13.
 *
 * A frozen snapshot, like every other view model: nothing here can move the
 * player, spend what they are carrying or start them mining. What is worth
 * noting is the *units*. Authoritative position is an integer count of subtiles
 * (see `player/player-state.ts`); this view carries the fractional tile
 * position instead, because a renderer anchoring a sprite wants a tile position
 * and a subtile count would only be divided at the other end. The division
 * happens once, here, on the derived side of the boundary — no system ever
 * compares these numbers.
 */

import type { Rotation } from '../world/coordinates.js';

/**
 * What the player is doing. Derived every frame from authoritative state, and
 * never persisted: it is three sprites' worth of difference (C10 task 6).
 */
export type PlayerActivity = 'idle' | 'walk' | 'work';

/** The tile being mined, and how far through the current item. */
export interface MiningView {
  readonly x: number;
  readonly y: number;
  /** 0..1. Derived from integer ticks, which is where the exactness lives. */
  readonly progress: number;
}

export interface PlayerView {
  /** Fractional tile position. See the file header on units. */
  readonly x: number;
  readonly y: number;
  /** The tile the player is standing on. */
  readonly tileX: number;
  readonly tileY: number;
  readonly facing: Rotation;
  readonly activity: PlayerActivity;
  /** How far the player can place a building, in tiles. Drives the overlay circle. */
  readonly buildRange: number;
  /** How far the player can reach to mine, in tiles. */
  readonly mineRange: number;
  readonly mining: MiningView | null;
  readonly usedSlots: number;
  readonly slots: number;
}
