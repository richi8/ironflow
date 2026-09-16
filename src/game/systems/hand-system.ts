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
 * inventory_full  your bag is full
 * ```
 *
 * Reach is asked before anything about contents for the same reason C10's
 * placement asks it first: it is the refusal a player can do something about,
 * and burying it under "there is none of that in there" would explain the
 * wrong thing.
 *
 * ## What counts as a buffer
 *
 * Content, never an id (§19 rule 17). A machine has an output buffer because
 * its building definition has `mining` on it — the same test `building-init.ts`
 * and `MiningSystem` already make — so C21's electric miner is a table entry
 * and nothing here changes. C13 adds the second kind of thing a player can
 * take from: anything with `storage` on its definition, which is a chest.
 *
 * Nothing has an *input* buffer yet, so `insert` still refuses everything.
 * That refusal is the permanent answer for a miner; C15's furnace is the first
 * machine with somewhere to put an ingredient, and it is the chunk that fills
 * the arm in. A chest is filled by the belt running into it (C13) and emptied
 * by the take button, which is the loop C13's acceptance criteria describe.
 */

import { asChest } from '../entities/chest-entity.js';
import type { EntityStore } from '../entities/entity-store.js';
import { forEachFootprintTile, type Entity } from '../entities/entity.js';
import { asMiner, minerOutput, takeMinerOutput } from '../entities/miner-entity.js';
import type { CommandRejectionReason, EntityId } from '../commands/command.js';
import { SlotInventory } from '../items/inventory.js';
import type { ItemStack } from '../items/item-stack.js';
import { MINE_RANGE_TILES, type PlayerState } from '../player/player-state.js';
import { BuildingRegistry } from '../registries/building-registry.js';
import type { ItemRegistry } from '../registries/item-registry.js';

export interface HandSystemOptions {
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  readonly player: PlayerState;
}

export class HandSystem {
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly items: ItemRegistry;
  private readonly player: PlayerState;

  constructor(options: HandSystemOptions) {
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.items = options.items;
    this.player = options.player;
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
  outputsOf(entity: Entity): readonly ItemStack[] {
    const miner = asMiner(entity);
    if (miner !== null) {
      const output = minerOutput(miner);
      return output === null ? NO_STACKS : [output];
    }

    const chest = asChest(entity);
    if (chest !== null && this.buildings.storageFor(entity.type) !== null) {
      const stacks: ItemStack[] = [];
      for (const [itemId, count] of chest.contents) {
        if (this.items.isItemId(itemId)) stacks.push({ itemId: this.items.byId(itemId).id, count });
      }
      return stacks;
    }

    return NO_STACKS;
  }

  /**
   * How many of one item a machine would hand over. Zero for "none of that".
   *
   * Asked by string id, because that is the vocabulary a command speaks (§7),
   * and answered from `outputsOf` so there is one definition of "what is in
   * there" rather than a second one that can disagree with the panel.
   */
  private availableOf(entity: Entity, itemId: string): number {
    for (const stack of this.outputsOf(entity)) {
      if (stack.itemId === itemId) return stack.count;
    }
    return 0;
  }

  /**
   * Take `amount` of one item out of a machine. Returns what actually left.
   *
   * The write half of `outputsOf`, and the reason both are here: a miner's
   * count and a chest's array are two ways of storing the same idea, and the
   * two places that empty them — this and C13's belt system — must not each
   * carry their own copy of how.
   */
  private removeFrom(entity: Entity, itemId: string, amount: number): number {
    const miner = asMiner(entity);
    if (miner !== null) return takeMinerOutput(miner, amount);

    const chest = asChest(entity);
    const storage = this.buildings.storageFor(entity.type);
    if (chest === null || storage === null) return 0;

    const inventory = new SlotInventory({
      slots: storage.slots,
      stackSizeOf: this.items.stackSizeOf,
      contents: chest.contents,
    });
    return inventory.remove(this.items.idOf(itemId), amount);
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
    const available = this.availableOf(entity, itemId);
    if (available <= 0) return 'nothing_to_take';

    const runtimeId = this.items.idOf(itemId);
    const space = this.player.inventory.spaceFor(runtimeId);
    if (space <= 0) return 'inventory_full';

    const moved = this.player.inventory.add(runtimeId, Math.min(amount, available, space));
    if (moved === 0) return 'inventory_full';

    // Only by what the bag actually accepted — the remainder stays in the
    // machine rather than evaporating between the two.
    this.removeFrom(entity, itemId, moved);
    return null;
  }

  /**
   * Put items from the player's bag into a machine's input buffer.
   *
   * Refuses everything today, with the reason that will stay true for a miner
   * forever: it has an output and no input. C15's furnace is the first machine
   * with somewhere to put an ingredient, and it fills this in.
   */
  insert(entityId: EntityId, _itemId: string, _amount: number): CommandRejectionReason | null {
    const entity = this.entities.get(entityId);
    if (entity === undefined) return 'unknown_entity';
    if (!this.canReach(entity)) return 'out_of_reach';
    return 'not_accepted';
  }
}

/** Nothing to take. Shared and frozen: most buildings, most of the time. */
const NO_STACKS: readonly ItemStack[] = Object.freeze([]);
