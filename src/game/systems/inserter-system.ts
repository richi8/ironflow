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
 * source       a belt (its front item) | a mining buffer | a container
 * destination  a belt (if a slot fits) | a container (if a slot fits)
 * ```
 *
 * A miner is an output and has no way in; C15's furnace is the first machine
 * with an input buffer and adds an arm to `canAccept` and `deliver`, exactly
 * as it does in `belt-system.ts` and `hand-system.ts`. Those three files each
 * carry their own copy of "how an item gets into a chest" today, which is one
 * copy too many — C15 is the chunk that has to touch all three, and therefore
 * the chunk to unify them.
 */

import {
  BELT_MAX_POSITION,
  asBelt,
  beltAccept,
  beltEntryPosition,
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
import { MachineStatus } from '../entities/machine-status.js';
import { inputPortOf, outputPortOf, type PortContext } from '../items/item-port.js';
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
}

/** Is this a tile the occupancy index can be asked about without throwing? */
function inTileRange(x: number, y: number): boolean {
  return x >= TILE_MIN && x <= TILE_MAX && y >= TILE_MIN && y <= TILE_MAX;
}

export class InserterSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;

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

  constructor(options: InserterSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.ports = { buildings: options.buildings, items: options.items, recipes: options.recipes };
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
          inserter.status = MachineStatus.OutputFull;
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
    const itemId = this.sourceItem(inserter);
    if (itemId === NO_ITEM) {
      inserter.status = MachineStatus.Idle;
      return;
    }
    if (!this.hasRoom(inserter, itemId)) {
      inserter.status = MachineStatus.OutputFull;
      return;
    }
    this.enter(inserter, InserterState.Pickup);
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
    inserter.status = MachineStatus.Idle;
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
   * A belt offers its **front** item — the one nearest its output end, which
   * is `items[0]` by the invariant `belt-entity.ts` states. Everything else
   * offers whatever its output port offers, which is its lowest item id,
   * because a container's slots are kept sorted and "whatever is first" must
   * not depend on the order things were put in (§6 R4).
   */
  private sourceItem(inserter: InserterEntity): ItemId {
    const source = this.source(inserter);
    if (source === undefined) return NO_ITEM;

    const belt = asBelt(source);
    if (belt !== null) return belt.items[0]?.itemId ?? NO_ITEM;

    return outputPortOf(source, this.ports)?.peek() ?? NO_ITEM;
  }

  /**
   * Take one item out of the source. Returns what was taken, or `NO_ITEM`.
   *
   * Asked again rather than trusting what `beginCycle` saw a few ticks ago:
   * the source may have been emptied by another inserter, taken by hand, or
   * demolished in between, and this is the moment the item actually moves.
   */
  private grab(inserter: InserterEntity): ItemId {
    const source = this.source(inserter);
    if (source === undefined) return NO_ITEM;

    const belt = asBelt(source);
    if (belt !== null) return takeBeltFront(belt);

    const port = outputPortOf(source, this.ports);
    if (port === null) return NO_ITEM;
    const itemId = port.peek();
    return itemId !== NO_ITEM && port.take(itemId, 1) === 1 ? itemId : NO_ITEM;
  }

  /* ---------------------------------------------------------------- *
   * Putting down
   * ---------------------------------------------------------------- */

  /** Would the destination take this item right now? C14 task 6. */
  private hasRoom(inserter: InserterEntity, itemId: ItemId): boolean {
    const target = this.destination(inserter);
    if (target === undefined) return false;

    const belt = asBelt(target);
    if (belt !== null) return beltEntryPosition(belt, BELT_MAX_POSITION) >= 0;

    return (inputPortOf(target, this.ports)?.spaceFor(itemId) ?? 0) > 0;
  }

  /** Put the held item into the destination. Returns whether it went. */
  private deliver(inserter: InserterEntity): boolean {
    const target = this.destination(inserter);
    if (target === undefined) return false;

    const belt = asBelt(target);
    // As far forward as it fits, which is still behind everything already on
    // the tile — the same entry `belt-system.ts` gives a machine unloading,
    // so an item handed to a belt never has to cross a tile it was never on.
    if (belt !== null) return beltAccept(belt, inserter.heldItem, BELT_MAX_POSITION);

    return inputPortOf(target, this.ports)?.give(inserter.heldItem, 1) === 1;
  }
}

/**
 * Take the front item off a belt tile. `NO_ITEM` if there was none.
 *
 * `items[0]` is the item nearest the output end, and removing it keeps the
 * front-first invariant by construction: everything behind it stays in the
 * order it was in.
 */
function takeBeltFront(belt: BeltEntity): ItemId {
  const item = belt.items.shift();
  return item === undefined ? NO_ITEM : item.itemId;
}
