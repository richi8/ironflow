/**
 * Phase 7: research. See ironflow.md C22 and §8.
 *
 * ```text
 *   startResearch   phase 1   put a technology in the queue
 *   cancelResearch  phase 1   take one out again
 *   tick            phase 7   every lab spends a tick; a finished unit counts
 *                             toward the head of the queue, and a finished
 *                             technology applies its unlocks on the spot
 * ```
 *
 * It owns the two commands, the queue on `ResearchState`, and the one piece of
 * derived state that everything else in the game reads — `Unlocks`, which is
 * rebuilt here and nowhere else.
 *
 * ## A lab, one tick at a time
 *
 * ```text
 *   check power        no network -> no_power; a tick its share does not buy
 *                      -> nothing happens at all, exactly as a machine (C21)
 *   nothing queued?    it stops where it is, keeping any part-finished unit
 *   starting a unit?   only if the technology still needs one that is not
 *                      already in flight in another lab; then one of each
 *                      science item leaves this lab's buffer
 *   spend a tick       integer, never a float (§6 R3)
 *   unit finished?     it counts toward whatever is at the head of the queue
 * ```
 *
 * **Units are counted, not ticks.** A technology's cost is its unit total
 * (`technology-registry.ts`), one unit takes one of each science item and
 * `durationTicks` of one lab's time, and a second lab is a second unit in
 * flight rather than a faster one. So labs parallelise exactly, the rate is a
 * whole number of items per lab per unit, and none of it is a fraction.
 *
 * ## Why in-flight units are counted
 *
 * Without it, four labs finishing units on the same tick could push a
 * technology that needed one more unit four units past its total, and the
 * three extra cores would be gone with nothing to show. The count is taken at
 * the top of the phase by looking at the labs themselves — a lab with
 * `progressTicks > 0` is holding a unit — so there is no counter to serialize
 * and nothing that can go stale across a load (§10).
 *
 * It is carried across a change of technology inside one tick, which is
 * conservative in the only direction that is safe: a unit in flight for the
 * technology that just finished holds a place against the one that follows it,
 * so at worst one lab waits a tick. The alternative — resetting the count —
 * would spend science on a unit with nowhere to go, which is the thing this is
 * for.
 *
 * ## What is *not* here
 *
 * **An alert for a lab with no science.** §13's alert rule (see
 * `views/alert.ts`) is that a toast is for something the player must act on
 * that will not clear itself, and a starved lab is `no_input` — the same fact
 * one machine upstream, which is precisely the case that rule excludes. The
 * lab says `no_input` in the inspector and the HUD's research tile stops
 * moving. A **completed** technology does get one, because it is the one thing
 * in the game the player has been waiting several minutes to hear.
 */

import type { AlertLog } from '../alerts.js';
import type { CommandRejectionReason } from '../commands/command.js';
import type { EntityStore } from '../entities/entity-store.js';
import type { LabEntity } from '../entities/lab-entity.js';
import { MachineStatus } from '../entities/machine-status.js';
import { BufferInventory } from '../items/inventory.js';
import type { BuildingRegistry, ResearchProperties } from '../registries/building-registry.js';
import {
  NO_TECHNOLOGY,
  type Technology,
  type TechnologyRegistry,
} from '../registries/technology-registry.js';
import { MAX_RESEARCH_QUEUE, type ResearchState } from '../research/research-state.js';
import type { Unlocks } from '../research/unlocks.js';
import { PowerGate, type PowerSystem } from './power-system.js';

export interface ResearchSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly technologies: TechnologyRegistry;
  readonly research: ResearchState;
  /** The derived unlock tables this system rebuilds. See `research/unlocks.ts`. */
  readonly unlocks: Unlocks;
  readonly power: PowerSystem;
  readonly alerts: AlertLog;
}

export class ResearchSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly technologies: TechnologyRegistry;
  private readonly state: ResearchState;
  private readonly unlocked: Unlocks;
  private readonly power: PowerSystem;
  private readonly alerts: AlertLog;

  constructor(options: ResearchSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.technologies = options.technologies;
    this.state = options.research;
    this.unlocked = options.unlocks;
    this.power = options.power;
    this.alerts = options.alerts;
    this.rebuild();
  }

  /**
   * Recompute the unlock tables from the research state (§10).
   *
   * What `rebuildDerived()` means for research: C24's load restores the state
   * and calls this, and the constructor calls it so that a simulation is
   * never one tick away from knowing what is buildable.
   */
  rebuild(): void {
    this.unlocked.rebuild(this.state.isUnlockedById);
  }

  /**
   * Queue a technology. The `startResearch` command (§7).
   *
   * The refusals, in the order a player can act on them:
   *
   * ```text
   * unknown_technology     no such thing
   * already_researched     you have it
   * already_queued         it is already on the list
   * missing_prerequisites  something it needs is neither done nor queued first
   * research_queue_full    the list is as long as it goes
   * ```
   *
   * **A prerequisite already earlier in the queue counts**, which is what
   * makes the queue worth having: a player can line up a whole branch in one
   * pass instead of coming back each time a node lands. It is still enforced
   * — the prerequisite is ahead of it and will be done first — and a
   * technology whose prerequisites are neither done nor coming cannot be
   * started at all, which is C22's first acceptance criterion.
   */
  start(technologyId: string): CommandRejectionReason | null {
    if (!this.technologies.has(technologyId)) return 'unknown_technology';
    const technology = this.technologies.get(technologyId);
    if (this.state.isUnlocked(technology.technologyId)) return 'already_researched';
    if (this.state.isQueued(technology.technologyId)) return 'already_queued';
    for (const prerequisite of technology.prerequisites) {
      if (this.state.isUnlocked(prerequisite)) continue;
      if (this.state.isQueued(prerequisite)) continue;
      return 'missing_prerequisites';
    }
    if (this.state.queue.length >= MAX_RESEARCH_QUEUE) return 'research_queue_full';

    this.state.queue.push(technology.technologyId);
    return null;
  }

  /**
   * Take a technology out of the queue. The `cancelResearch` command (§7).
   *
   * Nothing is lost and nothing is refunded: the units already paid for stay
   * recorded against that technology (`research-state.ts`), and a lab holding
   * a part-finished unit keeps it — a unit of research work belongs to no
   * particular technology (`lab-entity.ts`). So this is the one command in the
   * game that cannot fail for a reason the player would have to undo.
   *
   * Cancelling a technology that other queued technologies depend on takes
   * **them** with it, because a queue containing a technology whose
   * prerequisite is no longer coming is a queue with a stall in the middle
   * that nothing would explain.
   */
  cancel(technologyId: string): CommandRejectionReason | null {
    if (!this.technologies.has(technologyId)) return 'unknown_technology';
    const technology = this.technologies.get(technologyId);
    if (!this.state.dequeue(technology.technologyId)) return 'nothing_queued';
    this.dropDependents();
    return null;
  }

  /** Every technology in the queue that can no longer be reached, removed. */
  private dropDependents(): void {
    for (;;) {
      // Content order, not queue order, so the walk is the same however the
      // player built the list (§6 R4). One pass can strand another, so it
      // repeats until nothing moves — the tree is nine nodes deep at most.
      let dropped = false;
      for (const technology of this.technologies.all()) {
        if (!this.state.isQueued(technology.technologyId)) continue;
        if (this.reachable(technology)) continue;
        this.state.dequeue(technology.technologyId);
        dropped = true;
      }
      if (!dropped) return;
    }
  }

  /** Are this technology's prerequisites done, or queued ahead of it? */
  private reachable(technology: Technology): boolean {
    const position = this.state.queue.indexOf(technology.technologyId);
    for (const prerequisite of technology.prerequisites) {
      if (this.state.isUnlocked(prerequisite)) continue;
      const at = this.state.queue.indexOf(prerequisite);
      if (at >= 0 && (position < 0 || at < position)) continue;
      return false;
    }
    return true;
  }

  /**
   * Complete a technology outright, unlocks and all.
   *
   * Not a command and not reachable from the UI: it is what C24's load uses to
   * restore a world, and what a test uses to start from a factory that has
   * already researched something. It goes through `complete` rather than
   * writing the flag, so the queue and the part-progress are tidied the same
   * way a real completion tidies them.
   */
  grant(technologyId: string): void {
    if (!this.technologies.has(technologyId)) return;
    this.state.complete(this.technologies.get(technologyId).technologyId);
    this.rebuild();
  }

  /** Complete every technology. For tests, and for C25's new-game options. */
  grantAll(): void {
    for (const technology of this.technologies.all()) this.state.complete(technology.technologyId);
    this.rebuild();
  }

  /**
   * Phase 7. Every lab spends a tick.
   *
   * Lab types in type order, labs within a type in id order: two fixed
   * orderings, neither of them a `Map`'s insertion order (§6 R4). Contention —
   * which lab gets the last unit of a technology — is therefore settled by
   * entity id, which is §6 R6.
   */
  tick(): void {
    let inFlight = 0;
    this.forEachLab((lab) => {
      if (lab.progressTicks > 0) inFlight += 1;
    });

    // The head of the queue is re-read **per lab**, not once for the phase.
    // A lab that completes the last unit of a technology finishes it inside
    // this loop, and a lab visited after it must see that: with one reading
    // for the whole phase the later labs would spend science on a technology
    // that was already done, which is precisely the waste the in-flight count
    // exists to prevent. It also means the next technology in the queue is
    // picked up on the same tick rather than the next one.
    this.forEachLab((lab, config) => {
      inFlight += this.advance(lab, config, this.activeTechnology(), inFlight);
    });
  }

  /** The technology at the head of the queue, or null when nothing is queued. */
  private activeTechnology(): Technology | null {
    const id = this.state.active;
    return id === NO_TECHNOLOGY || !this.technologies.isTechnologyId(id) ? null : this.technologies.byId(id);
  }

  private forEachLab(visit: (lab: LabEntity, config: ResearchProperties) => void): void {
    for (const type of this.buildings.researchTypes()) {
      const config = this.buildings.researchFor(type);
      if (config === null) continue;
      const labs = this.entities.byType<LabEntity>(type);
      for (let i = 0; i < labs.length; i++) {
        const lab = labs[i];
        if (lab !== undefined) visit(lab, config);
      }
    }
  }

  /**
   * One lab, one tick. Returns the change in the number of units in flight:
   * `+1` when it started one, `-1` when it finished one, `0` otherwise.
   */
  private advance(
    lab: LabEntity,
    config: ResearchProperties,
    technology: Technology | null,
    inFlight: number,
  ): number {
    // Power first, for the reason `production-system.ts` gives: a building
    // with none does nothing at all, and phase 2 has already settled the ratio
    // for the whole tick (§8).
    let working = MachineStatus.Running;
    const power = this.power.gate(lab);
    if (power === PowerGate.Unpowered) {
      this.setStatus(lab, MachineStatus.NoPower);
      return 0;
    }
    if (power === PowerGate.Starved) return 0;
    if (power === PowerGate.Throttled) working = MachineStatus.LowPower;

    if (technology === null) {
      // Nothing queued. A part-finished unit is kept exactly where it is —
      // see `lab-entity.ts` on why a unit belongs to no technology.
      this.setStatus(lab, MachineStatus.Idle);
      return 0;
    }

    let started = 0;
    if (lab.progressTicks === 0) {
      if (this.state.unitsOf(technology.technologyId) + inFlight >= technology.units) {
        // The technology's last units are already being worked on elsewhere.
        // Idle rather than a stall: nothing is wrong, this lab has simply run
        // out of research to do.
        this.setStatus(lab, MachineStatus.Idle);
        return 0;
      }
      if (!this.takeScience(lab, config, technology)) {
        this.setStatus(lab, MachineStatus.NoInput);
        return 0;
      }
      started = 1;
    }

    lab.progressTicks += 1;
    this.setStatus(lab, working);
    if (lab.progressTicks < technology.durationTicks) return started;

    lab.progressTicks = 0;
    this.completeUnit(technology);
    return started - 1;
  }

  /**
   * Take one of each science item this technology costs, or nothing at all.
   *
   * All or nothing, checked before anything moves, for the reason
   * `CraftingSystem.deliver` checks first: a unit half paid for would be
   * science the player watched disappear with no progress against it.
   */
  private takeScience(lab: LabEntity, config: ResearchProperties, technology: Technology): boolean {
    const buffer = new BufferInventory({ capacityPerItem: config.inputCapacity, contents: lab.input });
    for (const cost of technology.cost) {
      if (buffer.count(cost.itemId) < 1) return false;
    }
    for (const cost of technology.cost) buffer.remove(cost.itemId, 1);
    return true;
  }

  /**
   * One unit of research has landed. Count it, and finish the technology if
   * that was the last one.
   *
   * The unlock is applied **here**, inside phase 7, which is what makes C22's
   * second acceptance criterion — "completing a technology immediately makes
   * its unlocks buildable" — a property of the phase order: phase 8 and the
   * next tick's phase 1 both see the new tables.
   */
  private completeUnit(technology: Technology): void {
    this.state.addUnit(technology.technologyId);
    if (this.state.unitsOf(technology.technologyId) < technology.units) return;

    this.state.complete(technology.technologyId);
    this.rebuild();
    this.alerts.push({
      type: 'research_complete',
      // Research belongs to no entity and to no tile — it is the one thing in
      // the game that happens to the *player* rather than somewhere on the map
      // — so it carries the sentinel and the technology's own id.
      entityId: 0,
      x: 0,
      y: 0,
      subject: technology.name,
    });
  }

  private setStatus(lab: LabEntity, status: MachineStatus): void {
    if (lab.status === status) return;
    lab.status = status;
    // C21's rule, one building over: a lab standing in open ground will not
    // connect itself, and nothing about it will change until the player runs a
    // pole. Every other status a lab can hold clears itself.
    if (status === MachineStatus.NoPower) {
      this.alerts.push({ type: 'no_power_network', entityId: lab.id, x: lab.x, y: lab.y });
    }
  }

}
