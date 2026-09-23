/**
 * What a save file *is*. See ironflow.md §14 and C24 task 1.
 *
 * Types and two constants. There is no logic in this file on purpose: it is
 * the document `save-serializer.ts` writes, `save-validator.ts` (C26) checks
 * and `save-migrator.ts` (C27) rewrites, and three modules agreeing on a shape
 * only works while the shape has one definition.
 *
 * ## Everything here is plain JSON
 *
 * No class, no `Map`, no `Set`, no `undefined`, no cycle, no typed array —
 * `entities/entity.ts`'s `assertSerializable` is the machine-checkable form of
 * that sentence and C24's structural test runs it over a real save. The reason
 * is §14's: a value that `structuredClone` keeps and `JSON.stringify` alters
 * produces a save that loads into a *subtly different* world, which is the
 * most expensive bug shape this project can produce.
 *
 * ## Why string ids appear in a format built on numbers
 *
 * The simulation runs on numeric runtime ids — `ItemId`, `RecipeId`,
 * `TechnologyId`, `EntityType` — because that is what a hot loop compares.
 * Only two of the four are safe to write into a save as numbers:
 *
 * ```text
 * EntityType    a hand-written enum whose numbers are promised never to move
 *               (see entity-types.ts) -> written raw
 * ItemId        assigned in registration order, so it moves when data/items.ts
 *               is edited -> written raw, with the mapping that explains it
 * RecipeId      a dense index into content order, with no mapping and no
 *               reserved numbers -> written as the recipe's string id
 * TechnologyId  the same, and for the same reason -> written as a string
 * ```
 *
 * `ItemId` gets a mapping rather than string ids because items are the one of
 * the four that appears *thousands* of times in a save — every belt slot,
 * every buffer, every inventory row — and a table of forty strings is much
 * smaller than forty thousand copies of them. Recipes and technologies appear
 * once per machine and once per queue entry, where a translation table would
 * cost more than it saves and a save that names its recipes is a save a human
 * can read. This is the split `registries/recipe-registry.ts` describes.
 */

import type { ItemIdMapping } from '../registries/item-registry.js';

/**
 * The save schema version (§14). A plain integer, bumped on any breaking
 * change to `SerializedGameState`; C27 chains pure `vN -> vN+1` migrations
 * against it.
 *
 * It is **not** `GENERATOR_VERSION`, and the two move independently: a
 * generator change alters what unexplored ground looks like, a schema change
 * alters what the file says. A save carries both because neither answers the
 * other's question.
 */
export const SAVE_VERSION = 6;

/** The magic string that marks a file as one of ours. §14, and C26's header. */
export const SAVE_FORMAT = 'ironflow-save';

/* -------------------------------------------------------------------------- *
 * Leaves
 * -------------------------------------------------------------------------- */

/**
 * Any value a save may contain. The type-level half of "plain JSON".
 *
 * It exists so `SerializedEntity` can be honest: an entity's own fields differ
 * per type — a belt has `items`, a furnace has three buffers — and a union of
 * every subtype would have to be extended by every chunk that adds a building.
 * The index signature says what is true of all of them instead.
 */
export type SaveValue = string | number | boolean | null | readonly SaveValue[] | { readonly [key: string]: SaveValue };

/** A container's contents: `[itemId, count]`, ascending by id, no zeroes. */
export type SerializedItemSlots = readonly (readonly [number, number])[];

/**
 * The player's bag (v3): `[slot, itemId, count]` for every occupied slot,
 * ascending by slot. Positions are state since the bag became a grid.
 */
export type SerializedItemGrid = readonly (readonly [number, number, number])[];

/* -------------------------------------------------------------------------- *
 * Entities
 * -------------------------------------------------------------------------- */

/**
 * One building, as a save carries it: its own plain fields, unchanged, with
 * `recipe` translated to a string where a machine has one.
 *
 * Entities are already plain data by C05's rule, so serializing one is a copy
 * rather than a transformation — which is the point of that rule. The five
 * named fields are the ones every entity has and the ones a loader has to read
 * before it knows which subtype it is holding.
 */
export interface SerializedEntity {
  readonly id: number;
  /** An `EntityType`. Written raw; those numbers never move (§14). */
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly [field: string]: SaveValue;
}

/* -------------------------------------------------------------------------- *
 * World deltas
 * -------------------------------------------------------------------------- */

/**
 * Tiles within one world chunk that differ from generator output, as parallel
 * arrays. C24 task 3.
 *
 * Parallel rather than `{ index, value }` objects because a mined-out patch is
 * thousands of entries and an object per entry is a brace, a quote and a key
 * name per tile in the JSON — several times the bytes for the same facts.
 *
 * `at` holds local indexes into the world chunk's arrays (`localIndex`), not
 * tile coordinates, and is strictly ascending so that two equal worlds produce
 * equal bytes (§6 R4).
 */
export interface SerializedTileDelta {
  readonly at: readonly number[];
  readonly to: readonly number[];
}

/**
 * One world chunk's divergence from what the generator would produce.
 *
 * A delta is written for **every dirty world chunk**, even one whose three
 * lists are empty. `dirty` latches (see `world/chunk.ts`) and decides what the
 * *next* save writes, so it cannot be re-derived from the tiles: dropping an
 * empty delta would silently clean a world chunk that the game considers
 * modified.
 */
export interface SerializedChunkDelta {
  readonly cx: number;
  readonly cy: number;
  /** `TileType` per changed tile. */
  readonly terrain: SerializedTileDelta;
  /** `ResourceType` per changed tile. */
  readonly resource: SerializedTileDelta;
  /** Remaining units per changed tile. What mining writes. */
  readonly amount: SerializedTileDelta;
}

/* -------------------------------------------------------------------------- *
 * Player and research
 * -------------------------------------------------------------------------- */

/** One order in the hand-craft queue, with its recipe named (C21A). */
export interface SerializedCraftOrder {
  readonly recipe: string;
  readonly remaining: number;
  readonly progressTicks: number;
}

/** The player character (C10, C21A). Position is in subtiles, never tiles. */
export interface SerializedPlayerState {
  readonly subX: number;
  readonly subY: number;
  readonly facing: number;
  readonly moveX: number;
  readonly moveY: number;
  readonly miningX: number | null;
  readonly miningY: number | null;
  readonly miningTicks: number;
  /** v5: is F held? v4 and before had no pickup. */
  readonly pickingUp: boolean;
  /** v3: stacks with positions. v1 and v2 wrote item→count pairs. */
  readonly inventory: SerializedItemGrid;
  /** Head first. The order is the player's decision, so it is never sorted. */
  readonly crafts: readonly SerializedCraftOrder[];
}

/** The tech tree's authoritative half (C22). Technologies named, not numbered. */
export interface SerializedResearchState {
  /** Completed technologies, ascending by string id. */
  readonly unlocked: readonly string[];
  /** Part-finished technologies as `[id, units]`, ascending, never zero. */
  readonly progress: readonly (readonly [string, number])[];
  /** The queue, head first. Order is the decision, so it is written as it is. */
  readonly queue: readonly string[];
}

/* -------------------------------------------------------------------------- *
 * The state
 * -------------------------------------------------------------------------- */

/**
 * Everything §10 puts in the authoritative column, and nothing else.
 *
 * Read it beside §10's table: if a field here has no row there, one of the two
 * is wrong. The derived indexes — occupancy, power networks, belt order,
 * unlock tables, production rates — are deliberately absent and are rebuilt by
 * `Simulation.rebuildDerived()` after a load.
 */
export interface SerializedGameState {
  /** Which generator drew the unexplored world (C19). C27 migrates against it. */
  readonly generatorVersion: number;
  /** The seed that was accepted, not the one the player typed (§14, C19). */
  readonly seed: number;
  /** The simulation RNG's stream position — `Rng.state` (§6 R2). */
  readonly rngPosition: number;
  readonly tick: number;
  /** The next id the entity store will hand out (§6 R5). */
  readonly nextEntityId: number;
  /** The string→number item mapping this save was written with (§14). */
  readonly itemIdMap: ItemIdMapping;
  readonly player: SerializedPlayerState;
  /** Ascending by id, so two equal worlds serialize identically (C24 task 6). */
  readonly entities: readonly SerializedEntity[];
  /** One per dirty world chunk, ascending by packed `chunkKey`. */
  readonly chunkDeltas: readonly SerializedChunkDelta[];
  /** Packed `chunkKey`s the player has revealed, ascending (C23). */
  readonly exploredChunks: readonly number[];
  readonly research: SerializedResearchState;
}

/* -------------------------------------------------------------------------- *
 * The file
 * -------------------------------------------------------------------------- */

/**
 * What a slot in the save list knows without reading the state (§14, C25).
 *
 * Listing fifty saves must not deserialize fifty factories, which is why this
 * is a separate object beside the state rather than fields inside it.
 */
export interface SaveMetadata {
  readonly name: string;
  /** Wall-clock milliseconds. The one place a save is allowed a real clock. */
  readonly createdAt: number;
  readonly playtimeTicks: number;
  /** A data URL, or null. C25 decides whether it ever fills this in. */
  readonly thumbnail: string | null;
  /**
   * The player's hotbar, slot by slot: an item id or `null` for an empty
   * slot. `null` as a whole means the default layout (v2, 2026-09-23). It
   * held only buildings until later that day; a building's id is its item's
   * id (§15), so those layouts read the same and the schema did not move.
   *
   * In the metadata rather than the state because it is not simulation state:
   * no system reads it and it changes while the game is paused, which a
   * command could not do (§7). It travels with the save because the player
   * arranged it for this factory.
   */
  readonly hotbar: readonly (string | null)[] | null;
  /**
   * The quest steps met in this world, in the order they were met, or `null`
   * for none (v6, C31). Metadata for the hotbar's reason: no system reads it,
   * and it belongs to this factory rather than to the browser. The ids are
   * `ui/objectives.ts`'s; an id the chain no longer has is ignored there.
   */
  readonly quests: readonly string[] | null;
}

/**
 * A save file, as §14 writes it down.
 *
 * C24 produces and consumes the `state`; C25 puts this object in IndexedDB and
 * C26 writes it to disk. The wrapper is defined here rather than there because
 * `version` is a property of the *format*, and a format whose version lived in
 * the storage layer would be a format that could not be migrated without one.
 */
export interface SaveFile {
  readonly format: typeof SAVE_FORMAT;
  readonly version: number;
  readonly metadata: SaveMetadata;
  readonly state: SerializedGameState;
}
