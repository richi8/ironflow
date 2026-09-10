/**
 * Terrain tile types. See ironflow.md C02 task 1 and §2 pillar 4.
 *
 * Terrain exists to constrain layout. A world where every tile is equally
 * buildable is a blank sheet of graph paper, and routing around an obstacle is
 * the cheapest interesting decision a factory game can offer — so water is
 * impassable and unbuildable from the very first chunk, before anything has a
 * chance to assume otherwise.
 *
 * Tile space only. Nothing here knows what a tile looks like; the terrain
 * colours in §11 are the renderer's business.
 */

/**
 * A terrain type, stored as one byte per tile in `WorldChunk.terrain`.
 *
 * `Grass = 0` on purpose: a zero-filled `Uint8Array` is therefore a valid,
 * fully grass world chunk, which is what `createChunk` relies on. Values are
 * persisted inside world-chunk deltas (§14), so **existing numbers may never be
 * reassigned** — a new terrain type takes the next free number.
 */
export enum TileType {
  Grass = 0,
  Dirt = 1,
  Sand = 2,
  Stone = 3,
  Water = 4,
}

/** What the simulation is allowed to ask about a terrain type. */
export interface TileProperties {
  /** May the player, and later any pathing entity, walk over this tile? */
  readonly passable: boolean;
  /** May a building or belt be placed on this tile? */
  readonly buildable: boolean;
  /** Stable identifier for debug readouts and test failure messages. */
  readonly name: string;
}

/**
 * Indexed by `TileType`. Frozen, because this table is shared by every system
 * that asks a question about terrain and none of them owns it.
 */
const TILE_PROPERTIES: readonly TileProperties[] = Object.freeze([
  Object.freeze({ passable: true, buildable: true, name: 'grass' }),
  Object.freeze({ passable: true, buildable: true, name: 'dirt' }),
  Object.freeze({ passable: true, buildable: true, name: 'sand' }),
  Object.freeze({ passable: true, buildable: true, name: 'stone' }),
  Object.freeze({ passable: false, buildable: false, name: 'water' }),
]);

/** How many terrain types exist. Kept in step with the table, not hand-written. */
export const TILE_TYPE_COUNT = TILE_PROPERTIES.length;

/** Is `value` a byte the terrain array may legitimately hold? */
export function isTileType(value: number): value is TileType {
  return Number.isInteger(value) && value >= 0 && value < TILE_TYPE_COUNT;
}

/** Properties of a terrain type. Throws on a value outside the enum. */
export function tileProperties(type: TileType): TileProperties {
  const properties = TILE_PROPERTIES[type];
  if (properties === undefined) {
    throw new RangeError(`tileProperties: ${type} is not a TileType.`);
  }
  return properties;
}

/** May something stand on this terrain? */
export function isPassable(type: TileType): boolean {
  return tileProperties(type).passable;
}

/** May something be built on this terrain? */
export function isBuildable(type: TileType): boolean {
  return tileProperties(type).buildable;
}
