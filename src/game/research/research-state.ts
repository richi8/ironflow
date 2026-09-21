/**
 * What has been researched, what is being researched, and what is next.
 * See ironflow.md C22 and §10.
 *
 * Authoritative state (§10, "research state and unlocked technologies"), and
 * the *only* research state there is: everything a player can see about the
 * tech tree — which buildings are available, which recipes a picker offers,
 * what the build menu greys out — is derived from these three fields by
 * `unlocks.ts`. That is what makes a load trivial: restore this, recompute
 * that, and the world is the world that was saved.
 *
 * ```text
 *   unlockedFlags   which technologies are done
 *   units           how far each unfinished one has got, in research units
 *   queue           what is being researched, head first
 * ```
 *
 * ## Progress is per technology, not per session
 *
 * `units` is kept for every technology, not only the active one, so changing
 * your mind costs nothing: cancel a half-researched technology, start another,
 * come back, and the units already paid for are still there. The alternative —
 * clearing progress on a switch — would make the queue a trap, and the science
 * it destroyed would be science a player watched a lab consume.
 *
 * ## Why the queue is a plain array
 *
 * Its order is the *decision*, not an accident of a container, so §6 R4 does
 * not apply to it — the same licence `PlayerState.crafts` takes. The head is
 * the technology being researched; there is no separate "active" field,
 * because two places to write "what is being researched" is one place too
 * many.
 */

import { NO_TECHNOLOGY, type TechnologyId } from '../registries/technology-registry.js';

/**
 * How many technologies the queue holds. A **balance number** (C22).
 *
 * A bound rather than a design, for the reason `MAX_CRAFT_ORDERS` is one: the
 * queue is authoritative state fed by a button, and a player leaning on that
 * button must not be able to grow a save without limit. Ten is more than the
 * v1 tree has nodes, so it can only ever be reached by a tree that has grown.
 */
export const MAX_RESEARCH_QUEUE = 10;

/** The research half of a save file. Plain data, sorted where it can be. */
export interface SerializedResearch {
  /** Completed technologies, ascending by runtime id. */
  readonly unlocked: readonly TechnologyId[];
  /**
   * Part-finished technologies as `[id, units]`, ascending by id and never
   * carrying a zero — the same shape, and the same reason, as `ItemSlots`.
   */
  readonly progress: readonly (readonly [TechnologyId, number])[];
  /** The queue, head first. Order is the decision, so it is written as it is. */
  readonly queue: readonly TechnologyId[];
}

export class ResearchState {
  /** Indexed by `TechnologyId`. Authoritative. */
  private readonly unlockedFlags: boolean[];

  /** Indexed by `TechnologyId`: units completed toward it. Authoritative. */
  private readonly units: number[];

  /**
   * What is being researched, head first. Authoritative.
   *
   * Only `ResearchSystem` writes here; it is public because the controller
   * reads it to build the panel's view, exactly as it reads `player.crafts`.
   */
  readonly queue: TechnologyId[] = [];

  constructor(technologyCount: number) {
    this.unlockedFlags = new Array<boolean>(technologyCount).fill(false);
    this.units = new Array<number>(technologyCount).fill(0);
  }

  /** How many technologies this state has room for. The registry's count. */
  get size(): number {
    return this.unlockedFlags.length;
  }

  /** The technology being researched, or `NO_TECHNOLOGY` for an empty queue. */
  get active(): TechnologyId {
    return this.queue[0] ?? NO_TECHNOLOGY;
  }

  isUnlocked(id: TechnologyId): boolean {
    return this.unlockedFlags[id] === true;
  }

  /** Units completed toward `id`. Zero for one that has not been started. */
  unitsOf(id: TechnologyId): number {
    return this.units[id] ?? 0;
  }

  /** Is this technology in the queue at all? Used to refuse a second entry. */
  isQueued(id: TechnologyId): boolean {
    return this.queue.includes(id);
  }

  /** Record one completed unit of research toward `id`. */
  addUnit(id: TechnologyId): void {
    if (id < 0 || id >= this.units.length) return;
    this.units[id] = (this.units[id] ?? 0) + 1;
  }

  /**
   * Mark a technology done: set its flag, forget its part-progress, and take
   * it out of the queue wherever it is.
   *
   * The progress is cleared rather than left at the total because a completed
   * technology is answered by `isUnlocked` from then on, and two fields
   * claiming to say the same thing is how a save ends up self-contradictory.
   */
  complete(id: TechnologyId): void {
    if (id < 0 || id >= this.unlockedFlags.length) return;
    this.unlockedFlags[id] = true;
    this.units[id] = 0;
    this.dequeue(id);
  }

  /** Take a technology out of the queue. True if it was in it. */
  dequeue(id: TechnologyId): boolean {
    const index = this.queue.indexOf(id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /**
   * Every completed technology, ascending.
   *
   * Walked by id rather than by a `Set`'s iteration order (§6 R4), and
   * allocated fresh each call — it is asked once per unlock and once per save,
   * never in a tick loop.
   */
  unlockedIds(): readonly TechnologyId[] {
    const out: TechnologyId[] = [];
    for (let id = 0; id < this.unlockedFlags.length; id++) {
      if (this.unlockedFlags[id] === true) out.push(id);
    }
    return out;
  }

  /**
   * `computeUnlocks`'s parameter, bound to this state.
   *
   * An arrow property for the reason `ItemRegistry.stackSizeOf` is one: it is
   * handed over as a value and must not lose `this`.
   */
  readonly isUnlockedById = (id: TechnologyId): boolean => this.isUnlocked(id);

  toJSON(): SerializedResearch {
    const progress: [TechnologyId, number][] = [];
    for (let id = 0; id < this.units.length; id++) {
      const units = this.units[id] ?? 0;
      if (units > 0) progress.push([id, units]);
    }
    return {
      unlocked: this.unlockedIds(),
      progress,
      // Copied, not handed over: `toJSON` is read by the determinism harness
      // and by C24's save, and neither may hold the live queue.
      queue: [...this.queue],
    };
  }

  /**
   * Replace this state with a saved one. C24's load, and the test hook that
   * lets a test start from a factory that has already researched something.
   *
   * It validates nothing about the *tree* — that a prerequisite of an unlocked
   * technology is itself unlocked is C26's job on an imported save — but it
   * does refuse ids the registry has never heard of, because a stale id would
   * index an array that no longer has that slot.
   */
  load(saved: SerializedResearch): void {
    this.unlockedFlags.fill(false);
    this.units.fill(0);
    this.queue.length = 0;

    for (const id of saved.unlocked) {
      if (this.inRange(id)) this.unlockedFlags[id] = true;
    }
    for (const [id, units] of saved.progress) {
      if (this.inRange(id) && Number.isInteger(units) && units > 0) this.units[id] = units;
    }
    for (const id of saved.queue) {
      if (this.inRange(id) && !this.queue.includes(id)) this.queue.push(id);
    }
  }

  private inRange(id: TechnologyId): boolean {
    return Number.isInteger(id) && id >= 0 && id < this.unlockedFlags.length;
  }
}
