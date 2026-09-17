/**
 * Reaching into a machine. See ironflow.md C12 task 5 and §7.
 *
 * The `takeItems` and `insertItems` arms of the command switch: the player
 * emptying a miner's buffer into their bag by hand, and — once something in
 * the game has an input buffer — putting something back. It is a system rather
 * than three lines in `simulation.ts` for the reason `BuildSystem` is: it owns
 * one pair of commands end to end, including their refusals, and C15's furnace
 * adds an arm here rather than widening the orchestration.
 *
 * It is **not** C14's inserter. An inserter is a building, it runs in phase 6
 * every tick, and it has no opinion about where the player is standing. This
 * runs in phase 1, once, because somebody clicked.
 *
 * ## The order of the refusals
 *
 * ```text
 * unknown_entity  the machine is gone          — nothing to be said about it
 * out_of_reach    walk closer                  — the answer the player can act on
 * nothing_to_take / not_accepted               — about the buffer itself
 * inventory_full / nothing_to_give             — about the bag
 * ```
 *
 * Reach is asked before anything about contents for the same reason C10's
 * placement asks it first: it is the refusal a player can do something about,
 * and burying it under "there is none of that in there" would explain the
 * wrong thing.
 *
 * ## What counts as a buffer
 *
 * Content, never an id (§19 rule 17) — and since C15, not even a branch here.
 * A miner's mined ore, a chest's contents, an inserter's hand and a furnace's
 * three buffers are all *ports* (`items/item-port.ts`), which is the one place
 * that knows how a building holds things. This system asks a building for the
 * end of the transfer it needs and moves items across it; C21's electric miner
 * and C16's assembler are table entries and nothing here changes.
 *
 * C15 also filled in `insert`, which C12 and C14 left refusing everything for
 * want of anything in the game with an input buffer. `not_accepted` is now the
 * *building's* answer rather than a standing one — a miner has no input port
 * and a furnace refuses an item no smelting recipe wants — which is the same
 * sentence it always was, now said by content.
 */

import type { EntityStore } from '../entities/entity-store.js';
import { forEachFootprintTile, type Entity } from '../entities/entity.js';
import type { CommandRejectionReason, EntityId } from '../commands/command.js';
import { inputPortOf, outputPortOf, type PortContext, type PortStack } from '../items/item-port.js';
import { MINE_RANGE_TILES, type PlayerState } from '../player/player-state.js';
import { BuildingRegistry } from '../registries/building-registry.js';
import type { ItemId, ItemRegistry } from '../registries/item-registry.js';
import type { RecipeRegistry } from '../registries/recipe-registry.js';

export interface HandSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly recipes: RecipeRegistry;
  readonly player: PlayerState;
}

export class HandSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly items: ItemRegistry;
  private readonly player: PlayerState;

  /** What each building holds and accepts — see `items/item-port.ts` (C15). */
  private readonly ports: PortContext;

  constructor(options: HandSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.items = options.items;
    this.player = options.player;
    this.ports = { buildings: options.buildings, items: options.items, recipes: options.recipes };
  }

  /**
   * Is the player close enough to reach into this machine?
   *
   * `MINE_RANGE_TILES` rather than the longer build range: this is the arm
   * that swings a pick, and the two ought to reach the same distance. Measured
   * to the **nearest tile of the footprint**, exactly as build reach is, so a
   * 2x2 miner is not refused because its far corner is a tile too far.
   *
   * Public because the inspector greys out a take button the simulation would
   * refuse — which §7 permits as a *pre*-check, the authority still being the
   * refusal below.
   */
  canReach(entity: Entity): boolean {
    const definition = this.buildings.forEntityType(entity.type);
    const facing = BuildingRegistry.normalizeRotation(definition, entity.rotation);

    let reachable = false;
    forEachFootprintTile(entity.x, entity.y, definition.size, facing, (tileX, tileY) => {
      if (this.player.isWithinRange(tileX, tileY, MINE_RANGE_TILES)) reachable = true;
    });
    return reachable;
  }

  /**
   * What is waiting in a machine's output, as stacks a player could take.
   *
   * The one place that knows how a building's output is *stored*: for a miner,
   * a bare count whose item is implied by `resourceType` (C11); for a chest,
   * the plain `[itemId, count]` array the entity carries (C13). The inspector
   * reads it through the controller and this system reads it to empty it, so
   * the panel can never offer a take the simulation will not honour.
   *
   * A list rather than C12's single stack, because a chest holds more than one
   * kind of thing. Ordered by item id for a chest and single for a miner, so
   * the inspector's rows never reorder under the player's cursor.
   */
  outputsOf(entity: Entity): readonly PortStack[] {
    return outputPortOf(entity, this.ports)?.stacks() ?? NO_STACKS;
  }

  /**
   * What is waiting on a machine's *input* side: ingredients, then fuel.
   *
   * The inspector's INPUT section, which was empty for every building in the
   * game until C15's furnace. It is read-only from the panel — the TAKE button
   * belongs to outputs — but the player can fill it with `insertItems`.
   */
  inputsOf(entity: Entity): readonly PortStack[] {
    return inputPortOf(entity, this.ports)?.stacks() ?? NO_STACKS;
  }

  /**
   * How many of one item a machine would hand over. Zero for "none of that".
   *
   * Asked by string id, because that is the vocabulary a command speaks (§7),
   * and answered from `outputsOf` so there is one definition of "what is in
   * there" rather than a second one that can disagree with the panel.
   */
  private availableOf(entity: Entity, itemId: ItemId): number {
    return outputPortOf(entity, this.ports)?.count(itemId) ?? 0;
  }

  /**
   * Move up to `amount` of `itemId` from a machine's output into the player's
   * bag. Partial and honest, like every other transfer in the game (C08): what
   * fits moves, and only an attempt that moves *nothing* is a rejection.
   */
  take(entityId: EntityId, itemId: string, amount: number): CommandRejectionReason | null {
    const entity = this.entities.get(entityId);
    if (entity === undefined) return 'unknown_entity';
    if (!this.canReach(entity)) return 'out_of_reach';

    // An item the registry has never heard of cannot be put in a slot
    // inventory, which keys on runtime ids. It is the same "there is none of
    // that in there" from the player's side, so it needs no reason of its own.
    if (!this.items.has(itemId)) return 'nothing_to_take';
    const runtimeId = this.items.idOf(itemId);
    const available = this.availableOf(entity, runtimeId);
    if (available <= 0) return 'nothing_to_take';

    const space = this.player.inventory.spaceFor(runtimeId);
    if (space <= 0) return 'inventory_full';

    const moved = this.player.inventory.add(runtimeId, Math.min(amount, available, space));
    if (moved === 0) return 'inventory_full';

    // Only by what the bag actually accepted — the remainder stays in the
    // machine rather than evaporating between the two.
    outputPortOf(entity, this.ports)?.take(runtimeId, moved);
    return null;
  }

  /**
   * Put items from the player's bag into a building that takes them: coal or
   * ore into C15's furnace, anything into a chest.
   *
   * C12 refused everything here, because the only machine in the game had an
   * output and no input. What has not changed is *who decides*: `not_accepted`
   * still comes from the building — a miner has no input port, and a furnace
   * refuses an item no recipe of its category wants — rather than from a list
   * of ids kept here (§19 rule 17).
   *
   * Partial like `take`: what fits moves, and only moving nothing is a
   * rejection. The bag is debited by exactly what the building accepted.
   */
  insert(entityId: EntityId, itemId: string, amount: number): CommandRejectionReason | null {
    const entity = this.entities.get(entityId);
    if (entity === undefined) return 'unknown_entity';
    if (!this.canReach(entity)) return 'out_of_reach';

    const port = inputPortOf(entity, this.ports);
    if (port === null) return 'not_accepted';
    if (!this.items.has(itemId)) return 'not_accepted';

    const runtimeId = this.items.idOf(itemId);
    if (port.spaceFor(runtimeId) <= 0) return 'not_accepted';

    const held = this.player.inventory.count(runtimeId);
    if (held <= 0) return 'nothing_to_give';

    const moved = port.give(runtimeId, Math.min(amount, held));
    if (moved === 0) return 'not_accepted';
    this.player.inventory.remove(runtimeId, moved);
    return null;
  }
}

/** Nothing to take. Shared and frozen: most buildings, most of the time. */
const NO_STACKS: readonly PortStack[] = Object.freeze([]);
