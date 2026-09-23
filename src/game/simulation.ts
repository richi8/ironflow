import { AlertLog } from './alerts.js';
import { CommandProcessor } from './commands/command-processor.js';
import type { Command, CommandRejectionReason } from './commands/command.js';
import { BUILDINGS } from './data/buildings.js';
import { EntityStore } from './entities/entity-store.js';
import { forEachFootprintTile } from './entities/entity.js';
import { BuildMaterials } from './items/build-materials.js';
import { BUILD_RANGE_TILES, PlayerState } from './player/player-state.js';
import { BuildingRegistry } from './registries/building-registry.js';
import { ITEMS } from './data/items.js';
import { ItemRegistry } from './registries/item-registry.js';
import { Phase, type PhaseTimer } from './phase-timer.js';
import { ProductionCounters } from './production.js';
import { Rng, toUint32 } from './rng.js';
import { RECIPES } from './data/recipes.js';
import { RecipeRegistry } from './registries/recipe-registry.js';
import { TECHNOLOGIES } from './data/technologies.js';
import { TechnologyRegistry } from './registries/technology-registry.js';
import { ResearchState } from './research/research-state.js';
import { Unlocks, recipeForBuilding } from './research/unlocks.js';
import { CraftDurations } from './registries/craft-durations.js';
import { BeltSystem } from './systems/belt-system.js';
import { BuildSystem, countResourceTiles } from './systems/build-system.js';
import { CraftingSystem } from './systems/crafting-system.js';
import { ExplorationSystem } from './systems/exploration-system.js';
import { HandSystem } from './systems/hand-system.js';
import { InserterSystem } from './systems/inserter-system.js';
import { MiningSystem } from './systems/mining-system.js';
import { ProductionSystem } from './systems/production-system.js';
import { ResearchSystem } from './systems/research-system.js';
import { PlayerSystem } from './systems/player-system.js';
import { PowerSystem } from './systems/power-system.js';
import type { Rotation } from './world/coordinates.js';
import type { World } from './world/world.js';

/**
 * Authoritative game state and the ordered systems that advance it.
 * See ironflow.md §8 (phase order) and §6 (determinism contract).
 *
 * In C00 this was a skeleton owning only the tick counter. C02 gives it the
 * world and C05 the entity store; the phase block below is the contract that
 * later chunks fill in, and the order is deliberate — changing it is a decision
 * with a changelog entry, not a tidy-up.
 */
export interface SimulationOptions {
  readonly world: World;
  /**
   * The world seed (§6 R2, §10, §14). Defaulted to 0 so the hundreds of tests
   * that care about belts and not about worldgen need not invent one.
   *
   * It is authoritative from C18 onward even though nothing draws from the
   * stream yet: §14 saves the seed, C19's generator takes it, and folding it
   * into the state from this chunk means the determinism harness is already
   * watching it when the first random number is drawn.
   */
  readonly seed?: number;
  /**
   * Content. Defaulted rather than required so a test that cares about ticks
   * and not about buildings can say `new Simulation({ world })`, and so there
   * is exactly one place — `data/buildings.ts` — where the shipped set lives.
   */
  readonly buildings?: BuildingRegistry;
  readonly entities?: EntityStore;
  /** The item content table (C08). Defaulted from `data/items.ts`, like buildings. */
  readonly items?: ItemRegistry;
  readonly recipes?: RecipeRegistry;
  /** The technology content table (C22). Defaulted from `data/technologies.ts`. */
  readonly technologies?: TechnologyRegistry;
  /**
   * The player (C10). Defaulted to one standing at the origin, so a test that
   * cares about ticks and not about walking can still say `new Simulation({
   * world })` — and so there is exactly one place that decides how big a bag
   * the player starts with.
   */
  readonly player?: PlayerState;
  /**
   * Where a loaded world resumes from. C24's `deserialize` passes all three;
   * nothing else passes any of them.
   *
   * They are scalars rather than a restored `Simulation`, because the pieces
   * that hold the rest of the state — the entity store, the player, the
   * research — are built *by* this constructor from content it owns, and a
   * loader that had to build them first would have to know how (§4: one place
   * decides what a fresh world is made of). So the loader hands over the three
   * counters no sub-object owns, and fills the sub-objects in afterwards
   * through their own `restore`/`load` methods.
   */
  readonly tick?: number;
  /** The RNG stream position (§6 R2). `Rng.fromState`, not a re-seed. */
  readonly rngState?: number;
  /** The next entity id (§6 R5). Handed straight to the `EntityStore`. */
  readonly nextEntityId?: number;
}

export class Simulation {
  /**
   * The terrain and resources. Authoritative (§10) and owned here, because §4
   * puts every piece of simulated state under `Simulation` — the renderer and
   * the UI reach it through a view, never by holding their own reference.
   */
  readonly world: World;

  /**
   * Everything the player has built. Authoritative (§10). Its footprint lookup
   * comes from the building registry, which is why the two are constructed
   * together here rather than separately by the caller.
   */
  readonly entities: EntityStore;

  /** The building content table. Frozen; read by systems, the UI and hotkeys. */
  readonly buildings: BuildingRegistry;

  /**
   * The item content table. Frozen; the source of every numeric item id (C08).
   * Nothing holds items by id yet — C09 mines into one and C15 smelts out of
   * one — but it is built here so a typo in `data/items.ts` fails on the first
   * frame rather than the first ore.
   */
  readonly items: ItemRegistry;

  /** What every machine in the game can make (C15). Built from `data/recipes.ts`. */
  readonly recipes: RecipeRegistry;

  /** The technology content table (C22). Built from `data/technologies.ts`. */
  readonly technologies: TechnologyRegistry;

  /**
   * What has been researched, and what is being researched (C22).
   * Authoritative (§10), and the whole of what a save carries about the tree.
   */
  readonly research: ResearchState;

  /**
   * What research has made available. **Derived** (§10), never serialized —
   * `ResearchSystem` recomputes it from `research` whenever it changes, and on
   * a load.
   *
   * Exposed because five systems, the build validator and the controller all
   * ask it questions, and because `rebuildDerived()` for research is one call
   * on the system that owns it.
   */
  readonly unlocks: Unlocks;

  /**
   * How long one craft takes in each kind of machine (C16 task 5).
   *
   * Content, derived from the two registries above and never serialized: the
   * recipe's authored duration divided by the building's `craftingSpeed`,
   * rounded once here rather than per tick (§6 R3). The controller reads it
   * too, because a progress bar is that same fraction.
   */
  readonly crafts: CraftDurations;

  /**
   * The player character. Authoritative (§10), and the reason build range and
   * mining reach can be rules rather than suggestions (C10).
   */
  readonly player: PlayerState;

  /**
   * The player's items, by the string ids a build cost names them with (C20).
   *
   * A view over `player.inventory`, not a container: the second bag this used
   * to alias is gone, because §15's building recipes made a `chest` an item
   * like any other. See `items/build-materials.ts`.
   */
  readonly inventory: BuildMaterials;

  private readonly builder: BuildSystem;

  /**
   * The grid (C21), phase 2. Exposed rather than private because the
   * controller asks it two read-only questions the HUD and the inspector need
   * — how the whole grid is doing, and how one building is doing on it — and
   * §10 calls the networks derived state, so there is nowhere else to ask.
   */
  readonly power: PowerSystem;

  private readonly miningSystem: MiningSystem;

  /**
   * Machines (C15), phase 4. One system for the furnace and for every machine
   * after it: what a machine can make is content, not code — see
   * `production-system.ts`.
   */
  private readonly productionSystem: ProductionSystem;

  /**
   * Belts (C13), phase 5. It keeps a derived downstream-first order of its own
   * and rebuilds it when the entity set changes — see `belt-system.ts`.
   */
  private readonly beltSystem: BeltSystem;

  /**
   * Inserters (C14), phase 6. It runs after the belts so that what an inserter
   * finds beside it is a belt that has finished moving — see `inserter-system.ts`.
   */
  private readonly inserterSystem: InserterSystem;

  private readonly playerSystem: PlayerSystem;

  /**
   * Exploration (C23), phase 9. The player's legs and every radar write to
   * `world.explored`, and nothing in `game/` reads it back — the map panel is
   * its only consumer, through a view model.
   */
  private readonly explorationSystem: ExplorationSystem;

  /**
   * Research (C22), phase 7. It owns the `startResearch` and `cancelResearch`
   * commands, the queue, and the rebuild of `unlocks` — the one place the
   * derived tables are written.
   *
   * Exposed, like `power` and `hands`, because two callers outside a tick need
   * it: C24's load, which restores `research` and must then ask for the
   * derived tables to be rebuilt (§10), and a test that wants to start from a
   * factory which has already researched something. Neither is a way to change
   * the world behind a command — `grant` and `rebuild` are the only methods
   * that are not a command handler.
   */
  readonly researchSystem: ResearchSystem;

  /**
   * Hand-crafting (C21A), phase 8. It owns the `craftItem` and `cancelCraft`
   * commands and the queue on `PlayerState` that they write to.
   */
  private readonly craftingSystem: CraftingSystem;

  /**
   * The player's hands: the `takeItems`, `insertItems` (C12) and `setRecipe`
   * (C16) commands.
   *
   * Exposed rather than private because the controller asks it two read-only
   * questions the inspector needs — what is in a machine's output buffer, and
   * whether the player could reach it — and asking the system that *applies*
   * the transfer is what keeps the panel from offering a take that the next
   * tick refuses.
   */
  readonly hands: HandSystem;

  /**
   * How much each machine has made. Derived, never persisted (§10, C12 task 2).
   *
   * Systems write, the controller samples, and nothing in `game/` reads it
   * back — see `production.ts`. It lives on the simulation rather than in the
   * controller because production happens here; the rolling *average* is the
   * controller's.
   */
  readonly production = new ProductionCounters();

  /**
   * What the world has to tell the player (C11 task 5).
   *
   * Not authoritative state and never serialized: systems record here inside a
   * tick, the controller empties it once the frame is over, and nothing in
   * `game/` ever reads it back. See `alerts.ts`.
   */
  readonly alerts = new AlertLog();

  /**
   * The command queue (§7). Owned here because §7 puts validation inside the
   * simulation: the input layer holds this object only as a `CommandSink`, so
   * it can ask for something to happen but cannot decide when — or whether —
   * it does.
   */
  readonly commands = new CommandProcessor();

  /**
   * The seed this world was made from. Authoritative (§10), never changes.
   *
   * A 32-bit unsigned integer, normalised once here, so that "the seed the
   * player typed" and "the seed the save carries" are the same number however
   * it was written down.
   */
  readonly seed: number;

  /**
   * The simulation's random stream (§6 R2). Its **position** is authoritative
   * state and is serialized with the world; the generator itself is not.
   *
   * Nothing draws from it yet — every decision in the game today is a
   * round-robin or a counter, deliberately — and C19's worldgen will use a
   * separate positionally-derived stream rather than this one, so that
   * generating world chunks in a different order still yields the same world.
   * See `rng.ts`.
   */
  readonly rng: Rng;

  private tickCount: number;

  /**
   * Is a tick running right now? C24 task 5.
   *
   * §14 requires that a save is taken **between** ticks: a snapshot of a
   * half-advanced tick has belts that have moved and inserters that have not,
   * and it would load into a world no sequence of ticks could have produced.
   * Pausing the loop around a save is C25's job — this is the half that can be
   * enforced from here, so that a future caller who saves from inside a system
   * finds out at the first attempt rather than from a corrupt file.
   */
  private ticking = false;

  /**
   * Who is timing the phases, if anyone (C28). See `phase-timer.ts`.
   *
   * Not state in any sense §10 means: it changes nothing a tick computes, it
   * is never serialized, and a loaded world starts without one. `null` is the
   * normal case and the one the release build runs in.
   */
  private phaseTimer: PhaseTimer | null = null;

  constructor(options: SimulationOptions) {
    this.world = options.world;
    this.seed = toUint32(options.seed ?? 0);
    // A resumed stream, not a re-seeded one: mulberry32's position is the
    // whole of its state, so a save carries the word rather than a count of
    // calls a loader would have to replay (§6 R2, `rng.ts`).
    this.rng = options.rngState === undefined ? new Rng(this.seed) : Rng.fromState(options.rngState);
    this.tickCount = wholeCount(options.tick ?? 0, 'tick');
    this.buildings = options.buildings ?? new BuildingRegistry(BUILDINGS);
    this.entities =
      options.entities ??
      new EntityStore(
        options.nextEntityId === undefined
          ? { footprintOf: this.buildings.footprintOf }
          : { footprintOf: this.buildings.footprintOf, nextId: options.nextEntityId },
      );
    this.items = options.items ?? new ItemRegistry(ITEMS);
    this.recipes = options.recipes ?? new RecipeRegistry(RECIPES, this.items);
    this.crafts = new CraftDurations(this.buildings, this.recipes);
    this.technologies =
      options.technologies ??
      new TechnologyRegistry(TECHNOLOGIES, this.items, {
        hasBuilding: (id) => this.buildings.has(id),
        hasRecipe: (id) => this.recipes.has(id),
        // The same answer `unlocks.ts` gives when it grants a building's
        // recipe along with the building, asked here so that a tree claiming
        // that recipe separately is a content error (see the registry).
        recipeForBuilding: (id) =>
          recipeForBuilding({ buildings: this.buildings, recipes: this.recipes, items: this.items }, id)?.id ?? null,
      });
    this.research = new ResearchState(this.technologies.size);
    this.unlocks = new Unlocks({
      technologies: this.technologies,
      buildings: this.buildings,
      recipes: this.recipes,
      items: this.items,
    });
    this.player = options.player ?? new PlayerState({ stackSizeOf: this.items.stackSizeOf });
    this.inventory = new BuildMaterials(this.player.inventory, this.items);
    this.builder = new BuildSystem({
      world: this.world,
      entities: this.entities,
      buildings: this.buildings,
      inventory: this.inventory,
      unlocks: this.unlocks,
    });
    this.power = new PowerSystem({
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      alerts: this.alerts,
    });
    this.miningSystem = new MiningSystem({
      world: this.world,
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      alerts: this.alerts,
      production: this.production,
    });
    this.productionSystem = new ProductionSystem({
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      recipes: this.recipes,
      crafts: this.crafts,
      alerts: this.alerts,
      production: this.production,
      power: this.power,
      unlocks: this.unlocks,
    });
    this.beltSystem = new BeltSystem({
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      recipes: this.recipes,
      unlocks: this.unlocks,
    });
    this.inserterSystem = new InserterSystem({
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      recipes: this.recipes,
      alerts: this.alerts,
      unlocks: this.unlocks,
    });
    this.hands = new HandSystem({
      entities: this.entities,
      buildings: this.buildings,
      items: this.items,
      recipes: this.recipes,
      player: this.player,
      unlocks: this.unlocks,
    });
    this.craftingSystem = new CraftingSystem({
      player: this.player,
      recipes: this.recipes,
      crafts: this.crafts,
      alerts: this.alerts,
      unlocks: this.unlocks,
    });
    this.researchSystem = new ResearchSystem({
      entities: this.entities,
      buildings: this.buildings,
      technologies: this.technologies,
      research: this.research,
      unlocks: this.unlocks,
      power: this.power,
      alerts: this.alerts,
    });
    this.playerSystem = new PlayerSystem({
      world: this.world,
      entities: this.entities,
      buildings: this.buildings,
      player: this.player,
      items: this.items,
    });
    this.explorationSystem = new ExplorationSystem({
      world: this.world,
      entities: this.entities,
      buildings: this.buildings,
      player: this.player,
      power: this.power,
      alerts: this.alerts,
    });
  }

  /**
   * Recompute every index that is derived rather than saved. C24 task 4, §10.
   *
   * §10's rule is "persist the left column only", and its consequence is that
   * a loaded world is authoritative state plus one pass of rebuilding. This is
   * that pass, and it is the *whole* of it — a system that grows a derived
   * index of its own has to be named here or a save will load into a subtly
   * wrong world.
   *
   * Three of the four indexes are not in the list, and each absence is a
   * design rather than an omission:
   *
   * ```text
   * occupancy grid   rebuilt by EntityStore.restore, which claims the tiles as
   *                  it inserts — there is no moment when the store holds an
   *                  entity that the index does not know about
   * belt order       BeltSystem compares the store's structure revision with
   *                  the one it last built from, so a restored store rebuilds
   *                  it on the first tick without being asked (C13)
   * rate averages    derived in the controller, which a loaded simulation does
   *                  not have yet; a fresh one starts empty
   * ```
   *
   * **Idempotent**, which §10 requires and the round-trip test exercises:
   * calling it twice on a loaded world, or once on a world that never left
   * memory, changes nothing. Both methods below rebuild from authoritative
   * state rather than amending what they already hold.
   */
  rebuildDerived(): void {
    // Power first, because a lab's research rate is a question about its
    // network (C22), and the unlock rebuild below is read by every system.
    this.power.rebuild();
    this.researchSystem.rebuild();
  }

  /**
   * Would this placement be accepted? Read-only, and safe to call per frame.
   *
   * The ghost preview's whole source of truth (C06 task 7). It is a method on
   * the simulation rather than a public `BuildSystem` because the UI may ask
   * questions and may not apply effects — asking is a view, placing is a
   * command (§7), and C07's controller narrows this to a view model.
   */
  checkPlacement(buildingId: string, x: number, y: number, rotation: Rotation): CommandRejectionReason | null {
    return this.checkBuildReach(buildingId, x, y, rotation) ?? this.builder.validate(buildingId, x, y, rotation);
  }

  /**
   * Is this placement close enough to the player to reach? C10 task 5.
   *
   * It is asked here rather than inside `BuildSystem` because it is not a fact
   * about the world. "May a building stand on this tile?" is a property of
   * terrain, occupancy and cost, and it is the same question C11's miner asks
   * about itself, which has no arms. "Can *the player* reach it?" is a property
   * of the player, and composing the two here keeps `BuildSystem` free of a
   * dependency on where someone happens to be standing.
   *
   * Reach is measured to the **nearest tile of the footprint**, so a 2x2 miner
   * is not refused because its far corner is a tile past the edge of a circle
   * the player can see drawn around themselves.
   *
   * It is checked *first*, before terrain or cost, because it is the answer
   * that explains the red ghost when the cursor is halfway across the screen —
   * and, unlike "that ground will not take a building", it is one the player
   * can act on by walking.
   */
  private checkBuildReach(
    buildingId: string,
    x: number,
    y: number,
    rotation: Rotation,
  ): CommandRejectionReason | null {
    if (!this.buildings.has(buildingId)) return null; // `validate` says which id is wrong
    const definition = this.buildings.get(buildingId);
    const facing = BuildingRegistry.normalizeRotation(definition, rotation);

    let reachable = false;
    forEachFootprintTile(x, y, definition.size, facing, (tileX, tileY) => {
      if (this.player.isWithinRange(tileX, tileY, BUILD_RANGE_TILES)) reachable = true;
    });
    return reachable ? null : 'out_of_reach';
  }

  /**
   * How many tiles of ore this placement would cover, or null for a building
   * that does not care. Read-only, and safe to call per frame.
   *
   * C11 task 4: "the ghost preview shows how many tiles it will cover". It is
   * asked of the simulation rather than computed by the UI for the same reason
   * `checkPlacement` is — the world is authoritative about what is under a
   * tile, and a preview that counted for itself would be a second answer to
   * the question the placement rule already asks.
   */
  resourceTilesUnder(buildingId: string, x: number, y: number, rotation: Rotation): number | null {
    if (!this.buildings.has(buildingId)) return null;
    const definition = this.buildings.get(buildingId);
    if (definition.placement.requiresResource !== true) return null;

    const facing = BuildingRegistry.normalizeRotation(definition, rotation);
    return countResourceTiles(this.world, x, y, definition.size, facing);
  }

  /** Ticks elapsed since this world was created. Authoritative; serialized. */
  getTick(): number {
    return this.tickCount;
  }

  /** Is the simulation inside `tick()`? See the field. `save/` asks this. */
  get isTicking(): boolean {
    return this.ticking;
  }

  /**
   * Time every phase from the next tick on, or stop (C28).
   *
   * Attached from outside `game/` because the clock is outside `game/` (§6
   * R1). A tick already in progress is not affected: the timer is read once,
   * at the top of the tick, so a tick is either timed from its first phase to
   * its last or not at all.
   */
  setPhaseTimer(timer: PhaseTimer | null): void {
    this.phaseTimer = timer;
  }

  /**
   * Advance the world by exactly one fixed timestep.
   *
   * Phase order (ironflow.md §8). Every tick runs these in this order:
   *
   *   1. commands      drain queue, validate, apply                    [C04]
   *   2. power         network supply/demand -> satisfaction ratio     [C21]
   *   3. mining        miners extract into their buffers               [C11]
   *   4. production    machines advance progress, consume, produce     [C15]
   *   5. belts         move items, hand off between belts (downstream-first)  [C13]
   *   6. inserters     transfer between belts / machines / chests      [C14]
   *   7. research      consume science, advance, apply unlocks         [C22]
   *   8. player        movement, manual mining progress                [C10]
   *   9. cleanup       process removals, compact stores, emit events   [C05]
   *
   * Power resolves first so every machine in the tick sees one satisfaction
   * ratio. Mining precedes production so freshly-mined ore is consumable the
   * same tick. Belts precede inserters so an inserter reads a settled belt
   * position, which keeps throughput predictable instead of oscillating with
   * array order. Exploration follows the player so the map never lags a tick
   * behind the legs that made it. Cleanup runs last so no system observes a
   * half-removed entity.
   */
  tick(): void {
    this.ticking = true;
    try {
      this.runPhases();
    } finally {
      // `finally`, so a system that throws leaves the flag correct: the
      // alternative is a world that can never be saved again, reported as a
      // save bug rather than as the system failure it is.
      this.ticking = false;
    }
  }

  /** The phases themselves. Split out only so `tick` can own the flag above. */
  private runPhases(): void {
    // Read once, so the eleven calls below cannot change their mind mid-tick.
    // Each is guarded by `!== null` rather than written `timer?.`: the two are
    // the same branch, and this spelling says out loud that nothing at all
    // happens without one (C28: "zero-cost when disabled").
    const timer = this.phaseTimer;
    if (timer !== null) timer.beginTick();

    this.tickCount += 1;

    // Phase 1 — commands. Drained fully, in queue order, capped per tick (§7).
    // Applying them here and nowhere else is what makes a command stream a
    // replay: no other entry point can change authoritative state.
    for (const command of this.commands.drain()) {
      const reason = this.applyCommand(command);
      if (reason !== null) this.commands.reject(command, reason);
    }
    if (timer !== null) timer.endPhase(Phase.Commands);

    // Phase 2 — power. Networks are resolved and every machine's share of the
    // supply is settled *before* anything can spend it, which is the whole
    // reason this phase is second (§8). It runs after the commands so a
    // generator placed this frame supplies on the tick it was built, which is
    // C21's third acceptance criterion.
    this.power.tick(this.tickCount);
    if (timer !== null) timer.endPhase(Phase.Power);

    // Phase 3 — mining. Miners extract into their own buffers (C11). It runs
    // before production so ore mined this tick is smeltable this tick, and
    // after the command phase so a miner placed this frame starts on the tick
    // it was built rather than the one after.
    this.miningSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Mining);

    // Phase 4 — production. Machines burn a tick of fuel and advance a tick of
    // progress (C15). After mining, so an ore that landed in a buffer this
    // tick can be smelted in it; before the belts, so a plate finished this
    // tick is on the belt in front of the furnace in the same tick.
    this.productionSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Production);

    // Phase 5 — belts. Items move, hand off between belts, and are dropped on
    // by the machines beside them (C13). Downstream-first, so belt speed is a
    // property of the layout rather than of the order the belts were built in.
    this.beltSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Belts);

    // Phase 6 — inserters. Items cross from one building to the next (C14).
    // After the belts, so an inserter reads a settled belt position and its
    // throughput is a property of the layout rather than of array order.
    this.inserterSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Inserters);

    // Phase 7 — research. Labs spend science, a finished unit counts toward
    // the head of the queue, and a finished technology applies its unlocks
    // here — before phase 8 and before the next tick's commands, which is
    // what makes "completing a technology immediately makes its unlocks
    // buildable" a property of the phase order rather than of a callback.
    this.researchSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Research);

    // Phase 8 — player. Movement, manual mining (C10) and hand-crafting
    // (C21A). It runs after every machine so that the world a step of walking
    // is judged against is the one the tick settled on, not a half-updated one.
    //
    // Crafting goes first within the phase, and the order is visible: a craft
    // that completes this tick is in the bag before `mineTile` looks for room
    // in it, so a player mining beside a finishing craft sees the two in the
    // order they happened rather than in the order the systems were written.
    this.craftingSystem.tick();
    this.playerSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Player);

    // Phase 9 — exploration. The world chunks around the player, and one
    // world chunk of each radar's coverage (C23). It is *appended* to §8's
    // list rather than inserted, so no existing phase moved: it has to follow
    // phase 8 because the player's reveal is about where they now stand, and
    // it has to precede cleanup because everything does.
    this.explorationSystem.tick();
    if (timer !== null) timer.endPhase(Phase.Exploration);

    // Phase 10 — cleanup. Deferred removals are applied here and nowhere else,
    // which is what makes "a system never sees a half-removed entity" a
    // property of the phase order rather than of every system's care.
    const removed = this.entities.cleanup();
    // Ids are never reused (§6 R5), so a counter for a demolished machine can
    // never be read again — only paid for. This is the one place that knows
    // an entity has actually gone.
    if (removed.length > 0) this.production.forget(removed);
    if (timer !== null) timer.endPhase(Phase.Cleanup);
  }

  /**
   * Dispatch one validated command to the system that owns it.
   *
   * C06 fills in the first two arms. The rest are still refused with
   * `'not_implemented'`, which is the honest answer and, more usefully, a
   * *visible* one: clicking with no build tool held produces a notice saying
   * so rather than nothing at all.
   *
   * Each later chunk replaces one arm of this with a call into its system —
   * C10 `movePlayer` and `mineTile`, C12 `takeItems` and `insertItems`, C16
   * `setRecipe`, C21A `craftItem` and `cancelCraft`, C22 `startResearch`.
   * There is deliberately no handler registry: a switch is smaller, it is
   * exhaustively checked by the compiler, and a registry would be an
   * abstraction for a plugin system nobody wants (§19 rule 10).
   */
  private applyCommand(command: Command): CommandRejectionReason | null {
    switch (command.type) {
      case 'build':
        return (
          this.checkBuildReach(command.buildingId, command.x, command.y, command.rotation) ??
          this.builder.place(command.buildingId, command.x, command.y, command.rotation)
        );
      case 'remove':
        return this.builder.remove(command.x, command.y);
      case 'movePlayer':
        // Never refused: the worst a bad direction can be is "stand still",
        // and a walk command that produces a toast would produce one per key.
        this.player.setMoveIntent(command.dx, command.dy);
        return null;
      case 'mineTile': {
        const reason = this.playerSystem.checkMineable(command.x, command.y);
        if (reason !== null) return reason;
        this.player.startMining(command.x, command.y);
        return null;
      }
      case 'takeItems':
        return this.hands.take(command.entityId, command.itemId, command.amount);
      case 'insertItems':
        return this.hands.insert(command.entityId, command.itemId, command.amount);
      case 'setRecipe':
        return this.hands.setRecipe(command.entityId, command.recipeId);
      case 'craftItem':
        return this.craftingSystem.craft(command.recipeId, command.count);
      case 'cancelCraft':
        return this.craftingSystem.cancel(command.index);
      case 'moveStack':
        // The player rearranging their own bag: never out of reach, and the
        // container itself says whether there was anything to move.
        return this.player.inventory.move(command.from, command.to) ? null : 'empty_slot';
      case 'startResearch':
        return this.researchSystem.start(command.technologyId);
      case 'cancelResearch':
        return this.researchSystem.cancel(command.technologyId);
      case 'stopMining':
        // A no-op when nothing is being mined. Releasing the button over empty
        // ground is not a mistake, and telling the player it was would put a
        // toast on screen every time they finished doing something else.
        this.player.stopMining();
        return null;
      default:
        return 'not_implemented';
    }
  }
}

/**
 * A restored counter that has to be a whole, non-negative number.
 *
 * A save with a fractional tick count would make every `%`-based decision in
 * the game answer differently for ever, and a negative one would run the
 * research queue's arithmetic backwards. Both are cheaper to refuse here than
 * to diagnose in a world that has already loaded (§6 R3, R7).
 */
function wholeCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Simulation: ${field} is ${String(value)}; it must be a whole number of at least 0.`);
  }
  return value;
}
