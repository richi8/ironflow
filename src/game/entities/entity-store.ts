/**
 * The entity store. See ironflow.md C05 tasks 2–5.
 *
 * Three indexes over one dense array:
 *
 * ```text
 * entities[]              id-ascending, the only thing systems iterate (§6 R4)
 * byId:      Map<EntityId, Entity>        get / has / remove
 * occupancy: Map<tileKey, EntityId>       at(x, y), O(1), every footprint tile
 * buckets[type][]         id-ascending, so a system sees only its own kind
 * ```
 *
 * The array is the authority on order and the maps are lookups. That split is
 * §6 R4 made structural: `Map` iterates in *insertion* order, which after a
 * load is the order entities were deserialized rather than the order they were
 * built, so a system that iterated one would produce a different factory after
 * a reload than before it — the quietest possible determinism break. Every
 * traversal here walks the array.
 *
 * Removal is deferred to the `cleanup` phase (§8 phase 9). `remove()` marks;
 * nothing disappears until the tick is over. A miner removed while the belt
 * system is halfway through the tick is still there for the inserter system
 * that runs after it, so what a system sees never depends on which phase
 * happened to run first.
 */

import { isRotation, tileKey } from '../world/coordinates.js';

import {
  FIRST_ENTITY_ID,
  UNIT_FOOTPRINT,
  assertFootprint,
  assertPlaceable,
  assertSerializable,
  forEachFootprintTile,
  isEntityId,
  type Entity,
  type EntityId,
  type EntityInit,
  type Footprint,
} from './entity.js';
import { ENTITY_TYPE_COUNT, entityTypeName, isEntityType, type EntityType } from './entity-types.js';

/**
 * Where the store learns how big a type's footprint is.
 *
 * Injected rather than owned, for the same reason `World` is handed a
 * `ChunkGenerator`: the size of a miner is content (§15), it belongs to C06's
 * building registry, and duplicating it here would create a second truth that
 * can disagree with the first.
 *
 * **Implementations must be pure.** The store asks once when an entity is
 * created and again when it is removed, and a lookup that answered differently
 * the second time would free the wrong tiles and leave the occupancy index
 * holding a building that no longer exists.
 */
export type FootprintLookup = (type: EntityType) => Footprint;

/** Everything is 1×1 until C06's registry says otherwise. */
const UNIT_FOOTPRINTS: FootprintLookup = () => UNIT_FOOTPRINT;

export interface EntityStoreOptions {
  readonly footprintOf?: FootprintLookup;
  /**
   * The next id to hand out. Only C24's loader passes this: ids are monotonic
   * across a save (§6 R5), so a restored world must not start counting from 1
   * again and hand a new building the id of a demolished one.
   */
  readonly nextId?: number;
}

/** Nothing was removed this tick. Shared and frozen: almost every tick. */
const NO_REMOVALS: readonly EntityId[] = Object.freeze([]);

export class EntityStore {
  /** Dense and strictly id-ascending, because creates append and ids only rise. */
  private readonly entities: Entity[] = [];

  private readonly byId = new Map<EntityId, Entity>();

  /** Packed tile -> the entity standing on it. Derived state (§10). */
  private readonly occupancy = new Map<number, EntityId>();

  /** One id-ascending array per `EntityType`, so `byType` costs nothing. */
  private readonly buckets: Entity[][] = Array.from({ length: ENTITY_TYPE_COUNT }, () => []);

  /**
   * Ids marked for removal, drained by `cleanup`.
   *
   * A `Set` is safe here because it is only ever asked `has` — it is never
   * iterated, so its insertion order never reaches a decision (§6 R4).
   */
  private readonly pending = new Set<EntityId>();

  private readonly footprintOf: FootprintLookup;

  private nextEntityId: EntityId;

  /**
   * Bumped whenever an entity is added or actually removed. C13 task 3.
   *
   * §10 calls belt network topology derived state, rebuilt rather than
   * persisted, and a derived index needs to know when the thing it indexes has
   * changed. A counter is the cheapest honest answer: `BeltSystem` keeps the
   * number it last built its downstream-first order from and rebuilds when the
   * two differ. It is **not** authoritative state — it is never serialized,
   * and a loaded world starts at zero with every index rebuilt on its first
   * tick, which is what `rebuildDerived()` means (§10).
   *
   * Anything that changes an entity's position, rotation or existence must
   * bump it. Today that is `create` and `cleanup`; a future `rotate` belongs
   * here too, which is the other reason base fields are readonly (see
   * `entity.ts`) — the only way to turn a belt will be a store method, and
   * this is the line that method has to remember.
   */
  private revision = 0;

  constructor(options: EntityStoreOptions = {}) {
    this.footprintOf = options.footprintOf ?? UNIT_FOOTPRINTS;
    this.nextEntityId = options.nextId ?? FIRST_ENTITY_ID;
    if (!isEntityId(this.nextEntityId)) {
      throw new RangeError(`EntityStore: nextId must be an integer >= ${FIRST_ENTITY_ID}, got ${options.nextId}.`);
    }
  }

  /** How many entities exist, including any marked for removal this tick. */
  get size(): number {
    return this.entities.length;
  }

  /** Marked for removal but still visible until `cleanup` runs. */
  get pendingRemovalCount(): number {
    return this.pending.size;
  }

  /**
   * The id the next `create` will use. Authoritative state (§10) — C24 writes
   * this into the save, and `EntityStoreOptions.nextId` reads it back.
   */
  get nextId(): EntityId {
    return this.nextEntityId;
  }

  /** How many times the set of entities has changed. See the field's note. */
  get structureRevision(): number {
    return this.revision;
  }

  /**
   * Add an entity and claim its tiles. Returns the stored object, not a copy.
   *
   * The type parameter is an assertion, not a check: `create<MinerEntity>` says
   * "the fields I passed are a miner's", and nothing but the caller can know
   * that. What *is* checked is everything the store depends on — a real type, a
   * real rotation, packable tiles, an unoccupied footprint, and plain
   * serializable data.
   *
   * Throws on an occupied tile rather than returning null. Placement validation
   * belongs to C06's build system, which tells the player `'occupied'` before
   * ever calling this; reaching here with a taken tile is a bug in the caller,
   * and a store that quietly declined would leave a building the player paid
   * for nowhere at all.
   */
  create<T extends Entity = Entity>(init: EntityInit<T>): T {
    const { type, x, y, rotation } = init;

    if (!isEntityType(type)) {
      throw new RangeError(`EntityStore.create: ${type} is not an EntityType.`);
    }
    if (!isRotation(rotation)) {
      throw new RangeError(`EntityStore.create: ${rotation} is not a Rotation.`);
    }
    assertSerializable(init, `${entityTypeName(type)} entity`);

    const footprint = this.lookupFootprint(type);
    // Both checks run over the whole footprint before a single tile is claimed,
    // so a rejected placement leaves the store exactly as it was.
    assertPlaceable(x, y, footprint, rotation);
    forEachFootprintTile(x, y, footprint, rotation, (tileX, tileY) => {
      const occupant = this.occupancy.get(tileKey(tileX, tileY));
      if (occupant !== undefined) {
        throw new Error(
          `EntityStore.create: tile (${tileX}, ${tileY}) is already occupied by entity #${occupant}.`,
        );
      }
    });

    if (this.nextEntityId >= Number.MAX_SAFE_INTEGER) {
      // Unreachable in any real game — 9e15 placements — but ids stop being
      // monotonic above this, and silently is not how that should be found out.
      throw new RangeError('EntityStore: entity ids exhausted.');
    }

    const id = this.nextEntityId;
    this.nextEntityId = id + 1;

    const entity = { ...init, id } as T;
    this.revision += 1;
    this.entities.push(entity);
    this.byId.set(id, entity);
    this.bucket(type).push(entity);
    forEachFootprintTile(x, y, footprint, rotation, (tileX, tileY) => {
      this.occupancy.set(tileKey(tileX, tileY), id);
    });

    return entity;
  }

  get(id: EntityId): Entity | undefined {
    return this.byId.get(id);
  }

  has(id: EntityId): boolean {
    return this.byId.has(id);
  }

  /**
   * The entity occupying a tile, whichever tile of its footprint that is.
   *
   * O(1): one packed-integer hash lookup, which is what makes it usable from
   * placement validation, belt hand-off and the hover inspector on every
   * frame.
   */
  at(x: number, y: number): Entity | undefined {
    const id = this.occupancy.get(tileKey(x, y));
    return id === undefined ? undefined : this.byId.get(id);
  }

  /**
   * Every entity, in ascending id order.
   *
   * The length is read once, so an entity created by the callback is not
   * visited by the pass that created it. That is the same promise deferred
   * removal makes at the other end: what a system sees is fixed when the pass
   * starts, and a system that reacts to something built this tick does so next
   * tick, identically on every machine.
   */
  forEach(visit: (entity: Entity) => void): void {
    const count = this.entities.length;
    for (let i = 0; i < count; i++) {
      const entity = this.entities[i];
      if (entity !== undefined) visit(entity);
    }
  }

  /**
   * Every entity of one type, in ascending id order.
   *
   * Returns the store's own array: systems call this every tick and copying
   * twenty thousand belts per tick to protect against a caller that should not
   * be writing to it is the wrong trade. It is `readonly` in the type, it must
   * not be retained across a `cleanup`, and `forEach` above documents what
   * mutating during iteration means.
   */
  byType<T extends Entity = Entity>(type: EntityType): readonly T[] {
    if (!isEntityType(type)) {
      throw new RangeError(`EntityStore.byType: ${type} is not an EntityType.`);
    }
    return this.bucket(type) as T[];
  }

  /**
   * Mark an entity for removal at the end of the tick (§8 phase 9).
   *
   * Nothing observable changes until `cleanup`: `get`, `at`, `forEach` and
   * `byType` all still report it. Removing something already gone, or already
   * marked, is not an error — a belt destroyed by two things in the same tick
   * is an ordinary event, not a bug.
   */
  remove(id: EntityId): void {
    if (!this.byId.has(id)) return;
    this.pending.add(id);
  }

  /** Is this entity going away at the end of this tick? */
  isPendingRemoval(id: EntityId): boolean {
    return this.pending.has(id);
  }

  /**
   * Apply every deferred removal. Returns the removed ids, ascending.
   *
   * Called once per tick by `Simulation`, last (§8 phase 9), so no system ever
   * observes a half-removed entity. Compaction is a single in-place pass over
   * the dense array and each affected bucket, which keeps both strictly
   * id-ascending without a sort — and without touching the array at all on the
   * overwhelming majority of ticks, where nothing was removed.
   */
  cleanup(): readonly EntityId[] {
    if (this.pending.size === 0) return NO_REMOVALS;

    const removed: EntityId[] = [];
    // A flag per type rather than a `Set` of the types seen, so that the loop
    // below walks type numbers in order instead of insertion order (§6 R4).
    // Bucket compaction is independent per type, so the order cannot change an
    // outcome — but "we never iterate a Set here" is a rule worth being able
    // to check by reading, rather than by reasoning about each case.
    const touched = new Uint8Array(ENTITY_TYPE_COUNT);

    // Ascending, because the dense array is — the returned list is ordered by
    // construction rather than by a sort with a comparator to get wrong.
    for (const entity of this.entities) {
      if (!this.pending.has(entity.id)) continue;
      removed.push(entity.id);
      touched[entity.type] = 1;
      this.byId.delete(entity.id);
      this.releaseTiles(entity);
    }

    compact(this.entities, this.pending);
    for (let type = 0; type < ENTITY_TYPE_COUNT; type++) {
      if (touched[type] === 1) compact(this.bucket(type), this.pending);
    }

    this.pending.clear();
    this.revision += 1;
    return removed;
  }

  /** Free every tile an entity claimed. Its footprint must not have changed. */
  private releaseTiles(entity: Entity): void {
    const footprint = this.lookupFootprint(entity.type);
    forEachFootprintTile(entity.x, entity.y, footprint, entity.rotation, (tileX, tileY) => {
      const key = tileKey(tileX, tileY);
      // Guarded rather than deleted blindly: if an impure `FootprintLookup`
      // ever returns a different size than it did at creation, this walks over
      // a neighbour's tiles, and evicting them would turn one bug into a world
      // where buildings can be built on top of each other.
      if (this.occupancy.get(key) === entity.id) this.occupancy.delete(key);
    });
  }

  private lookupFootprint(type: EntityType): Footprint {
    const footprint = this.footprintOf(type);
    assertFootprint(footprint);
    return footprint;
  }

  private bucket(type: EntityType): Entity[] {
    const bucket = this.buckets[type];
    if (bucket === undefined) {
      throw new RangeError(`EntityStore: no bucket for entity type ${type}.`);
    }
    return bucket;
  }
}

/** Drop every marked entity from an id-ordered array, preserving order. */
function compact(list: Entity[], removed: ReadonlySet<EntityId>): void {
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const entity = list[read];
    if (entity === undefined || removed.has(entity.id)) continue;
    list[write] = entity;
    write += 1;
  }
  list.length = write;
}
