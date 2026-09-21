/**
 * The map panel's snapshot of the explored world. See ironflow.md C23 task 4
 * and §13.
 *
 * A frozen value, not a live reference, exactly as every other view model is —
 * but this is the largest one in the game by two orders of magnitude, so the
 * shape is chosen for size rather than for readability:
 *
 * ```text
 *   one entry per explored world chunk
 *   inside it, one byte per map cell, in two flat typed arrays
 *   a cell is MAP_CELL_TILES tiles square
 * ```
 *
 * ## Why typed arrays in a view model
 *
 * §13's rule is that a view model is a **frozen snapshot** the UI cannot use
 * to mutate the game, and a `Uint8Array` satisfies that as well as an array of
 * objects does — better, since there is nothing in it to hold a reference to.
 * The rule a typed array *would* break is C05's, which forbids one in an
 * *entity*, because `JSON.stringify` mangles it. A view model is never
 * serialized (§10 calls every view derived), so that reason does not reach
 * here. An object per cell would: a 40x40-world-chunk map at this cell size is
 * 409,600 cells, and that many objects a second is not a panel, it is a
 * garbage collector.
 *
 * ## Why the colours are names and not colours
 *
 * A cell carries a **terrain name** and a **resource name** — 'grass', 'iron'
 * — and the panel turns each into the CSS custom property `--if-<name>`. That
 * is the arrangement `ResourceProperties.name` has documented since C09 ("it
 * is the §11 palette token, the sprite id and the readout, one word, three
 * uses"), and it is what lets the map be drawn without `ui/**` importing
 * `renderer/palette.ts`, which §4 forbids. `tokens.css` stays the one place a
 * colour is written down.
 */

/**
 * Tiles to a map cell. Two, so a 32-tile world chunk is 16 cells square.
 *
 * A **balance between fidelity and size**, and the fidelity that matters is a
 * resource patch: §19's generator makes patches of mean radius 2.6 to 5.4
 * tiles, so a 2x2 cell still shows the smallest of them as a few pixels of
 * colour rather than swallowing it. One tile a cell would quadruple the
 * snapshot for a distinction nothing at map zoom could show.
 */
export const MAP_CELL_TILES = 2;

/** One explored world chunk, downsampled. Both arrays are `cells * cells` long. */
export interface MapChunkView {
  readonly cx: number;
  readonly cy: number;
  /** Index into `MapView.terrainNames`, per cell, row-major. */
  readonly terrain: Uint8Array;
  /** Index into `MapView.resourceNames`, per cell. `0` means none. */
  readonly resource: Uint8Array;
}

/** One thing the player built, as a dot. See `MapView.entities`. */
export interface MapEntityView {
  /** Tile position of the footprint's north-west corner. */
  readonly x: number;
  readonly y: number;
  /** Footprint extent in tiles, already rotated, so a dot can be sized. */
  readonly width: number;
  readonly height: number;
  /**
   * The building's own id, which is also its §11 palette token — `--if-miner`.
   * The same one-word-three-uses arrangement the cell names use.
   */
  readonly buildingId: string;
}

export interface MapView {
  /** Tiles to a cell, so the panel need not import the constant. */
  readonly cellTiles: number;
  /** Tiles along one edge of a world chunk, for the same reason. */
  readonly chunkTiles: number;
  /** Explored world chunks, ascending by packed key (§6 R4). */
  readonly chunks: readonly MapChunkView[];
  /**
   * The rectangle of world chunks `chunks` spans, inclusive.
   * `maxCx < minCx` means nothing has been explored yet.
   */
  readonly minCx: number;
  readonly minCy: number;
  readonly maxCx: number;
  readonly maxCy: number;
  /** Where the player is standing, in tiles. Fractional. */
  readonly playerX: number;
  readonly playerY: number;
  /** Every placed building, as a dot. Only those inside explored ground. */
  readonly entities: readonly MapEntityView[];
  /** Palette-token names indexed by a cell's `terrain` byte. */
  readonly terrainNames: readonly string[];
  /** Palette-token names indexed by a cell's `resource` byte. Index 0 is none. */
  readonly resourceNames: readonly string[];
}
