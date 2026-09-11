import { CommandProcessor } from './commands/command-processor.js';
import type { Command, CommandRejectionReason } from './commands/command.js';
import type { World } from './world/world.js';

/**
 * Authoritative game state and the ordered systems that advance it.
 * See ironflow.md §8 (phase order) and §6 (determinism contract).
 *
 * In C00 this was a skeleton owning only the tick counter. C02 gives it the
 * world; the phase block below is the contract that later chunks fill in, and
 * the order is deliberate — changing it is a decision with a changelog entry,
 * not a tidy-up.
 */
export class Simulation {
  /**
   * The terrain and resources. Authoritative (§10) and owned here, because §4
   * puts every piece of simulated state under `Simulation` — the renderer and
   * the UI reach it through a view, never by holding their own reference.
   */
  readonly world: World;

  /**
   * The command queue (§7). Owned here because §7 puts validation inside the
   * simulation: the input layer holds this object only as a `CommandSink`, so
   * it can ask for something to happen but cannot decide when — or whether —
   * it does.
   */
  readonly commands = new CommandProcessor();

  private tickCount = 0;

  constructor(world: World) {
    this.world = world;
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

    // Phases 2-9 arrive with the chunks listed above.
  }

  /**
   * Dispatch one validated command to the system that owns it.
   *
   * C04 ships the pipeline and none of the effects, so every command is
   * refused with `'not_implemented'` — which is the honest answer and, more
   * usefully, a *visible* one: clicking a tile today produces a notification
   * saying so rather than nothing at all, which is how the whole path gets
   * verified before there is anything at the end of it.
   *
   * Each later chunk replaces one arm of this with a call into its system —
   * C06 `build` and `remove`, C10 `movePlayer` and `mineTile`, C15
   * `setRecipe`, C22 `startResearch`. There is deliberately no handler
   * registry: a switch is smaller, it is exhaustively checked by the compiler,
   * and a registry would be an abstraction for a plugin system nobody wants
   * (§19 rule 10).
   */
  private applyCommand(_command: Command): CommandRejectionReason | null {
    return 'not_implemented';
  }
}
