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
 * said it had. C14 adds the fourth, the inserter, and C17 the splitter. All of
 * them are one field each — `belt`, `storage`, `inserter`, `splitter` —
 * because what a building *is* is decided by the content it carries and never
 * by its id (§19 rule 17): the whole of "this thing moves items along itself"
 * is `tilesPerSecond`, the whole of "this thing holds items" is `slots`, and
 * the whole of "this thing hands items to its neighbour" is `itemsPerSecond`.
 *
 * C15's furnace and C16's assembler are the fifth and sixth, and they are the
 * proof of that rule rather than another instance of it: they differ from one
 * another in nothing at all but the `production` field, and
 * `production-system.ts` does not contain either of their names.
 *
 * The order is §15's building table order, and it is also menu and hotkey
 * order — which is why the inserter goes between the belt and the chest
 * rather than on the end, and why C17's splitter pushes it along a slot
 * rather than being appended.
 *
 * C22's three are the lab — the first building whose output is not an item at
 * all — and the tier-2 miner and assembler its tree unlocks. The tier-2 pair
 * is the proof of this file's central claim taken one step further: they
 * differ from the rows above them in exactly one number each, and no file
 * outside `data/` knows they exist.
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
    id: 'splitter',
    name: 'Splitter',
    entityType: EntityType.Splitter,
    category: 'logistics',
    // Two tiles across the flow and one deep, which is §15's "1x2" written the
    // way `footprintExtent` reads it: at rotation 0 the splitter faces north
    // and its two lanes sit side by side along X. The registry refuses any
    // other shape, because every geometry helper in `splitter-entity.ts`
    // depends on "one tile deep".
    size: { width: 2, height: 1 },
    // Four, not the two §15's shape suggests. A splitter has a *direction*,
    // not just an orientation: with two rotations it could only ever push
    // north and east, so a belt line running south or west could never use
    // one — which is half the layout puzzle C17 exists to create.
    rotationCount: 4,
    buildCost: [{ itemId: 'splitter', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // The same speed as the belt it sits in, and for a reason rather than for
    // symmetry: a splitter slower than its belt would be a throughput cliff in
    // the middle of a line the player cannot see, and one faster would make
    // splitting a line *speed it up*. §9's 2.0 tiles/s carries through it.
    splitter: { tilesPerSecond: 2.0 },
    // The rotation and the chevron phase are appended by the renderer, exactly
    // as they are for the belt above — see `entity-view.ts`.
    sprite: 'splitter',
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

  /* ---------------------------------------------------------------------- *
   * Power (C21). Appended rather than slotted into §15's table order, which
   * the chest already departs from: the order here is *hotkey* order, and
   * inserting a building in the middle would silently renumber the hotbar a
   * player has already learned.
   * ---------------------------------------------------------------------- */
  {
    id: 'generator',
    name: 'Generator',
    entityType: EntityType.Generator,
    category: 'power',
    size: { width: 3, height: 3 },
    // One. A generator has no output side — what it makes leaves through the
    // poles around it, not through a tile — so a rotation would be three
    // states the player cannot tell apart, which is the chest's argument.
    rotationCount: 1,
    buildCost: [{ itemId: 'generator', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §15: −900 kW, burning 0.75 coal/s. The second of those is *derived* from
    // the first and from coal's eight seconds — see `FUEL_REFERENCE_KW` in
    // `systems/power-system.ts` — so it is not a number here. The fifty is the
    // furnace's fuel buffer, and a **balance number**: at 0.75 coal/s it is a
    // little over a minute of burn, which is long enough that a coal belt can
    // stutter and short enough that a generator with no belt runs out while
    // the player is still standing next to it.
    generator: { productionKw: 900, fuelCapacity: 50 },
    sprite: 'building:power:GE:3x3:3',
  },
  {
    id: 'power_pole',
    name: 'Power Pole',
    entityType: EntityType.PowerPole,
    category: 'power',
    size: { width: 1, height: 1 },
    // A pole is a point. Nothing about it faces anywhere.
    rotationCount: 1,
    buildCost: [{ itemId: 'power_pole', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §15: wire reach 8, supply area 5. Both are **balance numbers**, and the
    // gap between them is the whole of C21's layout puzzle: a pole powers a
    // 5x5 square and reaches 8 tiles to the next one, so a line of poles
    // leaves unpowered gaps unless it is laid closer than it needs to be to
    // stay connected. Closing that gap is what makes a pole run a decision.
    pole: { wireReach: 8, supplyArea: 5 },
    sprite: 'building:power:PP:1x1:2',
  },
  {
    id: 'electric_furnace',
    name: 'Electric Furnace',
    entityType: EntityType.ElectricFurnace,
    category: 'production',
    size: { width: 2, height: 2 },
    rotationCount: 4,
    buildCost: [{ itemId: 'electric_furnace', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // The furnace above with two fields changed, which is the point: it
    // smelts the same recipes at the same speed with the same buffers, it has
    // **no `fuelCapacity`**, and it draws 150 kW instead.
    //
    // 150 is not a free parameter. It is `FUEL_REFERENCE_KW`, the rate a fuel
    // buffer burns at, so six electric furnaces on one 900 kW generator eat
    // exactly the coal six burner furnaces would have. The trade C21 task 6
    // asks for is therefore purely logistical: one coal line to one generator
    // instead of six coal lines to six furnaces, and one inserter per furnace
    // instead of two. That is worth the poles and the steel, and it is worth
    // them for a reason a player can see on the screen rather than in a table.
    production: {
      category: 'smelting',
      recipeSelection: 'auto',
      craftingSpeed: 1.0,
      inputCapacity: 50,
      outputCapacity: 50,
    },
    power: { consumptionKw: 150 },
    sprite: 'building:production:EF:2x2:2',
  },

  /* ---------------------------------------------------------------------- *
   * Research (C22). Appended for C21's reason: content order is hotkey order,
   * and inserting a row renumbers a hotbar the player has already learned.
   * ---------------------------------------------------------------------- */
  {
    id: 'lab',
    name: 'Lab',
    entityType: EntityType.Lab,
    category: 'research',
    size: { width: 3, height: 3 },
    // One. A lab has no output side: what it makes is a technology, and that
    // leaves through the tech tree rather than through a tile. Three
    // rotations the player cannot tell apart is the chest's argument.
    rotationCount: 1,
    buildCost: [{ itemId: 'lab', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // The whole of "this building researches" (C22). One number, because a
    // lab's *speed* is the technology's own duration and there is no second
    // tier of lab to divide it by — see `ResearchProperties`.
    //
    // Fifty is the machine buffers' number and a **balance number**: at one
    // data core every five seconds it is four minutes of research, which is
    // long enough that a lab can be filled by hand and short enough that a
    // factory researching in earnest wants a belt to it.
    research: { inputCapacity: 50 },
    // §15's power column, and the row that makes C21's grid mandatory rather
    // than optional: every technology in the game goes through this building,
    // and it does not turn over without a pole in reach.
    power: { consumptionKw: 180 },
    sprite: 'building:research:LA:3x3:3',
  },

  /* ---------------------------------------------------------------------- *
   * The tier-2 buildings the tech tree unlocks (C22).
   *
   * Each is the row above it with **one number changed**, which is the claim
   * every `*Properties` doc-comment in `building-registry.ts` has been making
   * since C11: "a second tier is a table entry rather than a code change".
   * This is where that claim is cashed, and nothing outside `data/` moved.
   * ---------------------------------------------------------------------- */
  {
    id: 'miner_2',
    name: 'Miner Mk2',
    entityType: EntityType.Miner2,
    category: 'extraction',
    size: { width: 2, height: 2 },
    rotationCount: 4,
    buildCost: [{ itemId: 'miner_2', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN, requiresResource: true },
    // §15's tree: "miner tier 2 (1.0/s)" — 30 ticks per item exactly, twice
    // the tier-1 anchor. It is the one unlock in v1 that is a *number*, and
    // §15 is explicit that it earns its place by re-deriving every ratio
    // downstream of it: one of these feeds 3.2 plate furnaces, and a line
    // built for tier-1 miners is suddenly short of furnaces rather than short
    // of ore.
    mining: { itemsPerSecond: 1.0, bufferCapacity: 50 },
    sprite: 'building:extraction:M2:2x2:2',
  },
  {
    id: 'assembler_2',
    name: 'Assembler Mk2',
    entityType: EntityType.Assembler2,
    category: 'production',
    size: { width: 3, height: 3 },
    rotationCount: 4,
    buildCost: [{ itemId: 'assembler_2', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // The assembler with `craftingSpeed` doubled to 1.0, which is §15's
    // "assembler tier 2". At speed 1.0 a recipe takes exactly the time §15
    // authors it at, so the tier-2 assembler is the machine the content table
    // was written for and the tier-1 one is the handicap.
    production: {
      category: 'crafting',
      recipeSelection: 'player',
      craftingSpeed: 1.0,
      inputCapacity: 50,
      outputCapacity: 50,
    },
    sprite: 'building:production:A2:3x3:2',
  },

  /* ---------------------------------------------------------------------- *
   * Expansion (C23). The radar §15's table has listed since revision 2 and
   * `entity-types.ts` has held a number for since day one, and the
   * underground belt §9's own table named — "a pair of entities with a
   * validated span".
   *
   * Appended, for C21's reason: content order is hotkey order, and inserting
   * a row renumbers a hotbar the player has already learned.
   * ---------------------------------------------------------------------- */
  {
    id: 'radar',
    name: 'Radar',
    entityType: EntityType.Radar,
    category: 'exploration',
    size: { width: 2, height: 2 },
    // One. A radar looks the same from every direction because what it
    // produces leaves through the map panel rather than through a tile —
    // which is the lab's argument, and the chest's before it.
    rotationCount: 1,
    buildCost: [{ itemId: 'radar', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // **Balance numbers**, both. Five world chunks is a 352-tile square —
    // about a third of `SCALE_RANGE` in `world-generator.ts`, which is the
    // distance at which patches are fully grown, so one radar shows the
    // player roughly where the *next* factory could go without showing them
    // where the one after that could. Half a second a world chunk makes a
    // full sweep of its 121 chunks take a minute: long enough that the map
    // fills in visibly while the player watches, short enough that a radar
    // has paid for itself before they have finished walking back.
    radar: { chunkRadius: 5, sweepSeconds: 0.5 },
    // §15's power column. A radar is the second thing in the game that makes
    // the grid worth having, and the first that is optional — a player who
    // never builds one never misses the 300 kW.
    power: { consumptionKw: 300 },
    sprite: 'building:exploration:RA:2x2:3',
  },
  {
    id: 'underground_belt',
    name: 'Underground Belt',
    entityType: EntityType.UndergroundBelt,
    category: 'logistics',
    size: { width: 1, height: 1 },
    // Four, and like the belt the rotation is the mechanic: it is the
    // direction items run, and it is also what decides which end of a pair a
    // mouth is — the one whose partner lies *ahead* of it is the entrance.
    rotationCount: 4,
    buildCost: [{ itemId: 'underground_belt', count: 1 }],
    placement: { onTerrain: ANY_BUILDABLE_TERRAIN },
    // §9's tier-1 anchor, unchanged, and six tiles — see
    // `UndergroundProperties` for why neither is free.
    underground: { tilesPerSecond: 2.0, maxSpan: 6 },
    // The rotation and which end it is are appended by the renderer, exactly
    // as the belt's chevron phase is — see `entity-view.ts`.
    sprite: 'underground',
  },
]);
