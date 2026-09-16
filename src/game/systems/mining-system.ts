/**
 * Miners. See ironflow.md C11 and §8 phase 3.
 *
 * The first system that produces something while the player does nothing,
 * which makes it the first place three of the project's rules have teeth at
 * once:
 *
 * ```text
 * §6 R3   progress is an integer tick count, so 0.5 items/s is exactly
 *         60 ticks per item on every machine and at every frame rate
 * §6 R4   miners are walked in the entity store's id order, never a Map
 * §9      backpressure exists from day one: a full buffer stops the miner
 * ```
 *
 * ## The order of the checks is the order of the answers
 *
 * A miner asks "have I anything to mine?" before "have I anywhere to put it?",
 * because the first is the condition that will never fix itself. Both are
 * asked before progress is added, so a stalled miner is stalled this tick
 * rather than one tick after the player can see why.
 *
 * ## What a stall does to progress
 *
 * `output_full` **keeps** the partial item and `no_resource` **discards** it,
 * and the asymmetry is deliberate. An inserter (C14) empties a buffer a few
 * ticks after it fills, so a miner that reset its progress every time it
 * touched its cap would sit at a full buffer producing nothing at all — the
 * bug would look like a miner that works alone and stops the moment it is
 * automated. A miner with no ore left, on the other hand, has nothing to be
 * partway through; C10 discards the player's manual progress for the same
 * reason, and this keeps the two answers to "what happens to half a lump of
 * iron" the same.
 *
 * ## Round-robin, and when a miner changes its mind
 *
 * `tileCursor` advances past the tile each item came from (C11 task 1), so a
 * 2x2 miner thins its four tiles evenly instead of eating one to nothing
 * first — which is what makes a depleting patch read as a patch.
 *
 * A miner adopts a resource type on its first tick and keeps it until its
 * tiles are exhausted. It may then adopt another kind of ore under the same
 * footprint, **but only while its buffer is empty**: the buffer is a count
 * with no item id (see `miner-entity.ts`), so its contents are whatever
 * `resourceType` says, and changing that with ore still inside would silently
 * transmute it.
 */

import type { AlertLog } from '../alerts.js';
import type { EntityStore } from '../entities/entity-store.js';
import { footprintTileAt, footprintTileCount, type Footprint } from '../entities/entity.js';
import { EntityType } from '../entities/entity-types.js';
import { MachineStatus } from '../entities/machine-status.js';
import type { MinerEntity } from '../entities/miner-entity.js';
import { NO_ITEM, type ItemId } from '../registries/item-registry.js';
import type { BuildingRegistry, MiningConfig } from '../registries/building-registry.js';
import type { ItemRegistry } from '../registries/item-registry.js';
import { ResourceType, resourceItemId } from '../world/resource.js';
import type { World } from '../world/world.js';

export interface MiningSystemOptions {
  readonly world: World;
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly items: ItemRegistry;
  /** Where a miner running dry is recorded for the UI. C11 task 5. */
  readonly alerts: AlertLog;
}

export class MiningSystem {
  private readonly world: World;
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly items: ItemRegistry;
  private readonly alerts: AlertLog;

  constructor(options: MiningSystemOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.items = options.items;
    this.alerts = options.alerts;
  }

  /**
   * Phase 3. Every miner, in ascending entity id (§6 R4, §8).
   *
   * The length is read once, so a miner built by this tick's command phase is
   * included and nothing created later could be — but nothing here creates
   * entities, which is what makes that a note rather than a rule.
   */
  tick(): void {
    const miners = this.entities.byType<MinerEntity>(EntityType.Miner);
    const count = miners.length;
    for (let i = 0; i < count; i++) {
      const miner = miners[i];
      if (miner !== undefined) this.advance(miner);
    }
  }

  /** One tick of one miner. See the file header for the order of the checks. */
  private advance(miner: MinerEntity): void {
    const config = this.buildings.miningFor(miner.type);
    // A miner bucket entry whose building has no mining content: unreachable
    // through `initialBuildingState`, which is what creates miners, and an
    // honest no-op rather than a throw if content is ever edited mid-flight.
    if (config === null) return;

    const footprint = this.buildings.forEntityType(miner.type).size;
    const tileCount = footprintTileCount(footprint, miner.rotation);

    let index = this.nextTile(miner, footprint, tileCount);
    if (index < 0 && miner.outputCount === 0 && this.adoptResource(miner, footprint, tileCount)) {
      index = this.nextTile(miner, footprint, tileCount);
    }
    if (index < 0) {
      // Nothing to be partway through. See the file header.
      miner.progressTicks = 0;
      this.setStatus(miner, MachineStatus.NoResource);
      return;
    }

    if (miner.outputCount >= config.bufferCapacity) {
      this.setStatus(miner, MachineStatus.OutputFull);
      return;
    }

    miner.progressTicks += 1;
    if (miner.progressTicks >= config.ticksPerItem) {
      this.extract(miner, footprint, tileCount, index, config);
    }

    this.setStatus(miner, miner.outputCount >= config.bufferCapacity ? MachineStatus.OutputFull : MachineStatus.Running);
  }

  /** Take one unit from the tile the cursor landed on and bank the progress. */
  private extract(
    miner: MinerEntity,
    footprint: Footprint,
    tileCount: number,
    index: number,
    config: MiningConfig,
  ): void {
    const tile = footprintTileAt(miner.x, miner.y, footprint, miner.rotation, index);
    const taken = this.world.consumeResource(tile.x, tile.y, 1);

    // Subtracted rather than zeroed (§6 R3): a period that does not divide the
    // tick rate evenly would otherwise lose its remainder every single item,
    // and the rate would quietly be slower than the content table says.
    miner.progressTicks -= config.ticksPerItem;
    miner.outputCount += taken;
    // Past the tile it came from, even if it yielded nothing — a tile that
    // emptied between the check and here must not be tried again first.
    miner.tileCursor = (index + 1) % tileCount;
  }

  /**
   * The next covered tile holding this miner's resource, or -1 if there is
   * none. Searched from `tileCursor` forward, wrapping once.
   */
  private nextTile(miner: MinerEntity, footprint: Footprint, tileCount: number): number {
    if (this.itemIdFor(miner.resourceType) === NO_ITEM) return -1;

    for (let offset = 0; offset < tileCount; offset++) {
      const index = (miner.tileCursor + offset) % tileCount;
      const tile = footprintTileAt(miner.x, miner.y, footprint, miner.rotation, index);
      if (this.world.getResourceAmount(tile.x, tile.y) <= 0) continue;
      if (this.world.getResource(tile.x, tile.y) === miner.resourceType) return index;
    }
    return -1;
  }

  /**
   * Take up whatever mineable resource is under the footprint. Only ever
   * called with an empty buffer — see the file header.
   *
   * Returns whether it found one. Searched in the same cursor-relative order
   * as everything else here, so which of two ores a mixed patch offers first
   * is decided by the same rule that decides which tile is mined next.
   */
  private adoptResource(miner: MinerEntity, footprint: Footprint, tileCount: number): boolean {
    for (let offset = 0; offset < tileCount; offset++) {
      const index = (miner.tileCursor + offset) % tileCount;
      const tile = footprintTileAt(miner.x, miner.y, footprint, miner.rotation, index);
      if (this.world.getResourceAmount(tile.x, tile.y) <= 0) continue;

      const resource = this.world.getResource(tile.x, tile.y);
      if (this.itemIdFor(resource) === NO_ITEM) continue;
      miner.resourceType = resource;
      return true;
    }
    miner.resourceType = ResourceType.None;
    return false;
  }

  /**
   * Record the status, and raise an alert on the transition into `no_resource`.
   *
   * On the *transition*, which is the whole of C11's "one alert, not one per
   * tick": the condition is true for every tick that follows, and a toast per
   * tick is how a legible game becomes an unreadable one.
   */
  private setStatus(miner: MinerEntity, status: MachineStatus): void {
    if (miner.status === status) return;
    miner.status = status;
    if (status === MachineStatus.NoResource) {
      this.alerts.push({ type: 'miner_no_resource', entityId: miner.id, x: miner.x, y: miner.y });
    }
  }

  /**
   * The registered item a resource yields, or `NO_ITEM` for one that yields
   * nothing the game knows about.
   *
   * The guard matters because `outputCount` names no item: it is whatever
   * `resourceType` yields, so a resource with no item behind it would let a
   * miner bank ore that nothing could ever take out. The same three ways of
   * yielding nothing collapse into one answer here that they do in
   * `player-system.ts`.
   */
  private itemIdFor(resource: ResourceType): ItemId {
    if (resource === ResourceType.None) return NO_ITEM;
    const stringId = resourceItemId(resource);
    if (stringId === null || !this.items.has(stringId)) return NO_ITEM;
    return this.items.idOf(stringId);
  }
}

