/**
 * Belts and splitters. See ironflow.md §9, §8 phase 5, C13 and C17.
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
 * ## One system, two buildings (C17)
 *
 * §8's phase list has a `belts` phase and no splitter phase, and §9 puts
 * "splitter round-robin" in the belt model's own list of required behaviours.
 * That is not an oversight: a splitter is two belt lanes with a decision at
 * the end of them, the downstream-first order below is **one graph** spanning
 * both, and splitting it across two systems would mean each holding half an
 * order and neither being able to compute it. So this file moves both, and the
 * word for what it moves is a *carrier* — anything content gives a
 * `tilesPerSecond` to.
 *
 * The difference between the two is exactly one thing: how many ways out an
 * item has at the end of a lane. A belt has one, a splitter has two and a
 * counter that says which to try first (`entities/splitter-entity.ts`). The
 * movement itself is one loop, `advanceLane`, run over an array of items that
 * neither building owns exclusively.
 *
 * ## Downstream-first, and why it is a cached order rather than an id walk
 *
 * §8 says the tile nearest the output end moves first. Walk the entity store's
 * id order instead and a belt whose downstream neighbour has not yet moved
 * sees a *fuller* tile in front of it than the tick will end with, so items
 * bunch up by a slot and the line runs slower — by an amount that depends on
 * which end of it was built first. That is C13's "throughput is identical
 * whether belts were built left-to-right or right-to-left", and it is the
 * acceptance criterion this file exists to satisfy. C17 asks the same of a
 * line with a splitter in it.
 *
 * So carriers are visited in a **post-order walk of the carrier graph**: every
 * one is emitted after everything it feeds. A belt has out-degree one and a
 * splitter out-degree two, so the walk is a depth-first traversal with an
 * explicit edge cursor, it costs one pass over the carriers, and the resulting
 * order is a property of the *layout* rather than of the build order.
 *
 * The order is derived state (§10 lists belt topology as exactly that), so it
 * is rebuilt rather than persisted, and it is rebuilt only when the set of
 * entities has changed — `EntityStore.structureRevision` is what says so. On
 * an unchanged factory this file does no graph work at all.
 *
 * A closed loop of carriers has no last tile, so there is no downstream-first
 * order for it to have: the walk breaks the cycle at whichever carrier it
 * entered from, which is deterministic for a given layout and store but is the
 * one case where the break point depends on entity id. A loop that feeds only
 * itself carries nothing anywhere, so nothing observable rides on it.
 *
 * ## The two ends of a belt line
 *
 * Items **arrive** on a belt from the tile behind it, or from a machine
 * standing beside it with its output side turned that way — C11 gave the miner
 * an output side for exactly this, and there is no inserter until C14. They
 * **leave** into the next carrier, into a container, or nowhere at all, in
 * which case the item sits at the exit edge and everything behind it compacts.
 * That last sentence is §9's backpressure: nothing here propagates a "blocked"
 * flag, because a full tile in front *is* the block, and it reaches the miner
 * by the ordinary means of the miner's own buffer filling up. A splitter
 * inherits it whole — a jammed output stalls the lane behind it, and a
 * splitter with both outputs jammed stalls the belt feeding it.
 *
 * Machines are unloaded **after** every carrier has moved, so an item dropped
 * onto a belt lands on the settled tile the next tick will advance — the same
 * promise §8 makes to C14's inserters one phase later, for the same reason.
 */

import {
  BELT_MAX_POSITION,
  BELT_SLOT_SPACING,
  BELT_TILE_UNITS,
  asBelt,
  facesBack,
  laneAccept,
  type BeltItem,
} from '../entities/belt-entity.js';
import type { EntityStore } from '../entities/entity-store.js';
import { ENTITY_TYPE_COUNT, EntityType } from '../entities/entity-types.js';
import { UNIT_FOOTPRINT, forEachOutputTile, type Entity, type EntityId, type Footprint } from '../entities/entity.js';
import {
  SPLITTER_LANES,
  asSplitter,
  otherSide,
  splitterSideFedFrom,
  splitterTile,
  type SplitterEntity,
  type SplitterSide,
} from '../entities/splitter-entity.js';
import { inputPortOf, outputPortOf, type PortContext } from '../items/item-port.js';
import type { Unlocks } from '../research/unlocks.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import type { RecipeRegistry } from '../registries/recipe-registry.js';
import { DIRECTION_OFFSETS, TILE_MAX, TILE_MIN, type Rotation } from '../world/coordinates.js';

export interface BeltSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  /** Needed to turn a miner's resource into a runtime item id, and for stacks. */
  readonly items: ItemRegistry;
  /** Part of the port context; belts never look a recipe up themselves (C15). */
  readonly recipes: RecipeRegistry;
  /**
   * What research has revealed (C22). Held only to build the port context: a
   * machine's input port asks it what a machine would accept.
   */
  readonly unlocks: Unlocks;
}

/** Is this a tile the occupancy index can be asked about without throwing? */
function inTileRange(x: number, y: number): boolean {
  return x >= TILE_MIN && x <= TILE_MAX && y >= TILE_MIN && y <= TILE_MAX;
}

/**
 * The most ways out any carrier has. A belt's single edge is edge 0 and it
 * answers `-1` for the rest, so the walk below needs no per-kind degree.
 */
const MAX_OUT_EDGES = SPLITTER_LANES;

export class BeltSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;

  /** What the buildings at either end of a belt hold — see `items/item-port.ts`. */
  private readonly ports: PortContext;

  /**
   * Fixed-point units per tick by entity type, `null` for anything that is not
   * a carrier.
   *
   * An array read rather than a `Map` lookup, because this is asked once per
   * carrier per tick and §12's reference factory has twelve thousand of them.
   * Content is frozen at construction, so caching it cannot go stale — and a
   * belt and a splitter land in the same table because the question ("how fast
   * does this thing move an item?") is the same one.
   */
  private readonly carrierUnits: readonly (number | null)[];

  /** Footprints by entity type, for the splitter geometry. Content, so cached. */
  private readonly carrierSizes: readonly Footprint[];

  /**
   * Carrier entity types, ascending. What `rebuildOrder` collects, in a fixed
   * order that does not depend on which building was defined first (§6 R4).
   */
  private readonly carrierTypes: readonly EntityType[];

  /** Carriers, downstream-first. Derived (§10); see the file header. */
  private order: Entity[] = [];

  /** The store revision `order` was built from. `-1` means "never built". */
  private orderRevision = -1;

  constructor(options: BeltSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.ports = {
      buildings: options.buildings,
      items: options.items,
      recipes: options.recipes,
      unlocks: options.unlocks,
    };

    const types = Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) => type as EntityType);
    this.carrierUnits = Object.freeze(
      types.map((type) => {
        const belt = this.buildings.beltFor(type);
        if (belt !== null) return belt.unitsPerTick;
        return this.buildings.splitterFor(type)?.unitsPerTick ?? null;
      }),
    );
    this.carrierSizes = Object.freeze(types.map((type) => this.buildings.footprintOf(type)));
    this.carrierTypes = Object.freeze(types.filter((type) => this.carrierUnits[type] !== null));
  }

  /** How many carriers the cached order holds. For tests and the debug readout. */
  get orderedBeltCount(): number {
    return this.order.length;
  }

  /** Phase 5. Move everything, then load the machines feeding the lines. */
  tick(): void {
    this.ensureOrder();

    const order = this.order;
    for (let i = 0; i < order.length; i++) {
      const carrier = order[i];
      if (carrier === undefined) continue;
      const units = this.carrierUnits[carrier.type];
      if (units === null || units === undefined) continue;

      const belt = asBelt(carrier);
      if (belt !== null) {
        this.advanceLane(belt.items, units, belt);
        continue;
      }

      const splitter = asSplitter(carrier);
      if (splitter !== null) this.advanceSplitter(splitter, units);
    }

    this.unloadMachines();
  }

  /**
   * One tick of one lane, front item first.
   *
   * The loop compacts in place: an item that leaves is simply not written back,
   * so a lane never allocates and the front-first invariant is maintained by
   * construction rather than by a sort.
   *
   * `frontPos` is the position of the last item that *stayed*. Until one has,
   * the item being considered is the one at the head of the lane and is free
   * to try to leave; after that, every item is capped one slot behind the one
   * ahead, which is §9's "an item stops behind a stationary item" and the
   * compaction that makes a backed-up belt look full rather than gappy.
   *
   * `owner` is the carrier the lane belongs to, and is used only when an item
   * reaches the end of it: `exit` is the single place that knows a belt has
   * one way out and a splitter two.
   */
  private advanceLane(items: BeltItem[], unitsPerTick: number, owner: Entity): void {
    let write = 0;
    let frontPos = 0;
    let hasFront = false;

    for (let read = 0; read < items.length; read++) {
      const item = items[read];
      if (item === undefined) continue;

      let target = item.pos + unitsPerTick;

      if (!hasFront) {
        if (target >= BELT_TILE_UNITS && this.exit(owner, item.itemId, target - BELT_TILE_UNITS)) {
          // Gone to the next carrier: not written back, and the item behind it
          // becomes the head of this lane on the next pass of the loop.
          continue;
        }
        // Either it was never leaving, or there was nowhere to go. An item
        // with nowhere to go waits *at the exit edge*, which is what makes the
        // lane look full from the outside and what the tile behind measures
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
   * One tick of a splitter: both lanes, favoured one first. C17 task 3.
   *
   * The order matters only when the two lanes are competing for the same way
   * out — a merge, where one output belt is fed by two input belts. Always
   * advancing lane 0 first would let it win every such tick for ever and starve
   * lane 1, so `inputCursor` says which goes first, and it passes to the other
   * lane the moment the favoured one actually gets an item out.
   *
   * "Actually gets one out" is measured as the lane getting *shorter*: items
   * only ever leave a lane during its own advance, because the downstream-first
   * order guarantees everything upstream of this splitter moves later in the
   * tick. A lane that is empty, or blocked, keeps the favour — a dead input
   * must not cost the live one a turn.
   */
  private advanceSplitter(splitter: SplitterEntity, unitsPerTick: number): void {
    const favoured = splitter.inputCursor;
    const lane = splitter.lanes[favoured];
    const before = lane.length;

    this.advanceLane(lane, unitsPerTick, splitter);
    if (lane.length < before) splitter.inputCursor = otherSide(favoured);

    this.advanceLane(splitter.lanes[otherSide(favoured)], unitsPerTick, splitter);
  }

  /**
   * Try to move one item off the end of a carrier. Returns whether it went.
   *
   * `desired` is how far into the next tile the item's own momentum carries
   * it. A carrier may place it further back than that if something is already
   * there; a container takes it whole or not at all.
   *
   * For a splitter this is C17's whole mechanic, and it is three lines because
   * the cursor rule is one sentence: **try the side the cursor names; if it
   * was taken, the cursor moves on; if it was not, fall back to the other side
   * and leave the cursor where it is.** Balanced output, full pass-through
   * under a block, and identical behaviour after a reload all follow from that
   * — see the header of `entities/splitter-entity.ts`.
   */
  private exit(owner: Entity, itemId: ItemId, desired: number): boolean {
    const belt = asBelt(owner);
    if (belt !== null) {
      const target = this.tileAhead(belt.x, belt.y, belt.rotation);
      return target !== undefined && this.deposit(target, belt.x, belt.y, belt.rotation, itemId, desired);
    }

    const splitter = asSplitter(owner);
    if (splitter === null) return false;

    const favoured = splitter.outputCursor;
    if (this.pushOut(splitter, favoured, itemId, desired)) {
      splitter.outputCursor = otherSide(favoured);
      return true;
    }
    return this.pushOut(splitter, otherSide(favoured), itemId, desired);
  }

  /** Try one of a splitter's two ways out. Returns whether the item went. */
  private pushOut(splitter: SplitterEntity, side: SplitterSide, itemId: ItemId, desired: number): boolean {
    const from = splitterTile(splitter, this.sizeOf(splitter.type), side);
    const target = this.tileAhead(from.x, from.y, splitter.rotation);
    return target !== undefined && this.deposit(target, from.x, from.y, splitter.rotation, itemId, desired);
  }

  /**
   * Hand one item to whatever is at `target`, arriving from `(fromX, fromY)`.
   *
   * The one place that knows what may receive an item leaving a carrier, so a
   * belt's end and a splitter's two ends cannot disagree about it:
   *
   * ```text
   * belt        unless it faces straight back — see `facesBack`
   * splitter    only across its back edge — see `splitterSideFedFrom`
   * container   whole item or not at all
   * ```
   *
   * Machines are deliberately absent. C13 expected C15's furnace to gain an
   * arm here and it did not: a belt that could load a machine directly would
   * carry 8 items/s into it, and every ratio in §15 is derived with an
   * inserter's 1 item/s in that gap. A furnace is fed by an inserter.
   */
  private deposit(
    target: Entity,
    fromX: number,
    fromY: number,
    fromRotation: Rotation,
    itemId: ItemId,
    desired: number,
  ): boolean {
    const entry = Math.min(desired, BELT_MAX_POSITION);

    const belt = asBelt(target);
    if (belt !== null) {
      // Two belts nose to nose would otherwise trade the same item back and
      // forth every tick — see `facesBack`.
      if (facesBack(fromRotation, belt.rotation)) return false;
      return laneAccept(belt.items, itemId, entry);
    }

    const splitter = asSplitter(target);
    if (splitter !== null) {
      const side = splitterSideFedFrom(splitter, this.sizeOf(splitter.type), fromX, fromY);
      if (side === null) return false;
      return laneAccept(splitter.lanes[side], itemId, entry);
    }

    if (this.buildings.storageFor(target.type) === null) return false;
    return this.store(target, itemId, 1) === 1;
  }

  /** The entity one step along `rotation`, or undefined for nothing usable. */
  private tileAhead(x: number, y: number, rotation: Rotation): Entity | undefined {
    const step = DIRECTION_OFFSETS[rotation];
    if (step === undefined) return undefined;
    return this.entityAt(x + step.x, y + step.y);
  }

  /** The entity on a tile, or undefined for an empty or half-removed one. */
  private entityAt(x: number, y: number): Entity | undefined {
    if (!inTileRange(x, y)) return undefined;

    const target = this.entities.at(x, y);
    if (target === undefined) return undefined;
    // Demolished earlier this tick: it holds its tiles until cleanup (C05),
    // but putting an item into it would delete the item along with it.
    return this.entities.isPendingRemoval(target.id) ? undefined : target;
  }

  /** A building's footprint, from content. `UNIT_FOOTPRINT` for an unknown type. */
  private sizeOf(type: EntityType): Footprint {
    return this.carrierSizes[type] ?? UNIT_FOOTPRINT;
  }

  /**
   * Put items into a container. Returns how many actually went in.
   *
   * The port is built over the entity's own `contents` array, so this writes
   * straight into authoritative state with nothing to copy back — see
   * `chest-entity.ts` on why an entity cannot simply hold a `SlotInventory`,
   * and `items/item-port.ts` for why all three systems that do this now ask
   * the same code (C15).
   */
  private store(entity: Entity, itemId: ItemId, amount: number): number {
    return inputPortOf(entity, this.ports)?.give(itemId, amount) ?? 0;
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
    // Whatever its output port offers — a miner's mined ore, in v1, because a
    // miner is the only building `outputBufferTypes` contains. See the note
    // there on why C15's furnace is not in it.
    const port = outputPortOf(machine, this.ports);
    if (port === null) return;
    const itemId = port.peek();
    if (itemId === NO_ITEM) return;

    const definition = this.buildings.forEntityType(machine.type);
    let delivered = false;
    forEachOutputTile(machine.x, machine.y, definition.size, machine.rotation, (x, y) => {
      if (delivered) return;
      const target = this.entityAt(x, y);
      if (target === undefined) return;

      // A belt only, not a splitter: §15 counts a miner's output straight onto
      // a belt and everything else through an inserter, and a splitter is a
      // belt fitting rather than a thing machines load. See C17's report.
      const belt = asBelt(target);
      if (belt === null) return;
      // As far forward as it fits, which is still behind everything already on
      // the tile: an item dropped onto an empty belt should not have to cross
      // a tile it was never on.
      if (laneAccept(belt.items, itemId, BELT_MAX_POSITION)) delivered = true;
    });

    if (delivered) port.take(itemId, 1);
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
   * Rebuild the order: a post-order walk of the carrier graph, iteratively.
   *
   * Iteratively because a belt line is exactly the shape that makes a
   * recursive walk overflow the stack — §12's reference factory allows twelve
   * thousand belt tiles and a player is entirely capable of laying them in one
   * line.
   *
   * `state` is per carrier: 0 unvisited, 1 on the stack, 2 emitted. `edges` is
   * how many of that carrier's ways out have been tried — one for a belt and
   * two for a splitter, which is why the cursor exists at all; C13 could get
   * away with following a single chain. A carrier whose downstream is already
   * on the stack is in a cycle and is emitted where it is; see the file header
   * on what that means.
   */
  private rebuildOrder(): void {
    const carriers: Entity[] = [];
    for (const type of this.carrierTypes) {
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const carrier = bucket[i];
        if (carrier !== undefined) carriers.push(carrier);
      }
    }

    const order: Entity[] = [];
    const indexById = new Map<EntityId, number>();
    for (let i = 0; i < carriers.length; i++) {
      const carrier = carriers[i];
      if (carrier !== undefined) indexById.set(carrier.id, i);
    }

    const state = new Uint8Array(carriers.length);
    const edges = new Uint8Array(carriers.length);
    const stack: number[] = [];

    for (let start = 0; start < carriers.length; start++) {
      if (state[start] !== 0) continue;
      state[start] = 1;
      stack.push(start);

      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top === undefined) break;
        const carrier = carriers[top];
        const edge = edges[top] ?? MAX_OUT_EDGES;

        if (carrier !== undefined && edge < MAX_OUT_EDGES) {
          edges[top] = edge + 1;
          const next = this.downstreamIndex(carrier, edge, indexById);
          if (next >= 0 && state[next] === 0) {
            state[next] = 1;
            stack.push(next);
          }
          continue;
        }

        stack.pop();
        state[top] = 2;
        if (carrier !== undefined) order.push(carrier);
      }
    }

    this.order = order;
  }

  /**
   * The index of the carrier this one's `edge`th way out feeds, or -1.
   *
   * A belt has one way out, from its own tile; a splitter has one per side,
   * each from that side's tile. Anything that is not a carrier — a chest, the
   * empty ground, a belt facing back — is not an edge in this graph, because
   * the graph exists to order *movement* and a container does not move
   * anything on.
   */
  private downstreamIndex(carrier: Entity, edge: number, indexById: ReadonlyMap<EntityId, number>): number {
    let fromX = carrier.x;
    let fromY = carrier.y;

    const splitter = asSplitter(carrier);
    if (splitter !== null) {
      const tile = splitterTile(splitter, this.sizeOf(splitter.type), edge as SplitterSide);
      fromX = tile.x;
      fromY = tile.y;
    } else if (edge > 0) {
      return -1;
    }

    const target = this.tileAhead(fromX, fromY, carrier.rotation);
    if (target === undefined || !this.carriesOn(target, fromX, fromY, carrier.rotation)) return -1;
    return indexById.get(target.id) ?? -1;
  }

  /**
   * Would `target` take an item arriving from `(fromX, fromY)` and carry it on?
   *
   * The same two rules `deposit` applies, asked as a question about the layout
   * rather than about this tick's room: whether the lane in front happens to
   * be full is not a property of the graph, and an order that changed with the
   * traffic would defeat the point of caching it.
   */
  private carriesOn(target: Entity, fromX: number, fromY: number, fromRotation: Rotation): boolean {
    const belt = asBelt(target);
    if (belt !== null) return !facesBack(fromRotation, belt.rotation);

    const splitter = asSplitter(target);
    if (splitter === null) return false;
    return splitterSideFedFrom(splitter, this.sizeOf(splitter.type), fromX, fromY) !== null;
  }
}
