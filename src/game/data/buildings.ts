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
 *
 * C13 adds the third, the belt, and gives the chest the insides §15 always
 * said it had. C14 adds the fourth, the inserter. All of them are one field
 * each — `belt`, `storage`, `inserter` — because what a building *is* is
 * decided by the content it carries and never by its id (§19 rule 17): the
 * whole of "this thing moves items along itself" is `tilesPerSecond`, the
 * whole of "this thing holds items" is `slots`, and the whole of "this thing
 * hands items to its neighbour" is `itemsPerSecond`.
 *
 * C15's furnace and C16's assembler are the fifth and sixth, and they are the
 * proof of that rule rather than another instance of it: they differ from one
 * another in nothing at all but the `production` field, and
 * `production-system.ts` does not contain either of their names.
 *
 * The order is §15's building table order, and it is also menu and hotkey
 * order — which is why the inserter goes between the belt and the chest
 * rather than on the end.
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
    // §15's tier-1 anchor: 0.5 items/s, which is 60 ticks per item exactly.
    // The buffer is fifty — a hundred seconds of production, so a miner with
    // nowhere to send its ore stalls inside a play session rather than in
    // theory (C11 task 3). Both are **balance numbers** for C20's pass.
    mining: { itemsPerSecond: 0.5, bufferCapacity: 50 },
    sprite: 'building:extraction:MI:2x2:2',
  },
  {
    id: 'belt',
    name: 'Transport Belt',
    entityType: EntityType.Belt,
    category: 'logistics',
    size: { width: 1, height: 1 },
    // Four, and the only building where the rotation is the whole mechanic:
    // a belt's facing is the direction items travel (C13).
    rotationCount: 4,
    buildCost: [{ itemId: 'belt', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §9's tier-1 anchor: 2.0 tiles/s over four slots per tile is 8.0 items/s,
    // and that number is what every machine rate in §15 is derived from.
    // Changing it means re-deriving the content bible (§19 rule 18).
    belt: { tilesPerSecond: 2.0 },
    // The rotation is appended by the renderer, which is the only layer
    // allowed to know that `belt:1` names a picture — see `entity-view.ts`.
    sprite: 'belt',
  },
  {
    id: 'inserter',
    name: 'Inserter',
    entityType: EntityType.Inserter,
    category: 'logistics',
    size: { width: 1, height: 1 },
    // Four, and like the belt the rotation is the mechanic: an inserter takes
    // from the tile behind it and puts into the tile in front (C14).
    rotationCount: 4,
    buildCost: [{ itemId: 'inserter', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §15's anchor: 1.0 items/s, which is 30 ticks per cycle exactly.
    // Deliberately an eighth of a tier-1 belt, so saturating one takes eight
    // inserters — the asymmetry §15 calls "where layout decisions live".
    // A **balance number** for C20's pass.
    inserter: { itemsPerSecond: 1.0 },
    // The arm's swing and whether the hand is full are appended by the
    // renderer, which is the only layer allowed to know what that looks like
    // — see `entity-view.ts`, exactly as with the belt above.
    sprite: 'inserter',
  },
  {
    id: 'furnace',
    name: 'Furnace',
    entityType: EntityType.Furnace,
    category: 'production',
    size: { width: 2, height: 2 },
    rotationCount: 4,
    buildCost: [{ itemId: 'furnace', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // Rotation picks the side finished plates fall out of onto a belt, exactly
    // as it does for a miner; the footprint is square either way. The three
    // fifties are **balance numbers** for C20: one stack of ore in, one of
    // plates out, and enough coal that a furnace is not a chore to feed.
    //
    // `auto` and speed 1.0 are the two C16 added. A furnace reads its own
    // input buffer and runs whatever is in it, which is what makes an ore belt
    // into a plate belt without the player ever opening the panel; and §15's
    // smelting times are already the times a furnace takes, so its speed is
    // the identity rather than a number to tune.
    production: {
      category: 'smelting',
      recipeSelection: 'auto',
      craftingSpeed: 1.0,
      inputCapacity: 50,
      outputCapacity: 50,
      fuelCapacity: 50,
    },
    sprite: 'building:production:FU:2x2:2',
  },
  {
    id: 'assembler',
    name: 'Assembler',
    entityType: EntityType.Assembler,
    category: 'production',
    size: { width: 3, height: 3 },
    // Four, for the furnace's reason: rotation is which side an inserter and
    // the placement ghost face, and a 3x3 looks the same in all of them.
    rotationCount: 4,
    buildCost: [{ itemId: 'assembler', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §15: "recipe selectable, speed 0.5". Both words are this one field pair
    // — the assembler is the first building in the game that holds a decision
    // the player made rather than one its belt made for it (C16 tasks 1–3).
    //
    // No `fuelCapacity`: §15 gives it 150 kW, and a machine that takes power
    // is one whose gate is C21's satisfaction ratio. Until C21 exists it runs
    // for free, which is the same thing every other building does today.
    //
    // The two fifties are **balance numbers** for C20, and the same ones the
    // furnace has: a ceiling per ingredient is what makes backpressure reach
    // the belt in front of it (§9).
    production: {
      category: 'crafting',
      recipeSelection: 'player',
      craftingSpeed: 0.5,
      inputCapacity: 50,
      outputCapacity: 50,
    },
    sprite: 'building:production:AS:3x3:2',
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
    // §15's 24 slots. A **balance number** for C20: it is how much buffer a
    // factory gets for free before the player has to think about throughput.
    storage: { slots: 24 },
    sprite: 'building:storage:CH:1x1:1',
  },
]);
