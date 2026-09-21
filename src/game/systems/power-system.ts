/**
 * Phase 2: power. See ironflow.md C21 and §8.
 *
 * Power runs **first**, before anything that could spend it, so that every
 * machine in a tick sees one satisfaction ratio (§8). That is the whole reason
 * this phase exists ahead of mining and production rather than beside them: a
 * ratio computed while machines were already consuming would depend on the
 * order they were visited in, which is the class of bug §6 R4 and R6 exist to
 * prevent.
 *
 * ## The model, in four sentences
 *
 * A **pole** covers a square of tiles and links to other poles within its wire
 * reach. Poles linked directly or indirectly form one **network** — a
 * connected component, §10's "belt network topology" entry applied to wires
 * and, like it, derived state that is rebuilt rather than saved. Everything
 * that draws or supplies power joins the network of the **lowest-id pole**
 * covering any tile of its footprint (§6 R6: contention resolved by id), or no
 * network at all. Each tick a network's supply and demand are summed and the
 * quotient is its satisfaction.
 *
 * ```text
 *   satisfaction = min(1, supply / demand)      demand 0 -> fully satisfied
 * ```
 *
 * ## Fuel follows the load
 *
 * Supply is the capacity of every generator that *could* run; a generator's
 * fuel is then spent at `demand / supply`, by the same Bresenham step. So a
 * 900 kW generator over a network asking for 150 kW burns a sixth of the coal
 * — which is what makes an electric furnace cost exactly the coal a burner
 * furnace would at any load, not only at a full one. See `burnFuel`.
 *
 * ## Demand is what is built, not what is running
 *
 * A consumer on a network demands its full rating every tick it exists, even
 * while it is starved of ingredients or has no recipe. The alternative —
 * demand from machines that *would* run — is circular: whether a machine runs
 * is decided in phases 3 and 4, out of a ratio this phase has already had to
 * produce. It is also the wrong game. C21's goal is "a resource that
 * constrains layout rather than adding arithmetic", and a power budget the
 * player can read off what they have built is a constraint they can plan
 * against; one that drifts with the state of every buffer in the factory is a
 * number that moves while they are looking at it.
 *
 * ## Partial satisfaction, without a float and without a field
 *
 * C21 task 4 asks for "a fixed-point progress numerator rather than a float",
 * and the shipped answer is the same arithmetic with no stored numerator at
 * all. A machine at 60% must advance 0.6 ticks of progress per tick; since
 * progress is integer (§6 R3), that means working on 60% of ticks. Which
 * ticks is decided by a Bresenham step over the **tick counter**:
 *
 * ```text
 *   works this tick  <=>  floor(t * sat / SCALE) > floor((t-1) * sat / SCALE)
 * ```
 *
 * The long-run rate is exact, every machine on a network skips the same ticks
 * — "slows every machine on the network equally", C21's second acceptance
 * criterion, taken literally — and there is nothing to serialize, so a save
 * taken mid-brownout reloads into the same schedule rather than a rephased
 * one (§6 R8). An accumulator per machine would have been a new field on three
 * entity shapes and a new way for a save to be subtly wrong.
 *
 * ## What is rebuilt, and when
 *
 * Nothing here is authoritative state (§10). The pole graph is rebuilt when
 * the **set of poles** changes and at no other time: adding a belt, a machine
 * or a generator costs nothing, and a factory can be built out to twenty
 * thousand entities without the networks being recomputed once except by the
 * poles themselves. Consumers and generators are not indexed at all — they
 * look their network up from the coverage map as they are walked, which is a
 * handful of integer-keyed lookups on the same pass that has to sum them
 * anyway. C21 task 3's "incremental" is that: the cost of a change is
 * proportional to the poles, never to the entities.
 */

import type { AlertLog } from '../alerts.js';
import type { EntityStore } from '../entities/entity-store.js';
import { asGenerator, type GeneratorEntity } from '../entities/generator-entity.js';
import {
  UNIT_FOOTPRINT,
  footprintExtent,
  type Entity,
  type EntityId,
  type Footprint,
} from '../entities/entity.js';
import { BufferInventory } from '../items/inventory.js';
import { MachineStatus } from '../entities/machine-status.js';
import { ENTITY_TYPE_COUNT, type EntityType } from '../entities/entity-types.js';
import type { BuildingRegistry, GeneratorProperties, PowerProperties } from '../registries/building-registry.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import { TILE_MAX, TILE_MIN, tileKey } from '../world/coordinates.js';

/**
 * The denominator of a satisfaction ratio, and the only place power meets
 * fractions.
 *
 * A thousand rather than a power of two, because the number a player is shown
 * is a percentage and a tenth of a percent is finer than anything they can
 * act on. It stays exact in the Bresenham step for any tick count a real game
 * can reach: `tick * SCALE` is integral in a double up to 9e12 ticks, which is
 * some nine thousand years at 30 TPS.
 */
export const POWER_SCALE = 1000;

/**
 * The power a fuel buffer burns at when nothing says otherwise, in kilowatts.
 *
 * **Derived, not chosen.** §15 gives coal an 8-second burn in a machine with a
 * fuel buffer *and* gives the generator 900 kW at 0.75 coal/s. Those two rows
 * only agree if a coal is worth `900 / 0.75 = 1200 kJ`, and 1200 kJ over 8 s
 * is 150 kW. So this is the constant that makes §15 consistent with itself,
 * and the reason C15's furnace needed no change: a burner with no power rating
 * burns at exactly this rate, which is the eight seconds it always had.
 *
 * It is also what makes C21's electric furnace an honest choice rather than an
 * upgrade — it draws 150 kW, so six of them cost a generator exactly the coal
 * that six burner furnaces would have eaten. What the player buys with the
 * poles and the generator is one coal line instead of six.
 */
export const FUEL_REFERENCE_KW = 150;

/** "Not on any network." Never a valid network index. */
export const NO_NETWORK = -1;

/**
 * What the power phase has to say about one building, asked in phases 3–8.
 *
 * Five answers rather than a boolean, because the three that mean "do not work
 * this tick" want three different things said to the player (pillar 3): one is
 * not connected, one is on a network that cannot keep up, and one is simply
 * between the ticks its share of the power buys it.
 */
export enum PowerGate {
  /** This building takes no power. It runs, and reports `running`. */
  Free = 0,
  /** Connected and fully supplied. It runs, and reports `running`. */
  Powered = 1,
  /** Under-supplied, and this tick is one of the ones it gets. `low_power`. */
  Throttled = 2,
  /** Under-supplied, and this tick is not. It does nothing and says nothing. */
  Starved = 3,
  /** No network, or a network with no supply at all. `no_power`. */
  Unpowered = 4,
}

/** The whole grid at a glance, for the HUD's power tile (C21 task 5). */
export interface PowerSummary {
  /** Kilowatts being generated right now, across every network. */
  readonly supplyKw: number;
  /** Kilowatts demanded by everything connected, across every network. */
  readonly demandKw: number;
  /**
   * The **worst** network's satisfaction, 0..100.
   *
   * The worst rather than the total, because the total can read 100% while a
   * network on the far side of the factory is dark — and the one the player
   * has to do something about is the worst one.
   */
  readonly satisfactionPercent: number;
  readonly networks: number;
}

/** One building's power situation, for the inspector (C21 task 5). */
export interface PowerReading {
  readonly consumptionKw: number;
  readonly productionKw: number;
  readonly connected: boolean;
  /** 0..100 for a connected building; 0 for one on no network. */
  readonly satisfactionPercent: number;
}

export interface PowerSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly alerts: AlertLog;
}

/** A pole, reduced to the four numbers the graph is built from. */
interface PoleNode {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly reach: number;
  readonly supplyArea: number;
}

export class PowerSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly items: ItemRegistry;
  private readonly alerts: AlertLog;

  /** Tile -> the lowest-id pole covering it. Derived (§10); see the header. */
  private readonly coverage = new Map<number, EntityId>();

  /** Pole id -> network index. Rebuilt with the coverage map. */
  private readonly poleNetwork = new Map<EntityId, number>();

  /**
   * The pole ids the current graph was built from, ascending.
   *
   * Compared against the live set once per tick — a few hundred integer
   * comparisons — rather than maintained by a change feed. It is the cheapest
   * thing that cannot go stale: a bookkeeping hook missed on one code path
   * would leave a network wrong for the rest of the session, and the symptom
   * would be a factory that stopped for no visible reason.
   */
  private builtFrom: EntityId[] = [];

  private networkCount = 0;

  private readonly supply: number[] = [];
  private readonly demand: number[] = [];
  private readonly satisfaction: number[] = [];

  /**
   * How much of each network's available generation is being asked for, out of
   * `POWER_SCALE`. The reciprocal of satisfaction, clamped the same way, and
   * the rate at which its generators spend fuel.
   */
  private readonly load: number[] = [];

  /**
   * Consumer and generator id -> network index, refilled every tick.
   *
   * Only ever read by key (`gate`, `readingFor`), never iterated, so its
   * insertion order never reaches a decision (§6 R4) — the same licence
   * `EntityStore.pending` takes.
   */
  private readonly entityNetwork = new Map<EntityId, number>();

  /**
   * `powerFor` and `footprintOf`, precomputed per entity type.
   *
   * `gate` is asked about **every machine in the factory, every tick**, and
   * the overwhelmingly common answer is "this one runs for free". §16's rule
   * about the tick loop is to keep it out of hash lookups where an array
   * index will do, and this is the same arrangement `InserterSystem` makes
   * with its configs. Content is frozen at construction, so the arrays cannot
   * go stale.
   */
  private readonly powerByType: readonly (PowerProperties | null)[];

  private readonly footprintByType: readonly Footprint[];

  private currentTick = 0;

  constructor(options: PowerSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.items = options.items;
    this.alerts = options.alerts;
    this.powerByType = Object.freeze(
      Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) => this.buildings.powerFor(type as EntityType)),
    );
    this.footprintByType = Object.freeze(
      Array.from({ length: ENTITY_TYPE_COUNT }, (_unused, type) =>
        this.buildings.footprintOf(type as EntityType),
      ),
    );
  }

  /**
   * Phase 2. Rebuild the networks if the poles moved, then sum and divide.
   *
   * The order inside is demand, supply, the two quotients, then the fuel. Both
   * quotients come before anything is burned, because how hard a generator
   * pulls on its coal is `demand / supply` and it cannot know either until
   * both sides have been counted — see `burnFuel`.
   */
  tick(tickCount: number): void {
    this.currentTick = tickCount;
    this.syncPoles();
    this.resetNetworks();
    this.collectDemand();
    this.collectSupply();
    this.computeRatios();
    this.burnFuel();
  }

  /**
   * What phases 3–8 must do about this building's power. See `PowerGate`.
   *
   * Total: a building the content table gave no power rating answers `Free`,
   * so a system can consult this unconditionally rather than testing first
   * whether the thing it is holding is electric (§19 rule 17).
   */
  gate(entity: Entity): PowerGate {
    if (!this.consumes(entity.type)) return PowerGate.Free;

    const network = this.entityNetwork.get(entity.id) ?? NO_NETWORK;
    if (network === NO_NETWORK) return PowerGate.Unpowered;

    const satisfaction = this.satisfaction[network] ?? 0;
    // Zero supply on a network that is asking for power is not a brownout, it
    // is a dark factory: reported as `no_power` because "add a generator" is
    // the thing to do, and because a machine gated on a ratio of zero would
    // never reach the tick that updates its status.
    if (satisfaction <= 0) return PowerGate.Unpowered;
    if (satisfaction >= POWER_SCALE) return PowerGate.Powered;
    return advancesOn(this.currentTick, satisfaction) ? PowerGate.Throttled : PowerGate.Starved;
  }

  /**
   * Does this kind of building draw power at all?
   *
   * Asked once per machine *type* per tick by the systems that gate on power,
   * rather than once per machine: whether a building is electric is a fact
   * about the content table, and the overwhelming majority of the entities in
   * a factory are not. See `production-system.ts`, which hoists it out of its
   * inner loop.
   */
  consumes(type: EntityType): boolean {
    return this.powerByType[type] != null;
  }

  /** The whole grid, or null when no network exists yet. For the HUD. */
  summary(): PowerSummary | null {
    if (this.networkCount === 0) return null;

    let supplyKw = 0;
    let demandKw = 0;
    let worst = POWER_SCALE;
    for (let network = 0; network < this.networkCount; network++) {
      supplyKw += this.supply[network] ?? 0;
      demandKw += this.demand[network] ?? 0;
      worst = Math.min(worst, this.satisfaction[network] ?? 0);
    }
    return Object.freeze({
      supplyKw,
      demandKw,
      satisfactionPercent: percent(worst),
      networks: this.networkCount,
    });
  }

  /** One building's power situation, or null for one with no power role. */
  readingFor(entity: Entity): PowerReading | null {
    const consumption = this.buildings.powerFor(entity.type);
    const generator = this.buildings.generatorFor(entity.type);
    if (consumption === null && generator === null) return null;

    const network = this.entityNetwork.get(entity.id) ?? NO_NETWORK;
    return Object.freeze({
      consumptionKw: consumption?.consumptionKw ?? 0,
      productionKw: generator?.productionKw ?? 0,
      connected: network !== NO_NETWORK,
      satisfactionPercent: network === NO_NETWORK ? 0 : percent(this.satisfaction[network] ?? 0),
    });
  }

  /** How many separate networks exist. For tests and the debug overlay. */
  get networks(): number {
    return this.networkCount;
  }

  /**
   * The network a building is on, or `NO_NETWORK`. For tests.
   *
   * Answered from the coverage map rather than from this tick's walk, so it
   * is meaningful for a belt or a chest as well — anything standing in a
   * pole's supply area is "on" a network even though nothing asks it to be.
   */
  networkAt(entity: Entity): number {
    const pole = this.ownerOf(entity);
    return pole === 0 ? NO_NETWORK : (this.poleNetwork.get(pole) ?? NO_NETWORK);
  }

  /**
   * Throw the graph away and build it again from the store.
   *
   * What `rebuildDerived()` means for power (§10), and what the next tick
   * would have done anyway — `syncPoles` detects the empty `builtFrom` and
   * rebuilds. It is exposed so a load, and the test that proves an
   * incrementally-maintained graph matches a freshly built one, can ask for it
   * directly.
   */
  rebuild(): void {
    this.builtFrom = [];
    this.syncPoles();
  }

  /* ---------------------------------------------------------------- *
   * The pole graph                                                    *
   * ---------------------------------------------------------------- */

  /**
   * Rebuild the graph if, and only if, the set of poles has changed.
   *
   * The check walks the pole buckets and compares ids in place: it allocates
   * nothing and runs on every tick of every game, including the overwhelming
   * majority where there is not a pole in the world. Everything below it —
   * the node array, the sort, the coverage map, the components — happens only
   * when the answer is yes.
   */
  private syncPoles(): void {
    if (!this.poleSetChanged()) return;

    const poles = this.collectPoles();
    this.buildNetworks(poles);
    this.builtFrom = poles.map((pole) => pole.id);
  }

  /**
   * Every pole in the world, ascending by entity id.
   *
   * Type order then id order within a type would be enough for determinism,
   * but the *ids* are what the coverage map's lowest-wins rule compares, so
   * the array is sorted into that order once here rather than reasoned about
   * at each use. Poles are a fraction of a percent of a factory's entities;
   * this is a few hundred elements.
   */
  private collectPoles(): PoleNode[] {
    const poles: PoleNode[] = [];
    // Walked in the same order `poleSetChanged` walks — type order, then id
    // order within a type — and then sorted, so `builtFrom` and the graph are
    // built from one sequence rather than two that must agree.

    for (const type of this.buildings.poleTypes()) {
      const config = this.buildings.poleFor(type);
      if (config === null) continue;
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const entity = bucket[i];
        if (entity === undefined) continue;
        poles.push({
          id: entity.id,
          x: entity.x,
          y: entity.y,
          reach: config.wireReach,
          supplyArea: config.supplyArea,
        });
      }
    }
    return poles;
  }

  /**
   * Does the live set of poles differ from the one the graph was built from?
   *
   * Compared against `builtFrom` in **walk order**, not sorted order: the two
   * coincide while there is one kind of pole, and what this needs is only that
   * the same world produces the same sequence twice.
   */
  private poleSetChanged(): boolean {
    let index = 0;
    for (const type of this.buildings.poleTypes()) {
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const entity = bucket[i];
        if (entity === undefined) continue;
        if (this.builtFrom[index] !== entity.id) return true;
        index += 1;
      }
    }
    return index !== this.builtFrom.length;
  }

  /**
   * Coverage map and connected components, from scratch.
   *
   * Poles are linked when the squared distance between them is within the
   * *smaller* of the two wire reaches — the smaller, because a wire is one
   * span and both ends have to be able to hold it, which is the answer that
   * does not depend on which of the pair is asked.
   */
  private buildNetworks(unsorted: readonly PoleNode[]): void {
    // Ascending by entity id, which is what the coverage map's lowest-wins
    // rule compares. A copy, so `syncPoles` keeps the walk order it needs.
    const poles = [...unsorted].sort((a, b) => a.id - b.id);
    this.coverage.clear();
    this.poleNetwork.clear();
    this.networkCount = 0;
    if (poles.length === 0) return;

    // Ascending, so the first pole to claim a tile is the lowest-id one that
    // covers it (§6 R6). Every later pole finds the tile taken and leaves it.
    for (const pole of poles) {
      const half = (pole.supplyArea - 1) / 2;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const key = safeTileKey(pole.x + dx, pole.y + dy);
          if (key === null || this.coverage.has(key)) continue;
          this.coverage.set(key, pole.id);
        }
      }
    }

    const parent = new Int32Array(poles.length);
    for (let i = 0; i < poles.length; i++) parent[i] = i;

    // Bucketed by a cell at least as wide as the longest wire, so a pole's
    // partners can only be in its own cell or the eight around it. Without
    // this the link pass is every pair against every other, which is fine at
    // a hundred poles and is not at ten thousand.
    let cell = 1;
    for (const pole of poles) cell = Math.max(cell, pole.reach);
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < poles.length; i++) {
      const pole = poles[i];
      if (pole === undefined) continue;
      const key = cellKey(pole.x, pole.y, cell);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [i]);
      else bucket.push(i);
    }

    for (let i = 0; i < poles.length; i++) {
      const a = poles[i];
      if (a === undefined) continue;
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          const bucket = buckets.get(packCell(nx, ny));
          if (bucket === undefined) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = poles[j];
            if (b === undefined) continue;
            const span = Math.min(a.reach, b.reach);
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            if (dx * dx + dy * dy <= span * span) union(parent, i, j);
          }
        }
      }
    }

    // Numbered by first appearance in ascending pole id, so a network's index
    // is a function of the graph and not of the order anything was walked in.
    const indexOfRoot = new Map<number, number>();
    for (let i = 0; i < poles.length; i++) {
      const pole = poles[i];
      if (pole === undefined) continue;
      const root = find(parent, i);
      let network = indexOfRoot.get(root);
      if (network === undefined) {
        network = this.networkCount;
        this.networkCount += 1;
        indexOfRoot.set(root, network);
      }
      this.poleNetwork.set(pole.id, network);
    }
  }

  /* ---------------------------------------------------------------- *
   * The per-tick sums                                                 *
   * ---------------------------------------------------------------- */

  private resetNetworks(): void {
    this.entityNetwork.clear();
    this.supply.length = this.networkCount;
    this.demand.length = this.networkCount;
    this.satisfaction.length = this.networkCount;
    this.load.length = this.networkCount;
    for (let network = 0; network < this.networkCount; network++) {
      this.supply[network] = 0;
      this.demand[network] = 0;
      this.satisfaction[network] = POWER_SCALE;
      this.load[network] = 0;
    }
  }

  /** Every consumer, in type order then id order (§6 R4). */
  private collectDemand(): void {
    for (const type of this.buildings.consumerTypes()) {
      const config = this.buildings.powerFor(type);
      if (config === null) continue;
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const entity = bucket[i];
        if (entity === undefined) continue;
        const network = this.networkAt(entity);
        this.entityNetwork.set(entity.id, network);
        if (network === NO_NETWORK) continue;
        this.demand[network] = (this.demand[network] ?? 0) + config.consumptionKw;
      }
    }
  }

  /**
   * Every generator, in type order then id order (§6 R4): what the network
   * can draw on.
   *
   * A generator counts toward supply when it is **able** to run — already
   * alight, or holding something it could light — rather than when it happens
   * to be spending fuel this tick. That is what lets the fuel follow the load
   * in `burnFuel` without the supply flickering on and off underneath the
   * machines: a spinning generator is available power whether or not this
   * particular tick is one where it eats.
   */
  private collectSupply(): void {
    for (const type of this.buildings.generatorTypes()) {
      const config = this.buildings.generatorFor(type);
      if (config === null) continue;
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const entity = bucket[i];
        if (entity === undefined) continue;
        const generator = asGenerator(entity, this.buildings);
        if (generator === null) continue;

        const network = this.networkAt(generator);
        this.entityNetwork.set(generator.id, network);
        if (network === NO_NETWORK) {
          // Fuel, a rating, and no wire to anywhere. `no_power` is the same
          // word the machines use and the same thing to do about it: run a
          // pole to it.
          this.setGeneratorStatus(generator, MachineStatus.NoPower);
          continue;
        }
        if (!this.available(generator)) {
          this.setGeneratorStatus(generator, MachineStatus.NoFuel);
          continue;
        }
        this.supply[network] = (this.supply[network] ?? 0) + config.productionKw;
      }
    }
  }

  /**
   * Spend fuel at the rate the network is actually drawing.
   *
   * A generator over a network asking for 150 kW of its 900 burns a sixth of
   * the coal, and *which* sixth of the ticks is the same Bresenham step that
   * decides which ticks a throttled machine works on — so there is one piece
   * of fixed-point arithmetic in this file rather than two, and no fractional
   * fuel counter to serialize (§6 R3).
   *
   * This is what makes the electric furnace exactly coal-neutral at **any**
   * load rather than only at a full one: six electric furnaces on a generator
   * cost the coal six burner furnaces would, and so does one. Without it the
   * smallest useful power plant would be six furnaces wide, and a player who
   * built their first generator for a single machine would be burning six
   * times the coal for it and have nothing on screen to say so.
   *
   * An item already alight is never put out. The coal is spent; a generator
   * that banked the remainder when demand fell would be storing energy, which
   * is the accumulator C21 excludes.
   */
  private burnFuel(): void {
    for (const type of this.buildings.generatorTypes()) {
      const config = this.buildings.generatorFor(type);
      if (config === null) continue;
      const bucket = this.entities.byType(type);
      for (let i = 0; i < bucket.length; i++) {
        const entity = bucket[i];
        if (entity === undefined) continue;
        const generator = asGenerator(entity, this.buildings);
        if (generator === null) continue;

        const network = this.entityNetwork.get(generator.id) ?? NO_NETWORK;
        if (network === NO_NETWORK || !this.available(generator)) continue;

        const load = this.load[network] ?? 0;
        if (load <= 0) {
          // Nothing on this network is asking for anything. A generator that
          // burned anyway would be a coal leak with no symptom.
          this.setGeneratorStatus(generator, MachineStatus.Idle);
          continue;
        }
        this.setGeneratorStatus(generator, MachineStatus.Running);
        if (!advancesOn(this.currentTick, load)) continue;
        if (generator.burnTicksRemaining <= 0 && !this.light(generator, config)) continue;
        generator.burnTicksRemaining -= 1;
      }
    }
  }

  /** Is there anything alight in here, or anything that could be? */
  private available(generator: GeneratorEntity): boolean {
    return generator.burnTicksRemaining > 0 || this.nextFuel(generator) !== NO_ITEM;
  }

  /**
   * Take one item out of the fuel buffer and set it alight. False if there is
   * nothing in there that burns.
   *
   * The burn length is the item's own, scaled by how hard this generator is
   * pulling on it — see `FUEL_REFERENCE_KW`. Rounded once, here, to the whole
   * ticks §6 R3 requires, and floored at one so that a generator big enough to
   * finish an item inside a tick still makes progress through its buffer
   * rather than stalling on an item it can never consume.
   */
  private light(generator: GeneratorEntity, config: GeneratorProperties): boolean {
    const itemId = this.nextFuel(generator);
    if (itemId === NO_ITEM) return false;
    const fuelTicks = this.items.fuelTicksOf(itemId);
    if (fuelTicks < 1) return false;

    // Through an inventory over the generator's own slots rather than by
    // splicing the array here: `ItemSlots` is sorted and zero-free by
    // invariant (C08), and a second place that edits one by hand is a second
    // place that can break it. Allocated per item lit — once every forty
    // ticks at §15's numbers — not per tick.
    new BufferInventory({ capacityPerItem: config.fuelCapacity, contents: generator.fuel }).remove(itemId, 1);
    generator.burnTicksRemaining = Math.max(1, Math.round((fuelTicks * FUEL_REFERENCE_KW) / config.productionKw));
    return true;
  }

  /** The lowest item id in the fuel buffer that actually burns. */
  private nextFuel(generator: GeneratorEntity): ItemId {
    for (const entry of generator.fuel) {
      if (entry[1] > 0 && this.items.fuelTicksOf(entry[0]) > 0) return entry[0];
    }
    return NO_ITEM;
  }

  /**
   * The two quotients, per network: how much of what is wanted arrives, and
   * how hard that makes the generators pull on their fuel.
   *
   * They are reciprocals, each clamped at full, and both are floored — so a
   * network is never reported as more than satisfied and a generator is never
   * asked to burn faster than it can.
   */
  private computeRatios(): void {
    for (let network = 0; network < this.networkCount; network++) {
      const demand = this.demand[network] ?? 0;
      const supply = this.supply[network] ?? 0;
      // A network nobody draws on is fully satisfied rather than undefined:
      // the division is guarded because §6 R7 says every division is.
      this.satisfaction[network] =
        demand <= 0 ? POWER_SCALE : Math.min(POWER_SCALE, Math.floor((supply * POWER_SCALE) / demand));
      this.load[network] =
        supply <= 0 ? 0 : Math.min(POWER_SCALE, Math.floor((demand * POWER_SCALE) / supply));
    }
  }

  /**
   * The lowest-id pole covering any tile of this building's footprint, or 0.
   *
   * The whole footprint, not the anchor tile: a 3x3 assembler with one corner
   * inside a pole's square is connected, which is what a player reading the
   * overlap on screen expects. Lowest id, because two poles of two different
   * networks can cover the same building and something has to decide (§6 R6).
   */
  private ownerOf(entity: Entity): EntityId {
    // No poles anywhere is the state most factories spend most of their life
    // in, and it needs no footprint walked to answer.
    if (this.coverage.size === 0) return 0;

    const footprint = this.footprintByType[entity.type] ?? UNIT_FOOTPRINT;
    const extent = footprintExtent(footprint, entity.rotation);
    let owner = 0;
    // Written out rather than through `forEachFootprintTile`, which takes a
    // callback: this runs per powered building per tick, and §16's rule about
    // the tick loop is no closures created inside it.
    for (let dy = 0; dy < extent.height; dy++) {
      for (let dx = 0; dx < extent.width; dx++) {
        const key = safeTileKey(entity.x + dx, entity.y + dy);
        if (key === null) continue;
        const pole = this.coverage.get(key);
        if (pole === undefined) continue;
        if (owner === 0 || pole < owner) owner = pole;
      }
    }
    return owner;
  }

  /** Record a generator's status, alerting on the transitions worth a toast. */
  private setGeneratorStatus(generator: GeneratorEntity, status: MachineStatus): void {
    if (generator.status === status) return;
    generator.status = status;
    if (status === MachineStatus.NoFuel) {
      this.alerts.push({ type: 'machine_no_fuel', entityId: generator.id, x: generator.x, y: generator.y });
    }
    if (status === MachineStatus.NoPower) {
      this.alerts.push({ type: 'no_power_network', entityId: generator.id, x: generator.x, y: generator.y });
    }
  }
}

/**
 * Does a machine at this satisfaction get this tick?
 *
 * The Bresenham step from the file header. Exported because C21's determinism
 * test checks the *rate* it produces rather than the schedule it happens to
 * pick, and because a second copy of this expression anywhere would be a
 * second answer to "is this tick mine".
 */
export function advancesOn(tick: number, satisfaction: number): boolean {
  if (satisfaction >= POWER_SCALE) return true;
  if (satisfaction <= 0) return false;
  return Math.floor((tick * satisfaction) / POWER_SCALE) > Math.floor(((tick - 1) * satisfaction) / POWER_SCALE);
}

/** A ratio out of `POWER_SCALE` as whole percent, rounded toward the player. */
function percent(satisfaction: number): number {
  return Math.floor((satisfaction * 100) / POWER_SCALE);
}

/**
 * `tileKey`, or null for a tile outside the packable range.
 *
 * A pole two tiles from the edge of the world has part of its supply square
 * off the end of it, and `tileKey` throws on those coordinates by design
 * (C01). Nothing can stand there either, so a tile with no key is a tile with
 * nothing to power.
 */
function safeTileKey(x: number, y: number): number | null {
  if (x < TILE_MIN || x > TILE_MAX || y < TILE_MIN || y > TILE_MAX) return null;
  return tileKey(x, y);
}

/** The bucket a pole falls in, for the link pass. */
function cellKey(x: number, y: number, cell: number): number {
  return packCell(Math.floor(x / cell), Math.floor(y / cell));
}

/** Two cell coordinates as one integer. Cells are far coarser than tiles. */
function packCell(cx: number, cy: number): number {
  return cx * 0x10000 + cy;
}

/* -------------------------------------------------------------------------- *
 * Union-find over pole indices                                                *
 * -------------------------------------------------------------------------- */

function find(parent: Int32Array, index: number): number {
  let root = index;
  while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
  // Path compression, which is what keeps the link pass linear in practice.
  let walk = index;
  while ((parent[walk] ?? walk) !== walk) {
    const next = parent[walk] ?? walk;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

/**
 * Join two components, keeping the **lower** index as the root.
 *
 * Union by index rather than by rank, deliberately: rank makes the root depend
 * on the order the unions happened in, and although the component *membership*
 * would be the same either way, a root that moves is one more thing a reader
 * has to prove does not reach the numbering (§6 R4).
 */
function union(parent: Int32Array, a: number, b: number): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA === rootB) return;
  if (rootA < rootB) parent[rootB] = rootA;
  else parent[rootA] = rootB;
}
