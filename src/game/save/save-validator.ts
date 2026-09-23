/**
 * Total distrust of a save file. See ironflow.md C26 tasks 3–6 and §14.
 *
 * > **A full validator, because an imported save is untrusted input.**
 *
 * Every save that reaches the game comes through here first — the ones this
 * build wrote to IndexedDB as much as the one a stranger sent over Discord,
 * because "stored by us" is a claim about provenance that a truncated write,
 * a flipped bit or a devtools console can all falsify. `save-codec.ts` calls
 * it the moment the JSON parses, which makes this the single door (C25's
 * header checks are the doorbell: *is this one of ours, and is it from the
 * future?* — two questions with two different answers for the player).
 *
 * ## What it promises
 *
 * ```text
 * in    anything at all: a string, null, a 40 MB array, a hostile object
 * out   a SaveFile whose every field has been read, checked and rebuilt —
 *       or a SaveValidationError listing what is wrong with it
 * ```
 *
 * Nothing is mutated on the way to a rejection, which is task 4's "never
 * partially import": the validator has no access to game state at all, so a
 * refusal cannot have left a mark on one. And the object it returns is
 * **constructed field by field** rather than cast — no `JSON.parse` result is
 * ever spread into the game — so a property nobody validated cannot ride along
 * inside it.
 *
 * ## Why it collects reasons instead of stopping at the first
 *
 * A save rejected one problem at a time is a save the player fixes one problem
 * at a time, and the second reason is usually the one that explains the first.
 * Each top-level field is validated inside its own boundary: the first problem
 * *within* a field ends that field, and the next field is still checked. The
 * list is capped, because thirty reasons is not a message, it is a wall.
 *
 * ## The two things it is not
 *
 * It is not a migrator. A save from an older schema version is *valid*; C27
 * decides what to do about it, and this only refuses versions from the future,
 * which nothing can know how to read.
 *
 * It is not a balance check. A chest holding a legal number of plates the
 * player could not possibly have mined is a cheat, and §2 puts cheat detection
 * out of scope — C26 says so in as many words. What is refused here is what
 * would **crash the game or produce NaN state**: an unknown id, a fractional
 * coordinate, a count that is not a count, a structure that is not the shape
 * the loader will index into.
 */

import { BUILDINGS } from '../data/buildings.js';
import { ITEMS } from '../data/items.js';
import { RECIPES } from '../data/recipes.js';
import { TECHNOLOGIES } from '../data/technologies.js';
import { FIRST_ENTITY_ID } from '../entities/entity.js';
import { footprintExtent, forEachFootprintTile } from '../entities/entity.js';
import { isEntityType, type EntityType } from '../entities/entity-types.js';
import {
  MAX_CRAFT_BATCH,
  MAX_CRAFT_ORDERS,
  PLAYER_INVENTORY_SLOTS,
  SUBTILES_PER_TILE,
} from '../player/player-state.js';
import { BuildingRegistry } from '../registries/building-registry.js';
import { FIRST_ITEM_ID, ItemRegistry, MAX_STACK_SIZE } from '../registries/item-registry.js';
import { MAX_RESEARCH_QUEUE } from '../research/research-state.js';
import { CHUNK_AREA, CHUNK_MAX, CHUNK_MIN, chunkKey } from '../world/chunk.js';
import { TILE_MAX, TILE_MIN, isRotation, tileKey, type Rotation } from '../world/coordinates.js';
import { isResourceType } from '../world/resource.js';
import { isTileType } from '../world/tile.js';
import { unpackChunkKey } from '../world/explored.js';
import { GENERATOR_VERSION } from '../world/world-generator.js';

import {
  SAVE_FORMAT,
  SAVE_VERSION,
  type SaveFile,
  type SaveMetadata,
  type SaveValue,
  type SerializedChunkDelta,
  type SerializedEntity,
  type SerializedGameState,
  type SerializedItemGrid,
  type SerializedItemSlots,
  type SerializedPlayerState,
  type SerializedResearchState,
  type SerializedTileDelta,
} from './save-format.js';

/* -------------------------------------------------------------------------- *
 * Caps
 * -------------------------------------------------------------------------- */

/**
 * Sane caps on how much of anything a save may claim. C26 task 3's "every
 * array length within a sane cap".
 *
 * Each is far above what §12's reference factory produces and far below what
 * allocates for a minute: the file with a 10⁹-length array is refused by the
 * number rather than by the clock. `save-codec.ts`'s 64 MB decompression limit
 * is the other half — that one bounds the bytes, these bound the shapes.
 */
export const MAX_ENTITIES = 250_000;
/** Any array inside an entity, a delta or the player. */
export const MAX_ARRAY_LENGTH = 65_536;
export const MAX_CHUNK_DELTAS = 65_536;
export const MAX_EXPLORED_CHUNKS = 262_144;
/** Item ids a save's mapping may name, deleted content included. */
export const MAX_ITEM_MAP_ENTRIES = 4_096;
export const MAX_STRING_LENGTH = 256;
/** How deep a nested value inside an entity may go before it is not one. */
export const MAX_DEPTH = 8;
/** More hotbar slots than the game has, and far fewer than would cost anything. */
export const MAX_HOTBAR_SLOTS = 32;
/**
 * The largest count anything may hold.
 *
 * Not `MAX_SAFE_INTEGER`: a count that survives one addition without losing
 * precision is the actual requirement, and a billion of one item is already
 * four orders of magnitude past a full chest.
 */
export const MAX_COUNT = 1_000_000_000;
/** Reasons listed before the message stops being one. */
export const MAX_REASONS = 12;

/** Keys that must never appear in a parsed save. Task 3's prototype rule. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Fields that carry an item id directly, rather than inside a slot pair. */
const ITEM_ID_FIELDS: ReadonlySet<string> = new Set(['itemId', 'heldItem']);

/** Subtile bounds, from the tile bounds the world can actually address. */
const SUBTILE_MIN = TILE_MIN * SUBTILES_PER_TILE;
const SUBTILE_MAX = (TILE_MAX + 1) * SUBTILES_PER_TILE - 1;

/* -------------------------------------------------------------------------- *
 * Failure
 * -------------------------------------------------------------------------- */

/**
 * Why a save was refused, as a list rather than a sentence.
 *
 * `message` is the sentence the player reads and `reasons` is what it was
 * built from, kept separately so a caller can show one reason per line
 * without parsing prose back apart.
 */
export class SaveValidationError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      reasons.length === 1
        ? `This save was refused: ${reasons[0]}`
        : `This save was refused for ${reasons.length} reasons: ${reasons.join(' ')}`,
    );
    this.name = 'SaveValidationError';
    this.reasons = Object.freeze([...reasons]);
  }
}

/**
 * One problem, thrown to end the field it was found in.
 *
 * Internal: it never escapes this module. `validateSaveFile` catches it per
 * field, records the sentence and carries on with the next one — see the file
 * header on why a save is not rejected one problem at a time.
 */
class Invalid extends Error {}

/**
 * A field ending because something *inside* it already recorded the reason.
 *
 * Without it the state would add "the state could not be read" underneath the
 * sentence that actually explains the problem, which is one line of noise per
 * rejection in the place a player is trying to read.
 */
class Bail extends Invalid {}

function fail(message: string): never {
  throw new Invalid(message);
}

/* -------------------------------------------------------------------------- *
 * The content this build has
 * -------------------------------------------------------------------------- */

interface Content {
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly recipes: ReadonlySet<string>;
  readonly technologies: ReadonlySet<string>;
  readonly entityTypes: ReadonlySet<number>;
}

let content: Content | null = null;

/**
 * The registries and name sets every "is this id known?" question is asked of.
 *
 * Built once, lazily, and from `data/**` rather than from a running
 * `Simulation`: validation happens before there is a game to ask, and it has
 * to be answerable in a test with no world in it. Recipes and technologies are
 * plain sets because membership is the only thing wanted of them here, while
 * buildings and items arrive as their registries, which know footprints and
 * stack sizes — the two facts that turn "this id exists" into "this entity
 * fits on the map" and "this chest could hold that".
 */
function contentOf(): Content {
  if (content === null) {
    content = {
      buildings: new BuildingRegistry(BUILDINGS),
      items: new ItemRegistry(ITEMS),
      recipes: new Set(RECIPES.map((recipe) => recipe.id)),
      technologies: new Set(TECHNOLOGIES.map((technology) => technology.id)),
      entityTypes: new Set(BUILDINGS.map((building) => building.entityType as number)),
    };
  }
  return content;
}

/**
 * The item numbers *this save* uses, and what they mean here.
 *
 * A save carries the string→number table it was written with (§14), so an id
 * on a belt means whatever that table says — and it is usable only if this
 * build still has the item it names. A number the table maps to content that
 * has since been deleted is therefore refused rather than loaded: the
 * registry deliberately keeps that number reserved, so nothing would throw
 * until a machine asked its stack size, three hours in.
 */
interface ItemNumbering {
  readonly usable: ReadonlySet<number>;
  readonly stackSizeOf: (itemId: number) => number;
}

/* -------------------------------------------------------------------------- *
 * The entry point
 * -------------------------------------------------------------------------- */

/**
 * A `SaveFile` from anything at all, or a listed refusal. C26 tasks 3 and 4.
 *
 * The returned object shares no structure with the input: every string,
 * number and array in it was read out, checked and written into a fresh
 * object. That is the difference between validating a save and believing one.
 */
export function validateSaveFile(value: unknown): SaveFile {
  const reasons: string[] = [];

  let file: Readonly<Record<string, unknown>>;
  try {
    file = readObject(value, 'the save');
  } catch (cause) {
    // Nothing else can be said about a value that is not an object at all,
    // and the caller still gets a `SaveValidationError` rather than whatever
    // this module happened to throw.
    if (!(cause instanceof Invalid)) throw cause;
    throw new SaveValidationError([cause.message]);
  }

  const format = collect(reasons, (): typeof SAVE_FORMAT => {
    const claimed = readString(file['format'], 'format', MAX_STRING_LENGTH);
    if (claimed !== SAVE_FORMAT) fail(`it is not an IronFlow save: its format says "${claimed}".`);
    return SAVE_FORMAT;
  });

  const version = collect(reasons, () => {
    const claimed = readInteger(file['version'], 'version', 1, Number.MAX_SAFE_INTEGER);
    if (claimed > SAVE_VERSION) {
      fail(`it is schema version ${claimed}; this build reads up to ${SAVE_VERSION}.`);
    }
    return claimed;
  });

  const metadata = collect(reasons, () => readMetadata(file['metadata']));
  const state = collect(reasons, () => readState(file['state'], reasons));

  if (reasons.length > 0 || format === undefined || version === undefined || metadata === undefined || state === undefined) {
    throw new SaveValidationError(reasons.length > 0 ? reasons : ['it is not a save file.']);
  }
  return { format, version, metadata, state };
}

/**
 * Run one field's checks, recording the first problem it finds.
 *
 * The cap is applied here rather than at the end so that a file which is
 * wrong in ten thousand ways costs ten thousand *checks* and not ten thousand
 * strings.
 */
function collect<T>(reasons: string[], read: () => T): T | undefined {
  if (reasons.length >= MAX_REASONS) return undefined;
  try {
    return read();
  } catch (cause) {
    if (!(cause instanceof Invalid)) throw cause;
    if (cause instanceof Bail) return undefined;
    reasons.push(cause.message);
    if (reasons.length === MAX_REASONS) reasons.push('(further problems not listed.)');
    return undefined;
  }
}

/* -------------------------------------------------------------------------- *
 * Leaves
 * -------------------------------------------------------------------------- */

/**
 * A parsed object, with the prototype-polluting keys refused. Task 3.
 *
 * `JSON.parse` puts a `__proto__` key on the object as ordinary own data
 * rather than as the prototype — so it is not by itself an exploit — and it
 * becomes one the moment anything copies the object with `Object.assign`, or
 * reads it back through a bracket access the engine treats as the accessor.
 * The save format has no use for any of the three names, so refusing them
 * costs nothing and closes the question.
 */
function readObject(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} is ${describe(value)}, not an object.`);
  }
  for (const key of Object.keys(value)) {
    if (POLLUTING_KEYS.has(key)) fail(`${where} has a "${key}" key, which a save may never carry.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, where: string, cap: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${where} is ${describe(value)}, not an array.`);
  if (value.length > cap) fail(`${where} claims ${value.length} entries; the limit is ${cap}.`);
  return value as readonly unknown[];
}

/**
 * Map over an array **by index**, so a hole is seen rather than skipped.
 *
 * `Array.prototype.map` walks around a hole and puts one back in the result,
 * which is how an array with an element deleted from it passes a validator
 * built on `map` and then lands as an `undefined` inside the game — a value
 * `JSON.stringify` drops and `entity.ts` spends a whole function refusing. A
 * hole is `undefined`, `undefined` is not a value a save may contain, and the
 * indexed read is what makes those two sentences the same sentence.
 */
function mapArray<T>(entries: readonly unknown[], read: (entry: unknown, index: number) => T): T[] {
  const out: T[] = [];
  for (let index = 0; index < entries.length; index++) out.push(read(entries[index], index));
  return out;
}

function readInteger(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${where} is ${describe(value)}, not a finite number.`);
  }
  if (!Number.isInteger(value)) fail(`${where} is ${value}, which is not a whole number.`);
  if (Object.is(value, -0)) fail(`${where} is -0, which does not survive a save round trip.`);
  if (value < min || value > max) fail(`${where} is ${value}, outside ${min}..${max}.`);
  return value;
}

function readBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} is ${describe(value)}, not true or false.`);
  return value;
}

function readString(value: unknown, where: string, cap: number): string {
  if (typeof value !== 'string') fail(`${where} is ${describe(value)}, not a string.`);
  if (value.length > cap) fail(`${where} is ${value.length} characters long; the limit is ${cap}.`);
  return value;
}

/** What a value is, for a message, without printing a megabyte of it. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `a string`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} (${String(value)})`;
}

/* -------------------------------------------------------------------------- *
 * The file wrapper
 * -------------------------------------------------------------------------- */

function readMetadata(value: unknown): SaveMetadata {
  const metadata = readObject(value, 'the metadata');
  const thumbnail = metadata['thumbnail'];
  return {
    name: readString(metadata['name'], 'the save name', MAX_STRING_LENGTH),
    createdAt: readInteger(metadata['createdAt'], 'createdAt', 0, Number.MAX_SAFE_INTEGER),
    playtimeTicks: readInteger(metadata['playtimeTicks'], 'playtimeTicks', 0, Number.MAX_SAFE_INTEGER),
    // A data URL, and nothing has ever written one (C25 decided against it),
    // so the cap is generous rather than considered. What matters is that it
    // is a string or it is null, and never a script-bearing object.
    thumbnail: thumbnail === null ? null : readString(thumbnail, 'the thumbnail', 4 * 1024 * 1024),
    hotbar: readHotbar(metadata['hotbar']),
  };
}

/**
 * The hotbar layout (v2). Ids are only checked to be short strings: whether an
 * item exists is content, and the controller turns an unknown one into an
 * empty slot rather than refusing a whole save over a preference.
 */
function readHotbar(value: unknown): readonly (string | null)[] | null {
  if (value === null) return null;
  return readArray(value, 'the hotbar', MAX_HOTBAR_SLOTS).map((slot, index) =>
    slot === null ? null : readString(slot, `hotbar slot ${index + 1}`, MAX_STRING_LENGTH),
  );
}

/* -------------------------------------------------------------------------- *
 * The state
 * -------------------------------------------------------------------------- */

function readState(value: unknown, reasons: string[]): SerializedGameState {
  const state = readObject(value, 'the state');

  const generatorVersion = readInteger(state['generatorVersion'], 'generatorVersion', 0, GENERATOR_VERSION);
  const seed = readInteger(state['seed'], 'the seed', 0, 0xffff_ffff);
  const rngPosition = readInteger(state['rngPosition'], 'rngPosition', 0, 0xffff_ffff);
  const tick = readInteger(state['tick'], 'the tick count', 0, Number.MAX_SAFE_INTEGER);
  const nextEntityId = readInteger(state['nextEntityId'], 'nextEntityId', FIRST_ENTITY_ID, Number.MAX_SAFE_INTEGER);

  const itemIdMap = readItemIdMap(state['itemIdMap']);
  const numbering = numberingOf(itemIdMap);

  // Each of the four below is collected separately: a broken research queue
  // and a broken entity list are independent problems, and a player who has
  // both should be told both.
  const player = collect(reasons, () => readPlayer(state['player'], numbering));
  const entities = collect(reasons, () => readEntities(state['entities'], nextEntityId, numbering));
  const chunkDeltas = collect(reasons, () => readChunkDeltas(state['chunkDeltas']));
  const exploredChunks = collect(reasons, () => readExplored(state['exploredChunks']));
  const research = collect(reasons, () => readResearch(state['research']));

  if (
    player === undefined ||
    entities === undefined ||
    chunkDeltas === undefined ||
    exploredChunks === undefined ||
    research === undefined
  ) {
    // The reasons are already recorded; this ends the state rather than
    // adding a second sentence about the same problem.
    throw new Bail('the state could not be read.');
  }

  return {
    generatorVersion,
    seed,
    rngPosition,
    tick,
    nextEntityId,
    itemIdMap,
    player,
    entities,
    chunkDeltas,
    exploredChunks,
    research,
  };
}

/* -------------------------------------------------------------------------- *
 * Item numbering
 * -------------------------------------------------------------------------- */

function readItemIdMap(value: unknown): Readonly<Record<string, number>> {
  const mapping = readObject(value, 'the item id table');
  const keys = Object.keys(mapping);
  if (keys.length > MAX_ITEM_MAP_ENTRIES) {
    fail(`the item id table names ${keys.length} items; the limit is ${MAX_ITEM_MAP_ENTRIES}.`);
  }

  const out: Record<string, number> = {};
  const taken = new Map<number, string>();
  for (const key of keys) {
    readString(key, 'an item id table key', MAX_STRING_LENGTH);
    const id = readInteger(mapping[key], `the item id table entry for "${key}"`, FIRST_ITEM_ID, MAX_STACK_SIZE);
    const clash = taken.get(id);
    if (clash !== undefined) {
      fail(`the item id table gives both "${clash}" and "${key}" the id ${id}.`);
    }
    taken.set(id, key);
    out[key] = id;
  }
  return out;
}

/**
 * Which numbers in this save name an item this build can still load.
 *
 * An id the table does not mention is unusable whatever it is, and so is one
 * whose name this build no longer has: both would reach `ItemRegistry.byId`
 * and throw, long after the load said it had worked.
 */
function numberingOf(mapping: Readonly<Record<string, number>>): ItemNumbering {
  const { items } = contentOf();
  const usable = new Set<number>();
  const stackSizes = new Map<number, number>();
  for (const [stringId, itemId] of Object.entries(mapping)) {
    if (!items.has(stringId)) continue;
    usable.add(itemId);
    stackSizes.set(itemId, items.get(stringId).stackSize);
  }
  return {
    usable,
    stackSizeOf: (itemId) => stackSizes.get(itemId) ?? 1,
  };
}

/* -------------------------------------------------------------------------- *
 * Inventories
 * -------------------------------------------------------------------------- */

/** How much of one item a container may hold, and how that limit is reached. */
type Capacity =
  /** A chest or a bag: slots, each holding one stack of one item. */
  | { readonly kind: 'slots'; readonly slots: number }
  /** A machine buffer: a ceiling per item, and no slots at all. */
  | { readonly kind: 'buffer'; readonly perItem: number }
  /** A belt lane or an unknown container: counts, but no capacity to check. */
  | null;

/**
 * `[itemId, count]` pairs, ascending, within capacity. C26 task 3's
 * "every inventory count ≤ stackSize × slots".
 *
 * Ascending and unique because that is what the format promises (§6 R4) and
 * what `Inventory.load` will otherwise throw about, and because a duplicate
 * entry is the difference between a chest holding 300 plates and one holding
 * 300 plates twice.
 */
function readItemSlots(value: unknown, where: string, numbering: ItemNumbering, capacity: Capacity): SerializedItemSlots {
  const entries = readArray(value, where, MAX_ARRAY_LENGTH);
  const out: (readonly [number, number])[] = [];
  let previous = -1;
  let usedSlots = 0;

  for (const entry of entries) {
    const pair = readArray(entry, `an entry of ${where}`, 2);
    if (pair.length !== 2) fail(`an entry of ${where} has ${pair.length} fields, not 2.`);
    const itemId = readInteger(pair[0], `an item id in ${where}`, FIRST_ITEM_ID, MAX_STACK_SIZE);
    if (!numbering.usable.has(itemId)) {
      fail(`${where} holds item ${itemId}, which this build has no item for.`);
    }
    if (itemId <= previous) {
      fail(`${where} lists item ${itemId} after ${previous}; item ids must ascend and never repeat.`);
    }
    previous = itemId;

    const count = readInteger(pair[1], `a count in ${where}`, 1, MAX_COUNT);
    const stackSize = numbering.stackSizeOf(itemId);
    if (capacity !== null && capacity.kind === 'buffer' && count > capacity.perItem) {
      fail(`${where} holds ${count} of item ${itemId}; that buffer holds ${capacity.perItem}.`);
    }
    if (capacity !== null && capacity.kind === 'slots') {
      usedSlots += Math.ceil(count / stackSize);
      if (usedSlots > capacity.slots) {
        fail(`${where} needs ${usedSlots} slots of ${capacity.slots}.`);
      }
    }
    out.push([itemId, count] as const);
  }
  return out;
}

/**
 * `[slot, itemId, count]` triples, ascending by slot (v3): the player's bag.
 * Every slot is inside the bag, used once, and holds at most one stack.
 */
function readItemGrid(value: unknown, where: string, numbering: ItemNumbering, slots: number): SerializedItemGrid {
  const entries = readArray(value, where, slots);
  const out: (readonly [number, number, number])[] = [];
  let previous = -1;

  for (const entry of entries) {
    const triple = readArray(entry, `an entry of ${where}`, 3);
    if (triple.length !== 3) fail(`an entry of ${where} has ${triple.length} fields, not 3.`);
    const slot = readInteger(triple[0], `a slot in ${where}`, 0, slots - 1);
    if (slot <= previous) fail(`${where} lists slot ${slot} after ${previous}; slots must ascend and never repeat.`);
    previous = slot;

    const itemId = readInteger(triple[1], `an item id in ${where}`, FIRST_ITEM_ID, MAX_STACK_SIZE);
    if (!numbering.usable.has(itemId)) fail(`${where} holds item ${itemId}, which this build has no item for.`);
    const stackSize = numbering.stackSizeOf(itemId);
    const count = readInteger(triple[2], `a count in ${where}`, 1, stackSize);
    out.push([slot, itemId, count] as const);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * The player
 * -------------------------------------------------------------------------- */

function readPlayer(value: unknown, numbering: ItemNumbering): SerializedPlayerState {
  const player = readObject(value, 'the player');
  const miningX = player['miningX'];
  const miningY = player['miningY'];
  if ((miningX === null) !== (miningY === null)) {
    fail('the player is mining a tile with only one coordinate.');
  }

  const facing = readInteger(player['facing'], "the player's facing", 0, 3);
  return {
    subX: readInteger(player['subX'], "the player's subX", SUBTILE_MIN, SUBTILE_MAX),
    subY: readInteger(player['subY'], "the player's subY", SUBTILE_MIN, SUBTILE_MAX),
    facing: facing as Rotation,
    moveX: readInteger(player['moveX'], "the player's moveX", -1, 1),
    moveY: readInteger(player['moveY'], "the player's moveY", -1, 1),
    miningX: miningX === null ? null : readInteger(miningX, 'the mining target x', TILE_MIN, TILE_MAX),
    miningY: miningY === null ? null : readInteger(miningY, 'the mining target y', TILE_MIN, TILE_MAX),
    miningTicks: readInteger(player['miningTicks'], 'miningTicks', 0, Number.MAX_SAFE_INTEGER),
    pickingUp: readBoolean(player['pickingUp'], 'pickingUp'),
    inventory: readItemGrid(player['inventory'], "the player's inventory", numbering, PLAYER_INVENTORY_SLOTS),
    crafts: readCrafts(player['crafts']),
  };
}

function readCrafts(value: unknown): SerializedPlayerState['crafts'] {
  const orders = readArray(value, 'the craft queue', MAX_CRAFT_ORDERS);
  const { recipes } = contentOf();
  return mapArray(orders, (entry) => {
    const order = readObject(entry, 'a craft order');
    const recipe = readString(order['recipe'], "a craft order's recipe", MAX_STRING_LENGTH);
    if (!recipes.has(recipe)) fail(`the craft queue makes "${recipe}", which this build has no recipe for.`);
    return {
      recipe,
      remaining: readInteger(order['remaining'], 'a craft order count', 1, MAX_CRAFT_BATCH),
      progressTicks: readInteger(order['progressTicks'], 'a craft order progress', 0, Number.MAX_SAFE_INTEGER),
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Research
 * -------------------------------------------------------------------------- */

function readResearch(value: unknown): SerializedResearchState {
  const research = readObject(value, 'the research state');
  const { technologies } = contentOf();

  const name = (entry: unknown, where: string): string => {
    const id = readString(entry, where, MAX_STRING_LENGTH);
    if (!technologies.has(id)) fail(`${where} names technology "${id}", which this build does not have.`);
    return id;
  };

  const unlocked = mapArray(readArray(research['unlocked'], 'the completed technologies', technologies.size), (entry) =>
    name(entry, 'the completed technologies'),
  );
  if (new Set(unlocked).size !== unlocked.length) fail('a technology is completed twice.');

  const progress = mapArray(readArray(research['progress'], 'the research progress table', technologies.size), (entry) => {
    const pair = readArray(entry, 'a research progress entry', 2);
    if (pair.length !== 2) fail(`a research progress entry has ${pair.length} fields, not 2.`);
    return [name(pair[0], 'the research progress table'), readInteger(pair[1], 'a research progress count', 1, MAX_COUNT)] as const;
  });
  if (new Set(progress.map((entry) => entry[0])).size !== progress.length) {
    fail('a technology appears twice in the progress table.');
  }

  const queue = mapArray(readArray(research['queue'], 'the research queue', MAX_RESEARCH_QUEUE), (entry) =>
    name(entry, 'the research queue'),
  );
  if (new Set(queue).size !== queue.length) fail('a technology is queued twice.');

  return { unlocked, progress, queue };
}

/* -------------------------------------------------------------------------- *
 * Entities
 * -------------------------------------------------------------------------- */

function readEntities(value: unknown, nextEntityId: number, numbering: ItemNumbering): readonly SerializedEntity[] {
  const raw = readArray(value, 'the entity list', MAX_ENTITIES);
  const { buildings, entityTypes } = contentOf();
  const out: SerializedEntity[] = [];

  /** Tile -> the entity standing on it. Task 3's "no duplicate occupancy". */
  const occupied = new Map<number, number>();
  let previousId = FIRST_ENTITY_ID - 1;

  for (const entry of raw) {
    const source = readObject(entry, 'an entity');

    const id = readInteger(source['id'], 'an entity id', FIRST_ENTITY_ID, Number.MAX_SAFE_INTEGER);
    if (id >= nextEntityId) {
      fail(`entity #${id} is at or above the saved next id ${nextEntityId}; ids would be handed out twice.`);
    }
    if (id <= previousId) {
      fail(`entity #${id} follows #${previousId}; entity ids must ascend and never repeat.`);
    }
    previousId = id;

    const type = readInteger(source['type'], `the type of entity #${id}`, 0, Number.MAX_SAFE_INTEGER);
    if (!isEntityType(type) || !entityTypes.has(type)) {
      fail(`entity #${id} is of type ${type}, which this build has no building for.`);
    }

    const x = readInteger(source['x'], `the x of entity #${id}`, TILE_MIN, TILE_MAX);
    const y = readInteger(source['y'], `the y of entity #${id}`, TILE_MIN, TILE_MAX);
    const rotation = readInteger(source['rotation'], `the rotation of entity #${id}`, 0, 3);
    if (!isRotation(rotation)) fail(`entity #${id} has rotation ${rotation}, which is not a quarter-turn.`);

    // The far corner has to be inside the world too: a 3×2 assembler one tile
    // short of the edge would index a tile `tileKey` cannot pack, which is a
    // throw in the middle of a load rather than at the door.
    const footprint = buildings.footprintOf(type);
    const extent = footprintExtent(footprint, rotation);
    if (x + extent.width - 1 > TILE_MAX || y + extent.height - 1 > TILE_MAX) {
      fail(`entity #${id} at (${x}, ${y}) reaches past the edge of the world.`);
    }
    forEachFootprintTile(x, y, footprint, rotation, (tileX, tileY) => {
      const key = tileKey(tileX, tileY);
      const occupant = occupied.get(key);
      if (occupant !== undefined) {
        fail(`entity #${id} stands on (${tileX}, ${tileY}), which entity #${occupant} already occupies.`);
      }
      occupied.set(key, id);
    });

    out.push(readEntityFields(source, id, type, x, y, rotation, numbering));
  }
  return out;
}

/**
 * One entity's own fields, rebuilt.
 *
 * The five named fields are validated above; everything else is whatever the
 * building's chunk gave that entity, which is why this cannot be a table of
 * shapes per type. It is two passes instead: a structural one that rejects
 * anything a save may not contain at all, and a content one that asks the
 * **building registry** what this type is — the same question the systems ask
 * (§19 rule 17), so a building added by a later chunk is validated without
 * this file learning its name.
 */
function readEntityFields(
  source: Readonly<Record<string, unknown>>,
  id: number,
  type: EntityType,
  x: number,
  y: number,
  rotation: number,
  numbering: ItemNumbering,
): SerializedEntity {
  const { buildings } = contentOf();
  const capacity = capacityFor(type);

  const fields: Record<string, SaveValue> = {};
  for (const key of Object.keys(source)) {
    if (key === 'id' || key === 'type' || key === 'x' || key === 'y' || key === 'rotation') continue;
    const where = `field "${key}" of entity #${id}`;
    const value = source[key];

    if (ITEM_ID_FIELDS.has(key)) {
      fields[key] = readItemIdField(value, where, numbering);
      continue;
    }
    // A storage building's inventory is a grid since v4 (2026-09-23): the
    // only array such a building holds is its contents.
    if (capacity !== null && capacity.kind === 'slots' && Array.isArray(value)) {
      fields[key] = readItemGrid(value, where, numbering, capacity.slots) as unknown as SaveValue;
      continue;
    }
    if (isItemSlots(value)) {
      fields[key] = readItemSlots(value, where, numbering, capacity) as SaveValue;
      continue;
    }
    fields[key] = readPlain(value, where, numbering, 0);
  }

  // The one field a save writes differently from the entity that holds it
  // (§14): a machine names its recipe, and only a machine has one.
  if (buildings.productionFor(type) !== null) {
    const recipe = fields['recipe'];
    if (recipe !== null && typeof recipe !== 'string') {
      fail(`entity #${id} is a machine whose recipe is ${describe(recipe)}, not a name or null.`);
    }
    if (typeof recipe === 'string' && !contentOf().recipes.has(recipe)) {
      fail(`entity #${id} is set to make "${recipe}", which this build has no recipe for.`);
    }
  }

  return { ...fields, id, type, x, y, rotation } as SerializedEntity;
}

/**
 * What limit this kind of building's containers have, asked of content.
 *
 * Nothing here branches on an entity type number: a chest has slots because
 * `data/buildings.ts` gave it `storage`, and a furnace has a per-item ceiling
 * because it was given `production`. A belt lane answers `null` — its items
 * are positions rather than a container, and §9's spacing is what limits them.
 */
function capacityFor(type: EntityType): Capacity {
  const { buildings } = contentOf();

  const storage = buildings.storageFor(type);
  if (storage !== null) return { kind: 'slots', slots: storage.slots };

  const production = buildings.productionFor(type);
  if (production !== null) {
    return {
      kind: 'buffer',
      perItem: Math.max(production.inputCapacity, production.outputCapacity, production.fuelCapacity ?? 0),
    };
  }

  const research = buildings.researchFor(type);
  if (research !== null) return { kind: 'buffer', perItem: research.inputCapacity };

  const generator = buildings.generatorFor(type);
  if (generator !== null) return { kind: 'buffer', perItem: generator.fuelCapacity };

  return null;
}

/**
 * Does this value have the shape of an inventory — `[itemId, count]` pairs?
 *
 * Shape rather than a table of field names per entity type, for §19 rule 17's
 * reason: a building added by a later chunk brings its own fields, and a
 * validator that only checked the ones listed here would quietly stop
 * checking the newest half of the game. Inside an entity the pair-array shape
 * is only ever an inventory.
 *
 * The length is checked **before** the contents: `every` walks a sparse
 * 10⁹-length array index by index, which is a denial of service by way of a
 * type check. Anything that long is refused by `readPlain`'s cap a moment
 * later whatever it turns out to be.
 */
function isItemSlots(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_LENGTH) return false;
  return value.every(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number' && typeof entry[1] === 'number',
  );
}

/**
 * Any other field an entity carries, rebuilt leaf by leaf.
 *
 * This is the check that makes task 6 ("a malformed save must never be able to
 * crash the game or produce `NaN` state") true for fields no chunk has written
 * yet: a number is finite, a string is short, an array is bounded, an object is
 * not deep, and `undefined` — which `JSON.parse` cannot produce but a
 * hand-built object can — is not a value a save may contain.
 */
function readPlain(value: unknown, where: string, numbering: ItemNumbering, depth: number): SaveValue {
  if (depth > MAX_DEPTH) fail(`${where} nests more than ${MAX_DEPTH} deep.`);
  if (value === null) return null;

  switch (typeof value) {
    case 'undefined':
      // A hole in an array, or a key somebody set to `undefined`. Neither
      // survives `JSON.stringify`, so neither may enter the game (C05).
      fail(`${where} is undefined, which a save may not contain.`);
      break;
    case 'boolean':
      return value;
    case 'string':
      return readString(value, where, MAX_STRING_LENGTH);
    case 'number':
      return readNumber(value, where);
    case 'object':
      break;
    default:
      fail(`${where} is ${describe(value)}, which a save may not contain.`);
  }

  if (Array.isArray(value)) {
    return mapArray(readArray(value, where, MAX_ARRAY_LENGTH), (entry) =>
      readPlain(entry, `an entry of ${where}`, numbering, depth + 1),
    );
  }

  const source = readObject(value, where);
  const out: Record<string, SaveValue> = {};
  for (const key of Object.keys(source)) {
    const field = `${where}.${key}`;
    const entry = source[key];
    if (ITEM_ID_FIELDS.has(key)) {
      out[key] = readItemIdField(entry, field, numbering);
      continue;
    }
    out[key] = readPlain(entry, field, numbering, depth + 1);
  }
  return out;
}

/** A number as a save may hold one: finite, and never `-0` (§6, `coordinates.ts`). */
function readNumber(value: number, where: string): number {
  if (!Number.isFinite(value)) fail(`${where} is ${String(value)}, which is not a number a save may hold.`);
  if (Object.is(value, -0)) fail(`${where} is -0, which does not survive a save round trip.`);
  if (!Number.isSafeInteger(value)) fail(`${where} is ${value}, which is not a whole number in range.`);
  return value;
}

/**
 * A field that names an item outright — a belt slot, an inserter's hand.
 *
 * `NO_ITEM` is allowed and is the reason this is not `readItemSlots`: an empty
 * hand is zero, and zero is not an item id anything could look up.
 */
function readItemIdField(value: unknown, where: string, numbering: ItemNumbering): number {
  const itemId = readInteger(value, where, 0, MAX_STACK_SIZE);
  if (itemId !== 0 && !numbering.usable.has(itemId)) {
    fail(`${where} is item ${itemId}, which this build has no item for.`);
  }
  return itemId;
}

/* -------------------------------------------------------------------------- *
 * World deltas and exploration
 * -------------------------------------------------------------------------- */

function readChunkDeltas(value: unknown): readonly SerializedChunkDelta[] {
  const raw = readArray(value, 'the world deltas', MAX_CHUNK_DELTAS);
  const out: SerializedChunkDelta[] = [];
  const seen = new Set<number>();

  for (const entry of raw) {
    const delta = readObject(entry, 'a world delta');
    const cx = readInteger(delta['cx'], 'a world delta cx', CHUNK_MIN, CHUNK_MAX);
    const cy = readInteger(delta['cy'], 'a world delta cy', CHUNK_MIN, CHUNK_MAX);
    const key = chunkKey(cx, cy);
    if (seen.has(key)) fail(`the world deltas carry world chunk (${cx}, ${cy}) twice.`);
    seen.add(key);

    const where = `world chunk (${cx}, ${cy})`;
    out.push({
      cx,
      cy,
      terrain: readTileDelta(delta['terrain'], `the terrain of ${where}`, (tile, at) => {
        if (!isTileType(tile)) fail(`${at} is ${tile}, which is not a terrain type.`);
      }),
      resource: readTileDelta(delta['resource'], `the resources of ${where}`, (resource, at) => {
        if (!isResourceType(resource)) fail(`${at} is ${resource}, which is not a resource type.`);
      }),
      // Remaining units. `World.setResource` stores them in a `Uint16Array`,
      // so anything above 65,535 would be silently truncated into a patch
      // holding a different amount than the file said.
      amount: readTileDelta(delta['amount'], `the amounts of ${where}`, (amount, at) => {
        if (amount < 0 || amount > 0xffff) fail(`${at} is ${amount}, which is not a remaining amount.`);
      }),
    });
  }
  return out;
}

function readTileDelta(value: unknown, where: string, checkValue: (value: number, at: string) => void): SerializedTileDelta {
  const delta = readObject(value, where);
  const at = readArray(delta['at'], `the indexes of ${where}`, CHUNK_AREA);
  const to = readArray(delta['to'], `the values of ${where}`, CHUNK_AREA);
  if (at.length !== to.length) {
    fail(`${where} has ${at.length} indexes and ${to.length} values.`);
  }

  const indexes: number[] = [];
  const values: number[] = [];
  let previous = -1;
  for (let i = 0; i < at.length; i++) {
    const index = readInteger(at[i], `an index of ${where}`, 0, CHUNK_AREA - 1);
    if (index <= previous) fail(`${where} lists tile ${index} after ${previous}; indexes must ascend.`);
    previous = index;
    const entry = readInteger(to[i], `a value of ${where}`, 0, 0xffff);
    checkValue(entry, `the value at tile ${index} of ${where}`);
    indexes.push(index);
    values.push(entry);
  }
  return { at: indexes, to: values };
}

function readExplored(value: unknown): readonly number[] {
  const raw = readArray(value, 'the explored world chunks', MAX_EXPLORED_CHUNKS);
  const out: number[] = [];
  let previous = -1;
  for (const entry of raw) {
    const key = readInteger(entry, 'an explored world chunk', 0, Number.MAX_SAFE_INTEGER);
    if (unpackChunkKey(key) === null) fail(`${key} is not a world-chunk key.`);
    if (key <= previous) fail(`the explored world chunks list ${key} after ${previous}; keys must ascend.`);
    previous = key;
    out.push(key);
  }
  return out;
}
