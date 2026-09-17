/**
 * Phase 4: machines turn ingredients into products. See ironflow.md C15.
 *
 * One system for every machine in the game, now and later. It never asks what
 * building it is advancing or what recipe it is running — task 2's "no
 * per-recipe special cases, ever", widened to buildings because the same
 * argument applies: a branch on "is this a furnace" is a branch that C16, C21
 * and C20 each have to find and extend. What varies lives in
 * `data/buildings.ts` (which category, who chooses the recipe, how fast, how
 * big the buffers, does it burn fuel) and `data/recipes.ts` (what turns into
 * what, and how long it takes). C16 added an assembler to this system by
 * adding a row to the first of those files, and the word "assembler" appears
 * nowhere below.
 *
 * ## A tick of one machine
 *
 * ```text
 *   resolve recipe      the one it was told, or one its input buffer names
 *   craft length        the recipe's duration at this machine's speed
 *   deliver a held item a finished craft that had nowhere to go, retried
 *   check ingredients   progress 0 and not enough in the buffer -> no_input
 *   check fuel          nothing burning and nothing to burn   -> no_fuel
 *   consume ingredients once, at the start of a craft
 *   burn one tick, advance one tick
 *   finished?           deliver, and start again next tick
 * ```
 *
 * Two orderings in there are deliberate and both are about not punishing the
 * player for a supply gap:
 *
 * - **Fuel is checked before the ingredients are consumed**, so a furnace that
 *   runs dry between crafts has not eaten an ore it cannot smelt.
 * - **A finished craft that cannot be put down keeps `progressTicks` at
 *   `durationTicks`** rather than being thrown away, and the ingredients for
 *   the *next* craft are not consumed until it lands. That is task 6's "hold
 *   the finished item" and it is what makes the stall reversible: unblock the
 *   output and the machine carries on from where it stopped, in the same tick.
 *
 * ## Exact rates
 *
 * A saturated machine completes one craft every `craftTicks` exactly: the
 * craft that finishes at the end of a tick delivers in that same tick and
 * leaves `progressTicks` at 0, so the next tick is the next craft's first,
 * with no idle tick between them. 3.2 s is 96 ticks and 96 ticks is what a fed
 * furnace takes, which is what C15's ±2% acceptance criterion is measured
 * against (§6 R3 — integer ticks, never accumulated seconds).
 *
 * `craftTicks` is the recipe's duration divided by the machine's
 * `craftingSpeed`, so C16's tier-1 assembler takes 60 ticks over a 1.0 s
 * recipe. The division is done once at startup and looked up here (C16 task
 * 5): a quotient recomputed per tick is a float in the middle of the one loop
 * §6 R3 exists to keep integral.
 */

import type { AlertLog } from '../alerts.js';
import type { EntityStore } from '../entities/entity-store.js';
import { MachineStatus } from '../entities/machine-status.js';
import type { MachineEntity } from '../entities/machine-entity.js';
import { machineBuffers, type MachinePorts } from '../items/item-port.js';
import type { ProductionCounters } from '../production.js';
import type { BuildingRegistry, ProductionProperties } from '../registries/building-registry.js';
import { CANNOT_CRAFT, type CraftDurations } from '../registries/craft-durations.js';
import { NO_ITEM, type ItemId, type ItemRegistry } from '../registries/item-registry.js';
import { NO_RECIPE, type Recipe, type RecipeRegistry } from '../registries/recipe-registry.js';

export interface ProductionSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly recipes: RecipeRegistry;
  /** How long a craft takes in each machine (C16 task 5). */
  readonly crafts: CraftDurations;
  readonly alerts: AlertLog;
  readonly production: ProductionCounters;
}

export class ProductionSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly recipes: RecipeRegistry;
  private readonly items: ItemRegistry;
  private readonly crafts: CraftDurations;
  private readonly alerts: AlertLog;
  private readonly counters: ProductionCounters;

  constructor(options: ProductionSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.recipes = options.recipes;
    this.items = options.items;
    this.crafts = options.crafts;
    this.alerts = options.alerts;
    this.counters = options.production;
  }

  tick(): void {
    // Machine types in type order, machines within a type in id order: two
    // fixed orderings, neither of them a Map's insertion order (§6 R4).
    for (const type of this.buildings.productionTypes()) {
      const config = this.buildings.productionFor(type);
      if (config === null) continue;
      const machines = this.entities.byType<MachineEntity>(type);
      for (let i = 0; i < machines.length; i++) {
        const machine = machines[i];
        if (machine !== undefined) this.advance(machine, config);
      }
    }
  }

  private advance(machine: MachineEntity, config: ProductionProperties): void {
    const buffers = machineBuffers(machine, config);
    const recipe = this.resolveRecipe(machine, config, buffers);
    if (recipe === null) {
      // Two different sentences, and the difference is the one thing the
      // player can act on: a furnace with nothing in it wants an ingredient,
      // an assembler with nothing chosen wants a decision (§13, pillar 3).
      this.setStatus(
        machine,
        config.recipeSelection === 'player' ? MachineStatus.NoRecipe : MachineStatus.NoInput,
      );
      return;
    }

    // How long one craft of this recipe takes *in this machine* — the recipe's
    // duration divided by the machine's speed, rounded once at startup rather
    // than here (C16 task 5, §6 R3). See `registries/craft-durations.ts`.
    const craftTicks = this.crafts.ticksFor(machine.type, recipe.recipeId);
    if (craftTicks === CANNOT_CRAFT) {
      // A recipe this building cannot run at all. `resolveRecipe` has already
      // refused every recipe of the wrong category, so this is only reachable
      // from content that changed under an old save (C27) — and a machine that
      // sat at 0/0 for ever would be the least legible stall in the game.
      machine.recipe = NO_RECIPE;
      machine.progressTicks = 0;
      this.setStatus(machine, MachineStatus.NoRecipe);
      return;
    }

    // A craft that finished into a full output buffer, retried.
    if (machine.progressTicks >= craftTicks) {
      if (!this.deliver(machine, recipe, buffers)) {
        this.setStatus(machine, MachineStatus.OutputFull);
        return;
      }
      machine.progressTicks = 0;
    }

    if (machine.progressTicks === 0 && !this.hasIngredients(recipe, buffers)) {
      this.setStatus(machine, MachineStatus.NoInput);
      return;
    }
    if (!this.hasFuel(machine, config, buffers)) {
      this.setStatus(machine, MachineStatus.NoFuel);
      return;
    }
    if (machine.progressTicks === 0) this.consumeIngredients(recipe, buffers);

    if (machine.fuelTicksRemaining > 0) machine.fuelTicksRemaining -= 1;
    machine.progressTicks += 1;

    if (machine.progressTicks >= craftTicks) {
      if (!this.deliver(machine, recipe, buffers)) {
        this.setStatus(machine, MachineStatus.OutputFull);
        return;
      }
      machine.progressTicks = 0;
    }
    this.setStatus(machine, MachineStatus.Running);
  }

  /* ---------------------------------------------------------------- *
   * Recipes                                                           *
   * ---------------------------------------------------------------- */

  /**
   * What this machine is making, picking one from its input buffer if it is
   * between crafts, has nothing selected, and is the kind of machine that
   * picks for itself.
   *
   * The selected recipe is stored (§10: authoritative) rather than derived
   * each tick, because an assembler is *told* its recipe and the two kinds of
   * machine read the same field. What differs is only how long the choice
   * lives, and that is `recipeSelection` in `data/buildings.ts` (C16):
   *
   * - **`'auto'`** — a craft in progress keeps its recipe whatever is in the
   *   buffer, because the ore is already spent; a recipe whose ingredients
   *   have run out is dropped, so a furnace fed something else can switch.
   * - **`'player'`** — the recipe is kept through an empty buffer and never
   *   replaced by one the items suggest. An assembler that quietly started
   *   making wire because a copper plate arrived would be a factory that
   *   rearranged itself while the player was not looking, and only
   *   `setRecipe` (C16 task 2) may change it.
   */
  private resolveRecipe(
    machine: MachineEntity,
    config: ProductionProperties,
    buffers: MachinePorts,
  ): Recipe | null {
    const current = this.recipes.isRecipeId(machine.recipe) ? this.recipes.byId(machine.recipe) : null;
    if (current !== null && current.category === config.category) {
      if (config.recipeSelection === 'player') return current;
      if (machine.progressTicks > 0 || this.hasIngredients(current, buffers)) return current;
    } else if (machine.recipe !== NO_RECIPE) {
      // Stale or wrong-category: a content change under an old save (C27).
      machine.recipe = NO_RECIPE;
      machine.progressTicks = 0;
    }

    if (config.recipeSelection === 'player') return null;

    const picked = this.select(machine, config, buffers);
    machine.recipe = picked === null ? NO_RECIPE : picked.recipeId;
    if (picked === null) machine.progressTicks = 0;
    return picked;
  }

  /**
   * The recipe the input buffer asks for: the first ingredient it holds, by
   * item id, whose recipe it can actually run.
   *
   * By item id and not by arrival order, because arrival order is not
   * serialized and a furnace holding both ore and stone must pick the same one
   * after a reload as before it (§6 R4, §6 R6's "resolve by id" applied to
   * items rather than entities).
   */
  private select(machine: MachineEntity, config: ProductionProperties, buffers: MachinePorts): Recipe | null {
    for (const entry of machine.input) {
      const recipe = this.recipes.forInput(config.category, entry[0]);
      if (recipe !== null && this.hasIngredients(recipe, buffers)) return recipe;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Buffers                                                           *
   * ---------------------------------------------------------------- */

  private hasIngredients(recipe: Recipe, buffers: MachinePorts): boolean {
    for (const stack of recipe.inputs) {
      if (buffers.input.count(stack.itemId) < stack.count) return false;
    }
    return true;
  }

  private consumeIngredients(recipe: Recipe, buffers: MachinePorts): void {
    for (const stack of recipe.inputs) buffers.input.take(stack.itemId, stack.count);
  }

  /** True when every product fits; false leaves the buffer untouched. */
  private deliver(machine: MachineEntity, recipe: Recipe, buffers: MachinePorts): boolean {
    const output = buffers.output;
    for (const stack of recipe.outputs) {
      if (output.spaceFor(stack.itemId) < stack.count) return false;
    }
    let made = 0;
    for (const stack of recipe.outputs) {
      output.give(stack.itemId, stack.count);
      made += stack.count;
    }
    this.counters.record(machine.id, made);
    return true;
  }

  /**
   * True when the machine can spend a tick working: something is burning, it
   * can light something, or it does not burn anything at all (C21's electric
   * machines, whose gate is the power ratio and not this).
   */
  private hasFuel(machine: MachineEntity, config: ProductionProperties, buffers: MachinePorts): boolean {
    if (config.fuelCapacity === undefined) return true;
    if (machine.fuelTicksRemaining > 0) return true;
    const itemId = this.nextFuel(machine);
    if (itemId === NO_ITEM) return false;
    const ticks = this.items.fuelTicksOf(itemId);
    if (ticks < 1) return false;
    buffers.fuel.take(itemId, 1);
    machine.fuelTicksRemaining = ticks;
    return true;
  }

  /** The lowest item id in the fuel buffer that actually burns. */
  private nextFuel(machine: MachineEntity): ItemId {
    for (const entry of machine.fuel) {
      if (entry[1] > 0 && this.items.fuelTicksOf(entry[0]) > 0) return entry[0];
    }
    return NO_ITEM;
  }

  /* ---------------------------------------------------------------- *
   * Status                                                            *
   * ---------------------------------------------------------------- */

  private setStatus(machine: MachineEntity, status: MachineStatus): void {
    if (machine.status === status) return;
    machine.status = status;
    if (status === MachineStatus.NoFuel) {
      this.alerts.push({ type: 'machine_no_fuel', entityId: machine.id, x: machine.x, y: machine.y });
    }
  }
}
