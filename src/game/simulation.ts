import { CommandProcessor } from './commands/command-processor.js';
import type { Command, CommandRejectionReason } from './commands/command.js';
import { BUILDINGS } from './data/buildings.js';
import { EntityStore } from './entities/entity-store.js';
import { forEachFootprintTile } from './entities/entity.js';
import type { ItemCounts } from './items/item-stack.js';
import { BUILD_RANGE_TILES, PlayerState } from './player/player-state.js';
import { BuildingRegistry } from './registries/building-registry.js';
import { ITEMS } from './data/items.js';
import { ItemRegistry } from './registries/item-registry.js';
import { BuildSystem } from './systems/build-system.js';
import { PlayerSystem } from './systems/player-system.js';
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
   * Content. Defaulted rather than required so a test that cares about ticks
   * and not about buildings can say `new Simulation({ world })`, and so there
   * is exactly one place — `data/buildings.ts` — where the shipped set lives.
   */
  readonly buildings?: BuildingRegistry;
  readonly entities?: EntityStore;
  /** The item content table (C08). Defaulted from `data/items.ts`, like buildings. */
  readonly items?: ItemRegistry;
  /**
   * The player (C10). Defaulted to one standing at the origin, so a test that
   * cares about ticks and not about walking can still say `new Simulation({
   * world })` — and so there is exactly one place that decides how big a bag
   * the player starts with.
   */
  readonly player?: PlayerState;
  /**
   * The player's build-materials bag. Kept as a `Simulation` option after C10
   * moved the bag onto the player, because it is how a test hands the game a
   * stock without building a `PlayerState` to do it. Ignored when `player` is
   * given — a player brought their own.
   */
  readonly inventory?: ItemCounts;
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

  /**
   * The player character. Authoritative (§10), and the reason build range and
   * mining reach can be rules rather than suggestions (C10).
   */
  readonly player: PlayerState;

  /**
   * The player's build materials. Still the string-keyed `ItemCounts` bag,
   * which now lives on the player; this is an alias so the build system, the
   * controller and C06's tests keep one name for it. C16 replaces both with
   * the player's `SlotInventory` when building items become real items.
   */
  get inventory(): ItemCounts {
    return this.player.materials;
  }

  private readonly builder: BuildSystem;

  private readonly playerSystem: PlayerSystem;

  /**
   * The command queue (§7). Owned here because §7 puts validation inside the
   * simulation: the input layer holds this object only as a `CommandSink`, so
   * it can ask for something to happen but cannot decide when — or whether —
   * it does.
   */
  readonly commands = new CommandProcessor();

  private tickCount = 0;

  constructor(options: SimulationOptions) {
    this.world = options.world;
    this.buildings = options.buildings ?? new BuildingRegistry(BUILDINGS);
    this.entities = options.entities ?? new EntityStore({ footprintOf: this.buildings.footprintOf });
    this.items = options.items ?? new ItemRegistry(ITEMS);
    this.player =
      options.player ??
      new PlayerState({
        stackSizeOf: this.items.stackSizeOf,
        ...(options.inventory === undefined ? {} : { materials: options.inventory }),
      });
    this.builder = new BuildSystem({
      world: this.world,
      entities: this.entities,
      buildings: this.buildings,
      inventory: this.player.materials,
    });
    this.playerSystem = new PlayerSystem({
      world: this.world,
      entities: this.entities,
      player: this.player,
      items: this.items,
    });
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

  /** Ticks elapsed since this world was created. Authoritative; serialized. */
  getTick(): number {
    return this.tickCount;
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
   * array order. Cleanup runs last so no system observes a half-removed entity.
   */
  tick(): void {
    this.tickCount += 1;

    // Phase 1 — commands. Drained fully, in queue order, capped per tick (§7).
    // Applying them here and nowhere else is what makes a command stream a
    // replay: no other entry point can change authoritative state.
    for (const command of this.commands.drain()) {
      const reason = this.applyCommand(command);
      if (reason !== null) this.commands.reject(command, reason);
    }

    // Phases 2-7 arrive with the chunks listed above.

    // Phase 8 — player. Movement and manual mining (C10). It runs after every
    // machine so that the world a step of walking is judged against is the one
    // the tick settled on, not a half-updated one.
    this.playerSystem.tick();

    // Phase 9 — cleanup. Deferred removals are applied here and nowhere else,
    // which is what makes "a system never sees a half-removed entity" a
    // property of the phase order rather than of every system's care.
    this.entities.cleanup();
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
   * C10 `movePlayer` and `mineTile`, C15 `setRecipe`, C22 `startResearch`.
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
