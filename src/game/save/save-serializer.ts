/**
 * A world into plain data, and plain data back into a world.
 * See ironflow.md C24 tasks 2–6 and §14.
 *
 * Two pure functions. `serialize` reads a `Simulation` and writes a
 * `SerializedGameState`; `deserialize` reads one and builds a `Simulation`.
 * Neither touches storage, files or the DOM — C25 puts the result in
 * IndexedDB, C26 writes it to a file — and both run headlessly, which is what
 * lets the §6 R8 round-trip be an ordinary test rather than a browser session.
 *
 * ## What is written, and what is regenerated
 *
 * §14's rule, in one picture:
 *
 * ```text
 * written      seed, generator version, RNG position, tick, next entity id
 *              every entity, verbatim
 *              the player and the research state
 *              the explored world-chunk set
 *              per dirty world chunk: the tiles that differ from what the
 *                generator would have produced
 *
 * regenerated  every clean world chunk, from the seed
 *              the occupancy index, the power networks, the belt order,
 *                the unlock tables  (Simulation.rebuildDerived)
 * ```
 *
 * A clean world chunk is *by construction* identical to generator output —
 * `dirty` is set by the only three methods that can change a tile — so which
 * clean world chunks happen to be resident in memory is a caching artifact and
 * not state. That is why a loaded world has fewer world chunks in it than the
 * one it was saved from and is nonetheless the same world.
 *
 * ## Byte-stability
 *
 * C24 task 6: two equivalent states must serialize identically, because the §6
 * R8 hash compares them. Everything written here is in a fixed order that
 * comes from the data rather than from a container's insertion order (§6 R4) —
 * entities ascending by id, world chunks ascending by packed key, tile deltas
 * ascending by local index, explored keys ascending, inventories ascending by
 * item id, the item mapping sorted by string id. The two exceptions are the
 * craft queue and the research queue, whose order *is* the state.
 */

import { ITEMS } from '../data/items.js';
import { isEntityType } from '../entities/entity-types.js';
import type { Entity } from '../entities/entity.js';
import type { MachineEntity } from '../entities/machine-entity.js';
import type { CraftOrder, SerializedPlayer } from '../player/player-state.js';
import { ItemRegistry, type ItemIdMapping } from '../registries/item-registry.js';
import { NO_RECIPE, type RecipeId, type RecipeRegistry } from '../registries/recipe-registry.js';
import type { SerializedResearch } from '../research/research-state.js';
import type { TechnologyId, TechnologyRegistry } from '../registries/technology-registry.js';
import { Simulation } from '../simulation.js';
import { CHUNK_AREA, CHUNK_SIZE, type WorldChunk } from '../world/chunk.js';
import { isResourceType, type ResourceType } from '../world/resource.js';
import { isTileType, type TileType } from '../world/tile.js';
import { GENERATOR_VERSION, createWorldGenerator } from '../world/world-generator.js';
import { World, type ChunkGenerator } from '../world/world.js';

import type {
  SaveValue,
  SerializedChunkDelta,
  SerializedCraftOrder,
  SerializedEntity,
  SerializedGameState,
  SerializedPlayerState,
  SerializedResearchState,
  SerializedTileDelta,
} from './save-format.js';

/* -------------------------------------------------------------------------- *
 * Serialize
 * -------------------------------------------------------------------------- */

/**
 * A snapshot of everything §10 calls authoritative. C24 task 2.
 *
 * Refuses to run inside a tick (task 5, §14): a snapshot of a half-advanced
 * tick has belts that have moved and inserters that have not, and it would
 * load into a world no sequence of ticks could have produced.
 */
export function serialize(simulation: Simulation): SerializedGameState {
  if (simulation.isTicking) {
    throw new Error('serialize: a save is taken between ticks, never inside one (§14).');
  }

  return {
    generatorVersion: GENERATOR_VERSION,
    seed: simulation.seed,
    rngPosition: simulation.rng.state,
    tick: simulation.getTick(),
    nextEntityId: simulation.entities.nextId,
    itemIdMap: simulation.items.idMapping(),
    player: serializePlayer(simulation.player.toJSON(), simulation.recipes),
    entities: serializeEntities(simulation),
    chunkDeltas: serializeChunkDeltas(simulation.world),
    exploredChunks: simulation.world.explored.keysAscending(),
    research: serializeResearch(simulation.research.toJSON(), simulation.technologies),
  };
}

/**
 * Every entity, ascending by id, each one a shallow copy of its own fields.
 *
 * A **deep** copy, not the live object and not a spread of it. C25 writes a
 * save asynchronously while the factory keeps running, and a belt's `items`, a
 * machine's three buffers and a chest's `contents` are arrays: a shallow copy
 * would hand the writer the same arrays the simulation is still pushing items
 * onto, and the file would land somewhere between two ticks. Copying is cheap
 * because C05 made an entity a shallow tree of plain data — which is the whole
 * reason that rule exists.
 *
 * `recipe` is the single field not carried across unchanged; see
 * `save-format.ts` for why recipes are named rather than numbered.
 */
function serializeEntities(simulation: Simulation): readonly SerializedEntity[] {
  const out: SerializedEntity[] = [];
  // `forEach` walks the store's dense, id-ordered array (§6 R4, C24 task 6).
  simulation.entities.forEach((entity) => {
    // Asked of the building registry rather than of the field, so that a
    // future entity with a `recipe` field meaning something else is not
    // silently rewritten: this is "does this type run recipes?", which is
    // exactly the question `MachineEntity` answers yes to.
    if (simulation.buildings.productionFor(entity.type) === null) {
      out.push(clonePlain(entity) as unknown as SerializedEntity);
      return;
    }
    const machine = entity as MachineEntity;
    const { recipe: _recipe, ...rest } = clonePlain(machine);
    out.push({ ...rest, recipe: recipeName(simulation.recipes, machine.recipe) } as unknown as SerializedEntity);
  });
  return out;
}

/**
 * A deep copy of plain data: arrays, plain objects and primitives.
 *
 * Deliberately not `structuredClone`, which would happily clone the `Map`, the
 * `Date` and the class instance that `entities/entity.ts` spends a whole
 * function refusing — and would therefore carry one into a save, where
 * `JSON.stringify` turns it into something else. This handles exactly the
 * shapes an entity is allowed to be, so anything else is a bug caught by
 * `assertSerializable` on the way in rather than a value quietly cloned here.
 */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => clonePlain(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = clonePlain(source[key]);
    return out as T;
  }
  return value;
}

/** A recipe's string id, or null for `NO_RECIPE`. */
function recipeName(recipes: RecipeRegistry, recipe: RecipeId): string | null {
  return recipe === NO_RECIPE ? null : recipes.byId(recipe).id;
}

function serializePlayer(player: SerializedPlayer, recipes: RecipeRegistry): SerializedPlayerState {
  return {
    subX: player.subX,
    subY: player.subY,
    facing: player.facing,
    moveX: player.moveX,
    moveY: player.moveY,
    miningX: player.miningX,
    miningY: player.miningY,
    miningTicks: player.miningTicks,
    inventory: player.inventory,
    crafts: player.crafts.map((order) => ({
      // An order always names a real recipe — `CraftingSystem` will not queue
      // one without — so this is `byId`, not `recipeName`.
      recipe: recipes.byId(order.recipe).id,
      remaining: order.remaining,
      progressTicks: order.progressTicks,
    })),
  };
}

function serializeResearch(
  research: SerializedResearch,
  technologies: TechnologyRegistry,
): SerializedResearchState {
  const name = (id: TechnologyId): string => technologies.byId(id).id;
  return {
    // `unlocked` and `progress` arrive ascending by runtime id, which is
    // content order. Sorted again by *string* id so the bytes do not move when
    // `data/technologies.ts` is reordered — the same stability `idMapping`
    // gives the item table.
    unlocked: research.unlocked.map(name).sort(compareStrings),
    progress: research.progress
      .map((entry) => [name(entry[0]), entry[1]] as readonly [string, number])
      .sort((a, b) => compareStrings(a[0], b[0])),
    // The queue is head-first and is never sorted: its order is the decision.
    queue: research.queue.map(name),
  };
}

/** Locale-independent string order (§6 R1 bans `Intl` and locale collation). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- *
 * World deltas
 * -------------------------------------------------------------------------- */

/**
 * Every dirty world chunk's divergence from generator output. C24 task 3.
 *
 * `forEachLoadedChunk` visits ascending by packed key and generates nothing,
 * which matters twice over: a save that generated world chunks while writing
 * would change what the *next* save contains, and the order has to come from
 * the coordinates rather than from the `Map` (§6 R4).
 */
function serializeChunkDeltas(world: World): readonly SerializedChunkDelta[] {
  const deltas: SerializedChunkDelta[] = [];
  world.forEachLoadedChunk((chunk) => {
    if (!chunk.dirty) return;
    const pristine = world.pristineChunk(chunk.cx, chunk.cy);
    deltas.push({
      cx: chunk.cx,
      cy: chunk.cy,
      terrain: diff(chunk.terrain, pristine.terrain),
      resource: diff(chunk.resource, pristine.resource),
      amount: diff(chunk.resourceAmount, pristine.resourceAmount),
    });
  });
  return deltas;
}

/** The entries of `live` that differ from `pristine`, ascending by index. */
function diff(live: Uint8Array | Uint16Array, pristine: Uint8Array | Uint16Array): SerializedTileDelta {
  const at: number[] = [];
  const to: number[] = [];
  for (let index = 0; index < CHUNK_AREA; index++) {
    const value = live[index];
    if (value === undefined || value === pristine[index]) continue;
    at.push(index);
    to.push(value);
  }
  return { at, to };
}

/* -------------------------------------------------------------------------- *
 * Deserialize
 * -------------------------------------------------------------------------- */

/** What a load may be told that the save itself does not say. */
export interface DeserializeOptions {
  /**
   * How to build the generator for a seed. Defaults to `createWorldGenerator`
   * — the one this build ships — and overriding it is the *only* way a save
   * gets terrain from anywhere else.
   *
   * Two callers need that. C27 pins the old generator for a save written by an
   * earlier one, which is the choice §14 says a migration has to make rather
   * than have made for it. And a test builds worlds from a fixed pattern
   * instead of from noise, so that what it is asserting about a save is not
   * also an assertion about C19's octaves.
   *
   * Passing it **skips the generator-version check**, because the version
   * describes `world-generator.ts` and a caller supplying its own generator
   * has already answered the question that check asks.
   */
  readonly worldGenerator?: (seed: number) => ChunkGenerator;
}

/**
 * A running world from a snapshot. C24 task 2.
 *
 * A fresh `Simulation`, not a mutated one: the state restored here reaches
 * eight objects, and a half-applied load is a factory with two of everything.
 * Building the world from scratch makes failure total, which is the only
 * failure mode a save loader can honestly offer.
 *
 * Throws on a save from a different generator. C27 owns the answer to that —
 * pin the old generator, or migrate — and guessing here would hand the player
 * their factory standing on somebody else's terrain.
 */
export function deserialize(state: SerializedGameState, options: DeserializeOptions = {}): Simulation {
  const makeGenerator = options.worldGenerator ?? createWorldGenerator;
  if (options.worldGenerator === undefined && state.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(
      `deserialize: this save was written by world generator ${state.generatorVersion}; ` +
        `this build has ${GENERATOR_VERSION}. Migration is C27's.`,
    );
  }

  // The registry is rebuilt around the save's own numbers, so an item added to
  // `data/items.ts` since the save was written appends above them instead of
  // renumbering the ore already sitting on belts (see `item-registry.ts`).
  const items = new ItemRegistry(ITEMS, { assignedIds: asItemIdMap(state.itemIdMap) });

  const world = new World(makeGenerator(state.seed));
  for (const delta of state.chunkDeltas) applyChunkDelta(world, delta);
  world.explored.restore(state.exploredChunks);

  const simulation = new Simulation({
    world,
    items,
    seed: state.seed,
    tick: state.tick,
    rngState: state.rngPosition,
    nextEntityId: state.nextEntityId,
  });

  simulation.entities.restore(state.entities.map((entity) => deserializeEntity(entity, simulation)));
  simulation.player.load(deserializePlayer(state.player, simulation.recipes));
  simulation.research.load(deserializeResearch(state.research, simulation.technologies));

  // §10: the left column is back, so the right column is recomputed. Nothing
  // above this line may depend on a derived index.
  simulation.rebuildDerived();
  return simulation;
}

/** The saved mapping, refused rather than coerced if it is not one. */
function asItemIdMap(mapping: ItemIdMapping): ItemIdMapping {
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new TypeError('deserialize: itemIdMap must be a string -> number table (§14).');
  }
  // The per-entry checks — integral, unique, above zero — are the registry's,
  // which already has to make them for content it builds itself.
  return mapping;
}

/**
 * One entity, with `recipe` turned back into a runtime id.
 *
 * The inverse of `serializeEntities`, and it asks the same question of the
 * building registry rather than of the field, so the two cannot drift apart.
 */
function deserializeEntity(entity: SerializedEntity, simulation: Simulation): Entity {
  const type = entity.type;
  if (!isEntityType(type)) {
    throw new RangeError(`deserialize: entity #${entity.id} has type ${type}, which is not an EntityType.`);
  }
  if (simulation.buildings.productionFor(type) === null) {
    return clonePlain(entity) as unknown as Entity;
  }

  const { recipe, ...rest } = clonePlain(entity) as { recipe?: SaveValue } & Record<string, SaveValue>;
  if (recipe !== null && typeof recipe !== 'string') {
    throw new TypeError(`deserialize: entity #${entity.id} has recipe ${JSON.stringify(recipe)}, which is not a name.`);
  }
  return {
    ...rest,
    recipe: recipe === null ? NO_RECIPE : simulation.recipes.get(recipe).recipeId,
  } as unknown as Entity;
}

function deserializePlayer(player: SerializedPlayerState, recipes: RecipeRegistry): SerializedPlayer {
  return {
    subX: player.subX,
    subY: player.subY,
    // `PlayerState.load` checks this is a real `Rotation`; the cast is what
    // gets it past the type system, not what makes it true.
    facing: player.facing as SerializedPlayer['facing'],
    moveX: player.moveX,
    moveY: player.moveY,
    miningX: player.miningX,
    miningY: player.miningY,
    miningTicks: player.miningTicks,
    inventory: player.inventory,
    crafts: player.crafts.map((order: SerializedCraftOrder): CraftOrder => {
      if (!recipes.has(order.recipe)) {
        throw new Error(`deserialize: the craft queue names recipe "${order.recipe}", which this build does not have.`);
      }
      return {
        recipe: recipes.get(order.recipe).recipeId,
        remaining: order.remaining,
        progressTicks: order.progressTicks,
      };
    }),
  };
}

function deserializeResearch(
  research: SerializedResearchState,
  technologies: TechnologyRegistry,
): SerializedResearch {
  const id = (name: string, where: string): TechnologyId => {
    if (!technologies.has(name)) {
      throw new Error(`deserialize: ${where} names technology "${name}", which this build does not have.`);
    }
    return technologies.get(name).technologyId;
  };
  return {
    unlocked: research.unlocked.map((name) => id(name, 'the completed set')),
    progress: research.progress.map(
      (entry) => [id(entry[0], 'the progress table'), entry[1]] as readonly [TechnologyId, number],
    ),
    queue: research.queue.map((name) => id(name, 'the research queue')),
  };
}

/* -------------------------------------------------------------------------- *
 * Applying a world delta
 * -------------------------------------------------------------------------- */

/**
 * Put one world chunk's saved divergences back.
 *
 * Written through `World`'s ordinary accessors rather than into the arrays, so
 * that the same range checks a running game gets apply to a loaded one and so
 * that `dirty` and `revision` move together (`world.ts` keeps them in one
 * place for exactly this reason). `markDirty` then runs unconditionally: a
 * dirty world chunk whose tiles happen to match the generator again is still
 * one the *next* save has to carry.
 */
function applyChunkDelta(world: World, delta: SerializedChunkDelta): void {
  const { cx, cy } = delta;
  // Generates the pristine world chunk, which is what the deltas are against.
  const chunk = world.getChunk(cx, cy);

  forEachChange(delta.terrain, `terrain of world chunk (${cx}, ${cy})`, (index, value) => {
    if (!isTileType(value)) {
      throw new RangeError(`deserialize: ${value} is not a TileType, at index ${index} of (${cx}, ${cy}).`);
    }
    const tile = tileOf(cx, cy, index);
    world.setTile(tile.x, tile.y, value as TileType);
  });

  forEachResourceChange(delta, chunk, (index, type, units) => {
    const tile = tileOf(cx, cy, index);
    world.setResource(tile.x, tile.y, type, units);
  });

  world.markDirty(cx, cy);
}

/** The world-space tile a local index names, in the world chunk at `(cx, cy)`. */
function tileOf(cx: number, cy: number, index: number): { readonly x: number; readonly y: number } {
  return { x: cx * CHUNK_SIZE + (index % CHUNK_SIZE), y: cy * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE) };
}

/** Walk one delta's pairs, checking the shape the file claims to have. */
function forEachChange(
  delta: SerializedTileDelta,
  where: string,
  visit: (index: number, value: number) => void,
): void {
  const { at, to } = delta;
  if (!Array.isArray(at) || !Array.isArray(to)) {
    throw new TypeError(`deserialize: the ${where} delta is not a pair of arrays.`);
  }
  if (at.length !== to.length) {
    throw new Error(`deserialize: the ${where} delta has ${at.length} indexes and ${to.length} values.`);
  }
  let previous = -1;
  for (let i = 0; i < at.length; i++) {
    const index = at[i];
    const value = to[i];
    if (index === undefined || value === undefined) continue;
    if (!Number.isInteger(index) || index < 0 || index >= CHUNK_AREA) {
      throw new RangeError(`deserialize: the ${where} delta names tile ${index}, which is not one of 0..${CHUNK_AREA - 1}.`);
    }
    if (index <= previous) {
      throw new RangeError(`deserialize: the ${where} delta lists tile ${index} after ${previous}; indexes must ascend.`);
    }
    previous = index;
    visit(index, value);
  }
}

/**
 * Walk the union of the resource-type and remaining-amount deltas, in index
 * order, with both final values for each tile.
 *
 * The two are stored apart because mining changes only the amount, and a patch
 * mined for an hour would otherwise repeat its unchanged resource type
 * thousands of times. They have to be *applied* together, because
 * `World.setResource` writes both — so a tile named by only one of them takes
 * its other value from the world chunk the generator has just produced.
 *
 * The world chunk is read before anything is written to it, and each index is
 * visited once, so a pristine value is never read back after being overwritten.
 */
function forEachResourceChange(
  delta: SerializedChunkDelta,
  pristine: WorldChunk,
  visit: (index: number, type: ResourceType, units: number) => void,
): void {
  const where = `world chunk (${delta.cx}, ${delta.cy})`;
  const types = new Map<number, number>();
  forEachChange(delta.resource, `resource of ${where}`, (index, value) => {
    if (!isResourceType(value)) {
      throw new RangeError(`deserialize: ${value} is not a ResourceType, at index ${index} of ${where}.`);
    }
    types.set(index, value);
  });

  const units = new Map<number, number>();
  forEachChange(delta.amount, `amount of ${where}`, (index, value) => {
    units.set(index, value);
  });

  // The union, walked by *index* rather than by either map's iteration order
  // (§6 R4): the two index lists are already ascending, so merging them is a
  // two-pointer walk and the order is the coordinates', not a container's.
  const a = delta.resource.at;
  const b = delta.amount.at;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    const index = left === undefined ? right : right === undefined ? left : Math.min(left, right);
    if (index === undefined) break;
    if (left === index) i += 1;
    if (right === index) j += 1;

    const type = types.get(index) ?? pristine.resource[index] ?? 0;
    const remaining = units.get(index) ?? pristine.resourceAmount[index] ?? 0;
    visit(index, type as ResourceType, remaining);
  }
}
