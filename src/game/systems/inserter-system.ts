/**
 * Inserters. See ironflow.md C14 and §8 phase 6.
 *
 * The connective tissue. A belt carries items along itself and a chest holds
 * them; an inserter is the only thing in the game that moves an item *across*
 * the boundary between two buildings, which makes it the piece that turns a
 * miner, a belt and a chest into a factory instead of three machines standing
 * near each other.
 *
 * ```text
 *        [source]  <- the tile behind, by rotation
 *            |
 *        [inserter]
 *            |
 *        [destination]  <- the tile in front
 * ```
 *
 * ## Why this runs after belts
 *
 * §8 puts inserters in phase 6 and belts in phase 5, and says why: an inserter
 * picks up from a belt's *settled* position. Were it the other way round, what
 * an inserter found on the tile beside it would depend on whether that belt had
 * moved yet this tick, and throughput would oscillate with the order the belts
 * happened to be walked in. Reading a belt that has finished moving makes the
 * grab a question with one answer.
 *
 * ## Contention is settled by entity id, and it is settled by the grab
 *
 * §6 R6: two inserters reaching for the same belt item, lowest id wins. That
 * falls out of two decisions rather than out of a rule written here. Inserters
 * are walked in the entity store's id-ordered array (§6 R4), and the item is
 * removed from the source at the *instant* the pickup completes — so the lower
 * id takes it and the higher id, reaching for it the same tick, finds the belt
 * empty and returns to idle. No reservation, no ordering table, nothing to
 * keep in step across a save.
 *
 * ## The hand is never emptied except into a destination
 *
 * C14 task 6 says not to pick up an item that cannot be dropped, and this
 * checks the destination has room at pickup time — so the *ordinary* stall is
 * an inserter waiting with **empty hands** and reporting `output_full`, which
 * is the chunk's second acceptance criterion.
 *
 * What task 6 cannot prevent is the destination being demolished while the arm
 * is already swinging. The item is out of the belt by then and exists nowhere
 * but the hand, so there are three possible answers: destroy it, put it on the
 * ground, or hold it. This holds it — `Drop` simply does not complete, the
 * inserter reports `output_full`, and the moment anything with room appears in
 * front of it the item goes in. Nothing in IronFlow deletes an item the player
 * mined, and there is no such thing as an item lying on the ground (§2). The
 * held item is visible in the inspector and can be taken back by hand
 * (`HandSystem`), so it is not hostage either.
 *
 * ## What counts as a source and what counts as a destination
 *
 * Content, never an id (§19 rule 17), and the same tests the belt system and
 * the hand system already make:
 *
 * ```text
 * source       a belt (any item on it) | a mining buffer | a container
 * destination  a belt (if a slot fits) | a container (if a slot fits)
 * ```
 *
 * A miner is an output and has no way in; C15's furnace is the first machine
 * with an input buffer and adds an arm to `canAccept` and `deliver`, exactly
 * as it does in `belt-system.ts` and `hand-system.ts`. Those three files each
 * carry their own copy of "how an item gets into a chest" today, which is one
 * copy too many — C15 is the chunk that has to touch all three, and therefore
 * the chunk to unify them.
 *
 * ## Which item it reaches for (2026-09-23)
 *
 * An inserter takes **only what the thing in front of it will accept**, and
 * looks past anything that will not:
 *
 * ```text
 * belt source   the front-most item on the tile the destination accepts
 * other source  into a machine with a recipe: the neediest ingredient (below)
 *               into anything else: the first stack, in slot order, it accepts
 * ```
 *
 * Until then an inserter offered the destination one item — a belt's front
 * item, a chest's first stack — and stalled if it was refused. A chest of
 * iron and copper beside an assembler making circuits fed whichever stack sat
 * in slot 0 until the assembler's buffer for it was full, and a single stray
 * item at the front of a stopped belt blocked an arm for ever.
 *
 * **Neediest** is the ingredient whose buffer holds the smallest share of what
 * one craft consumes — `have / need`, compared by cross-multiplication so it
 * stays in integers (§6 R3). An ingredient the machine is short of therefore
 * always comes before one it has enough of, and among ingredients it has
 * enough of the buffers fill in step with the recipe rather than one at a
 * time. A machine that burns fuel counts its fuel buffer as one more
 * ingredient needing one item. Ties go to recipe order, then fuel, so the
 * answer never depends on how the chest happens to be laid out (§6 R4).
 */

import {
  BELT_MAX_POSITION,
  asBelt,
  laneAccept,
  laneEntryPosition,
  type BeltEntity,
} from '../entities/belt-entity.js';
import type { EntityStore } from '../entities/entity-store.js';
import { ENTITY_TYPE_COUNT, EntityType } from '../entities/entity-types.js';
import type { Entity } from '../entities/entity.js';
import {
  InserterState,
  inserterStageTicks,
  type InserterEntity,
} from '../entities/inserter-entity.js';
import { asChest } from '../entities/chest-entity.js';
import { asMachine, type MachineEntity } from '../entities/machine-entity.js';
import { MachineStatus } from '../entities/machine-status.js';
import type { AlertLog } from '../alerts.js';
import { slotsCount } from '../items/inventory.js';
import {
  inputPortOf,
  outputPortOf,
  type ItemSink,
  type ItemSource,
  type PortContext,
} from '../items/item-port.js';
import type { Unlocks } from '../research/unlocks.js';
import type { BuildingRegistry, InserterConfig } from '../registries/building-registry.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import type { RecipeRegistry } from '../registries/recipe-registry.js';
import { DIRECTION_OFFSETS, TILE_MAX, TILE_MIN, type Rotation } from '../world/coordinates.js';

export interface InserterSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  /** Needed to turn a miner's resource into a runtime item id, and for stacks. */
  readonly items: ItemRegistry;
  /** Needed to know what a machine beside it will accept (C15). */
  readonly recipes: RecipeRegistry;
  /**
   * What research has revealed (C22). Held only to build the port context: a
   * machine's input port asks it what a machine would accept.
   */
  readonly unlocks: Unlocks;
  /** Where "this inserter is pointed at nothing" is reported (C20). */
  readonly alerts: AlertLog;
}

/**
 * How many crafts' worth of each ingredient an inserter keeps in a machine
 * (2026-09-24). Enough that a machine never waits on an arm mid-run, few
 * enough that one furnace does not swallow a whole belt the machine beside it
 * is waiting on.
 */
const FEED_CRAFTS = 5;

/** Is this a tile the occupancy index can be asked about without throwing? */
function inTileRange(x: number, y: number): boolean {
  return x >= TILE_MIN && x <= TILE_MAX && y >= TILE_MIN && y <= TILE_MAX;
}

export class InserterSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;

  private readonly alerts: AlertLog;

  /**
   * What every neighbour that is not a belt offers and accepts (C15).
   *
   * C14 had a branch here per kind of neighbour — miner, chest, nothing — and
   * C15 would have added two more for the furnace's two buffers. They live in
   * `items/item-port.ts` instead, so this system knows only "take one from the
   * thing behind me, put one into the thing in front of me".
   */
  private readonly ports: PortContext;

  /**
   * Inserter timings by entity type, resolved once.
   *
   * An array read rather than a `Map` lookup, for the reason `BeltSystem`
   * caches belt speeds the same way: this is asked once per inserter per tick,
   * and content is frozen at construction so caching it cannot go stale.
   */
  private readonly configs: readonly (InserterConfig | null)[];

  /**
   * Whether the last `choose` found anything at all behind the inserter — the
   * difference between "nothing to take" and "nothing it may take". Scratch,
   * written by every `choose` and read straight after; never authoritative.
   */
  private sourceHeldAny = false;

  /** Every item that burns, in id order: what a fuelled machine may be fed. */
  private readonly fuels: readonly ItemId[];

  constructor(options: InserterSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.alerts = options.alerts;
    this.ports = {
      buildings: options.buildings,
      items: options.items,
      recipes: options.recipes,
      unlocks: options.unlocks,
    };
    this.fuels = Object.freeze(
      options.items
        .all()
        .map((definition) => options.items.idOf(definition.id))
        .filter((itemId) => options.items.fuelTicksOf(itemId) > 0)
        .sort((a, b) => a - b),
    );
    this.configs = Object.freeze(
      Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) =>
        this.buildings.inserterFor(type as EntityType),
      ),
    );
  }

  /** Phase 6. Every inserter, in ascending entity id (§6 R4, R6). */
  tick(): void {
    const inserters = this.entities.byType<InserterEntity>(EntityType.Inserter);
    const count = inserters.length;
    for (let i = 0; i < count; i++) {
      const inserter = inserters[i];
      if (inserter !== undefined) this.advance(inserter);
    }
  }

  /**
   * One tick of one inserter.
   *
   * `Idle` is handled first and returns, because it is the one state with no
   * duration: it is a decision rather than a stage, and giving it a tick of
   * its own would make every cycle one tick longer than the content says.
   */
  private advance(inserter: InserterEntity): void {
    const config = this.configs[inserter.type];
    // An inserter bucket entry whose building has no inserter content:
    // unreachable through `initialBuildingState`, and an honest no-op rather
    // than a throw if content is ever edited mid-flight.
    if (config === null || config === undefined) return;

    if (inserter.state === InserterState.Idle) {
      this.beginCycle(inserter);
      return;
    }

    const duration = inserterStageTicks(inserter.state, config);
    inserter.stateTicks += 1;
    if (inserter.stateTicks < duration) {
      inserter.status = MachineStatus.Running;
      return;
    }
    // Clamped rather than left to grow: a `Drop` that cannot complete is
    // retried every tick, and an unbounded counter in authoritative state is a
    // number that differs between a live session and a reloaded one.
    inserter.stateTicks = duration;

    switch (inserter.state) {
      case InserterState.Pickup: {
        const taken = this.grab(inserter);
        if (taken === NO_ITEM) {
          // The source emptied, or was demolished, while the arm was reaching.
          // Nothing was ever in the hand, so there is nothing to drop and
          // nothing to put back — C14's third acceptance criterion exactly.
          this.park(inserter);
          return;
        }
        inserter.heldItem = taken;
        this.enter(inserter, InserterState.Carrying);
        return;
      }
      case InserterState.Carrying:
        this.enter(inserter, InserterState.Drop);
        return;
      case InserterState.Drop: {
        // An empty hand at the drop means the player took the item out of it
        // (`HandSystem`). There is nothing to deliver and no reason to stall.
        if (inserter.heldItem !== NO_ITEM && !this.deliver(inserter)) {
          this.setStatus(inserter, this.canEverDeliver(inserter) ? MachineStatus.OutputFull : MachineStatus.NoDestination);
          return;
        }
        inserter.heldItem = NO_ITEM;
        this.enter(inserter, InserterState.Returning);
        return;
      }
      case InserterState.Returning:
        // Straight on to the next pickup, in this tick: an inserter with work
        // waiting never rests in `Idle`, which is what makes the rate exactly
        // one item per `ticksPerItem` ticks.
        inserter.state = InserterState.Idle;
        inserter.stateTicks = 0;
        this.beginCycle(inserter);
        return;
    }
  }

  /**
   * Decide whether to start a cycle, and say why not if not.
   *
   * Both halves of C14 task 6 live here: an inserter looks at what it would
   * take *and* at whether the far end has room for it, and only then commits.
   * The destination check is what keeps a stalled inserter's hands empty.
   */
  private beginCycle(inserter: InserterEntity): void {
    // Asked before the source, and it is the only ordering question here worth
    // a comment: an inserter pointed at bare ground is misconfigured whether
    // or not there is anything behind it to pick up, and telling the player
    // "nothing to take" about an arm that could never deliver would send them
    // to look at the wrong end of it (C20).
    if (!this.canEverDeliver(inserter)) {
      this.setStatus(inserter, MachineStatus.NoDestination);
      return;
    }

    if (this.choose(inserter) === NO_ITEM) {
      // Something to take that nothing in front will have is the same stall,
      // to the player, as a full destination: the arm waits with empty hands
      // until the far end changes.
      this.setStatus(inserter, this.sourceHeldAny ? MachineStatus.OutputFull : MachineStatus.Idle);
      return;
    }
    this.enter(inserter, InserterState.Pickup);
  }

  /**
   * Is there anything in front of this inserter that could **ever** take an
   * item from it? C20.
   *
   * The question C14 never asked, and C17 noticed the consequence of: a
   * splitter has no input port, so an inserter aimed at one reported a full
   * output for ever and the player was told to empty something that was never
   * full. So is an inserter aimed at bare ground, at water, or at a second
   * inserter.
   *
   * It asks about the *destination's shape* and not about its contents, which
   * is what separates it from the room check in `choose`: a chest with no
   * room is a chest that will have room, and a splitter will never have a port.
   */
  private canEverDeliver(inserter: InserterEntity): boolean {
    const target = this.destination(inserter);
    if (target === undefined) return false;
    return asBelt(target) !== null || inputPortOf(target, this.ports) !== null;
  }

  /** Begin a timed stage. */
  private enter(inserter: InserterEntity, state: InserterState): void {
    inserter.state = state;
    inserter.stateTicks = 0;
    inserter.status = MachineStatus.Running;
  }

  /** Abandon the cycle with empty hands and wait for the next tick. */
  private park(inserter: InserterEntity): void {
    inserter.state = InserterState.Idle;
    inserter.stateTicks = 0;
    this.setStatus(inserter, MachineStatus.Idle);
  }

  /**
   * Record the status, raising an alert on the transition into one the player
   * has to act on.
   *
   * The same shape `MiningSystem` and `ProductionSystem` use, and the same
   * reason: the condition is true every tick that follows, and a toast per
   * tick is how a legible game becomes an unreadable one. See
   * `views/alert.ts` on why `no_destination` is worth a toast and
   * `output_full` is not.
   */
  private setStatus(inserter: InserterEntity, status: MachineStatus): void {
    if (inserter.status === status) return;
    inserter.status = status;
    if (status === MachineStatus.NoDestination) {
      this.alerts.push({
        type: 'inserter_no_destination',
        entityId: inserter.id,
        x: inserter.x,
        y: inserter.y,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * The two neighbours
   * ---------------------------------------------------------------- */

  /** The entity behind this inserter — what it takes from. */
  private source(inserter: InserterEntity): Entity | undefined {
    return this.neighbour(inserter, ((inserter.rotation + 2) % 4) as Rotation);
  }

  /** The entity in front of this inserter — what it puts into. */
  private destination(inserter: InserterEntity): Entity | undefined {
    return this.neighbour(inserter, inserter.rotation);
  }

  /**
   * The entity one step away in `direction`, or undefined for nothing usable.
   *
   * C14 task 3: never assume a neighbour still exists. A building demolished
   * earlier this tick holds its tiles until cleanup (C05), so it is filtered
   * here — taking from it would delete the item along with it, and putting
   * into it would do the same.
   */
  private neighbour(inserter: InserterEntity, direction: Rotation): Entity | undefined {
    const step = DIRECTION_OFFSETS[direction];
    if (step === undefined) return undefined;

    const x = inserter.x + step.x;
    const y = inserter.y + step.y;
    if (!inTileRange(x, y)) return undefined;

    const target = this.entities.at(x, y);
    if (target === undefined) return undefined;
    return this.entities.isPendingRemoval(target.id) ? undefined : target;
  }

  /* ---------------------------------------------------------------- *
   * Taking
   * ---------------------------------------------------------------- */

  /**
   * What this inserter would pick up, without taking it. `NO_ITEM` for nothing.
   *
   * Only ever an item the destination has room for right now — C14 task 6 —
   * and see the file header for which one when several qualify. A belt's items
   * are looked at front first, which is `items` in order by the invariant
   * `belt-entity.ts` states; every other source through its output port.
   *
   * `atPickup` is the second asking, from `grab`, and it lets a belt in front
   * be full: the arm already committed to it in `beginCycle`, and it holds the
   * item at the drop until a slot opens, as it always has. Re-checking there
   * would park it empty-handed each time the belt behind it filled the gap
   * first, and an inserter merging onto a busy belt would never get on.
   */
  private choose(inserter: InserterEntity, atPickup = false): ItemId {
    this.sourceHeldAny = false;
    const source = this.source(inserter);
    if (source === undefined) return NO_ITEM;

    // What is behind first, and before building anything for what is in
    // front: most arms that stop to decide are waiting on an empty source,
    // and for them this is the whole answer, as cheaply as C14's.
    const belt = asBelt(source);
    const port = belt === null ? outputPortOf(source, this.ports) : null;
    const first = belt !== null ? (belt.items[0]?.itemId ?? NO_ITEM) : (port?.peek() ?? NO_ITEM);
    if (first === NO_ITEM) return NO_ITEM;
    this.sourceHeldAny = true;

    const target = this.destination(inserter);
    if (target === undefined) return NO_ITEM;

    const targetBelt = asBelt(target);
    if (targetBelt !== null) {
      // A belt takes anything while its tile has a slot.
      return atPickup || laneEntryPosition(targetBelt.items, BELT_MAX_POSITION) >= 0 ? first : NO_ITEM;
    }

    const sink = this.feedPortOf(target);
    if (sink === null) return NO_ITEM;

    // A refused item is not asked about twice in a row: a belt of plates in
    // front of a full machine is one refusal, not four.
    if (belt !== null) {
      let refused = NO_ITEM;
      for (const item of belt.items) {
        if (item.itemId === refused) continue;
        if (sink.spaceFor(item.itemId) > 0) return item.itemId;
        refused = item.itemId;
      }
      return NO_ITEM;
    }
    if (port === null) return NO_ITEM;

    // Only a chest holds several kinds of item worth choosing between. A miner
    // offers one, and a machine's output is its recipe's product, so both keep
    // C14's single question — which is also what keeps a stalled arm cheap.
    if (asChest(source) === null) return sink.spaceFor(first) > 0 ? first : NO_ITEM;

    const machine = asMachine(target, this.buildings);
    if (machine !== null) {
      const needed = this.neediest(port, machine, sink);
      if (needed !== undefined) return needed;
    }

    // The common case first, and without building a list: the first stack is
    // one the destination takes.
    if (sink.spaceFor(first) > 0) return first;
    let refused = first;
    for (const stack of port.stacks()) {
      if (stack.itemId === refused) continue;
      if (sink.spaceFor(stack.itemId) > 0) return stack.itemId;
      refused = stack.itemId;
    }
    return NO_ITEM;
  }

  /**
   * What the destination accepts **from an arm**, as against by hand or off a
   * belt: a machine's ingredient buffer only up to `FEED_CRAFTS` crafts' worth
   * (2026-09-24). Anything that is not a machine, and fuel, is its own port.
   *
   * The count includes what is already there however it got there, so a
   * furnace the player stuffed with fifty ore by hand is left alone until it
   * has smelted it down below five. Only the pickup asks: an item already in
   * the hand is delivered whatever the buffer holds, so the ceiling is at most
   * one item soft and nothing is ever stranded in an arm.
   */
  private feedPortOf(target: Entity): ItemSink | null {
    const sink = inputPortOf(target, this.ports);
    if (sink === null) return null;
    const machine = asMachine(target, this.buildings);
    const config = machine === null ? null : this.buildings.productionFor(machine.type);
    if (machine === null || config === null) return sink;

    const ports = this.ports;
    return {
      spaceFor(itemId: ItemId): number {
        const room = sink.spaceFor(itemId);
        if (room === 0) return 0;
        if (config.fuelCapacity !== undefined && ports.items.fuelTicksOf(itemId) > 0) return room;
        const current = ports.recipes.isRecipeId(machine.recipe) ? ports.recipes.byId(machine.recipe) : null;
        const recipe =
          current !== null && current.category === config.category
            ? current
            : ports.recipes.forInput(config.category, itemId, ports.unlocks);
        const need = recipe?.inputs.find((stack) => stack.itemId === itemId)?.count ?? 0;
        if (need === 0) return room;
        return Math.max(0, Math.min(room, FEED_CRAFTS * need - slotsCount(machine.input, itemId)));
      },
      give: (itemId, amount) => sink.give(itemId, amount),
      stacks: () => sink.stacks(),
    };
  }

  /**
   * The ingredient `machine` is shortest of that `source` can supply, or
   * `NO_ITEM` for none; `undefined` when the machine has no recipe to be short
   * against and the caller should fall back to slot order. See the file header.
   */
  private neediest(source: ItemSource, machine: MachineEntity, sink: ItemSink): ItemId | undefined {
    const recipes = this.ports.recipes;
    if (!recipes.isRecipeId(machine.recipe)) return undefined;
    const recipe = recipes.byId(machine.recipe);
    const config = this.buildings.productionFor(machine.type);
    if (config === null || recipe.category !== config.category) return undefined;

    let best = NO_ITEM;
    let bestHave = 0;
    let bestNeed = 1;
    for (const input of recipe.inputs) {
      const itemId = input.itemId;
      if (source.count(itemId) === 0 || sink.spaceFor(itemId) === 0) continue;
      const have = slotsCount(machine.input, itemId);
      if (best === NO_ITEM || have * bestNeed < bestHave * input.count) {
        best = itemId;
        bestHave = have;
        bestNeed = input.count;
      }
    }

    if (config.fuelCapacity !== undefined) {
      let fuelHave = 0;
      for (const entry of machine.fuel) fuelHave += entry[1];
      for (const itemId of this.fuels) {
        if (source.count(itemId) === 0 || sink.spaceFor(itemId) === 0) continue;
        if (best === NO_ITEM || fuelHave * bestNeed < bestHave) {
          best = itemId;
          bestHave = fuelHave;
          bestNeed = 1;
        }
        // One fuel is enough to rank: the buffer is shared, so every fuel
        // the source holds is exactly as needed as the first.
        break;
      }
    }
    return best;
  }

  /**
   * Take one item out of the source. Returns what was taken, or `NO_ITEM`.
   *
   * Chosen again rather than trusting what `beginCycle` saw a few ticks ago:
   * the source may have been emptied by another inserter, taken by hand, or
   * demolished in between, the destination may have filled, and this is the
   * moment the item actually moves.
   */
  private grab(inserter: InserterEntity): ItemId {
    const source = this.source(inserter);
    if (source === undefined) return NO_ITEM;

    // With one kind of item behind it there is nothing to choose, and the arm
    // takes it as C14's did, without building the destination's port a second
    // time a cycle.
    const belt = asBelt(source);
    if (belt !== null) {
      if (uniform(belt)) return takeBeltItem(belt, belt.items[0]?.itemId ?? NO_ITEM);
      return takeBeltItem(belt, this.choose(inserter, true));
    }

    const port = outputPortOf(source, this.ports);
    if (port === null) return NO_ITEM;
    const itemId = asChest(source) === null ? port.peek() : this.choose(inserter, true);
    return itemId !== NO_ITEM && port.take(itemId, 1) === 1 ? itemId : NO_ITEM;
  }

  /* ---------------------------------------------------------------- *
   * Putting down
   * ---------------------------------------------------------------- */

  /** Put the held item into the destination. Returns whether it went. */
  private deliver(inserter: InserterEntity): boolean {
    const target = this.destination(inserter);
    if (target === undefined) return false;

    const belt = asBelt(target);
    // As far forward as it fits, which is still behind everything already on
    // the tile — the same entry `belt-system.ts` gives a machine unloading,
    // so an item handed to a belt never has to cross a tile it was never on.
    if (belt !== null) return laneAccept(belt.items, inserter.heldItem, BELT_MAX_POSITION);

    return inputPortOf(target, this.ports)?.give(inserter.heldItem, 1) === 1;
  }
}

/**
 * Take the front-most `itemId` off a belt tile. `NO_ITEM` if there was none.
 *
 * Front-most because `choose` looked front first, so this is the item it
 * chose. Removing any one item keeps the front-first invariant by
 * construction: everything else stays in the order it was in, and the gap
 * closes as the items behind it advance.
 */
function takeBeltItem(belt: BeltEntity, itemId: ItemId): ItemId {
  if (itemId === NO_ITEM) return NO_ITEM;
  const index = belt.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) return NO_ITEM;
  belt.items.splice(index, 1);
  return itemId;
}

/** Is every item on this belt tile the same item? True for an empty one. */
function uniform(belt: BeltEntity): boolean {
  const items = belt.items;
  const first = items[0]?.itemId;
  for (let i = 1; i < items.length; i++) if (items[i]?.itemId !== first) return false;
  return true;
}
