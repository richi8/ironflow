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

import { UNIT_FOOTPRINT, assertFootprint, type Footprint } from '../entities/entity.js';
import { TPS } from '../simulation-clock.js';
import { entityTypeName, isEntityType, type EntityType } from '../entities/entity-types.js';
import type { ItemStack } from '../items/item-stack.js';
import { isBuildable, isTileType, tileProperties, type TileType } from '../world/tile.js';
import { isRotation, type Rotation } from '../world/coordinates.js';

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
function ticksPerItem(mining: MiningProperties): number {
  return Math.round(TPS / mining.itemsPerSecond);
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
    }

    this.definitions = Object.freeze(frozen);
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
   * Cycles within `rotationCount`, so a chest never leaves north and a 1×2
   * splitter only ever faces north or east. Keeping this beside the definition
   * means the input layer can cycle a ghost without knowing what a splitter is.
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
