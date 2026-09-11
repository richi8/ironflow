/**
 * The building content table. See ironflow.md §15 and C06 task 3.
 *
 * Pure data, no logic, and the only file that has to change to add a building:
 * the registry validates whatever is here, the build system reads it, the
 * composition root gives every entry a hotkey in this order, and the renderer
 * draws whatever sprite id it names. That is the chunk's last acceptance
 * criterion — "adding a new building requires zero code changes elsewhere" —
 * and it is checked by a test that adds one.
 *
 * C06 ships two of §15's eleven, which is what the plan asks for: a miner is
 * the building with every placement rule at once (multi-tile, needs ore under
 * it, rotates) and a chest is the building with none of them. Between them
 * they exercise the whole pipeline; the other nine arrive with the systems
 * that make them do something.
 */

import { EntityType } from '../entities/entity-types.js';
import type { BuildingDefinition } from '../registries/building-registry.js';
import { TILE_TYPE_COUNT, TileType, isBuildable } from '../world/tile.js';

/**
 * Every terrain a building may stand on unless it says otherwise.
 *
 * Derived from `tile.ts` rather than written out, so a terrain type added in
 * C19 is buildable or not in exactly one place. Water is excluded because
 * `isBuildable` says so, which is the default C06 task 1 asks for.
 */
const ANY_BUILDABLE_TERRAIN: readonly TileType[] = Object.freeze(
  Array.from({ length: TILE_TYPE_COUNT }, (_, type) => type as TileType).filter(isBuildable),
);

export const BUILDINGS: readonly BuildingDefinition[] = Object.freeze([
  {
    id: 'miner',
    name: 'Miner',
    entityType: EntityType.Miner,
    category: 'extraction',
    size: { width: 2, height: 2 },
    // Four, because C11 gives it an output side and a miner that cannot be
    // turned towards the belt is a miner that dictates the factory's layout.
    rotationCount: 4,
    buildCost: [{ itemId: 'miner', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN, requiresResource: true },
    sprite: 'building:extraction:MI:2x2:2',
  },
  {
    id: 'chest',
    name: 'Chest',
    entityType: EntityType.Chest,
    category: 'storage',
    size: { width: 1, height: 1 },
    // A box is a box from every side. One rotation means `R` leaves it alone
    // rather than cycling through three states the player cannot tell apart.
    rotationCount: 1,
    buildCost: [{ itemId: 'chest', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    sprite: 'building:storage:CH:1x1:1',
  },
]);
