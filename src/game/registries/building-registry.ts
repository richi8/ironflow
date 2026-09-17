/**
 * What a building *is*, and the registry that holds them. See C06 tasks 1–2.
 *
 * A definition is pure content: the numbers in §15's building table, written
 * down. Nothing here knows how to place a building, what a placement costs in
 * time, or how one is drawn — the build system reads these fields and decides,
 * which is §19 rule 17 ("content lives in data, logic lives in systems") made
 * structural. The test for a change belonging here rather than in a system is
 * whether it is a *fact about a building* or a *rule about building*.
 *
 * The registry is frozen at construction and `get` throws on an unknown id. A
 * typo in `data/buildings.ts` must fail on the first frame, loudly, with the id
 * in the message — not resolve to `undefined` and surface ten minutes later as
 * a building that cannot be placed for no stated reason.
 */

import { BELT_TILE_UNITS } from '../entities/belt-entity.js';
import { SPLITTER_LANES } from '../entities/splitter-entity.js';
import { UNIT_FOOTPRINT, assertFootprint, type Footprint } from '../entities/entity.js';
import { TPS } from '../simulation-clock.js';
import { ENTITY_TYPE_COUNT, entityTypeName, isEntityType, type EntityType } from '../entities/entity-types.js';
import type { ItemStack } from '../items/item-stack.js';
import { isBuildable, isTileType, tileProperties, type TileType } from '../world/tile.js';
import { isRotation, type Rotation } from '../world/coordinates.js';
import { isRecipeCategory, type RecipeCategory } from './recipe-registry.js';

/**
 * How the build menu groups a building, and which colour its placeholder takes.
 *
 * C06 task 1 lists four categories; this is six. `extraction` and `research`
 * are added because the placeholder atlas (C03) already defines a colour for
 * each of the six, and §15 has buildings in both — a miner is not production
 * and a lab is not storage. Two category vocabularies, one for the menu and one
 * for the colour, would be a table that has to be kept in step by hand, and the
 * first building added after that would be the one that breaks it.
 */
export type BuildingCategory =
  | 'extraction'
  | 'production'
  | 'logistics'
  | 'storage'
  | 'power'
  | 'research';

/** Where a building may stand. `onTerrain` narrows the terrain table (C02). */
export interface PlacementRules {
  /**
   * Terrain this building accepts. It may only *narrow* what `tile.ts` already
   * calls buildable — a definition listing water is refused at construction,
   * because "water is unbuildable" is a fact about the world and content data
   * is not where it gets overruled.
   */
  readonly onTerrain: readonly TileType[];
  /** Miners: at least one tile of the footprint must hold ore (§15). */
  readonly requiresResource?: boolean;
}

/**
 * What a building extracts from the ground, as content authors it. C11 task 2.
 *
 * Its presence is what makes a building a miner — `entities/building-init.ts`
 * branches on this field and on nothing else — so an electric miner or a
 * second tier is a table entry rather than a code change.
 */
export interface MiningProperties {
  /**
   * Items extracted per simulated second. §15's anchor: 0.5 at tier 1.
   *
   * Authored in items per second because that is the unit §15's whole balance
   * table is written in, and converted to an integer tick count exactly once,
   * at registry-build time, as §6 R3 requires.
   */
  readonly itemsPerSecond: number;
  /**
   * How many items the output buffer holds before the miner stalls.
   *
   * Small on purpose. Backpressure from day one (C11 task 3) is only visible
   * if a miner with nowhere to put its ore fills up inside a play session.
   */
  readonly bufferCapacity: number;
}

/**
 * The same, in the integers a system actually runs on.
 *
 * Built once per registry, never authored and never serialized: it is content
 * (§10), so C20 retuning `itemsPerSecond` changes every existing save's miners
 * rather than leaving them on the old rate.
 */
export interface MiningConfig {
  /** Exactly `Math.round(TPS / itemsPerSecond)`. At least 1 (§6 R3). */
  readonly ticksPerItem: number;
  readonly bufferCapacity: number;
}

/**
 * How fast a belt carries things, as content authors it. C13 task 2.
 *
 * Its presence is what makes a building a belt — `building-init.ts` branches
 * on this field and on nothing else — so C22's fast belt is a table entry
 * rather than a code change. Authored in tiles per second because that is the
 * unit §9's throughput table is written in.
 */
export interface BeltProperties {
  /** §9's anchor: 2.0 at tier 1, which is 8.0 items/s over four slots. */
  readonly tilesPerSecond: number;
}

/**
 * The same, in the integers the belt system runs on.
 *
 * `unitsPerTick` is `tilesPerSecond * BELT_TILE_UNITS / TPS`, rounded once at
 * registry-build time (§6 R3). It does not come out whole — 2.0 tiles/s is
 * 17.07 units per tick and stores as 17 — and §9's 256 units per tile is what
 * makes that acceptable: the belt runs at 1.992 tiles/s, which is the 0.4%
 * inside the ±1% C13's acceptance criterion allows. The alternative is a
 * sub-tile scale chosen to divide 30 evenly, which would put a number nobody
 * can justify in §9's contract table to hide a rounding error nobody can see.
 */
export interface BeltConfig {
  /** Fixed-point units an item advances each tick. `1..BELT_TILE_UNITS - 1`. */
  readonly unitsPerTick: number;
  /** What the content table said, kept for the renderer's chevron animation. */
  readonly tilesPerSecond: number;
}

/**
 * How fast a splitter carries things, as content authors it. C17 task 1.
 *
 * Its presence is what makes a building a splitter — `building-init.ts`
 * branches on this field and on nothing else — so C22's fast splitter is a
 * table entry rather than a code change. It is a separate field from `belt`
 * rather than a flag on it because the two buildings are different *shapes*:
 * a belt is one tile with one way out, a splitter is two tiles with two, and
 * `belt-system.ts` has to know which it is holding before it can move an item
 * off the end of it.
 */
export interface SplitterProperties {
  /** Tiles per second through each of its two lanes. §9's tier-1 anchor: 2.0. */
  readonly tilesPerSecond: number;
}

/**
 * The same, in the integers the belt system runs on.
 *
 * Identical arithmetic to `BeltConfig`, because a splitter lane *is* a belt
 * lane (see `entities/splitter-entity.ts`) and an item that changed speed as
 * it crossed the seam would bunch up on one side of it.
 */
export interface SplitterConfig {
  /** Fixed-point units an item advances each tick. `1..BELT_TILE_UNITS - 1`. */
  readonly unitsPerTick: number;
  /** What the content table said, kept for the renderer's chevron animation. */
  readonly tilesPerSecond: number;
}

/**
 * How fast an inserter moves items, as content authors it. C14 task 2.
 *
 * Its presence is what makes a building an inserter — `building-init.ts`
 * branches on this field and on nothing else — so C22's fast inserter is a
 * table entry rather than a code change. Authored in items per second because
 * that is the unit §15's anchor table is written in.
 */
export interface InserterProperties {
  /** §15's anchors: 1.0 standard, 2.5 fast. Deliberately below belt speed. */
  readonly itemsPerSecond: number;
}

/**
 * The same, as the four stage lengths the state machine actually counts.
 *
 * The four add up to `ticksPerItem` exactly, which is what makes the rate
 * exact: a saturated inserter never rests in `Idle`, so it delivers one item
 * every `ticksPerItem` ticks for ever. Grabbing and releasing are quick and
 * the two swings are the bulk — a tenth of the cycle at each end, the rest
 * split evenly — so at 1.0 items/s the arm spends 24 of its 30 ticks moving,
 * which is what an inserter looks like.
 */
export interface InserterConfig {
  /** Exactly `Math.round(TPS / itemsPerSecond)`. At least 4 — see `validate`. */
  readonly ticksPerItem: number;
  /** Reaching into the source. The item is taken when this stage completes. */
  readonly pickupTicks: number;
  /** Swinging across, item in hand. */
  readonly carryTicks: number;
  /** Releasing. The item goes into the destination when this completes. */
  readonly dropTicks: number;
  /** Swinging back empty-handed. */
  readonly returnTicks: number;
}

/**
 * How much a container holds, as content authors it. §15: a chest is 24 slots.
 *
 * Its presence is what makes a building storage, in the same way `mining`
 * makes one a miner: a belt ending at anything with this field puts its items
 * in, and `HandSystem` lets the player take them out again.
 */
export interface StorageProperties {
  /** Slots, each holding one stack of one item (C08's `SlotInventory`). */
  readonly slots: number;
}

/**
 * What makes a building a machine that runs recipes (C15).
 *
 * Everything that separates a furnace from C16's assembler is in here, which
 * is why `production-system.ts` can be written without naming either of them:
 * the category picks the recipes it may run, the capacities size its buffers,
 * and `fuelCapacity` decides whether it burns something or (C21) takes power.
 *
 * The capacities are per *item*, not slots: a machine's buffer is not a chest
 * the player sorts, it is a few kinds of thing with a ceiling on each, and a
 * ceiling is what makes backpressure reach the belt in front of it (§9).
 */
export interface ProductionProperties {
  /** Which recipes this machine can run. §15 has smelting and crafting. */
  readonly category: RecipeCategory;
  /**
   * Who decides what this machine makes (C16).
   *
   * `'auto'` is C15's furnace: it reads its input buffer and runs whatever
   * single recipe the items in it name, dropping that recipe again when they
   * run out so a furnace fed something else can switch to it. `'player'` is
   * the assembler: it makes what it was told by `setRecipe` and nothing else,
   * for ever, including while it is empty — which is the whole difference
   * between a machine that follows its belt and a machine that holds a
   * decision the player made about the factory.
   *
   * It is a field rather than a test on the category because "who chooses" is
   * not a property of what a recipe *is*. C15 expected `forInput`'s ambiguity
   * to cover it; ambiguity decides *which* recipe an item names, and it
   * cannot make a player's choice survive an empty buffer. See C16.
   */
  readonly recipeSelection: RecipeSelection;
  /**
   * How fast it works, as a multiplier on a recipe's authored duration.
   *
   * §15's anchor: 1.0 for a furnace, whose smelting times are already the
   * times a furnace takes, and 0.5 for a tier-1 assembler. The division is
   * done once — see `registries/craft-durations.ts` — never per tick (§6 R3).
   */
  readonly craftingSpeed: number;
  /** Ceiling on each ingredient it holds. */
  readonly inputCapacity: number;
  /** Ceiling on each product it holds before it stalls with `output_full`. */
  readonly outputCapacity: number;
  /** Ceiling on each fuel it holds. Absent means it does not burn anything. */
  readonly fuelCapacity?: number;
}

/** Who picks a machine's recipe. See `ProductionProperties.recipeSelection`. */
export type RecipeSelection = 'auto' | 'player';

const RECIPE_SELECTIONS: readonly RecipeSelection[] = Object.freeze(['auto', 'player']);

export interface BuildingDefinition {
  readonly id: string;
  readonly name: string;
  /**
   * The numeric type stored on every placed entity.
   *
   * C06 task 1 does not list this field, and something has to carry it: the
   * entity store keys its buckets and its footprint lookup on `EntityType`
   * (C05), while commands, recipes and the UI name buildings by string id.
   * Holding the mapping here means there is exactly one place the two
   * vocabularies meet, and the registry refuses two definitions that claim the
   * same type.
   */
  readonly entityType: EntityType;
  readonly category: BuildingCategory;
  /** In tiles, unrotated. Odd rotations swap it — see `footprintExtent`. */
  readonly size: Footprint;
  /** How many of the four rotations this building actually has. */
  readonly rotationCount: 1 | 2 | 4;
  /**
   * What placing it costs. §15: always a single stack of the building's own
   * item, so the interesting cost lives in the recipe that crafts it and the
   * factory eventually builds itself.
   */
  readonly buildCost: readonly ItemStack[];
  readonly placement: PlacementRules;
  /** Present only on buildings that extract from the ground (C11). */
  readonly mining?: MiningProperties;
  /** Present only on buildings that carry items along themselves (C13). */
  readonly belt?: BeltProperties;
  /** Present only on buildings that fork one lane into two (C17). */
  readonly splitter?: SplitterProperties;
  /** Present only on buildings that move items between their neighbours (C14). */
  readonly inserter?: InserterProperties;
  /** Present only on buildings that hold items for the player (C13). */
  readonly storage?: StorageProperties;
  /** Present only on buildings that turn ingredients into products (C15). */
  readonly production?: ProductionProperties;
  /**
   * Typed `string` rather than the renderer's `SpriteId`, which is the same
   * type: §4 forbids `game/` from importing `renderer/`, and a sprite id is a
   * name, not a picture. C29 replaces the value, not the field.
   */
  readonly sprite: string;
}

/** Deep-freeze a definition, so content cannot be edited after startup. */
function freezeDefinition(definition: BuildingDefinition): BuildingDefinition {
  Object.freeze(definition.size);
  Object.freeze(definition.placement);
  Object.freeze(definition.placement.onTerrain);
  for (const stack of definition.buildCost) Object.freeze(stack);
  Object.freeze(definition.buildCost);
  if (definition.mining !== undefined) Object.freeze(definition.mining);
  if (definition.belt !== undefined) Object.freeze(definition.belt);
  if (definition.splitter !== undefined) Object.freeze(definition.splitter);
  if (definition.inserter !== undefined) Object.freeze(definition.inserter);
  if (definition.storage !== undefined) Object.freeze(definition.storage);
  if (definition.production !== undefined) Object.freeze(definition.production);
  return Object.freeze(definition);
}

function validate(definition: BuildingDefinition): void {
  const where = `building "${definition.id}"`;

  if (typeof definition.id !== 'string' || definition.id.length === 0 || definition.id.trim() !== definition.id) {
    throw new Error(`BuildingRegistry: ${JSON.stringify(definition.id)} is not a usable building id.`);
  }
  if (definition.name.length === 0) {
    throw new Error(`BuildingRegistry: ${where} has no name.`);
  }
  if (!isEntityType(definition.entityType)) {
    throw new Error(`BuildingRegistry: ${where} has entityType ${definition.entityType}, which is not one.`);
  }
  assertFootprint(definition.size);
  if (definition.rotationCount !== 1 && definition.rotationCount !== 2 && definition.rotationCount !== 4) {
    throw new Error(`BuildingRegistry: ${where} has rotationCount ${definition.rotationCount}; it must be 1, 2 or 4.`);
  }
  if (definition.sprite.length === 0) {
    throw new Error(`BuildingRegistry: ${where} has no sprite.`);
  }

  for (const stack of definition.buildCost) {
    if (stack.itemId.length === 0 || !Number.isInteger(stack.count) || stack.count < 1) {
      throw new Error(`BuildingRegistry: ${where} has a build cost entry that is not a whole number of a real item.`);
    }
  }

  const mining = definition.mining;
  if (mining !== undefined) {
    if (!Number.isFinite(mining.itemsPerSecond) || mining.itemsPerSecond <= 0) {
      throw new Error(`BuildingRegistry: ${where} mines ${mining.itemsPerSecond} items/s, which is not a rate.`);
    }
    if (ticksPerItem(mining) < 1) {
      throw new Error(
        `BuildingRegistry: ${where} mines ${mining.itemsPerSecond} items/s, which is faster than one item per tick.`,
      );
    }
    if (!Number.isInteger(mining.bufferCapacity) || mining.bufferCapacity < 1) {
      throw new Error(`BuildingRegistry: ${where} has a buffer of ${mining.bufferCapacity}; it must be whole and above 0.`);
    }
  }

  const belt = definition.belt;
  if (belt !== undefined) checkCarrierSpeed(belt.tilesPerSecond, where);

  const splitter = definition.splitter;
  if (splitter !== undefined) {
    checkCarrierSpeed(splitter.tilesPerSecond, where);
    // Every geometry helper in `entities/splitter-entity.ts` reads "one tile
    // deep, `SPLITTER_LANES` across" off the rotation alone: the tile in front
    // of a side is one step along the facing, and the tile behind it is one
    // step back. A deeper footprint would make both of those wrong for the far
    // row and the error would show up as items vanishing at a seam, so the
    // shape is refused here rather than discovered there.
    const { width, height } = definition.size;
    if (width !== SPLITTER_LANES || height !== 1) {
      throw new Error(
        `BuildingRegistry: ${where} splits, so it must be ${SPLITTER_LANES}x1 unrotated; it is ${width}x${height}.`,
      );
    }
  }

  const inserter = definition.inserter;
  if (inserter !== undefined) {
    if (!Number.isFinite(inserter.itemsPerSecond) || inserter.itemsPerSecond <= 0) {
      throw new Error(`BuildingRegistry: ${where} inserts ${inserter.itemsPerSecond} items/s, which is not a rate.`);
    }
    // Four stages, each at least one tick. Below this the cycle cannot be
    // divided into a pickup, a swing, a drop and a return at all — and an
    // inserter with a zero-length swing is one whose arm is in two places on
    // the same tick, which no amount of rendering can make legible.
    if (Math.round(TPS / inserter.itemsPerSecond) < INSERTER_STAGES) {
      throw new Error(
        `BuildingRegistry: ${where} inserts ${inserter.itemsPerSecond} items/s, which is under ${INSERTER_STAGES} ticks a cycle.`,
      );
    }
  }

  const storage = definition.storage;
  if (storage !== undefined && (!Number.isInteger(storage.slots) || storage.slots < 1)) {
    throw new Error(`BuildingRegistry: ${where} has ${storage.slots} slots; it must be whole and above 0.`);
  }

  const production = definition.production;
  if (production !== undefined) {
    if (!isRecipeCategory(production.category)) {
      throw new Error(`BuildingRegistry: ${where} runs "${production.category}" recipes, which is not a category.`);
    }
    if (!RECIPE_SELECTIONS.includes(production.recipeSelection)) {
      throw new Error(
        `BuildingRegistry: ${where} selects recipes "${production.recipeSelection}", which is neither "auto" nor "player".`,
      );
    }
    if (!Number.isFinite(production.craftingSpeed) || production.craftingSpeed <= 0) {
      throw new Error(`BuildingRegistry: ${where} works at speed ${production.craftingSpeed}, which is not a speed.`);
    }
    checkCapacity(production.inputCapacity, `${where} input buffer`);
    checkCapacity(production.outputCapacity, `${where} output buffer`);
    if (production.fuelCapacity !== undefined) checkCapacity(production.fuelCapacity, `${where} fuel buffer`);
  }

  if (definition.placement.onTerrain.length === 0) {
    throw new Error(`BuildingRegistry: ${where} accepts no terrain at all, so it could never be placed.`);
  }
  for (const terrain of definition.placement.onTerrain) {
    if (!isTileType(terrain)) {
      throw new Error(`BuildingRegistry: ${where} accepts terrain ${terrain}, which is not a TileType.`);
    }
    if (!isBuildable(terrain)) {
      throw new Error(
        `BuildingRegistry: ${where} accepts ${tileProperties(terrain).name}, which is not buildable terrain (C02).`,
      );
    }
  }
}

/**
 * Seconds per item as an exact tick count (§6 R3).
 *
 * `Math.round`, as §6 specifies, so a rate whose period is not a whole number
 * of ticks lands on the nearest one rather than accumulating a fractional
 * remainder that no two machines would agree on.
 */
function checkCapacity(capacity: number, where: string): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`BuildingRegistry: ${where} holds ${capacity}; it must be whole and above 0.`);
  }
}

function ticksPerItem(mining: MiningProperties): number {
  return Math.round(TPS / mining.itemsPerSecond);
}

/** Tiles per second as whole fixed-point units per tick (§6 R3). See `BeltConfig`. */
function unitsPerTick(tilesPerSecond: number): number {
  return Math.round((tilesPerSecond * BELT_TILE_UNITS) / TPS);
}

/**
 * A belt or a splitter's speed, checked once for both (C17).
 *
 * One function rather than two copies, because the two buildings carry items
 * with the same arithmetic and a rule that held for only one of them would be
 * a rule the other could break.
 */
function checkCarrierSpeed(tilesPerSecond: number, where: string): void {
  if (!Number.isFinite(tilesPerSecond) || tilesPerSecond <= 0) {
    throw new Error(`BuildingRegistry: ${where} moves ${tilesPerSecond} tiles/s, which is not a speed.`);
  }
  const units = unitsPerTick(tilesPerSecond);
  if (units < 1) {
    throw new Error(
      `BuildingRegistry: ${where} moves ${tilesPerSecond} tiles/s, which is under one fixed-point unit per tick.`,
    );
  }
  if (units >= BELT_TILE_UNITS) {
    // An item that advances a whole tile in one tick would step straight over
    // the tile in front without ever being on it — so blocking, curves and
    // hand-off would all be decided by a tile the item never visited.
    throw new Error(
      `BuildingRegistry: ${where} moves ${tilesPerSecond} tiles/s, which skips whole tiles in one tick.`,
    );
  }
}

/** How many timed stages one inserter cycle has. See `InserterConfig`. */
const INSERTER_STAGES = 4;

/**
 * Items per second as four whole stage lengths that sum to the cycle (§6 R3).
 *
 * The rounding happens once, here, at registry-build time, and every later
 * number is a subtraction — so the four stages cannot drift apart from the
 * cycle they divide however the content is retuned. `carryTicks` takes the odd
 * tick of an odd-length pair of swings, because reaching the destination a
 * tick early is the half a player is watching.
 */
function inserterConfig(inserter: InserterProperties): InserterConfig {
  const ticksPerItem = Math.round(TPS / inserter.itemsPerSecond);
  const grab = Math.max(1, Math.round(ticksPerItem / 10));
  const swings = ticksPerItem - 2 * grab;
  const carryTicks = Math.ceil(swings / 2);
  return Object.freeze({
    ticksPerItem,
    pickupTicks: grab,
    carryTicks,
    dropTicks: grab,
    returnTicks: swings - carryTicks,
  });
}

export class BuildingRegistry {
  /**
   * Definition order, which is menu order and hotkey order. The array is the
   * authority; the maps below are lookups and are never iterated (§6 R4).
   */
  private readonly definitions: readonly BuildingDefinition[];

  private readonly byId = new Map<string, BuildingDefinition>();

  private readonly byType = new Map<EntityType, BuildingDefinition>();

  /**
   * Mining content, converted to ticks once (§6 R3). Keyed by entity type
   * because the mining system iterates entities, and an entity carries a type.
   */
  private readonly miningByType = new Map<EntityType, MiningConfig>();

  /** Belt content, converted to fixed-point units per tick once (§6 R3). */
  private readonly beltByType = new Map<EntityType, BeltConfig>();

  /** Splitter content, converted the same way and for the same reason (C17). */
  private readonly splitterByType = new Map<EntityType, SplitterConfig>();

  /** Inserter content, converted to whole stage lengths once (§6 R3). */
  private readonly inserterByType = new Map<EntityType, InserterConfig>();

  private readonly storageByType = new Map<EntityType, StorageProperties>();

  private readonly productionByType = new Map<EntityType, ProductionProperties>();

  /**
   * Entity types that run recipes, ascending. What `ProductionSystem` walks,
   * in a fixed order that does not depend on the content table's (§6 R4).
   */
  private readonly productionTypeList: readonly EntityType[];

  /**
   * Entity types whose buildings have an output buffer something else can
   * empty, ascending. C13 task 5's "back to the source machine" needs a list
   * of the machines a belt can be loaded from, and it has to be in a fixed
   * order (§6 R4) that does not depend on which building was defined first.
   * A miner's mined ore and a furnace's finished plates are both such a
   * buffer, so both kinds of building are in it.
   */
  private readonly outputTypes: readonly EntityType[];

  constructor(definitions: readonly BuildingDefinition[]) {
    const frozen: BuildingDefinition[] = [];

    for (const definition of definitions) {
      validate(definition);
      if (this.byId.has(definition.id)) {
        throw new Error(`BuildingRegistry: two buildings share the id "${definition.id}".`);
      }
      const clash = this.byType.get(definition.entityType);
      if (clash !== undefined) {
        throw new Error(
          `BuildingRegistry: "${definition.id}" and "${clash.id}" both claim entity type ${entityTypeName(definition.entityType)}.`,
        );
      }

      const value = freezeDefinition(definition);
      frozen.push(value);
      this.byId.set(value.id, value);
      this.byType.set(value.entityType, value);
      if (value.mining !== undefined) {
        this.miningByType.set(
          value.entityType,
          Object.freeze({ ticksPerItem: ticksPerItem(value.mining), bufferCapacity: value.mining.bufferCapacity }),
        );
      }
      if (value.belt !== undefined) {
        this.beltByType.set(
          value.entityType,
          Object.freeze({
            unitsPerTick: unitsPerTick(value.belt.tilesPerSecond),
            tilesPerSecond: value.belt.tilesPerSecond,
          }),
        );
      }
      if (value.splitter !== undefined) {
        this.splitterByType.set(
          value.entityType,
          Object.freeze({
            unitsPerTick: unitsPerTick(value.splitter.tilesPerSecond),
            tilesPerSecond: value.splitter.tilesPerSecond,
          }),
        );
      }
      if (value.inserter !== undefined) {
        this.inserterByType.set(value.entityType, inserterConfig(value.inserter));
      }
      if (value.storage !== undefined) {
        this.storageByType.set(value.entityType, value.storage);
      }
      if (value.production !== undefined) {
        this.productionByType.set(value.entityType, value.production);
      }
    }

    this.definitions = Object.freeze(frozen);
    // Built by walking the *type numbers*, not the definitions, so the order is
    // the enum's and not the content table's (§6 R4).
    const allTypes = Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) => type as EntityType);
    this.outputTypes = Object.freeze(allTypes.filter((type) => this.miningByType.has(type)));
    this.productionTypeList = Object.freeze(allTypes.filter((type) => this.productionByType.has(type)));
  }

  /** Every building, in content order. What the build menu and hotkeys follow. */
  all(): readonly BuildingDefinition[] {
    return this.definitions;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** A definition by id. Throws on an unknown one — see the file header. */
  get(id: string): BuildingDefinition {
    const definition = this.byId.get(id);
    if (definition === undefined) {
      throw new Error(`BuildingRegistry: no building with id "${id}".`);
    }
    return definition;
  }

  /** The definition behind a placed entity. Throws on a type nothing defines. */
  forEntityType(type: EntityType): BuildingDefinition {
    const definition = this.byType.get(type);
    if (definition === undefined) {
      throw new Error(`BuildingRegistry: no building defines entity type ${type}.`);
    }
    return definition;
  }

  /**
   * How this kind of building mines, or null if it does not. C11.
   *
   * Null rather than a throw: the mining system asks about whatever is in the
   * miner bucket, and "this building does not mine" is an ordinary answer
   * rather than a content error.
   */
  miningFor(type: EntityType): MiningConfig | null {
    return this.miningByType.get(type) ?? null;
  }

  /**
   * How this kind of building carries items, or null if it is not a belt (C13).
   *
   * Null rather than a throw, for the reason `miningFor` gives: the belt
   * system asks about whatever is in front of a belt, and "that is not a belt"
   * is the ordinary answer rather than a content error.
   */
  beltFor(type: EntityType): BeltConfig | null {
    return this.beltByType.get(type) ?? null;
  }

  /**
   * How this kind of building forks a lane, or null if it is not a splitter
   * (C17). Null rather than a throw, for the reason `beltFor` gives: the belt
   * system asks about whatever is in front of a belt, and "that is not a
   * splitter" is an ordinary answer.
   */
  splitterFor(type: EntityType): SplitterConfig | null {
    return this.splitterByType.get(type) ?? null;
  }

  /**
   * How this kind of building moves items, or null if it is not an inserter
   * (C14). Null rather than a throw, for the reason `beltFor` gives.
   */
  inserterFor(type: EntityType): InserterConfig | null {
    return this.inserterByType.get(type) ?? null;
  }

  /** How much this kind of building stores, or null if it stores nothing (C13). */
  storageFor(type: EntityType): StorageProperties | null {
    return this.storageByType.get(type) ?? null;
  }

  /**
   * How this kind of building runs recipes, or null if it runs none (C15).
   *
   * This is also the answer to "is this entity a machine": `asMachine` asks it
   * rather than testing the entity type, so C16's assembler becomes a machine
   * by appearing in `data/buildings.ts` with a production config and nothing
   * else (§19 rule 17).
   */
  productionFor(type: EntityType): ProductionProperties | null {
    return this.productionByType.get(type) ?? null;
  }

  /** Every entity type that runs recipes, ascending by type number (C15). */
  productionTypes(): readonly EntityType[] {
    return this.productionTypeList;
  }

  /**
   * Every entity type with an output buffer, ascending by type number.
   *
   * What C13's belt system walks to unload machines onto the belts in front of
   * them. Content decides membership — a building has an output because it has
   * `mining`, never because of its id (§19 rule 17).
   *
   * C13 expected C15's furnace to join this list and it does **not**: §15's
   * ratios are derived with inserters between machines and belts ("1 std
   * inserter feeds 3.2 plate furnaces", "a belt is saturated by 16 miners *or*
   * 8 std inserters"), and C15's acceptance chain puts an inserter on each
   * side of the furnace. A machine that could drop its own output on a belt
   * would make half of those inserters decoration. A *miner* stays direct
   * because it has no input side and §15 counts it that way. See C15.
   */
  outputBufferTypes(): readonly EntityType[] {
    return this.outputTypes;
  }

  /**
   * The `FootprintLookup` the entity store needs (C05).
   *
   * An arrow property rather than a method so it can be handed over as a value
   * without losing `this`, and so the store's "implementations must be pure"
   * requirement is satisfied by construction: the registry is frozen, and a
   * frozen table always answers the same way.
   */
  readonly footprintOf = (type: EntityType): Footprint => {
    const definition = this.byType.get(type);
    return definition === undefined ? UNIT_FOOTPRINT : definition.size;
  };

  /**
   * The next rotation `R` should offer for this building.
   *
   * Cycles within `rotationCount`, so a chest never leaves north. C06 wrote
   * the splitter in as the other example — "a 1×2 splitter only ever faces
   * north or east" — and C17 gave it four: its shape repeats every half turn
   * but its *direction* does not, and a splitter that could not push south
   * would be unusable on half the belt lines in a factory. Keeping this beside
   * the definition means the input layer can cycle a ghost without knowing
   * what a splitter is.
   */
  static cycleRotation(definition: BuildingDefinition, current: Rotation): Rotation {
    const next = (current + 1) % definition.rotationCount;
    return isRotation(next) ? next : 0;
  }

  /**
   * The rotation this building would actually be stored with.
   *
   * A chest asked to face south is stored facing north: a rotation a building
   * does not have must never reach a save, where it would come back as a
   * footprint nobody can explain. Normalising rather than rejecting keeps the
   * rule out of the rejection vocabulary, where it would be a message no player
   * could act on.
   */
  static normalizeRotation(definition: BuildingDefinition, rotation: Rotation): Rotation {
    const normalized = rotation % definition.rotationCount;
    return isRotation(normalized) ? normalized : 0;
  }
}
