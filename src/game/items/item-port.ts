/**
 * Where an item can come from and where it can go — the one place in the
 * simulation that knows how a building holds things.
 *
 * ## Why this file exists
 *
 * C14 finished with three files each carrying their own copy of "how an item
 * gets into a chest": `belt-system.ts` handing an item off the end of a belt,
 * `hand-system.ts` letting the player reach in, and `inserter-system.ts`
 * dropping one. Six lines each, identical, and about to become four copies
 * when C15 gave the furnace an input buffer. C14's report named C15 as the
 * chunk that should unify them, which is what this is.
 *
 * A **port** is one end of a transfer. Two interfaces rather than one, because
 * the two directions are genuinely different sets of buildings: a miner offers
 * and never accepts, a furnace's input accepts and never offers, and only a
 * chest does both. Splitting them means every port that exists has a caller
 * for every method it implements.
 *
 * ## What is not here
 *
 * **Belts.** A belt holds items at fixed-point positions along a tile (§9),
 * not in an inventory, and the systems that touch one care exactly where the
 * item is: the end of a belt hands over at position 0, an inserter takes the
 * front item. Flattening that into "add one item" would throw away the
 * positions and make a belt a container with a count, which is the model §9
 * explicitly rejected. Belts stay special-cased in the two systems that move
 * items along them, and everything *else* goes through here.
 */

import type { Entity } from '../entities/entity.js';
import { asChest } from '../entities/chest-entity.js';
import { asInserter, inserterHolding } from '../entities/inserter-entity.js';
import { asMachine, type MachineEntity } from '../entities/machine-entity.js';
import { asMiner, minerOutput, takeMinerOutput } from '../entities/miner-entity.js';
import type { BuildingRegistry, ProductionProperties } from '../registries/building-registry.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import type { RecipeRegistry } from '../registries/recipe-registry.js';
import { BufferInventory, SlotInventory, slotsCount, type Inventory, type ItemSlots } from './inventory.js';

/** One line of a port's contents, for the inspector (C12). */
export interface PortStack {
  readonly itemId: ItemId;
  readonly count: number;
  /** The ceiling on this item, or null when the container is slot-limited. */
  readonly capacity: number | null;
}

/** Something an item can be taken out of. */
export interface ItemSource {
  /** What it offers first — its lowest item id — or `NO_ITEM` when empty. */
  peek(): ItemId;
  count(itemId: ItemId): number;
  /** Takes up to `amount`, and answers how many it actually gave. */
  take(itemId: ItemId, amount: number): number;
  stacks(): readonly PortStack[];
}

/** Something an item can be put into. */
export interface ItemSink {
  /** Room for `itemId`; `0` when it is full *or* refuses the item outright. */
  spaceFor(itemId: ItemId): number;
  /** Puts in up to `amount`, and answers how many it actually took. */
  give(itemId: ItemId, amount: number): number;
  stacks(): readonly PortStack[];
}

/** The registries a port needs to answer what it holds and what it accepts. */
export interface PortContext {
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly recipes: RecipeRegistry;
}

const NO_STACKS: readonly PortStack[] = Object.freeze([]);

/**
 * Where an item can be taken from this building, or null if nowhere.
 *
 * A machine offers its *output* buffer and nothing else: an inserter reaching
 * into a furnace takes plates, never the ore it is about to smelt, which is
 * what makes a furnace between two inserters a one-way machine rather than a
 * place items shuffle back and forth in.
 */
export function outputPortOf(entity: Entity, ctx: PortContext): ItemSource | null {
  const machine = asMachine(entity, ctx.buildings);
  if (machine !== null) return machineBuffers(machine, production(entity, ctx)).output;

  const chest = chestPort(entity, ctx);
  if (chest !== null) return chest;

  const miner = asMiner(entity);
  if (miner !== null) return new MinerPort(miner, ctx);

  const inserter = asInserter(entity);
  if (inserter !== null) return new HandPort(inserter);

  return null;
}

/**
 * Where an item can be put into this building, or null if nowhere.
 *
 * For a machine this routes: anything that burns goes in the fuel buffer, and
 * anything a recipe in its category wants goes in the input buffer. Nothing
 * else is accepted, so an inserter pointed at a furnace with copper plates on
 * its belt waits with empty hands instead of silting the furnace up with
 * something it can never smelt (C14 task 6).
 */
export function inputPortOf(entity: Entity, ctx: PortContext): ItemSink | null {
  const machine = asMachine(entity, ctx.buildings);
  if (machine !== null) return new MachineInputPort(machine, production(entity, ctx), ctx);

  return chestPort(entity, ctx);
}

/* -------------------------------------------------------------------------- *
 * Containers                                                                  *
 * -------------------------------------------------------------------------- */

/** A chest, as both directions of port. Null for a building that is not one. */
function chestPort(entity: Entity, ctx: PortContext): (ItemSource & ItemSink) | null {
  const storage = ctx.buildings.storageFor(entity.type);
  if (storage === null) return null;
  const chest = asChest(entity);
  if (chest === null) return null;
  return containerPort(
    chest.contents,
    new SlotInventory({ slots: storage.slots, stackSizeOf: ctx.items.stackSizeOf, contents: chest.contents }),
    null,
  );
}

/** A per-item-capped buffer over a machine's own slots, as both kinds of port. */
function bufferPort(contents: ItemSlots, capacityPerItem: number): ItemSource & ItemSink {
  return containerPort(contents, new BufferInventory({ capacityPerItem, contents }), capacityPerItem);
}

/** A port that holds nothing and accepts nothing: a buffer a machine lacks. */
const CLOSED_PORT: ItemSource & ItemSink = Object.freeze({
  peek: (): ItemId => NO_ITEM,
  count: (): number => 0,
  take: (): number => 0,
  spaceFor: (): number => 0,
  give: (): number => 0,
  stacks: (): readonly PortStack[] => NO_STACKS,
});

/** A machine's three buffers, built once per machine per tick by C15's system. */
export interface MachinePorts {
  readonly input: ItemSource & ItemSink;
  readonly fuel: ItemSource & ItemSink;
  readonly output: ItemSource & ItemSink;
}

/**
 * The three buffers of one machine.
 *
 * `production-system.ts` builds this once per machine per tick and passes it
 * down, rather than each helper re-deriving an inventory over the same array.
 * A machine that burns nothing gets a closed fuel port instead of a branch at
 * every use.
 */
export function machineBuffers(machine: MachineEntity, config: ProductionProperties): MachinePorts {
  return {
    input: bufferPort(machine.input, config.inputCapacity),
    fuel: config.fuelCapacity === undefined ? CLOSED_PORT : bufferPort(machine.fuel, config.fuelCapacity),
    output: bufferPort(machine.output, config.outputCapacity),
  };
}

function production(entity: Entity, ctx: PortContext): ProductionProperties {
  const config = ctx.buildings.productionFor(entity.type);
  if (config === null) {
    throw new Error(`item-port: ${entity.type} is not a machine.`);
  }
  return config;
}

/**
 * An inventory over an entity's own `ItemSlots` array, read and written in
 * place. `capacity` is what the inspector shows beside the count: a per-item
 * ceiling for a machine buffer, null for a chest, whose limit is slots.
 */
function containerPort(contents: ItemSlots, inventory: Inventory, capacity: number | null): ItemSource & ItemSink {
  return {
    peek(): ItemId {
      return contents[0]?.[0] ?? NO_ITEM;
    },
    count(itemId: ItemId): number {
      return slotsCount(contents, itemId);
    },
    take(itemId: ItemId, amount: number): number {
      return itemId === NO_ITEM || amount < 1 ? 0 : inventory.remove(itemId, amount);
    },
    spaceFor(itemId: ItemId): number {
      return itemId === NO_ITEM ? 0 : inventory.spaceFor(itemId);
    },
    give(itemId: ItemId, amount: number): number {
      return itemId === NO_ITEM || amount < 1 ? 0 : inventory.add(itemId, amount);
    },
    stacks(): readonly PortStack[] {
      if (contents.length === 0) return NO_STACKS;
      return Object.freeze(
        contents.map((entry) => Object.freeze({ itemId: entry[0], count: entry[1], capacity })),
      );
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Machines                                                                    *
 * -------------------------------------------------------------------------- */

/**
 * A machine's input side: one sink over two buffers, choosing by item.
 *
 * Fuel wins when an item is both, which in v1 it never is — coal smelts into
 * nothing — but the order has to be written down somewhere, and "a machine
 * that can burn it, burns it" is the answer that keeps a furnace running.
 */
class MachineInputPort implements ItemSink {
  private readonly ctx: PortContext;
  private readonly config: ProductionProperties;
  private readonly buffers: MachinePorts;

  constructor(machine: MachineEntity, config: ProductionProperties, ctx: PortContext) {
    this.ctx = ctx;
    this.config = config;
    this.buffers = machineBuffers(machine, config);
  }

  /** The buffer this item belongs in, or null when the machine refuses it. */
  private route(itemId: ItemId): ItemSink | null {
    if (itemId === NO_ITEM) return null;
    if (this.config.fuelCapacity !== undefined && this.ctx.items.fuelTicksOf(itemId) > 0) return this.buffers.fuel;
    if (!this.ctx.recipes.acceptsInput(this.config.category, itemId)) return null;
    return this.buffers.input;
  }

  spaceFor(itemId: ItemId): number {
    return this.route(itemId)?.spaceFor(itemId) ?? 0;
  }

  give(itemId: ItemId, amount: number): number {
    return this.route(itemId)?.give(itemId, amount) ?? 0;
  }

  /** Ingredients first, then fuel: content order, not insertion order (§6 R4). */
  stacks(): readonly PortStack[] {
    const input = this.buffers.input.stacks();
    const fuel = this.buffers.fuel.stacks();
    if (fuel.length === 0) return input;
    if (input.length === 0) return fuel;
    return Object.freeze([...input, ...fuel]);
  }
}

/* -------------------------------------------------------------------------- *
 * Single-item sources                                                         *
 * -------------------------------------------------------------------------- */

/** A miner's buffer: one resource, counted, with no inventory behind it (C11). */
class MinerPort implements ItemSource {
  private readonly miner: NonNullable<ReturnType<typeof asMiner>>;
  private readonly ctx: PortContext;

  constructor(miner: NonNullable<ReturnType<typeof asMiner>>, ctx: PortContext) {
    this.miner = miner;
    this.ctx = ctx;
  }

  private itemId(): ItemId {
    const output = minerOutput(this.miner);
    if (output === null || !this.ctx.items.has(output.itemId)) return NO_ITEM;
    return this.ctx.items.idOf(output.itemId);
  }

  peek(): ItemId {
    return this.itemId();
  }

  count(itemId: ItemId): number {
    return itemId !== NO_ITEM && itemId === this.itemId() ? this.miner.outputCount : 0;
  }

  take(itemId: ItemId, amount: number): number {
    return this.count(itemId) === 0 ? 0 : takeMinerOutput(this.miner, amount);
  }

  stacks(): readonly PortStack[] {
    const itemId = this.itemId();
    if (itemId === NO_ITEM) return NO_STACKS;
    const capacity = this.ctx.buildings.miningFor(this.miner.type)?.bufferCapacity ?? null;
    return Object.freeze([Object.freeze({ itemId, count: this.miner.outputCount, capacity })]);
  }
}

/**
 * An inserter's hand: at most one item, and only ever taken *out*.
 *
 * C14 left an inserter holding an item whose destination was demolished, and
 * gave the player a TAKE button rather than deleting it. This is that button's
 * end of the transfer.
 */
class HandPort implements ItemSource {
  private readonly inserter: NonNullable<ReturnType<typeof asInserter>>;

  constructor(inserter: NonNullable<ReturnType<typeof asInserter>>) {
    this.inserter = inserter;
  }

  peek(): ItemId {
    return inserterHolding(this.inserter) ? this.inserter.heldItem : NO_ITEM;
  }

  count(itemId: ItemId): number {
    return itemId !== NO_ITEM && this.peek() === itemId ? 1 : 0;
  }

  take(itemId: ItemId, amount: number): number {
    if (this.count(itemId) === 0 || amount < 1) return 0;
    this.inserter.heldItem = NO_ITEM;
    return 1;
  }

  stacks(): readonly PortStack[] {
    const itemId = this.peek();
    if (itemId === NO_ITEM) return NO_STACKS;
    return Object.freeze([Object.freeze({ itemId, count: 1, capacity: 1 })]);
  }
}
