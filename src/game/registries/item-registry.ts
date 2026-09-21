/**
 * What an item *is*, and the registry that numbers them. See C08 tasks 1–2.
 *
 * An item definition is pure content — §15's item table written down. The
 * registry's job beyond holding it is the one C08 task 2 asks for: giving every
 * item a **numeric runtime id**.
 *
 * ## Why two vocabularies
 *
 * Content data, commands and the UI name items by string id (`'iron_ore'`),
 * because that is what a human writes and reads. Inventories, belt slots and
 * saves store the number, because that is what a hot loop compares and what
 * keeps a save of a 200-belt factory small. The two meet here and nowhere else,
 * exactly as `BuildingDefinition.entityType` is the single place a building's
 * string id meets its numeric type (C06).
 *
 * ## Why the mapping is persisted
 *
 * Numeric ids are assigned in registration order, so reordering `data/items.ts`
 * — or inserting an item in the middle of the table — would renumber every item
 * after it and turn every existing save's iron plates into copper. A save
 * therefore carries the string→number mapping it was written with (§14), and a
 * registry built from that mapping keeps those numbers, appending new content
 * above the highest id ever used. Numbers named by the mapping are **reserved
 * even if the item no longer exists**: reusing one would resurrect a deleted
 * item's stock as something else. C27 is where migrations act on this.
 *
 * ## Id 0 is "no item"
 *
 * Ids start at 1 so `0` can mean *empty* — a belt slot with nothing on it, an
 * inserter hand holding nothing. The alternative is `undefined` in a typed
 * array that cannot hold it, or a falsy valid id, which is the same bug family
 * `NO_ENTITY` exists to avoid (C05).
 */

import { TPS } from '../simulation-clock.js';

/** A stable numeric handle to an item kind. Persisted; never renumbered. */
export type ItemId = number;

/** "No item": an empty belt slot, an empty inserter hand. Never in an inventory. */
export const NO_ITEM: ItemId = 0;

/** The first id a fresh registry hands out. */
export const FIRST_ITEM_ID: ItemId = 1;

/**
 * Where an item sits in the production chain. Drives UI grouping and, later,
 * the order the inventory panel lists things in. Not a rule about recipes —
 * recipes say what turns into what, this only says what to call the result.
 *
 * `building` is C20's, and it is the category that finally makes §15's
 * sentence true: "buildings are placed by consuming their item from the
 * player's inventory". A building item is an ordinary item in every respect —
 * it stacks, it rides a belt, an assembler makes it — and the category exists
 * so the build menu and the inventory panel can tell it from an ingredient
 * without a list of ids (§19 rule 17). Nothing in `game/` branches on it.
 */
export type ItemCategory = 'raw' | 'plate' | 'intermediate' | 'science' | 'building';

const ITEM_CATEGORIES: readonly ItemCategory[] = Object.freeze([
  'raw',
  'plate',
  'intermediate',
  'science',
  'building',
]);

/**
 * The largest stack any item may declare.
 *
 * `Uint16` headroom, because §16 reserves the right to move inventory counts
 * into typed arrays, and a stack size that cannot fit the container it is
 * counted in is a bug that only appears once a chest is full.
 */
export const MAX_STACK_SIZE = 65535;

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /** How many fit in one slot of a slot-based inventory. At least 1. */
  readonly stackSize: number;
  /**
   * Typed `string` rather than the renderer's `SpriteId` for the reason
   * `BuildingDefinition.sprite` is: §4 forbids `game/` from importing
   * `renderer/`, and a sprite id is a name, not a picture. The `item:<id>`
   * form is invented here; the atlas learns to draw it in the chunk that first
   * puts an item on screen (C12/C13), and until then nothing asks it to.
   */
  readonly sprite: string;
  readonly category: ItemCategory;
  /**
   * How long one of this item burns in a machine with a fuel buffer, in
   * seconds. Absent means "not a fuel", which is all but one item in v1.
   *
   * It is on the item rather than on the furnace because burning is a property
   * of the thing burnt: C21's generator gets the same eight seconds out of a
   * coal as C15's furnace does, and neither building has a table of what it
   * accepts. The registry converts it to ticks once (§6 R3).
   */
  readonly fuelSeconds?: number;
}

/** The persisted string→number mapping. Sorted by string id; plain data (§14). */
export type ItemIdMapping = Readonly<Record<string, ItemId>>;

export interface ItemRegistryOptions {
  /**
   * Ids to keep, from a save. Items listed here get their old number; anything
   * else is appended above every number the mapping mentions.
   */
  readonly assignedIds?: ItemIdMapping;
}

function validate(definition: ItemDefinition): void {
  const where = `item "${definition.id}"`;

  if (typeof definition.id !== 'string' || definition.id.length === 0 || definition.id.trim() !== definition.id) {
    throw new Error(`ItemRegistry: ${JSON.stringify(definition.id)} is not a usable item id.`);
  }
  if (definition.name.length === 0) {
    throw new Error(`ItemRegistry: ${where} has no name.`);
  }
  if (!Number.isInteger(definition.stackSize) || definition.stackSize < 1 || definition.stackSize > MAX_STACK_SIZE) {
    throw new Error(
      `ItemRegistry: ${where} has stackSize ${definition.stackSize}; it must be a whole number from 1 to ${MAX_STACK_SIZE}.`,
    );
  }
  if (definition.sprite.length === 0) {
    throw new Error(`ItemRegistry: ${where} has no sprite.`);
  }
  if (!ITEM_CATEGORIES.includes(definition.category)) {
    throw new Error(`ItemRegistry: ${where} has category "${definition.category}", which is not one.`);
  }
  const fuelSeconds = definition.fuelSeconds;
  if (fuelSeconds !== undefined) {
    if (!Number.isFinite(fuelSeconds) || fuelSeconds <= 0) {
      throw new Error(`ItemRegistry: ${where} burns for ${fuelSeconds} seconds, which is not a duration.`);
    }
    if (fuelTicksOf(definition) < 1) {
      throw new Error(`ItemRegistry: ${where} burns for ${fuelSeconds} seconds, which rounds to under one tick.`);
    }
  }
}

/** Burn time in whole ticks, converted once (§6 R3). `0` for a non-fuel. */
function fuelTicksOf(definition: ItemDefinition): number {
  const seconds = definition.fuelSeconds;
  return seconds === undefined ? 0 : Math.round(seconds * TPS);
}

function validateMapping(mapping: ItemIdMapping): void {
  const seen = new Map<ItemId, string>();
  for (const stringId of Object.keys(mapping)) {
    const numeric = mapping[stringId];
    if (numeric === undefined || !Number.isInteger(numeric) || numeric < FIRST_ITEM_ID) {
      throw new Error(
        `ItemRegistry: the saved id mapping gives "${stringId}" the id ${String(numeric)}, which is not a usable item id.`,
      );
    }
    const clash = seen.get(numeric);
    if (clash !== undefined) {
      throw new Error(`ItemRegistry: the saved id mapping gives both "${clash}" and "${stringId}" the id ${numeric}.`);
    }
    seen.set(numeric, stringId);
  }
}

export class ItemRegistry {
  /**
   * Definition order, which is content order and the order the UI lists items
   * in. The array is the authority; the maps below are lookups and are never
   * iterated (§6 R4).
   */
  private readonly definitions: readonly ItemDefinition[];

  private readonly byStringId = new Map<string, ItemDefinition>();

  private readonly byItemId = new Map<ItemId, ItemDefinition>();

  private readonly ids = new Map<string, ItemId>();

  /**
   * Stack size indexed by runtime id, so the inventory's inner loop is an array
   * read rather than a hash lookup. A hole is an id nothing defines, and
   * `stackSizeOf` turns that into a throw rather than `undefined` arithmetic.
   */
  private readonly stackSizes: readonly number[];

  /** Burn time in ticks, indexed by runtime id. `0` is "not a fuel". */
  private readonly fuelTicks: readonly number[];

  /**
   * Is this a science item, indexed by runtime id (C22)?
   *
   * Beside `fuelTicks` and for its reason: a lab asks it of everything an
   * inserter offers it, once per swing, and "what category is this" is a fact
   * about content that an array index answers faster than a map and a string
   * comparison.
   */
  private readonly science: readonly boolean[];

  constructor(definitions: readonly ItemDefinition[], options: ItemRegistryOptions = {}) {
    const assigned = options.assignedIds;
    if (assigned !== undefined) validateMapping(assigned);

    // New content is appended above *every* number the mapping mentions, not
    // above the highest number still in use: a number whose item has since been
    // deleted stays spoken for, because reusing it would resurrect that item's
    // stock in every old save as something else. See the file header.
    let nextFree = FIRST_ITEM_ID;
    for (const numeric of Object.values(assigned ?? {})) {
      if (numeric >= nextFree) nextFree = numeric + 1;
    }

    const frozen: ItemDefinition[] = [];
    const stackSizes: number[] = [];
    const fuelTicks: number[] = [];
    const science: boolean[] = [];

    for (const definition of definitions) {
      validate(definition);
      if (this.byStringId.has(definition.id)) {
        throw new Error(`ItemRegistry: two items share the id "${definition.id}".`);
      }

      const value = Object.freeze({ ...definition });
      const itemId = assigned?.[value.id] ?? nextFree++;

      frozen.push(value);
      this.byStringId.set(value.id, value);
      this.byItemId.set(itemId, value);
      this.ids.set(value.id, itemId);
      stackSizes[itemId] = value.stackSize;
      fuelTicks[itemId] = fuelTicksOf(value);
      science[itemId] = value.category === 'science';
    }

    this.definitions = Object.freeze(frozen);
    this.stackSizes = Object.freeze(stackSizes);
    this.fuelTicks = Object.freeze(fuelTicks);
    this.science = Object.freeze(science);
  }

  /** Every item, in content order. What the inventory panel follows. */
  all(): readonly ItemDefinition[] {
    return this.definitions;
  }

  /** How many items are registered. */
  get size(): number {
    return this.definitions.length;
  }

  has(stringId: string): boolean {
    return this.byStringId.has(stringId);
  }

  /** A definition by string id. Throws on an unknown one — a content typo. */
  get(stringId: string): ItemDefinition {
    const definition = this.byStringId.get(stringId);
    if (definition === undefined) {
      throw new Error(`ItemRegistry: no item with id "${stringId}".`);
    }
    return definition;
  }

  /** The runtime id of a string id. Throws on an unknown one. */
  idOf(stringId: string): ItemId {
    const itemId = this.ids.get(stringId);
    if (itemId === undefined) {
      throw new Error(`ItemRegistry: no item with id "${stringId}".`);
    }
    return itemId;
  }

  /** The definition behind a runtime id. Throws on one nothing defines. */
  byId(itemId: ItemId): ItemDefinition {
    const definition = this.byItemId.get(itemId);
    if (definition === undefined) {
      throw new Error(`ItemRegistry: no item has runtime id ${itemId}.`);
    }
    return definition;
  }

  /** Is this a number this registry handed out? The guard for loaded data. */
  isItemId(value: number): value is ItemId {
    return this.byItemId.has(value);
  }

  /**
   * Stack size by runtime id, for the inventory.
   *
   * An arrow property for the reason `BuildingRegistry.footprintOf` is one: it
   * is handed over as a value, and the registry is frozen, so it always answers
   * the same way. It throws rather than defaulting, because an item in an
   * inventory that no registry knows about is a content or save bug, and a
   * silent default would spend it as a stack of one.
   */
  readonly stackSizeOf = (itemId: ItemId): number => {
    const stackSize = this.stackSizes[itemId];
    if (stackSize === undefined) {
      throw new Error(`ItemRegistry: no item has runtime id ${itemId}.`);
    }
    return stackSize;
  };

  /**
   * How long one of `itemId` burns, in ticks; `0` when it is not a fuel.
   *
   * Unlike `stackSizeOf` an unknown id answers `0` rather than throwing: a
   * machine asks this of whatever is in its fuel buffer, and "this is not
   * fuel" is the honest answer to "what is this thing I cannot identify".
   */
  readonly fuelTicksOf = (itemId: ItemId): number => {
    return this.fuelTicks[itemId] ?? 0;
  };

  /**
   * Is `itemId` something a lab consumes (C22)?
   *
   * An unknown id answers `false` for `fuelTicksOf`'s reason: a lab asks this
   * of whatever is offered to it, and "that is not science" is the honest
   * answer to "what is this thing I cannot identify".
   */
  readonly isScience = (itemId: ItemId): boolean => {
    return this.science[itemId] ?? false;
  };

  /**
   * The string→number mapping, for the save file (§14).
   *
   * Sorted by string id so two registries built from the same content produce
   * byte-identical output whatever order the numbers landed in (§6).
   */
  idMapping(): ItemIdMapping {
    const out: Record<string, ItemId> = {};
    for (const [stringId, itemId] of [...this.ids].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      out[stringId] = itemId;
    }
    return out;
  }
}
