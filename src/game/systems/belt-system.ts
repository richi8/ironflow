/**
 * Belts. See ironflow.md §9, §8 phase 5 and C13.
 *
 * The chunk that makes it a factory game: after this, items move without the
 * player touching anything. Four things have to be right, and three of them
 * are ordering problems.
 *
 * ```text
 * §8   belts run downstream-first, or effective belt speed depends on the
 *      order the belts happened to be built in
 * §9   an item cannot pass the item in front of it, and the block propagates
 *      backwards until it reaches the machine feeding the line
 * §6   R3 positions are integers; R4 every traversal is over an ordered array
 * ```
 *
 * ## Downstream-first, and why it is a cached order rather than an id walk
 *
 * §8 says the tile nearest the output end moves first. Walk the entity store's
 * id order instead and a belt whose downstream neighbour has not yet moved
 * sees a *fuller* tile in front of it than the tick will end with, so items
 * bunch up by a slot and the line runs slower — by an amount that depends on
 * which end of it was built first. That is C13's "throughput is identical
 * whether belts were built left-to-right or right-to-left", and it is the
 * acceptance criterion this file exists to satisfy.
 *
 * So belts are visited in a **post-order walk of the belt graph**: every belt
 * is emitted after the belt it feeds. The graph has out-degree at most one — a
 * belt has one tile in front of it — so the walk is really chain-following, it
 * costs one pass over the belts, and the resulting order is a property of the
 * *layout* rather than of the build order.
 *
 * The order is derived state (§10 lists belt topology as exactly that), so it
 * is rebuilt rather than persisted, and it is rebuilt only when the set of
 * entities has changed — `EntityStore.structureRevision` is what says so. On
 * an unchanged factory this file does no graph work at all.
 *
 * A closed loop of belts has no last tile, so there is no downstream-first
 * order for it to have: the walk breaks the cycle at whichever belt it
 * entered from, which is deterministic for a given layout and store but is the
 * one case where the break point depends on entity id. A loop that feeds only
 * itself carries nothing anywhere, so nothing observable rides on it.
 *
 * ## The two ends of a belt line
 *
 * Items **arrive** on a belt from the tile behind it, or from a machine
 * standing beside it with its output side turned that way — C11 gave the miner
 * an output side for exactly this, and there is no inserter until C14. They
 * **leave** into the next belt, into a container, or nowhere at all, in which
 * case the item sits at the exit edge and everything behind it compacts. That
 * last sentence is §9's backpressure: nothing here propagates a "blocked"
 * flag, because a full tile in front *is* the block, and it reaches the miner
 * by the ordinary means of the miner's own buffer filling up.
 *
 * Machines are unloaded **after** every belt has moved, so an item dropped
 * onto a belt lands on the settled tile the next tick will advance — the same
 * promise §8 makes to C14's inserters one phase later, for the same reason.
 */

import {
  BELT_MAX_POSITION,
  BELT_SLOT_SPACING,
  BELT_TILE_UNITS,
  asBelt,
  beltAccept,
  facesBack,
  type BeltEntity,
  type BeltItem,
} from '../entities/belt-entity.js';
import { asChest } from '../entities/chest-entity.js';
import type { EntityStore } from '../entities/entity-store.js';
import { ENTITY_TYPE_COUNT, EntityType } from '../entities/entity-types.js';
import { forEachOutputTile, type Entity, type EntityId } from '../entities/entity.js';
import { asMiner, minerOutput, takeMinerOutput } from '../entities/miner-entity.js';
import { SlotInventory } from '../items/inventory.js';
import type { BeltConfig, BuildingRegistry, StorageProperties } from '../registries/building-registry.js';
import type { ItemId, ItemRegistry } from '../registries/item-registry.js';
import { DIRECTION_OFFSETS, TILE_MAX, TILE_MIN } from '../world/coordinates.js';

export interface BeltSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  /** Needed to turn a miner's resource into a runtime item id, and for stacks. */
  readonly items: ItemRegistry;
}

/** Is this a tile the occupancy index can be asked about without throwing? */
function inTileRange(x: number, y: number): boolean {
  return x >= TILE_MIN && x <= TILE_MAX && y >= TILE_MIN && y <= TILE_MAX;
}

export class BeltSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly items: ItemRegistry;

  /**
   * Belt speed by entity type, resolved once.
   *
   * An array read rather than a `Map` lookup, because this is asked once per
   * belt per tick and §12's reference factory has twelve thousand of them.
   * Content is frozen at construction, so caching it cannot go stale.
   */
  private readonly beltConfigs: readonly (BeltConfig | null)[];

  /** Belts, downstream-first. Derived (§10); see the file header. */
  private order: BeltEntity[] = [];

  /** The store revision `order` was built from. `-1` means "never built". */
  private orderRevision = -1;

  constructor(options: BeltSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.items = options.items;
    this.beltConfigs = Object.freeze(
      Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) => this.buildings.beltFor(type as EntityType)),
    );
  }

  /** How many belts the cached order holds. For tests and the debug readout. */
  get orderedBeltCount(): number {
    return this.order.length;
  }

  /** Phase 5. Move everything, then load the machines feeding the lines. */
  tick(): void {
    this.ensureOrder();

    const order = this.order;
    for (let i = 0; i < order.length; i++) {
      const belt = order[i];
      if (belt === undefined) continue;
      const config = this.beltConfigs[belt.type];
      if (config !== null && config !== undefined) this.advance(belt, config.unitsPerTick);
    }

    this.unloadMachines();
  }

  /**
   * One tick of one belt tile, front item first.
   *
   * The loop compacts in place: an item that leaves is simply not written back,
   * so a tile never allocates and the front-first invariant is maintained by
   * construction rather than by a sort.
   *
   * `frontPos` is the position of the last item that *stayed*. Until one has,
   * the item being considered is the one at the head of the tile and is free
   * to try to leave; after that, every item is capped one slot behind the one
   * ahead, which is §9's "an item stops behind a stationary item" and the
   * compaction that makes a backed-up belt look full rather than gappy.
   */
  private advance(belt: BeltEntity, unitsPerTick: number): void {
    const items = belt.items;
    let write = 0;
    let frontPos = 0;
    let hasFront = false;

    for (let read = 0; read < items.length; read++) {
      const item = items[read];
      if (item === undefined) continue;

      let target = item.pos + unitsPerTick;

      if (!hasFront) {
        if (target >= BELT_TILE_UNITS && this.handOff(belt, item, target - BELT_TILE_UNITS)) {
          // Gone to the next tile: not written back, and the item behind it
          // becomes the head of this tile on the next pass of the loop.
          continue;
        }
        // Either it was never leaving, or there was nowhere to go. An item
        // with nowhere to go waits *at the exit edge*, which is what makes the
        // belt look full from the outside and what the tile behind measures
        // its own room against.
        if (target > BELT_MAX_POSITION) target = BELT_MAX_POSITION;
      } else {
        const cap = frontPos - BELT_SLOT_SPACING;
        if (target > cap) target = cap;
      }

      item.pos = target;
      frontPos = target;
      hasFront = true;
      items[write] = item;
      write += 1;
    }

    items.length = write;
  }

  /**
   * Try to move one item off the end of a belt. Returns whether it went.
   *
   * `desired` is how far into the next tile the item's own momentum carries
   * it. A belt may place it further back than that if something is already
   * there; a container takes it whole or not at all.
   */
  private handOff(belt: BeltEntity, item: BeltItem, desired: number): boolean {
    const target = this.tileAhead(belt);
    if (target === undefined) return false;

    const next = asBelt(target);
    if (next !== null) {
      // Two belts nose to nose would otherwise trade the same item back and
      // forth every tick — see `facesBack`.
      if (facesBack(belt.rotation, next.rotation)) return false;
      return beltAccept(next, item.itemId, Math.min(desired, BELT_MAX_POSITION));
    }

    const storage = this.buildings.storageFor(target.type);
    if (storage !== null) return this.store(target, storage, item.itemId, 1) === 1;

    // A miner, or anything else with no way in. C15's furnace is the first
    // machine with an input buffer and adds its arm here.
    return false;
  }

  /** The entity on the tile a belt points at, or undefined for nothing usable. */
  private tileAhead(belt: BeltEntity): Entity | undefined {
    const step = DIRECTION_OFFSETS[belt.rotation];
    if (step === undefined) return undefined;

    const x = belt.x + step.x;
    const y = belt.y + step.y;
    if (!inTileRange(x, y)) return undefined;

    const target = this.entities.at(x, y);
    if (target === undefined) return undefined;
    // Demolished earlier this tick: it holds its tiles until cleanup (C05),
    // but putting an item into it would delete the item along with it.
    return this.entities.isPendingRemoval(target.id) ? undefined : target;
  }

  /**
   * Put items into a container. Returns how many actually went in.
   *
   * The container is built over the entity's own `contents` array, so this
   * writes straight into authoritative state with nothing to copy back — see
   * `chest-entity.ts` on why an entity cannot simply hold a `SlotInventory`.
   */
  private store(entity: Entity, storage: StorageProperties, itemId: ItemId, amount: number): number {
    const chest = asChest(entity);
    if (chest === null) return 0;
    const inventory = new SlotInventory({
      slots: storage.slots,
      stackSizeOf: this.items.stackSizeOf,
      contents: chest.contents,
    });
    return inventory.add(itemId, amount);
  }

  /**
   * Drop one item from each machine's output buffer onto a belt in front of it.
   *
   * One item per machine per tick: a miner produces 0.5 a second and a belt
   * accepts eight, so the cap is never the thing that limits the line — and it
   * bounds the work a single machine can do in a tick whatever C20 does to the
   * rates.
   *
   * The machine types come from content (`outputBufferTypes`), the entities
   * within each from the store's id-ordered bucket, so the traversal is fixed
   * by the enum and the ids rather than by anything incidental (§6 R4).
   */
  private unloadMachines(): void {
    for (const type of this.buildings.outputBufferTypes()) {
      const machines = this.entities.byType(type);
      for (let i = 0; i < machines.length; i++) {
        const machine = machines[i];
        if (machine !== undefined) this.unload(machine);
      }
    }
  }

  private unload(machine: Entity): void {
    // A miner's buffer is a bare count whose item is implied by its resource
    // (C11), so reading it is miner-shaped. C15's furnace holds a real buffer
    // and gains its own arm here, exactly as it does in `HandSystem`.
    const miner = asMiner(machine);
    if (miner === null) return;

    const output = minerOutput(miner);
    if (output === null || !this.items.has(output.itemId)) return;
    const itemId = this.items.idOf(output.itemId);

    const definition = this.buildings.forEntityType(machine.type);
    let delivered = false;
    forEachOutputTile(machine.x, machine.y, definition.size, machine.rotation, (x, y) => {
      if (delivered || !inTileRange(x, y)) return;
      const target = this.entities.at(x, y);
      if (target === undefined || this.entities.isPendingRemoval(target.id)) return;

      const belt = asBelt(target);
      if (belt === null) return;
      // As far forward as it fits, which is still behind everything already on
      // the tile: an item dropped onto an empty belt should not have to cross
      // a tile it was never on.
      if (beltAccept(belt, itemId, BELT_MAX_POSITION)) delivered = true;
    });

    if (delivered) takeMinerOutput(miner, 1);
  }

  /* ---------------------------------------------------------------- *
   * The downstream-first order
   * ---------------------------------------------------------------- */

  private ensureOrder(): void {
    if (this.entities.structureRevision === this.orderRevision) return;
    this.orderRevision = this.entities.structureRevision;
    this.rebuildOrder();
  }

  /**
   * Rebuild the order: a post-order walk of the belt graph, iteratively.
   *
   * Iteratively because a belt line is exactly the shape that makes a
   * recursive walk overflow the stack — §12's reference factory allows twelve
   * thousand belt tiles and a player is entirely capable of laying them in one
   * line.
   *
   * `state` is per belt: 0 unvisited, 1 on the stack, 2 emitted. A belt whose
   * downstream is already on the stack is in a cycle and is emitted where it
   * is; see the file header on what that means.
   */
  private rebuildOrder(): void {
    const belts = this.entities.byType<BeltEntity>(EntityType.Belt);
    const order: BeltEntity[] = [];

    const indexById = new Map<EntityId, number>();
    for (let i = 0; i < belts.length; i++) {
      const belt = belts[i];
      if (belt !== undefined) indexById.set(belt.id, i);
    }

    const state = new Uint8Array(belts.length);
    const stack: number[] = [];

    for (let start = 0; start < belts.length; start++) {
      if (state[start] !== 0) continue;
      state[start] = 1;
      stack.push(start);

      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top === undefined) break;
        const belt = belts[top];

        const next = belt === undefined ? -1 : this.downstreamIndex(belt, indexById);
        if (next >= 0 && state[next] === 0) {
          state[next] = 1;
          stack.push(next);
          continue;
        }

        stack.pop();
        state[top] = 2;
        if (belt !== undefined) order.push(belt);
      }
    }

    this.order = order;
  }

  /** The index of the belt this one feeds, or -1 if it feeds something else. */
  private downstreamIndex(belt: BeltEntity, indexById: ReadonlyMap<EntityId, number>): number {
    const target = this.tileAhead(belt);
    if (target === undefined) return -1;
    const next = asBelt(target);
    if (next === null || facesBack(belt.rotation, next.rotation)) return -1;
    return indexById.get(next.id) ?? -1;
  }
}
