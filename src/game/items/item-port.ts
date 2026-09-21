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
import { asGenerator } from '../entities/generator-entity.js';
import { asInserter, inserterHolding } from '../entities/inserter-entity.js';
import { asLab } from '../entities/lab-entity.js';
import { asMachine, type MachineEntity } from '../entities/machine-entity.js';
import { asMiner, minerOutput, takeMinerOutput } from '../entities/miner-entity.js';
import type { BuildingRegistry, ProductionProperties } from '../registries/building-registry.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import type { RecipeGate, RecipeRegistry } from '../registries/recipe-registry.js';
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
  /**
   * What research has made available (C22). `ALL_UNLOCKED` for a caller with
   * no tech tree.
   *
   * A port has to consult it because "would you take this item?" is answered
   * from the recipes a machine could run, and a machine must not accept an
   * ingredient for a recipe it may not run yet — see `RecipeGate`.
   */
  readonly unlocks: RecipeGate;
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

  // A generator (C21) and a lab (C22) are deliberately absent. Each has one
  // buffer and it is an *input*, so an inserter that could reach in would take
  // the coal, or the data core, straight back out again — the shuffling this
  // function's one-way rule was written to prevent. The *player* may still
  // empty either: see `handSourceOf`.
  if (ctx.buildings.generatorFor(entity.type) !== null) return null;
  if (ctx.buildings.researchFor(entity.type) !== null) return null;

  const chest = chestPort(entity, ctx);
  if (chest !== null) return chest;

  const miner = asMiner(entity);
  if (miner !== null) return new MinerPort(miner, ctx);

  const inserter = asInserter(entity);
  if (inserter !== null) return new HandPort(inserter);

  return null;
}

/**
 * Where the **player's hand** can take an item from this building. C20.
 *
 * Every buffer a building has, not just its output: a furnace hands back its
 * ore and its coal as readily as its plates. That is the difference between
 * this and `outputPortOf`, and the difference is *who is asking*.
 *
 * ```text
 *   inserter -> outputPortOf   output only, for ever
 *   player   -> handSourceOf   output, then ingredients, then fuel
 * ```
 *
 * C15 built the one-way rule so that a furnace between two inserters could not
 * become a place items shuffle back and forth in, and that rule is untouched —
 * `InserterSystem` asks `outputPortOf` and nothing here changes what it gets.
 * What C15 did not intend, and C16 wrote down, is that the rule also caught
 * the *player*: ingredients left in a machine because the bag was full could
 * only be recovered by switching the recipe twice.
 *
 * The order is output, input, fuel — what the player most likely wants, then
 * what they put in. It only matters when a machine holds the same item in two
 * buffers, which no valid recipe allows (`RecipeRegistry` refuses an item that
 * is both an ingredient and a product), so in practice it is a formality that
 * keeps the function total.
 */
export function handSourceOf(entity: Entity, ctx: PortContext): ItemSource | null {
  // A generator's fuel is the whole of what it holds, and C20's rule — the
  // player may take back anything they put in — applies to it unchanged.
  const generator = generatorPort(entity, ctx);
  if (generator !== null) return generator;

  // A lab's science is the whole of what it holds, and C20's rule — the player
  // may take back anything they put in — applies to it unchanged.
  const lab = labPort(entity, ctx);
  if (lab !== null) return lab;

  const machine = asMachine(entity, ctx.buildings);
  if (machine === null) return outputPortOf(entity, ctx);

  const buffers = machineBuffers(machine, production(entity, ctx));
  return unionSource([buffers.output, buffers.input, buffers.fuel]);
}

/**
 * Several sources read as one, in order. For `handSourceOf`.
 *
 * Takes from the first that has any, and keeps taking from the next until the
 * amount is met — partial and honest, like every transfer in the game (C08).
 */
function unionSource(sources: readonly ItemSource[]): ItemSource {
  return {
    peek(): ItemId {
      for (const source of sources) {
        const itemId = source.peek();
        if (itemId !== NO_ITEM) return itemId;
      }
      return NO_ITEM;
    },
    count(itemId: ItemId): number {
      let total = 0;
      for (const source of sources) total += source.count(itemId);
      return total;
    },
    take(itemId: ItemId, amount: number): number {
      let taken = 0;
      for (const source of sources) {
        if (taken >= amount) break;
        taken += source.take(itemId, amount - taken);
      }
      return taken;
    },
    stacks(): readonly PortStack[] {
      const out: PortStack[] = [];
      for (const source of sources) out.push(...source.stacks());
      return Object.freeze(out);
    },
  };
}

/**
 * Where an item can be put into this building, or null if nowhere.
 *
 * For a machine this routes: anything that burns goes in the fuel buffer, and
 * anything the recipe it is running wants goes in the input buffer. Nothing
 * else is accepted, so an inserter pointed at a furnace with copper plates on
 * its belt waits with empty hands instead of silting the furnace up with
 * something it can never smelt (C14 task 6). See `MachineInputPort` for what
 * a machine that has not chosen a recipe yet will take.
 */
export function inputPortOf(entity: Entity, ctx: PortContext): ItemSink | null {
  const machine = asMachine(entity, ctx.buildings);
  if (machine !== null) return new MachineInputPort(machine, production(entity, ctx), ctx);

  const generator = generatorPort(entity, ctx);
  if (generator !== null) return generator;

  const lab = labPort(entity, ctx);
  if (lab !== null) return lab;

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

/**
 * A generator's fuel buffer, as both directions of port. Null if not one (C21).
 *
 * It **accepts only what burns**, which is C14 task 6's rule applied to a
 * building with one buffer: an inserter pointed at a generator with iron ore
 * on the belt beside it waits with empty hands rather than filling the one
 * slot the generator has with something it can never light. The test is the
 * item's own `fuelSeconds` (§15's fuel note), so nothing here knows what coal
 * is.
 */
function generatorPort(entity: Entity, ctx: PortContext): (ItemSource & ItemSink) | null {
  const config = ctx.buildings.generatorFor(entity.type);
  if (config === null) return null;
  const generator = asGenerator(entity, ctx.buildings);
  if (generator === null) return null;

  const buffer = bufferPort(generator.fuel, config.fuelCapacity);
  // **The six keys are in `containerPort`'s order, and they have to stay that
  // way.** Two object literals with the same key sequence share a hidden
  // class; two that differ do not, and every call site that reads a port —
  // `production-system.ts` reads three per machine per tick — becomes
  // polymorphic the moment there are two shapes. Measured, on a thousand
  // furnaces, at more than everything else C21 added to the tick put together.
  //
  // A filter parameter on `containerPort` was the other way to keep one shape.
  // It was also measurably worse: it costs an extra closure variable on every
  // container in the game to spare one branch on a building most factories
  // have three of.
  return {
    peek: () => buffer.peek(),
    count: (itemId) => buffer.count(itemId),
    take: (itemId, amount) => buffer.take(itemId, amount),
    spaceFor: (itemId) => (ctx.items.fuelTicksOf(itemId) > 0 ? buffer.spaceFor(itemId) : 0),
    give: (itemId, amount) => (ctx.items.fuelTicksOf(itemId) > 0 ? buffer.give(itemId, amount) : 0),
    stacks: () => buffer.stacks(),
  };
}

/**
 * A lab's science buffer, as both directions of port. Null if not one (C22).
 *
 * It **accepts only science items**, which is the generator's rule with a
 * different test: an inserter pointed at a lab with iron plates on the belt
 * beside it waits with empty hands rather than filling the one buffer the lab
 * has with something it can never spend. The test is the item's own category
 * (§15), so nothing here knows what a data core is.
 */
function labPort(entity: Entity, ctx: PortContext): (ItemSource & ItemSink) | null {
  const config = ctx.buildings.researchFor(entity.type);
  if (config === null) return null;
  const lab = asLab(entity, ctx.buildings);
  if (lab === null) return null;

  const buffer = bufferPort(lab.input, config.inputCapacity);
  // The six keys in `containerPort`'s order, for the reason `generatorPort`
  // spells out: two port shapes make every call site that reads one
  // polymorphic.
  return {
    peek: () => buffer.peek(),
    count: (itemId) => buffer.count(itemId),
    take: (itemId, amount) => buffer.take(itemId, amount),
    spaceFor: (itemId) => (ctx.items.isScience(itemId) ? buffer.spaceFor(itemId) : 0),
    give: (itemId, amount) => (ctx.items.isScience(itemId) ? buffer.give(itemId, amount) : 0),
    stacks: () => buffer.stacks(),
  };
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
 *
 * Three of these are read per machine per tick, which makes this one of the
 * few genuinely hot constructors in the simulation. Anything else that builds
 * a port must produce **the same six keys in the same order** so that the call
 * sites stay monomorphic — see `generatorPort`, which is the only other one.
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
 *
 * ## What an ingredient buffer accepts (C16)
 *
 * **A machine that knows what it is making takes that recipe's ingredients and
 * nothing else.** C15 asked the *category* instead, which was the same answer
 * while every machine in the game picked its recipe from its own buffer. It
 * stops being the same answer the moment a machine is *told*: an assembler set
 * to make gears, with a copper plate on the belt beside it, would fill fifty
 * slots of its input with an ingredient it will never spend, and the player
 * would be left reading a full buffer under the word "missing ingredients".
 * That is C14 task 6's rule — an inserter waits rather than silting a machine
 * up with something it cannot use — now that a machine can say which is which.
 *
 * A machine with no recipe yet falls back to the category, and a machine whose
 * recipe is the player's falls back to *nothing*: until it is told, there is
 * no answer to "will you want this?" that is not a guess.
 */
class MachineInputPort implements ItemSink {
  private readonly ctx: PortContext;
  private readonly config: ProductionProperties;
  private readonly machine: MachineEntity;
  private readonly buffers: MachinePorts;

  constructor(machine: MachineEntity, config: ProductionProperties, ctx: PortContext) {
    this.ctx = ctx;
    this.config = config;
    this.machine = machine;
    this.buffers = machineBuffers(machine, config);
  }

  /** The buffer this item belongs in, or null when the machine refuses it. */
  private route(itemId: ItemId): ItemSink | null {
    if (itemId === NO_ITEM) return null;
    if (this.config.fuelCapacity !== undefined && this.ctx.items.fuelTicksOf(itemId) > 0) return this.buffers.fuel;
    return this.wants(itemId) ? this.buffers.input : null;
  }

  /** Is this item an ingredient of what the machine is making, or could make? */
  private wants(itemId: ItemId): boolean {
    const recipe = this.ctx.recipes.isRecipeId(this.machine.recipe)
      ? this.ctx.recipes.byId(this.machine.recipe)
      : null;
    if (recipe !== null && recipe.category === this.config.category) {
      return recipe.inputs.some((stack) => stack.itemId === itemId);
    }
    if (this.config.recipeSelection === 'player') return false;
    return this.ctx.recipes.acceptsInput(this.config.category, itemId, this.ctx.unlocks);
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
