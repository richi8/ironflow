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
  }
}
