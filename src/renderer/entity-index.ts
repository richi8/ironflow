/**
 * Which entities are near the screen. See ironflow.md C29, §16 path 3.
 *
 * The composition root used to describe **every** entity in the world at the
 * top of every frame — twenty thousand objects and sprite ids on the reference
 * factory, for the forty on screen at zoom 1. C29 measured that walk at about
 * 2 ms of a frame that drew one building, and it grows with the factory
 * rather than with the screen. This is the fix §16 names: a grid of world
 * chunk-sized cells, each holding the entities whose north-west tile falls in
 * it, so a frame visits the cells under the view and nothing else.
 *
 * It is derived state (§10) of the most ordinary kind. It is rebuilt whenever
 * the store's `structureRevision` moves — an entity built or removed — or the
 * store itself is a different one (a load), and positions cannot change in
 * between: an entity's tile and rotation are fixed from creation.
 *
 * Renderer-side, and a `Map` is fine here: this decides what is *drawn*, never
 * what happens (§6 R4 is about systems).
 */

import type { EntityStore } from '../game/entities/entity-store.js';
import { footprintExtent, type Entity } from '../game/entities/entity.js';
import type { BuildingRegistry } from '../game/registries/building-registry.js';
import type { TileBounds } from '../game/world/coordinates.js';

/** Cell edge in tiles. A world chunk's, so a view touches a handful. */
export const INDEX_CELL = 32;

interface Placed {
  readonly entity: Entity;
  readonly width: number;
  readonly height: number;
}

function cellKey(cx: number, cy: number): number {
  // Cells are 32 tiles, so ±2^20 of them is ±33 million tiles — well past
  // anything the world's packable coordinates allow.
  return (cx + 0x100000) * 0x200000 + (cy + 0x100000);
}

export class EntityIndex {
  private readonly cells = new Map<number, Placed[]>();
  private store: EntityStore | null = null;
  private revision = -1;
  /** The largest footprint seen, so a query can reach back for its corner. */
  private reach = 1;
  /** How many times the grid has been rebuilt. For the tests. */
  rebuilds = 0;

  /**
   * Visit every entity whose footprint overlaps `bounds`, each once.
   *
   * Order is cell by cell and id-ascending within a cell, which is no order a
   * caller may depend on: the entity layer sorts by depth key, and that is
   * the only order anything is drawn in.
   */
  forEachIn(store: EntityStore, buildings: BuildingRegistry, bounds: TileBounds, visit: (entity: Entity) => void): void {
    if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return;
    this.sync(store, buildings);

    // An entity is filed under its north-west tile, so one standing partly in
    // view may be filed a footprint to the north or west of it.
    const minX = bounds.minX - (this.reach - 1);
    const minY = bounds.minY - (this.reach - 1);
    const cx0 = Math.floor(minX / INDEX_CELL);
    const cy0 = Math.floor(minY / INDEX_CELL);
    const cx1 = Math.floor(bounds.maxX / INDEX_CELL);
    const cy1 = Math.floor(bounds.maxY / INDEX_CELL);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(cellKey(cx, cy));
        if (cell === undefined) continue;
        for (let i = 0; i < cell.length; i++) {
          const placed = cell[i];
          if (placed === undefined) continue;
          const entity = placed.entity;
          if (
            entity.x <= bounds.maxX &&
            entity.x + placed.width - 1 >= bounds.minX &&
            entity.y <= bounds.maxY &&
            entity.y + placed.height - 1 >= bounds.minY
          ) {
            visit(entity);
          }
        }
      }
    }
  }

  private sync(store: EntityStore, buildings: BuildingRegistry): void {
    if (store === this.store && store.structureRevision === this.revision) return;
    this.store = store;
    this.revision = store.structureRevision;
    this.cells.clear();
    this.reach = 1;
    this.rebuilds += 1;
    store.forEach((entity) => {
      const extent = footprintExtent(buildings.forEntityType(entity.type).size, entity.rotation);
      const key = cellKey(Math.floor(entity.x / INDEX_CELL), Math.floor(entity.y / INDEX_CELL));
      let cell = this.cells.get(key);
      if (cell === undefined) {
        cell = [];
        this.cells.set(key, cell);
      }
      cell.push({ entity, width: extent.width, height: extent.height });
      this.reach = Math.max(this.reach, extent.width, extent.height);
    });
  }
}
