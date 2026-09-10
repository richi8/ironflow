/**
 * What the renderer is allowed to see. See ironflow.md C03 task 2 and §4.
 *
 * `RenderState` is a **read-only view of the simulation assembled by the
 * controller — never the `Simulation` object itself**. That sentence is the
 * whole point of this file: if the renderer held a `Simulation` it could call
 * `tick()`, and the "renderer never mutates authoritative state" rule (§4)
 * would be a convention rather than a type.
 *
 * The types here are therefore the renderer's own vocabulary, not the
 * simulation's. `RenderEntity` is deliberately *not* the entity shape C05 will
 * define: it is the handful of fields a draw call needs, and the controller is
 * responsible for producing it. That indirection is what lets C05 change the
 * entity store without touching a layer.
 */

import type { TileBounds, TileCoord } from '../game/world/coordinates.js';

import type { SpriteId } from './sprite-atlas.js';

/**
 * A world chunk as the renderer may see it.
 *
 * Structurally satisfied by `WorldChunk`, with every scalar `readonly` so a
 * layer cannot stamp on `dirty` or `revision`. The typed arrays stay writable
 * because TypeScript has no read-only typed array; the rule that the renderer
 * does not write to them is enforced by review and by the fact that nothing
 * here has a reason to.
 */
export interface ReadonlyWorldChunk {
  readonly cx: number;
  readonly cy: number;
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly resourceAmount: Uint16Array;
  /** Changes whenever the contents change. The terrain cache's whole basis. */
  readonly revision: number;
}

/**
 * The slice of `World` the renderer uses.
 *
 * `forEachChunkInBounds` **generates world chunks that do not exist yet**, and
 * that is the design rather than a leak: C02 states that viewport-driven lazy
 * creation is how the map fills in and that the renderer's cull rectangle is
 * the intended trigger. Creating a world chunk is not a divergence — the new
 * world chunk is exactly what the generator says belongs there, `dirty` stays
 * false, and nothing authoritative has changed.
 */
export interface WorldView {
  forEachChunkInBounds(bounds: TileBounds, visit: (chunk: ReadonlyWorldChunk) => void): void;
}

/**
 * How things sharing a tile are ordered front-to-back. See §5.
 *
 * The numbers are a drawing order and nothing else — they are never persisted,
 * so they may be renumbered freely. The gaps exist so a later chunk can slot
 * something between two of them without renumbering the file.
 */
export enum RenderLayer {
  Terrain = 0,
  Resource = 1,
  Belt = 2,
  Building = 3,
  ItemOnBelt = 4,
  InserterArm = 5,
  Overlay = 6,
}

/** How many distinct layers a depth key must be able to encode. */
export const RENDER_LAYER_COUNT = 8;

/**
 * One drawable thing, as the controller describes it to the renderer.
 *
 * `(x, y)` is the footprint's north-west tile and `(width, height)` its size in
 * tiles — a multi-tile building is one `RenderEntity`, not one per tile, so it
 * sorts and draws as a single unit (§5).
 */
export interface RenderEntity {
  /** Stable, unique, and the deterministic tie-break in the depth key (§5). */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * What to draw. Direction is part of the id (`belt:1`), not a separate
   * field: that is how an image atlas addresses a cell, so C29's swap does not
   * have to reintroduce the rotation the procedural atlas had baked in.
   */
  readonly sprite: SpriteId;
  readonly layer: RenderLayer;
}

/** A pending placement preview, drawn in the overlay layer so nothing hides it. */
export interface GhostView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sprite: SpriteId;
  /** Drives the colour: §11's `--if-ghost-valid` or `--if-ghost-invalid`. */
  readonly valid: boolean;
}

/**
 * Everything one frame needs. Assembled fresh by the controller each frame.
 *
 * The entity list is empty until C05 gives the game entities to put in it;
 * `hover`, `ghost` and `selected` stay null until C04 has a pointer and C06 has
 * something to place. The fields exist now because C03 owns the overlay layer
 * that draws them, and a layer with no input is untestable and unreviewable.
 */
export interface RenderState {
  readonly world: WorldView;
  /** Unordered. The entity layer sorts by depth key; see `entity-layer.ts`. */
  readonly entities: readonly RenderEntity[];
  readonly hover: TileCoord | null;
  readonly ghost: GhostView | null;
  readonly selected: TileCoord | null;
}
