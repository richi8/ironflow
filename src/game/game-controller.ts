/**
 * The single seam between the UI and the game. See ironflow.md C07 task 1 and §4.
 *
 * ```text
 *   ui/  ->  GameController  ->  Game -> Simulation
 *            commands in, frozen views out
 * ```
 *
 * Everything the UI is allowed to do passes through this object, and the shape
 * of the object is the shape of the rule: `dispatch` takes a plain command and
 * hands back only whether it was queued; every getter returns a **frozen
 * snapshot**, never a live reference (§13). There is no method here that lets a
 * panel reach a machine, an inventory or the entity store, which is what makes
 * "the UI never mutates authoritative state" (§19 rule 8) a property of the
 * types rather than a promise in a comment.
 *
 * ## What it took over
 *
 * C04, C05 and C06 each noted work sitting in the composition root that
 * belonged here: resolving a hotbar slot against the content table, assembling
 * the placement preview, and holding the answer to "what is selected" where a
 * panel can read it. All three moved. The one that did **not** is deriving the
 * renderer's entity list: a drawable names a sprite, §4 forbids `game/**` from
 * knowing what a sprite is, and so that derivation stays on the renderer's
 * side of the boundary in `renderer/entity-view.ts`. The earlier notes were
 * optimistic about which side of §4 it would land on; this is the answer.
 *
 * ## Why the cursor is an injected interface
 *
 * What the player is holding and where they are pointing is presentation state
 * owned by `InputManager` (C04) — it is not serialized, no system reads it, and
 * it changes at pointer rate rather than at tick rate. The UI still has to see
 * it, and §4 forbids `ui/**` from importing `input/**`. So the controller reads
 * it through `Cursor`, a six-member interface that `InputManager`
 * satisfies structurally and has never heard of — the same arrangement C04 used
 * in the other direction for `CameraControl` and `TilePicker`. Nothing is
 * cached: every view reads the cursor live, so a rotation pressed between two
 * frames can never leave the toolbar showing the wrong one.
 */

import type { Command } from './commands/command.js';
import type { Entity, EntityId } from './entities/entity.js';
import { footprintExtent, forEachFootprintTile } from './entities/entity.js';
import { BELT_SLOTS_PER_TILE } from './entities/belt-entity.js';
import { asInserter, inserterCycleProgress } from './entities/inserter-entity.js';
import { machineStatusName, statusOf } from './entities/machine-status.js';
import { asMachine } from './entities/machine-entity.js';
import { splitterOutputTile, asSplitter } from './entities/splitter-entity.js';
import { asMiner } from './entities/miner-entity.js';
import type { Game } from './game.js';
import { ProductionRate } from './production.js';
import { BuildingRegistry } from './registries/building-registry.js';
import { CANNOT_CRAFT } from './registries/craft-durations.js';
import { maxCraftable } from './systems/craft-planner.js';
import { NO_RECIPE, type Recipe, type RecipeId } from './registries/recipe-registry.js';
import type { Simulation } from './simulation.js';
import { NO_TECHNOLOGY, type Technology, type Unlock } from './registries/technology-registry.js';
import { asLab, type LabEntity } from './entities/lab-entity.js';
import { MachineStatus } from './entities/machine-status.js';
import { TPS } from './simulation-clock.js';
import type { BuildMenuCost, BuildMenuEntry, BuildMenuView, HotbarSlotView } from './views/build-menu-view.js';
import type { Inventory } from './items/inventory.js';
import type { PortStack } from './items/item-port.js';
import type { ItemId } from './registries/item-registry.js';
import type { MachinePowerView, MachineSlotView, MachineStack, MachineView } from './views/building-view.js';
import { asGenerator } from './entities/generator-entity.js';
import { GridInventory, slotsCount } from './items/inventory.js';
import { asChest } from './entities/chest-entity.js';
import type { GameEvent, GameEventOf, GameEventType } from './views/game-event.js';
import type { HudItemCount, HudPowerView, HudResearchView, HudView } from './views/hud-view.js';
import type {
  CraftOptionView,
  CraftPartView,
  CraftQueueView,
  InventoryCellView,
  InventorySlotView,
  InventoryView,
} from './views/inventory-view.js';
import { MAP_CELL_TILES, type MapChunkView, type MapEntityView, type MapView } from './views/map-view.js';
import type { BuildingDetailsView, HoverView, OreUnderView, ResourceHoverView } from './views/hover-view.js';
import type { PlacementView } from './views/placement-view.js';
import type {
  ResearchCostView,
  ResearchView,
  TechnologyState,
  TechnologyView,
  UnlockView,
} from './views/research-view.js';
import type { RecipePartView, RecipeView } from './views/recipe-view.js';
import type { SelectionView } from './views/selection-view.js';
import type { PlayerActivity, PlayerView } from './views/player-view.js';
import {
  BUILD_RANGE_TILES,
  MAX_CRAFT_BATCH,
  MINE_RANGE_TILES,
  type CraftOrder,
} from './player/player-state.js';
import { DIRECTION_OFFSETS, EAST, NORTH, SOUTH, type Rotation, type TileCoord } from './world/coordinates.js';
import type { ObjectiveGoal } from './views/objective-view.js';
import { GAME_SPEEDS } from './game.js';
import { CHUNK_SIZE, localIndex, toChunkCoord, toLocalCoord } from './world/chunk.js';
import { unpackChunkKey } from './world/explored.js';
import { TILE_TYPE_COUNT, tileProperties, type TileType } from './world/tile.js';
import { RESOURCE_TYPE_COUNT, ResourceType, resourceItemId, resourceName } from './world/resource.js';

/** Hotbar slots the number row reaches. §13's toolbar, C07 task 3. */
export const HOTBAR_SLOTS = 9;

/**
 * The most quest steps a log remembers (C31). Far more than the chain has; a
 * bound so that a save's metadata, which is untrusted (§14), cannot grow it.
 */
export const MAX_QUEST_LOG = 256;

/**
 * A building held over the cursor.
 *
 * Structurally `input/input-manager.ts`'s `BuildTool`. It is redeclared rather
 * than imported because §4 forbids `game/**` from importing `input/**`, and
 * because the direction of the dependency is the point: the input layer is
 * free to satisfy this, and must never be required to know it exists.
 */
export interface HeldBuilding {
  readonly buildingId: string;
  readonly rotationCount: 1 | 2 | 4;
  /**
   * Is this building laid in lines by a click-drag? C13 task 7.
   *
   * Content decides — a belt is, because its definition says how fast it
   * carries things — and the answer is resolved here because §4 will not let
   * the input layer read the building table for itself.
   */
  readonly lineBuild: boolean;
}

/**
 * A material held in the hand: ore, plates, coal — an item that places no
 * building. Clicking a machine with one feeds it (`insertItems`, §7).
 *
 * Structurally `input/input-manager.ts`'s `HandItem`, redeclared for the
 * reason `HeldBuilding` is. `amount` is one stack of the item, resolved here
 * because §4 will not let the input layer read the item table: a click feeds
 * up to one stack, and the machine takes what fits.
 */
export interface HeldItem {
  readonly itemId: string;
  readonly amount: number;
}

/**
 * What the player is holding, where they are pointing, and what they have
 * selected. See the file header.
 *
 * C12 added the last of the three, and it is the same kind of thing as the
 * other two: presentation state owned by `InputManager`, changing at pointer
 * rate, never serialized, read by no system (C12 task 4). The controller holds
 * a setter as well as a getter because the inspector's close button and
 * `clearSelection()` have to put it down from the UI's side, which §4 will not
 * let them do by reaching into `input/**`.
 */
export interface Cursor {
  readonly buildTool: HeldBuilding | null;
  readonly buildRotation: Rotation;
  readonly hover: TileCoord | null;
  /**
   * The building under the pointer, when it is on one (C32's tooltip).
   * Optional so a cursor written before C32 still satisfies this; without it
   * the tooltip describes ground only.
   */
  readonly hoverEntity?: EntityId | null;
  readonly selectedEntityId: EntityId | null;
  /** A material in the hand, or null. Never set at the same time as `buildTool`. */
  readonly heldItem: HeldItem | null;
  setBuildTool(tool: HeldBuilding | null): void;
  /** Turn the held building. Ignored with nothing held, or past its `rotationCount`. */
  setBuildRotation(rotation: Rotation): void;
  setHeldItem(item: HeldItem | null): void;
  setSelectedEntity(entityId: EntityId | null): void;
}

/**
 * What `dispatch` can tell a caller straight away.
 *
 * Only whether the command reached the queue. **The reason a command failed
 * never comes back from this call**, even when it is refused on the spot: §7
 * puts validation inside the simulation, so the answer to "why not" arrives one
 * tick later. Both kinds of refusal — the malformed command the processor
 * rejects at `enqueue` and the occupied tile a system rejects in phase 1 — land
 * in the same rejection list and reach the UI as one `'rejected'` event, which
 * is what makes "a rejected command produces exactly one notification" true for
 * every reason in the vocabulary rather than for most of them.
 */
export interface CommandResult {
  readonly queued: boolean;
}

export interface GameControllerOptions {
  readonly game: Game;
  /**
   * Where the held building lives. Defaults to a detached holder, so a headless
   * test can drive the controller without an input layer or a DOM.
   */
  readonly cursor?: Cursor;
  /**
   * What the player last put on the hotbar, slot by slot — an item id or
   * `null` for an empty slot. Defaults to the first nine buildings in content
   * order, which is what the hotbar was before the player could arrange it.
   * (A building's id is its item's id — §15 — so a layout saved when the
   * hotbar held only buildings reads the same today.)
   *
   * The arrangement is not simulation state (§10) — no system reads it, and
   * it changes while paused, which a command could not — but it travels in
   * the save's metadata, so a loaded factory comes back with its hotbar. An id
   * the content table no longer has is an empty slot rather than an error.
   */
  readonly hotbar?: readonly (string | null)[] | null | undefined;
  /**
   * The quest steps already met in this world (C31, save schema v6), or
   * `null` for none. See `getQuestLog`.
   */
  readonly quests?: readonly string[] | null | undefined;
}

/** A `Cursor` with nothing on the other end of it. For tests and headless use. */
export class DetachedCursor implements Cursor {
  buildTool: HeldBuilding | null = null;
  buildRotation: Rotation = NORTH;
  hover: TileCoord | null = null;
  hoverEntity: EntityId | null = null;
  selectedEntityId: EntityId | null = null;
  heldItem: HeldItem | null = null;

  setBuildTool(tool: HeldBuilding | null): void {
    if (tool === null || this.buildTool?.buildingId !== tool.buildingId) this.buildRotation = NORTH;
    this.buildTool = tool;
    if (tool !== null) this.heldItem = null;
  }

  setBuildRotation(rotation: Rotation): void {
    if (this.buildTool !== null && rotation < this.buildTool.rotationCount) this.buildRotation = rotation;
  }

  setHeldItem(item: HeldItem | null): void {
    this.heldItem = item;
    if (item !== null) this.setBuildTool(null);
  }

  setSelectedEntity(entityId: EntityId | null): void {
    this.selectedEntityId = entityId;
  }
}

type Listener = (event: GameEvent) => void;

export class GameController {
  private readonly game: Game;
  private readonly cursor: Cursor;
  private readonly listeners = new Map<GameEventType, Set<Listener>>();

  /**
   * Rejections and alerts shown this session. The HUD's alert count.
   *
   * One counter for both, because it counts the same thing from the player's
   * side: how many times the game had to tell them something was wrong. C11
   * adds the second producer — a miner that ran out of ore.
   */
  private alerts = 0;

  /**
   * The last build-menu state, as a string.
   *
   * §13 says the build menu updates "on change event only", which means
   * something has to notice the change. Comparing a signature is the cheapest
   * honest way: it is one pass over the content table — eleven entries at the
   * end of §15 — and it cannot drift from the view, because it is built from
   * the same three facts the view shows.
   */
  private menuSignature = '';

  /**
   * The rolling items/minute of the selected machine (C12 task 2).
   *
   * Derived state, held here and never persisted (§10) — the plan puts it in
   * the controller in as many words. It is sampled in `pump()` rather than
   * recomputed in `getBuildingView`, because a rolling average is a function
   * of *when* it was asked and a view getter must be safe to call twice in a
   * frame without changing the answer.
   */
  private readonly rate = new ProductionRate();

  /** The last selection told to the UI, so a change can become one event. */
  private lastSelection: EntityId | null = null;

  /**
   * Downsampled world chunks for the map panel, by `"cx,cy"`, with the
   * `WorldChunk.revision` each was built from. Derived, never persisted (§10).
   */
  private readonly mapChunks = new Map<string, { revision: number; view: MapChunkView }>();

  /**
   * The hotbar, slot by slot: an item id or `null`. See `hotbar` in the
   * options. Length is always `HOTBAR_SLOTS`. One item may sit on several
   * slots; each shows its own stack (see `hotbarView`).
   */
  private readonly hotbar: (string | null)[];

  /**
   * The slot the hand was last filled from (0-based), or null when it was
   * filled from the bag. Only for the highlight: with one item on two slots,
   * the one the player pressed is the one that lights up.
   */
  private heldSlot: number | null = null;

  /** What the hand held at the last `pump`, and how many the bag had then. See `followHand`. */
  private handSeen: { readonly itemId: string; readonly count: number } | null = null;

  /** Quest steps met in this world (C31). See `getQuestLog`. */
  private readonly questLog: string[] = [];

  constructor(options: GameControllerOptions) {
    this.game = options.game;
    this.cursor = options.cursor ?? new DetachedCursor();
    this.hotbar = this.resolveHotbar(options.hotbar ?? null);
    this.setQuestLog(options.quests ?? null);
    this.menuSignature = this.buildMenuSignature();
    this.lastSelection = this.cursor.selectedEntityId;
  }

  /**
   * The world, read through `Game` rather than held.
   *
   * Held, from C07 to C24, because there was only ever one. C25's load
   * replaces it — `deserialize` returns a fresh `Simulation` rather than
   * mutating the old one — and a controller with its own reference would go
   * on answering every view from the factory the player just left.
   */
  private get simulation(): Simulation {
    return this.game.simulation;
  }

  /**
   * The world was replaced. Throw away everything derived from the old one (C25).
   *
   * Four caches and a selection, all of them keyed to a world that no longer
   * exists: the build-menu signature (so the toolbar repaints against the
   * loaded inventory rather than comparing it to the previous world's), the
   * map's downsampled world chunks (whose `revision` numbers restart), the
   * production rate window (measuring a machine that is gone), and the entity
   * the player had selected — ids are not reused *within* a world (§6 R5), but
   * a different world will hand the same number to something else entirely.
   *
   * The three events are what put the UI back in step on the frame of the
   * load rather than on the next beat of a 5 Hz lane — and while paused,
   * which is exactly what a game behind an open save menu is (§8).
   */
  reload(): void {
    this.mapChunks.clear();
    this.rate.reset();
    this.alerts = 0;
    this.cursor.setSelectedEntity(null);
    this.lastSelection = null;
    this.cursor.setBuildTool(null);
    this.cursor.setHeldItem(null);
    this.heldSlot = null;
    this.menuSignature = this.buildMenuSignature();
    // Drop what the old world recorded and never got to say; the toasts that
    // belong to it are about machines that no longer exist.
    this.simulation.commands.takeRejections();
    this.simulation.alerts.take();
    this.emit({ type: 'buildMenuChanged' });
    this.emit({ type: 'selectionChanged', entityId: null });
    this.emit({ type: 'pauseChanged', paused: this.game.isPaused() });
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  /**
   * Ask for something to happen. Nothing happens before the next tick (§7).
   *
   * The UI has no other way to change the world, and this method has no way to
   * change it either — it puts plain data in a queue that a tick drains.
   */
  dispatch(command: Command): CommandResult {
    return { queued: this.simulation.commands.enqueue(command) };
  }

  /**
   * Collect what the simulation recorded and tell the UI about it. Once a frame.
   *
   * The pull half of §13's "never write to the DOM inside a simulation phase":
   * systems record, the frame ends, and only then do listeners run. Called by
   * the composition root after `render`, which is the one place that knows a
   * frame has finished.
   */
  pump(): void {
    for (const rejection of this.simulation.commands.takeRejections()) {
      this.alerts += 1;
      this.emit({ type: 'rejected', command: rejection.command, reason: rejection.reason });
    }

    // C11: what the world stopped doing, recorded inside a tick and told to
    // the UI now the frame is over — the same pull the rejections above are.
    for (const alert of this.simulation.alerts.take()) {
      this.alerts += 1;
      this.emit({ type: 'alert', alert });
    }

    // C12: a selection whose machine has been demolished is not a selection.
    // Dropped here rather than in the input layer, which has no way to know an
    // entity is gone — it holds an id, and ids are never reused (§6 R5).
    const selected = this.cursor.selectedEntityId;
    if (selected !== null && this.simulation.entities.get(selected) === undefined) {
      this.cursor.setSelectedEntity(null);
    }

    const selection = this.cursor.selectedEntityId;
    if (selection !== this.lastSelection) {
      this.lastSelection = selection;
      // The window measured a different machine; keeping it would show one
      // miner's rate under another's name for the next ten seconds.
      this.rate.reset();
      this.emit({ type: 'selectionChanged', entityId: selection });
    }
    if (selection !== null) {
      this.rate.sample(selection, this.simulation.getTick(), this.simulation.production.totalFor(selection));
    }

    this.followHand();

    const signature = this.buildMenuSignature();
    if (signature !== this.menuSignature) {
      this.menuSignature = signature;
      this.emit({ type: 'buildMenuChanged' });
    }
  }

  /* ---------------------------------------------------------------- *
   * Views — every one frozen (§13)
   * ---------------------------------------------------------------- */

  getHudView(): HudView {
    const stats = this.game.getStats();
    const tick = this.simulation.getTick();

    let itemTotal = 0;
    const items: HudItemCount[] = [];

    // One pass, since C20: the player carries one container. `toJSON` is
    // ordered by runtime id, which is content order, so the row a player
    // watches while mining does not move when a building is crafted.
    for (const [itemId, count] of this.simulation.player.inventory.toJSON()) {
      const definition = this.simulation.items.byId(itemId);
      itemTotal += count;
      items.push(freeze({ itemId: definition.id, name: definition.name, count }));
    }

    return freeze({
      tick,
      // Integer division of an integer tick count: exact, and the same on
      // every machine (§6 R3).
      playtimeSeconds: Math.floor(tick / TPS),
      paused: this.game.isPaused(),
      fps: stats.fps,
      entityCount: this.simulation.entities.size,
      exploredChunks: this.simulation.world.chunkCount,
      items: freeze(items),
      itemTotal,
      alerts: this.alerts,
      power: this.powerView(),
      research: this.researchTileView(),
      speed: this.game.getSpeed(),
    });
  }

  /**
   * The grid, flattened for the HUD, or null when there is no grid (C21).
   *
   * Copied field by field rather than handed over, because `PowerSummary` is a
   * system's answer and a view model is the UI's: §4 lets a panel hold the
   * second and never the first, and they are free to diverge the moment the
   * HUD wants something the system does not phrase that way.
   */
  private powerView(): HudPowerView | null {
    const summary = this.simulation.power.summary();
    if (summary === null) return null;
    return freeze({
      supplyKw: summary.supplyKw,
      demandKw: summary.demandKw,
      satisfactionPercent: summary.satisfactionPercent,
      networks: summary.networks,
    });
  }

  /**
   * Where the player is, what they are doing, and how far they can reach.
   *
   * Read every frame by the composition root, which turns `activity` and
   * `facing` into a sprite id on the renderer's side of §4. `activity` is
   * derived here rather than stored on the player because it is exactly the
   * two booleans the player already carries: a field would be a third copy of
   * the same fact, kept in step by hand and serialized for no reason (§10).
   */
  getPlayerView(): PlayerView {
    const player = this.simulation.player;
    const target = player.miningTarget;

    let activity: PlayerActivity = 'idle';
    if (target !== null) activity = 'work';
    else if (player.isMoving) activity = 'walk';

    return freeze({
      x: player.x,
      y: player.y,
      tileX: player.tileX,
      tileY: player.tileY,
      facing: player.facing,
      activity,
      buildRange: BUILD_RANGE_TILES,
      mineRange: MINE_RANGE_TILES,
      mining: target === null ? null : freeze({ x: target.x, y: target.y, progress: player.miningProgress }),
      usedSlots: player.inventory.usedSlots,
      slots: player.inventory.slots,
    });
  }

  getBuildMenuView(): BuildMenuView {
    const held = this.cursor.buildTool;
    const entries: BuildMenuEntry[] = [];

    const entryFor = new Map<string, BuildMenuEntry>();
    this.simulation.buildings.all().forEach((definition) => {
      const slot = this.hotbar.indexOf(definition.id);
      const cost: BuildMenuCost[] = definition.buildCost.map((stack) =>
        freeze({ itemId: stack.itemId, count: stack.count, held: this.simulation.inventory.count(stack.itemId) }),
      );
      entries.push(
        freeze({
          buildingId: definition.id,
          name: definition.name,
          category: definition.category,
          cost: freeze(cost),
          affordable: this.simulation.inventory.canAfford(definition.buildCost),
          // C22: the derived unlock tables, asked per row. The technology's
          // *name* rides along so a locked row can say what would reveal it —
          // "visible locks are motivating; invisible ones are confusing"
          // (C22 task 5).
          unlocked: this.simulation.unlocks.isBuildingUnlocked(definition.entityType),
          unlockedBy: this.simulation.technologies.unlockedBy('building', definition.id)?.name ?? null,
          selected: held?.buildingId === definition.id,
          hotkey: slot < 0 ? null : slot + 1,
        }),
      );
      const entry = entries[entries.length - 1];
      if (entry !== undefined) entryFor.set(definition.id, entry);
    });

    return freeze({
      entries: freeze(entries),
      hotbar: this.hotbarView(entryFor),
      heldItemId: this.cursor.heldItem?.itemId ?? null,
      selectedBuildingId: held?.buildingId ?? null,
      rotation: this.cursor.buildRotation,
    });
  }

  /**
   * The hotbar, slot by slot, with the stack each slot stands for.
   *
   * **One slot is one stack**: the first hotbar slot holding iron plate shows
   * the first stack of it in the bag (in bag order), the second the next, and
   * a slot past what is carried shows 0. Nothing is reserved or moved — the
   * hotbar is a way of looking at the bag.
   */
  private hotbarView(entryFor: ReadonlyMap<string, BuildMenuEntry>): readonly (HotbarSlotView | null)[] {
    const items = this.simulation.items;
    const handItem = this.cursor.heldItem?.itemId ?? this.cursor.buildTool?.buildingId ?? null;
    const dealt = new Map<string, number>();

    const slots = this.hotbar.map((itemId, index): HotbarSlotView | null => {
      if (itemId === null || !items.has(itemId)) return null;
      const definition = items.get(itemId);
      const before = dealt.get(itemId) ?? 0;
      dealt.set(itemId, before + 1);
      const count = this.stacksOf(itemId)[before] ?? 0;
      const selected = handItem === itemId && this.selectedSlotIndex(itemId) === index;
      return freeze({
        itemId,
        name: definition.name,
        count,
        stackSize: definition.stackSize,
        building: entryFor.get(this.buildingForItem(itemId) ?? '') ?? null,
        selected,
      });
    });
    return freeze(slots);
  }

  /** Every stack of one item in the bag, in bag order. */
  private stacksOf(itemId: string): number[] {
    const bag = this.simulation.player.inventory;
    const items = this.simulation.items;
    if (!items.has(itemId)) return [];
    const runtimeId = items.idOf(itemId);
    const stacks: number[] = [];
    for (let index = 0; index < bag.slots; index++) {
      const cell = bag.cellAt(index);
      if (cell !== null && cell[0] === runtimeId) stacks.push(cell[1]);
    }
    return stacks;
  }

  /**
   * The bag, the craft grid and the queue, as one snapshot (C21A).
   *
   * §13's `InventoryPanel`, finally given something to read. Everything is
   * derived here for the reason every view model is: the stack sizes, the item
   * names and the hand-craft durations are registries, and §4 lets the UI hold
   * a frozen answer and never the thing that answered.
   *
   * It is built from scratch on each call, which is a dozen small objects at
   * 5 Hz while the panel is open and nothing at all while it is shut — see
   * `ui/ui.ts`, which does not ask when the panel is hidden.
   */
  getInventoryView(): InventoryView {
    const bag = this.simulation.player.inventory;

    const items: InventorySlotView[] = [];
    for (const definition of this.simulation.items.all()) {
      const itemId = this.simulation.items.idOf(definition.id);
      const count = bag.count(itemId);
      items.push(
        freeze({
          itemId: definition.id,
          name: definition.name,
          count,
          // The same ceiling the container itself uses, so "27/30 slots" and
          // the rows beneath it can never disagree about what a bag is full of.
          slots: Math.ceil(count / definition.stackSize),
          stackSize: definition.stackSize,
          buildingId: this.buildingForItem(definition.id),
        }),
      );
    }

    // C22: a recipe research has not revealed is hidden rather than greyed.
    // A hand-craft button is about what is in the bag — a row that said "you
    // cannot make this" for a reason that has nothing to do with the bag
    // would be answering a different question than the panel asks. The
    // research panel is where a lock is explained. Hidden by the panel, not
    // left out here: see `CraftOptionView.unlocked`.
    const crafts = this.simulation.recipes.handCraftable().map((recipe) => this.craftOptionView(recipe, bag));

    const queue = this.simulation.player.crafts.map((order, index) => this.craftQueueView(order, index));

    const cells = this.cellViews(bag);

    return freeze({
      cells,
      items: freeze(items),
      slots: bag.slots,
      usedSlots: bag.usedSlots,
      crafts: freeze(crafts),
      queue: queue.length === 0 ? EMPTY_QUEUE : freeze(queue),
    });
  }

  /** One row of the craft grid: a recipe, its bill, and how many are payable. */
  private craftOptionView(recipe: Recipe, bag: Inventory): CraftOptionView {
    let direct = MAX_CRAFT_BATCH;
    const inputs: CraftPartView[] = recipe.inputs.map((stack) => {
      const held = bag.count(stack.itemId);
      direct = Math.min(direct, Math.floor(held / stack.count));
      const part = this.partView(stack.itemId, stack.count);
      return freeze({ itemId: part.itemId, name: part.name, count: part.count, held });
    });
    // Counting what a chain could make too — the system's own planner, so the
    // button and the command cannot disagree. Only asked when the bag alone
    // falls short of a full batch, which keeps the common case one division.
    const { simulation } = this;
    const craftable =
      direct >= MAX_CRAFT_BATCH
        ? direct
        : maxCraftable(
            {
              recipes: simulation.recipes,
              durations: simulation.crafts,
              unlocks: simulation.unlocks,
              held: (itemId) => bag.count(itemId),
            },
            recipe,
            MAX_CRAFT_BATCH,
          );

    const first = recipe.outputs[0];
    const product = first === undefined ? null : this.partView(first.itemId, first.count);
    return freeze({
      id: recipe.id,
      name: product?.name ?? recipe.id,
      yield: first?.count ?? 1,
      productId: product?.itemId ?? recipe.id,
      inputs: freeze(inputs),
      craftTicks: this.simulation.crafts.handTicksFor(recipe.recipeId),
      craftable,
      chained: craftable > direct,
      unlocked: this.simulation.unlocks.isRecipeUnlocked(recipe.recipeId),
    });
  }

  /** One order in the hand-craft queue. Only the head has a progress bar. */
  private craftQueueView(order: CraftOrder, index: number): CraftQueueView {
    const recipe = this.simulation.recipes.byId(order.recipe);
    const duration = this.simulation.crafts.handTicksFor(order.recipe);
    const first = recipe.outputs[0];
    // Guarded for the reason `recipeView` guards its rate (§6 R7): a recipe
    // that has stopped being hand-craftable must not divide by zero here.
    const progress = index === 0 && duration > CANNOT_CRAFT ? order.progressTicks / duration : null;
    const product = first === undefined ? null : this.partView(first.itemId, first.count);
    return freeze({
      index,
      recipeId: recipe.id,
      name: product?.name ?? recipe.id,
      productId: product?.itemId ?? recipe.id,
      remaining: order.remaining,
      forChain: order.feeds > 0,
      progress,
      // Full progress and still at the head is exactly the state the system
      // parks a craft in when the bag has no room for it. The panel says so;
      // the toast said it once, a while ago.
      blocked: progress !== null && order.progressTicks >= duration,
    });
  }

  /**
   * The tech tree, as the research panel draws it (C22 task 5).
   *
   * Every technology in content order with its own state, one frozen snapshot
   * — see `views/research-view.ts` on why the whole tree is in it rather than
   * a diff. Built from scratch on each call, which is a few dozen small
   * objects at 5 Hz while the panel is open and nothing at all while it is
   * shut, exactly as the inventory is.
   */
  getResearchView(): ResearchView {
    const labs = this.countLabs();
    const technologies = this.simulation.technologies
      .all()
      .map((technology) => this.technologyView(technology));
    const queue = this.simulation.research.queue.map((id) => this.simulation.technologies.byId(id).id);

    return freeze({
      technologies: freeze(technologies),
      queue: queue.length === 0 ? EMPTY_IDS : freeze(queue),
      labs: labs.total,
      labsWorking: labs.working,
    });
  }

  /**
   * The explored world, as the map panel draws it (C23 task 4).
   *
   * One frozen snapshot of every explored world chunk, downsampled to
   * `MAP_CELL_TILES`-tile cells — see `views/map-view.ts` for the shape and
   * for why the colours are names rather than colours.
   *
   * ## The cache, and the one thing it reads that nothing else in `game/` does
   *
   * A downsampled world chunk is 512 bytes and a fully explored §12 map is
   * 1,600 of them, so rebuilding every one on every repaint is most of a
   * megabyte a second for a picture that changes when a miner empties a tile.
   * So each is cached against `WorldChunk.revision`, which is the same signal
   * the renderer's terrain cache uses and the same one `world.ts` documents as
   * "has this changed since I last drew it?".
   *
   * `revision` is described there as presentation-facing and read by nothing
   * in `game/`. This is the exception, and it is a narrow one: the controller
   * is the layer that *builds pictures* (§4), the alternative is a second
   * change counter beside the first, and a stale map cell is the one bug the
   * cache could cause — not a stale fact about the world.
   *
   * A world chunk that is explored but has never been **generated** is drawn
   * from `peekChunk`, which answers `undefined` rather than generating it: a
   * radar reveals ground without visiting it (`explored.ts`), and generating
   * a hundred world chunks because a panel opened is exactly what §14's
   * `peekChunk` exists to prevent. Such a cell is left at terrain index 0.
   */
  getMapView(): MapView {
    const world = this.simulation.world;
    const bounds = world.explored.bounds();

    const chunks: MapChunkView[] = [];
    for (const key of world.explored.keysAscending()) {
      const coords = unpackChunkKey(key);
      if (coords !== null) chunks.push(this.mapChunkView(coords.cx, coords.cy));
    }

    const entities: MapEntityView[] = [];
    this.simulation.entities.forEach((entity) => {
      if (!world.explored.hasTile(entity.x, entity.y)) return;
      const definition = this.simulation.buildings.forEntityType(entity.type);
      const extent = footprintExtent(definition.size, entity.rotation);
      entities.push(
        freeze({
          x: entity.x,
          y: entity.y,
          width: extent.width,
          height: extent.height,
          buildingId: definition.id,
        }),
      );
    });

    return freeze({
      cellTiles: MAP_CELL_TILES,
      chunkTiles: CHUNK_SIZE,
      chunks: freeze(chunks),
      minCx: bounds.minCx,
      minCy: bounds.minCy,
      maxCx: bounds.maxCx,
      maxCy: bounds.maxCy,
      playerX: this.simulation.player.x,
      playerY: this.simulation.player.y,
      entities: freeze(entities),
      terrainNames: TERRAIN_NAMES,
      resourceNames: RESOURCE_NAMES,
    });
  }

  /** One world chunk's cells, rebuilt only when its contents have moved. */
  private mapChunkView(cx: number, cy: number): MapChunkView {
    const chunk = this.simulation.world.peekChunk(cx, cy);
    const revision = chunk?.revision ?? -1;
    const key = `${cx},${cy}`;
    const cached = this.mapChunks.get(key);
    if (cached !== undefined && cached.revision === revision) return cached.view;

    const cells = CHUNK_SIZE / MAP_CELL_TILES;
    const terrain = new Uint8Array(cells * cells);
    const resource = new Uint8Array(cells * cells);

    if (chunk !== undefined) {
      for (let cellY = 0; cellY < cells; cellY++) {
        for (let cellX = 0; cellX < cells; cellX++) {
          // The cell's north-west tile, and nothing else. A cell is two tiles
          // square, and averaging four terrain types has no meaning — the
          // types are names, not numbers. Taking a corner is a *sample*, which
          // is what a downsampled map is, and it is the same corner every
          // time, so the picture does not shimmer as a patch is mined out.
          const index = (cellY * MAP_CELL_TILES) * CHUNK_SIZE + cellX * MAP_CELL_TILES;
          terrain[cellY * cells + cellX] = chunk.terrain[index] ?? 0;
          // Ore only where there is ore left: an exhausted tile keeps its
          // resource *type* (`world.ts`) so the delta stays lossless, and a
          // map that still showed it would send the player back to a patch
          // they finished.
          resource[cellY * cells + cellX] = (chunk.resourceAmount[index] ?? 0) > 0 ? (chunk.resource[index] ?? 0) : 0;
        }
      }
    }

    const view = freeze({ cx, cy, terrain, resource });
    this.mapChunks.set(key, { revision, view });
    return view;
  }

  /** One node of the tree: where it stands, what it costs, what it grants. */
  private technologyView(technology: Technology): TechnologyView {
    const research = this.simulation.research;
    const queuePosition = research.queue.indexOf(technology.technologyId);
    const unitsDone = research.unitsOf(technology.technologyId);
    const cost: ResearchCostView[] = technology.cost.map((line) => {
      const part = this.partView(line.itemId, line.count);
      return freeze({ itemId: part.itemId, name: part.name, count: part.count });
    });

    return freeze({
      id: technology.id,
      name: technology.name,
      summary: technology.summary,
      tier: technology.tier,
      state: this.technologyState(technology, queuePosition),
      queuePosition: queuePosition < 0 ? null : queuePosition,
      units: technology.units,
      unitsDone,
      // Guarded like every other division that reaches a view (§6 R7): the
      // registry refuses a technology of no units, and a view that divided by
      // one anyway would hand the panel an `Infinity` to draw a bar from.
      progress: technology.units > 0 ? unitsDone / technology.units : 0,
      cost: freeze(cost),
      unitSeconds: technology.durationTicks / TPS,
      prerequisites: freeze(
        technology.prerequisites.map((id) => this.simulation.technologies.byId(id).name),
      ),
      unlocks: freeze(technology.unlocks.map((unlock) => this.unlockView(unlock))),
    });
  }

  /**
   * The five words the panel draws a node in. See `TechnologyState`.
   *
   * `locked` is decided by the *prerequisites*, not by the unlock tables: a
   * technology is locked when something that leads to it is not done, which is
   * the thing the player can act on. Whether its grants are available is the
   * same question one step later and is the build menu's to answer.
   *
   * **A prerequisite already in the queue counts as satisfied**, because
   * `ResearchSystem.start` accepts one — a panel that greyed the node out
   * would make the queue's whole point, lining a branch up in one pass,
   * unreachable from the UI. §7 lets a pre-check be *looser* than the
   * simulation nowhere; this is the pre-check agreeing with it exactly.
   */
  private technologyState(technology: Technology, queuePosition: number): TechnologyState {
    if (this.simulation.research.isUnlocked(technology.technologyId)) return 'researched';
    if (queuePosition === 0) return 'active';
    if (queuePosition > 0) return 'queued';
    for (const prerequisite of technology.prerequisites) {
      if (this.simulation.research.isUnlocked(prerequisite)) continue;
      if (this.simulation.research.isQueued(prerequisite)) continue;
      return 'locked';
    }
    return 'available';
  }

  /** One grant, named: a building's own name, or what a recipe makes. */
  private unlockView(unlock: Unlock): UnlockView {
    if (unlock.kind === 'building') {
      const name = this.simulation.buildings.has(unlock.id)
        ? this.simulation.buildings.get(unlock.id).name
        : unlock.id;
      return freeze({ kind: unlock.kind, id: unlock.id, name });
    }
    if (!this.simulation.recipes.has(unlock.id)) {
      return freeze({ kind: unlock.kind, id: unlock.id, name: unlock.id });
    }
    const recipe = this.simulation.recipes.get(unlock.id);
    const first = recipe.outputs[0];
    return freeze({
      kind: unlock.kind,
      id: unlock.id,
      name: first === undefined ? recipe.id : this.partView(first.itemId, first.count).name,
    });
  }

  /**
   * The active technology, for the HUD's research tile, or null for an empty
   * queue (C22 task 5).
   */
  private researchTileView(): HudResearchView | null {
    const active = this.simulation.research.active;
    if (active === NO_TECHNOLOGY || !this.simulation.technologies.isTechnologyId(active)) return null;

    const technology = this.simulation.technologies.byId(active);
    const unitsDone = this.simulation.research.unitsOf(active);
    const labs = this.countLabs();
    return freeze({
      name: technology.name,
      unitsDone,
      units: technology.units,
      progressPercent: technology.units > 0 ? Math.floor((unitsDone * 100) / technology.units) : 0,
      labs: labs.total,
      labsWorking: labs.working,
    });
  }

  /**
   * How many labs exist, and how many are turning over.
   *
   * Walked rather than counted incrementally, for `PowerSystem.syncPoles`'s
   * reason: labs are a handful of entities and a bookkeeping hook missed on
   * one code path would leave the HUD explaining a stall that is not there.
   * The status is the one the *simulation* set in phase 7, so "working" here
   * means what it means in the inspector.
   */
  private countLabs(): { readonly total: number; readonly working: number } {
    let total = 0;
    let working = 0;
    for (const type of this.simulation.buildings.researchTypes()) {
      const labs = this.simulation.entities.byType<LabEntity>(type);
      for (let i = 0; i < labs.length; i++) {
        const lab = labs[i];
        if (lab === undefined) continue;
        total += 1;
        if (lab.status === MachineStatus.Running || lab.status === MachineStatus.LowPower) working += 1;
      }
    }
    return { total, working };
  }

  /** Every slot of a grid, in order, as the panels draw it. */
  private cellViews(grid: GridInventory): readonly InventoryCellView[] {
    const cells: InventoryCellView[] = [];
    for (let index = 0; index < grid.slots; index++) {
      const cell = grid.cellAt(index);
      if (cell === null || !this.simulation.items.isItemId(cell[0])) {
        cells.push(freeze({ index, itemId: null, name: '', count: 0, stackSize: 0, buildingId: null }));
        continue;
      }
      const definition = this.simulation.items.byId(cell[0]);
      cells.push(
        freeze({
          index,
          itemId: definition.id,
          name: definition.name,
          count: cell[1],
          stackSize: definition.stackSize,
          buildingId: this.buildingForItem(definition.id),
        }),
      );
    }
    return freeze(cells);
  }

  /** A chest's grid, or null for a building that is not storage. */
  private storageOf(entity: Entity): readonly InventoryCellView[] | null {
    const storage = this.simulation.buildings.storageFor(entity.type);
    const chest = asChest(entity);
    if (storage === null || chest === null) return null;
    // Built over a copy: a view must never hold the entity's own array.
    const grid = new GridInventory({
      slots: storage.slots,
      stackSizeOf: this.simulation.items.stackSizeOf,
      entries: chest.contents.map((entry) => [entry[0], entry[1], entry[2]]),
    });
    return this.cellViews(grid);
  }

  /**
   * The input slots of a building that takes materials by hand, or null.
   *
   * One slot per thing it needs, drawn even when empty, so the dialog shows
   * what to bring (2026-09-23):
   *
   * ```text
   * machine     a slot per ingredient of its recipe; a furnace that has not
   *             picked one shows what it holds, or one open slot; then fuel
   * generator   fuel
   * lab         science
   * ```
   */
  private machineSlotsOf(entity: Entity): readonly MachineSlotView[] | null {
    const buildings = this.simulation.buildings;
    const slots: MachineSlotView[] = [];

    const config = buildings.productionFor(entity.type);
    const machine = asMachine(entity, buildings);
    if (config !== null && machine !== null) {
      const recipes = this.simulation.recipes;
      const recipe = recipes.isRecipeId(machine.recipe) ? recipes.byId(machine.recipe) : null;
      if (recipe !== null) {
        for (const stack of recipe.inputs) {
          slots.push(this.slotView(entity, 'ingredient', stack.itemId, slotsCount(machine.input, stack.itemId), config.inputCapacity));
        }
      } else if (machine.input.length > 0) {
        for (const [itemId, count] of machine.input) {
          slots.push(this.slotView(entity, 'ingredient', itemId, count, config.inputCapacity));
        }
      } else if (config.recipeSelection !== 'player') {
        slots.push(this.slotView(entity, 'ingredient', null, 0, config.inputCapacity));
      }
      if (config.fuelCapacity !== undefined) {
        const fuel = machine.fuel[0];
        slots.push(this.slotView(entity, 'fuel', fuel?.[0] ?? null, fuel?.[1] ?? 0, config.fuelCapacity));
      }
      return freeze(slots);
    }

    const generatorConfig = buildings.generatorFor(entity.type);
    const generator = asGenerator(entity, buildings);
    if (generatorConfig !== null && generator !== null) {
      const fuel = generator.fuel[0];
      slots.push(this.slotView(entity, 'fuel', fuel?.[0] ?? null, fuel?.[1] ?? 0, generatorConfig.fuelCapacity));
      return freeze(slots);
    }

    const labConfig = buildings.researchFor(entity.type);
    const lab = asLab(entity, buildings);
    if (labConfig !== null && lab !== null) {
      const science = lab.input[0];
      slots.push(this.slotView(entity, 'science', science?.[0] ?? null, science?.[1] ?? 0, labConfig.inputCapacity));
      return freeze(slots);
    }
    return null;
  }

  /** One input slot, with what a PUT from the bag would move into it. */
  private slotView(
    entity: Entity,
    role: MachineSlotView['role'],
    itemId: ItemId | null,
    count: number,
    capacity: number,
  ): MachineSlotView {
    const items = this.simulation.items;
    const bag = this.simulation.player.inventory;
    let deposit: ItemId | null = itemId;
    if (deposit === null) {
      // The first thing in the bag, in content order, that this slot takes.
      // Fuel goes to the fuel slot and nothing else, which is how the
      // machine itself routes it (`items/item-port.ts`).
      for (const [candidate] of bag.toJSON()) {
        const burns = items.fuelTicksOf(candidate) > 0;
        if ((role === 'fuel') !== burns) continue;
        if (this.simulation.hands.roomFor(entity, candidate) > 0) {
          deposit = candidate;
          break;
        }
      }
    }
    const known = itemId !== null && items.isItemId(itemId);
    return freeze({
      role,
      itemId: known ? items.byId(itemId).id : null,
      name: known ? items.byId(itemId).name : SLOT_NAMES[role],
      count,
      capacity,
      depositItemId: deposit !== null && items.isItemId(deposit) ? items.byId(deposit).id : null,
      depositHeld: deposit === null ? 0 : bag.count(deposit),
    });
  }

  /**
   * One building, as the inspector draws it. `null` for an id nothing answers to.
   *
   * Everything here is derived on the spot from authoritative state (§10) and
   * frozen on the way out (§13), so a panel holding one of these is holding a
   * photograph: it cannot reach a machine through it and it cannot be
   * surprised by the machine changing underneath it.
   */
  getBuildingView(id: EntityId): MachineView | null {
    const entity = this.simulation.entities.get(id);
    if (entity === undefined) return null;
    const definition = this.simulation.buildings.forEntityType(entity.type);

    // C13: a chest has contents too, and more than one kind of them. The
    // capacity beside each line comes from the port that holds it, which is
    // what turns "12" into "12/50" and puts `output_full` on screen before it
    // happens; a chest fills by running out of *slots*, whatever is in them,
    // so there is no per-item number to show and the row shows none (C15).
    const inputs = this.simulation.hands.inputsOf(entity).map((stack) => this.stackView(stack));
    const outputs = this.simulation.hands.outputsOf(entity).map((stack) => this.stackView(stack));
    // A machine reports what it makes per minute; a miner what it mines. A
    // belt, a chest and an inserter make nothing and report null.
    const produces =
      this.simulation.buildings.miningFor(entity.type) !== null ||
      this.simulation.buildings.productionFor(entity.type) !== null;

    return freeze({
      id: entity.id,
      buildingId: definition.id,
      name: definition.name,
      // A building with no system behind it — a chest — is honestly idle.
      // Everything that can stall stores why, and `statusOf` is the one place
      // that knows the field is optional — which is §13's "status must always
      // explain a stall" holding for every machine rather than for the miner
      // the sentence was first written about.
      status: machineStatusName(statusOf(entity)),
      // Derived from the tick count every frame, never stored (§10). Null,
      // not zero, for a building that is not partway through anything — see
      // the note in `views/building-view.ts`.
      progress: this.progressOf(entity),
      // What it is making, and — for a machine the player chooses for — what
      // else it could make. Both null for a building that runs no recipes, so
      // the panel leaves the section out rather than drawing an empty grid
      // under every crate (C16 task 3, and §13's rule about `HudView`).
      recipe: this.currentRecipeView(entity),
      recipes: this.recipeChoicesFor(entity),
      inputs: inputs.length === 0 ? EMPTY_STACKS : freeze(inputs),
      slots: this.machineSlotsOf(entity),
      outputs: outputs.length === 0 ? EMPTY_STACKS : freeze(outputs),
      storage: this.storageOf(entity),
      // Measured for the selected machine only (C12 task 2). A machine asked
      // about in passing reads 0 rather than a figure from someone else's
      // window; a machine that produces nothing at all reads null.
      ratePerMinute: produces ? this.rate.perMinuteFor(entity.id) : null,
      // C20, closing C17's note: a splitter's panel used to be empty, because
      // it has no ports and therefore no contents to list. What it has is a
      // decision, and this is it.
      nextOutput: this.nextOutputOf(entity),
      // C21. Derived on the spot from phase 2's networks, which are derived
      // state themselves (§10) — so this is a photograph of a photograph, and
      // the panel can no more reach a network through it than it can a machine.
      power: this.powerReadingOf(entity),
      x: entity.x,
      y: entity.y,
      rotation: entity.rotation,
      inReach: this.simulation.hands.canReach(entity),
    });
  }

  /**
   * Where the next item out of a splitter goes, or null for anything else.
   *
   * Read straight off the entity's `outputCursor`, which is authoritative
   * state and the very thing C17 made deterministic — so the panel is showing
   * the simulation's own decision rather than a guess that could disagree with
   * it on the next tick.
   *
   * Null when the side it names has nothing on the other end: a splitter with
   * one output belt is a splitter that will send everything one way, and
   * pointing at a bare tile would say the opposite.
   */
  private powerReadingOf(entity: Entity): MachinePowerView | null {
    const reading = this.simulation.power.readingFor(entity);
    if (reading === null) return null;
    return freeze({
      consumptionKw: reading.consumptionKw,
      productionKw: reading.productionKw,
      connected: reading.connected,
      satisfactionPercent: reading.satisfactionPercent,
    });
  }

  private nextOutputOf(entity: Entity): { readonly x: number; readonly y: number } | null {
    const splitter = asSplitter(entity);
    if (splitter === null) return null;
    const size = this.simulation.buildings.forEntityType(entity.type).size;
    const tile = splitterOutputTile(splitter, size, splitter.outputCursor);
    return tile === null ? null : freeze({ x: tile.x, y: tile.y });
  }

  /**
   * The selected machine, or null when nothing is selected.
   *
   * The inspector's whole input. It is a second method rather than a
   * `getBuildingView(getSelection())` at the call site so that a selection
   * pointing at a machine demolished this frame is one `null` here instead of
   * an id the panel has to know to check.
   */
  getInspectorView(): MachineView | null {
    const selected = this.cursor.selectedEntityId;
    return selected === null ? null : this.getBuildingView(selected);
  }

  /**
   * The selected building's footprint, for the renderer's outline (C12 task 4).
   *
   * The extent is asked of the same `footprintExtent` the ghost uses, so a
   * rotated 2x1 is outlined the way it is drawn rather than the way it was
   * authored.
   */
  getSelectionView(): SelectionView | null {
    const selected = this.cursor.selectedEntityId;
    if (selected === null) return null;
    const entity = this.simulation.entities.get(selected);
    if (entity === undefined) return null;

    const definition = this.simulation.buildings.forEntityType(entity.type);
    const extent = footprintExtent(definition.size, entity.rotation);
    return freeze({
      entityId: entity.id,
      x: entity.x,
      y: entity.y,
      width: extent.width,
      height: extent.height,
    });
  }

  /**
   * The placement the cursor is currently proposing, or null for an empty hand.
   *
   * Validity is the simulation's own answer, asked without applying anything
   * (C06 decision 7), so a green ghost is never followed by a rejection.
   */
  getPlacementView(): PlacementView | null {
    const tool = this.cursor.buildTool;
    const tile = this.cursor.hover;
    if (tool === null || tile === null) return null;
    if (!this.simulation.buildings.has(tool.buildingId)) return null;

    const definition = this.simulation.buildings.get(tool.buildingId);
    const rotation = BuildingRegistry.normalizeRotation(definition, this.cursor.buildRotation);
    const extent = footprintExtent(definition.size, rotation);
    const reason = this.simulation.checkPlacement(tool.buildingId, tile.x, tile.y, rotation);

    return freeze({
      buildingId: definition.id,
      x: tile.x,
      y: tile.y,
      width: extent.width,
      height: extent.height,
      rotation,
      valid: reason === null,
      reason,
      // C11 task 4: how much ore a miner would actually sit on. Null for
      // everything that does not mine — see `PlacementView`.
      resourceTiles: this.simulation.resourceTilesUnder(definition.id, tile.x, tile.y, rotation),
    });
  }

  /**
   * What the pointer rests on, for the world tooltip (C32), or null over
   * nothing worth describing: bare ground, or no pointer on the world.
   *
   * The building part is `getBuildingView`, so the tooltip and the inspector
   * cannot disagree about a status. The rest is content numbers and the ore
   * under the pointer. Nothing is generated to answer: a tile whose world
   * chunk does not exist has no ore to report.
   */
  getHoverView(): HoverView | null {
    const tile = this.cursor.hover;
    if (tile === null) return null;
    const entityId = this.cursor.hoverEntity ?? null;
    const entity = entityId === null ? undefined : this.simulation.entities.get(entityId);
    const building = entity === undefined ? null : this.getBuildingView(entity.id);
    const resource = this.resourceAt(tile.x, tile.y);
    if (building === null && resource === null) return null;
    return freeze({
      x: tile.x,
      y: tile.y,
      building,
      details: entity === undefined || building === null ? null : this.buildingDetailsOf(entity),
      resource,
    });
  }

  /**
   * Which tile and building the pointer is on, as one string. Cheap, for the
   * UI to notice a change of target between its 10 Hz repaints (C32).
   */
  getHoverKey(): string {
    const tile = this.cursor.hover;
    if (tile === null) return '';
    return `${tile.x},${tile.y},${this.cursor.hoverEntity ?? ''}`;
  }

  /** The ore in one tile, without generating its world chunk. */
  private resourceAt(x: number, y: number): ResourceHoverView | null {
    const chunk = this.simulation.world.peekChunk(toChunkCoord(x), toChunkCoord(y));
    if (chunk === undefined) return null;
    const index = localIndex(toLocalCoord(x), toLocalCoord(y));
    const type = chunk.resource[index] ?? ResourceType.None;
    const amount = chunk.resourceAmount[index] ?? 0;
    if (type === ResourceType.None || amount <= 0) return null;
    const itemId = resourceItemId(type as ResourceType);
    if (itemId === null) return null;
    return freeze({ itemId, name: this.itemName(itemId), amount });
  }

  /** A building's content numbers. See `views/hover-view.ts`. */
  private buildingDetailsOf(entity: Entity): BuildingDetailsView {
    const buildings = this.simulation.buildings;
    const carry = buildings.carrySpeedFor(entity.type);
    const inserter = buildings.inserterFor(entity.type);
    const mining = buildings.miningFor(entity.type);
    const production = buildings.productionFor(entity.type);
    return freeze({
      beltTilesPerSecond: carry,
      beltItemsPerSecond: carry === null ? null : carry * BELT_SLOTS_PER_TILE,
      // `ticksPerItem` is at least 1 (§6 R7: the registry guarantees the
      // denominator), so neither division can make Infinity.
      inserterItemsPerSecond: inserter === null ? null : TPS / inserter.ticksPerItem,
      miningItemsPerSecond: mining === null ? null : TPS / mining.ticksPerItem,
      craftingSpeed: production?.craftingSpeed ?? null,
      oreUnder: mining === null ? null : this.oreUnder(entity),
    });
  }

  /**
   * The ore a miner still covers: the kind it is mining, or before its first
   * tick the first kind under it, in footprint order.
   */
  private oreUnder(entity: Entity): OreUnderView | null {
    const miner = asMiner(entity);
    const definition = this.simulation.buildings.forEntityType(entity.type);
    const world = this.simulation.world;
    let type = miner?.resourceType ?? ResourceType.None;
    if (type === ResourceType.None) {
      forEachFootprintTile(entity.x, entity.y, definition.size, entity.rotation, (x, y) => {
        if (type === ResourceType.None && world.getResourceAmount(x, y) > 0) type = world.getResource(x, y);
      });
    }
    if (type === ResourceType.None) return null;
    let remaining = 0;
    let tiles = 0;
    forEachFootprintTile(entity.x, entity.y, definition.size, entity.rotation, (x, y) => {
      if (world.getResource(x, y) !== type) return;
      const amount = world.getResourceAmount(x, y);
      remaining += amount;
      if (amount > 0) tiles += 1;
    });
    const itemId = resourceItemId(type);
    if (itemId === null) return null;
    return freeze({ itemId, name: this.itemName(itemId), remaining, tiles });
  }

  /** An item's name by its string id, or the id for one the table lacks. */
  private itemName(itemId: string): string {
    return this.simulation.items.has(itemId) ? this.simulation.items.get(itemId).name : itemId;
  }

  /* ---------------------------------------------------------------- *
   * Build tool
   * ---------------------------------------------------------------- */

  /** The building held over the cursor, by content id. */
  getSelectedBuilding(): string | null {
    return this.cursor.buildTool?.buildingId ?? null;
  }

  /**
   * Hold a building, or `null` to empty the hand. Unknown ids empty it too.
   *
   * Selecting the building already held puts it down, which is how every
   * toolbar in the genre behaves and the only way to empty a hand without
   * reaching for Escape.
   */
  selectBuilding(buildingId: string | null): void {
    this.heldSlot = null;
    if (buildingId === null || !this.simulation.buildings.has(buildingId)) {
      this.cursor.setBuildTool(null);
      this.cursor.setHeldItem(null);
      return;
    }
    if (this.cursor.buildTool?.buildingId === buildingId) {
      this.cursor.setBuildTool(null);
      return;
    }
    const definition = this.simulation.buildings.get(buildingId);
    this.cursor.setBuildTool({
      buildingId: definition.id,
      rotationCount: definition.rotationCount,
      lineBuild: definition.belt !== undefined,
    });
  }

  /**
   * The pipette (Q, 2026-09-23): hold another of the building under the
   * cursor, facing the same way, as the genre's pipette does.
   *
   * Only when the bag has one to place: a pipette over a building the player
   * has none of does nothing. Over bare ground (`null`) it empties the hand,
   * which is the pipette's other half in the genre. Returns whether the hand
   * now holds the building.
   */
  pipette(entityId: EntityId | null): boolean {
    const entity = entityId === null ? undefined : this.simulation.entities.get(entityId);
    if (entity === undefined) {
      this.selectBuilding(null);
      return false;
    }
    const definition = this.simulation.buildings.forEntityType(entity.type);
    if (this.simulation.inventory.count(definition.id) <= 0) return false;
    this.heldSlot = null;
    if (this.cursor.buildTool?.buildingId !== definition.id) this.selectBuilding(definition.id);
    this.cursor.setBuildRotation(entity.rotation);
    this.menuSignature = this.buildMenuSignature();
    this.emit({ type: 'buildMenuChanged' });
    return true;
  }

  /** The material in the hand, by content id — null when the hand is empty or holds a building. */
  getHeldItem(): string | null {
    return this.cursor.heldItem?.itemId ?? null;
  }

  /**
   * Take an item into the hand: its building if it places one, otherwise the
   * material itself, ready to feed a machine. Unknown ids empty the hand.
   *
   * Unlike `selectBuilding` this never puts down what is already held, so a
   * second click on the same bag cell keeps it in hand.
   */
  holdItem(itemId: string): void {
    this.heldSlot = null;
    this.fillHand(itemId);
  }

  private fillHand(itemId: string | null): void {
    if (itemId === null || !this.simulation.items.has(itemId)) {
      this.cursor.setBuildTool(null);
      this.cursor.setHeldItem(null);
      return;
    }
    const buildingId = this.buildingForItem(itemId);
    if (buildingId !== null) {
      if (this.cursor.buildTool?.buildingId !== buildingId) this.selectBuilding(buildingId);
      return;
    }
    if (this.cursor.heldItem?.itemId === itemId) return;
    this.cursor.setHeldItem({ itemId, amount: this.simulation.items.get(itemId).stackSize });
  }

  /**
   * The hand follows the bag down (2026-09-24, on request, as in Factorio).
   * When feeding machines or placing buildings empties the stack the hand was
   * lit on, the light moves to the next hotbar slot of the same item that
   * still has some; when the bag has none left at all, the hand empties and
   * the cursor is the plain pointer again.
   *
   * Only on the way down, and only for what the hand held last frame: pressing
   * a slot of something the bag has none of still holds it, as it always has.
   */
  private followHand(): void {
    const itemId = this.cursor.heldItem?.itemId ?? this.cursor.buildTool?.buildingId ?? null;
    const count = itemId === null ? 0 : this.simulation.inventory.count(itemId);
    const before = this.handSeen;
    this.handSeen = itemId === null ? null : { itemId, count };
    if (itemId === null || before?.itemId !== itemId || count >= before.count) return;

    if (count <= 0) {
      this.fillHand(null);
      this.heldSlot = null;
      this.handSeen = null;
      return;
    }
    const lit = this.heldSlot;
    if (lit === null) return;

    // Slot by slot, the stack each one shows — the same dealing `hotbarView` does.
    const stacks = this.stacksOf(itemId);
    const shown: number[] = [];
    let dealt = 0;
    for (const slotItem of this.hotbar) {
      shown.push(slotItem === itemId ? (stacks[dealt++] ?? 0) : 0);
    }
    if ((shown[lit] ?? 0) > 0) return;
    const next = shown.findIndex((stack, index) => index > lit && stack > 0);
    const index = next >= 0 ? next : shown.findIndex((stack) => stack > 0);
    this.heldSlot = index >= 0 ? index : null;
  }

  /** Is `itemId` what the hand holds, as a building or as a material? */
  private isInHand(itemId: string): boolean {
    return this.cursor.heldItem?.itemId === itemId || this.cursor.buildTool?.buildingId === itemId;
  }

  /**
   * Select hotbar slot `slot` (1-based). An empty slot empties the hand, and
   * pressing the slot already in hand puts it down.
   *
   * What a slot holds is the player's arrangement (`assignSlot`), starting
   * from the first nine buildings in content order. A building's slot holds
   * the building; any other item's slot holds the material, to feed a machine
   * with.
   */
  selectSlot(slot: number): void {
    if (!isHotbarSlot(slot)) return;
    const index = slot - 1;
    const itemId = this.hotbar[index] ?? null;
    if (itemId !== null && this.isInHand(itemId) && this.selectedSlotIndex(itemId) === index) {
      this.fillHand(null);
      this.heldSlot = null;
      return;
    }
    this.fillHand(itemId);
    this.heldSlot = itemId === null ? null : index;
    // Announced here, because the highlight moving between two slots of the
    // same item is the one change the signature cannot see; the signature is
    // brought up to date so the next `pump` does not announce it twice.
    this.menuSignature = this.buildMenuSignature();
    this.emit({ type: 'buildMenuChanged' });
  }

  /** The slot lit for `itemId`: the one pressed, or its first slot when it came from the bag. */
  private selectedSlotIndex(itemId: string): number {
    if (this.heldSlot !== null && this.hotbar[this.heldSlot] === itemId) return this.heldSlot;
    return this.hotbar.indexOf(itemId);
  }

  /**
   * Put an item on hotbar slot `slot` (1-based) — dragged there from the
   * inventory. Any item may go on the bar, and the same one may go on several
   * slots: each is one stack of it (see `hotbarView`).
   */
  assignSlot(slot: number, itemId: string): void {
    if (!isHotbarSlot(slot) || !this.simulation.items.has(itemId)) return;
    if (this.hotbar[slot - 1] === itemId) return;
    this.hotbar[slot - 1] = itemId;
    this.emit({ type: 'buildMenuChanged' });
  }

  /** Empty hotbar slot `slot` (1-based) — a right-click on it. */
  clearSlot(slot: number): void {
    if (!isHotbarSlot(slot) || this.hotbar[slot - 1] === null) return;
    this.hotbar[slot - 1] = null;
    if (this.heldSlot === slot - 1) this.heldSlot = null;
    this.emit({ type: 'buildMenuChanged' });
  }

  /** The hotbar as item ids, for the save's metadata. */
  getHotbarLayout(): readonly (string | null)[] {
    return freeze([...this.hotbar]);
  }

  /** Replace the whole hotbar — a loaded save's. `null` is the default layout. */
  setHotbarLayout(layout: readonly (string | null)[] | null): void {
    const next = this.resolveHotbar(layout);
    for (let slot = 0; slot < HOTBAR_SLOTS; slot++) this.hotbar[slot] = next[slot] ?? null;
    this.heldSlot = null;
    this.emit({ type: 'buildMenuChanged' });
  }

  /**
   * Swap two hotbar slots (1-based) — one slot's item dragged onto another.
   * Dropped on an empty slot, it simply moves.
   */
  moveSlot(from: number, to: number): void {
    if (!isHotbarSlot(from) || !isHotbarSlot(to) || from === to) return;
    const moving = this.hotbar[from - 1] ?? null;
    if (moving === null) return;
    this.hotbar[from - 1] = this.hotbar[to - 1] ?? null;
    this.hotbar[to - 1] = moving;
    if (this.heldSlot === from - 1) this.heldSlot = to - 1;
    else if (this.heldSlot === to - 1) this.heldSlot = from - 1;
    this.emit({ type: 'buildMenuChanged' });
  }

  /** A layout as nine slots of known items; `null` is the first nine buildings in content order. */
  private resolveHotbar(layout: readonly (string | null)[] | null): (string | null)[] {
    const buildings = this.simulation.buildings;
    const items = this.simulation.items;
    return Array.from({ length: HOTBAR_SLOTS }, (_, index) => {
      const id = layout === null ? (buildings.all()[index]?.id ?? null) : (layout[index] ?? null);
      return id !== null && items.has(id) ? id : null;
    });
  }

  /**
   * The building an item places, or `null` for an item that places nothing.
   *
   * §15 makes every build cost exactly one of the building's own item, so this
   * is the building whose cost is that one item. Asked by the inventory view,
   * which is how a building in the bag becomes something to pick up and drag.
   */
  buildingForItem(itemId: string): string | null {
    for (const definition of this.simulation.buildings.all()) {
      const cost = definition.buildCost;
      if (cost.length === 1 && cost[0]?.itemId === itemId) return definition.id;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Selection and manual transfer (C12 tasks 4 and 5)
   * ---------------------------------------------------------------- */

  /** The selected machine's id, or null. UI state; no system reads it. */
  getSelection(): EntityId | null {
    return this.cursor.selectedEntityId;
  }

  /**
   * Stop inspecting. The inspector's close button, and Escape's other half.
   *
   * The `selectionChanged` event follows on the next `pump()` rather than from
   * here, so that a selection cleared by a click, by this call and by a
   * demolished machine all reach the UI by one path.
   */
  clearSelection(): void {
    this.cursor.setSelectedEntity(null);
  }

  /**
   * Ask for items to be moved from a machine's output into the player's bag.
   *
   * A command like everything else (§7): this builds the plain data and queues
   * it, the simulation decides, and a refusal comes back as a toast one tick
   * later. It is a named method rather than the panel writing the command out
   * so that the UI never has to know the shape of one — the same reason
   * `selectSlot` exists instead of the toolbar reaching for the registry.
   */
  takeItems(entityId: EntityId, itemId: string, amount: number): CommandResult {
    return this.dispatch({ type: 'takeItems', entityId, itemId, amount });
  }

  /**
   * The other direction: coal or ore into a furnace, ingredients into an
   * assembler, anything into a chest. The building decides what it will take
   * — see `systems/hand-system.ts`.
   */
  insertItems(entityId: EntityId, itemId: string, amount: number): CommandResult {
    return this.dispatch({ type: 'insertItems', entityId, itemId, amount });
  }

  /**
   * Tell a machine what to make, or `null` to stop it making anything (C16).
   *
   * A command like everything else, for the reason `takeItems` is one: the
   * picker names a recipe, the simulation decides whether that machine may run
   * it, and the ingredients of whatever it was making come back to the player
   * in the same tick.
   */
  setRecipe(entityId: EntityId, recipeId: string | null): CommandResult {
    return this.dispatch({ type: 'setRecipe', entityId, recipeId });
  }

  /**
   * Move the stack in slot `from` of one grid to slot `to` of another — the
   * bag is `null`, a chest is its id — or to wherever it fits for `to: null`.
   * A drag inside the bag, a drag between bag and chest, a click that sends a
   * stack across. A command, because where a stack sits is state (§7).
   */
  moveStack(
    from: number,
    to: number | null,
    fromEntity: EntityId | null = null,
    toEntity: EntityId | null = null,
  ): CommandResult {
    return this.dispatch({ type: 'moveStack', fromEntity, from, toEntity, to });
  }

  /**
   * Queue `count` hand-crafts of a recipe (C21A).
   *
   * The ingredients leave the bag on the tick this is applied, not when each
   * item comes up — see `systems/crafting-system.ts` for why. The panel
   * pre-checks affordability to grey the button out, which §7 permits; the
   * simulation is still the authority.
   */
  craftItem(recipeId: string, count = 1): CommandResult {
    return this.dispatch({ type: 'craftItem', recipeId, count });
  }

  /** Drop the order at `index` and take its ingredients back (C21A). */
  cancelCraft(index: number): CommandResult {
    return this.dispatch({ type: 'cancelCraft', index });
  }

  /**
   * Put a technology in the research queue (C22).
   *
   * A command like everything else (§7): the panel names a technology, the
   * simulation decides whether its prerequisites allow it, and a refusal
   * comes back as a toast one tick later. The panel greys out a node it
   * expects to be refused, which §7 permits as a pre-check.
   */
  startResearch(technologyId: string): CommandResult {
    return this.dispatch({ type: 'startResearch', technologyId });
  }

  /** Take a technology out of the queue (C22). Nothing is lost by it. */
  cancelResearch(technologyId: string): CommandResult {
    return this.dispatch({ type: 'cancelResearch', technologyId });
  }

  /* ---------------------------------------------------------------- *
   * Pause
   * ---------------------------------------------------------------- */

  isPaused(): boolean {
    return this.game.isPaused();
  }

  setPaused(paused: boolean): void {
    if (this.game.isPaused() === paused) return;
    this.game.setPaused(paused);
    this.emit({ type: 'pauseChanged', paused });
  }

  togglePause(): void {
    this.setPaused(!this.game.isPaused());
  }

  /* ---------------------------------------------------------------- *
   * Speed (C30 task 5)
   * ---------------------------------------------------------------- */

  /** Simulated seconds per real second. See `GAME_SPEEDS`. */
  getSpeed(): number {
    return this.game.getSpeed();
  }

  /**
   * One step faster (`+1`) or slower (`-1`) through `GAME_SPEEDS`, stopping
   * at either end. Returns the speed now in effect.
   *
   * "A speed control for testing": watching a furnace column fill or a
   * patch run dry is minutes at 1x. It changes how many ticks a frame runs
   * and nothing about what a tick does, so a factory run at 8x is the factory
   * run at 1x, sooner — §8's "production speed must never depend on FPS" is
   * the same sentence about the same loop.
   */
  stepSpeed(direction: 1 | -1): number {
    const current = GAME_SPEEDS.indexOf(this.game.getSpeed());
    const index = Math.min(GAME_SPEEDS.length - 1, Math.max(0, (current < 0 ? 0 : current) + direction));
    const speed = GAME_SPEEDS[index] ?? 1;
    this.game.setSpeed(speed);
    return speed;
  }

  /* ---------------------------------------------------------------- *
   * The keyboard's target, and the first-run objectives (C30)
   * ---------------------------------------------------------------- */

  /**
   * Where the keyboard is pointing: the tile in front of the player, and the
   * entity standing on it.
   *
   * With a building held, the tile is where that building's footprint would
   * have its north-west corner if it stood **entirely** in front of the
   * player, centred on the way they face. A footprint anchored on the front
   * tile would reach back over the player for anything wider than a tile
   * facing north or west, and the placement would be refused for standing on
   * them — or, worse, not refused.
   *
   * The entity is the one on the front tile itself, which is what a player
   * facing a machine means by "this one".
   */
  getFacingTarget(): { readonly tile: TileCoord; readonly entityId: EntityId | null } | null {
    const player = this.simulation.player;
    const ahead = DIRECTION_OFFSETS[player.facing];
    if (ahead === undefined) return null;
    const front = { x: player.tileX + ahead.x, y: player.tileY + ahead.y };
    const occupant = this.simulation.entities.at(front.x, front.y);
    const entityId = occupant?.id ?? null;

    const tool = this.cursor.buildTool;
    if (tool === null || !this.simulation.buildings.has(tool.buildingId)) {
      return freeze({ tile: freeze(front), entityId });
    }
    const definition = this.simulation.buildings.get(tool.buildingId);
    const rotation = BuildingRegistry.normalizeRotation(definition, this.cursor.buildRotation);
    const { width, height } = footprintExtent(definition.size, rotation);
    // Centred across the facing axis; along it, the near edge touches the
    // front tile. Floor division, so an even width leans the same way for
    // every building rather than by rounding accident.
    const across = { x: front.x - Math.floor((width - 1) / 2), y: front.y - Math.floor((height - 1) / 2) };
    let tile: TileCoord;
    if (player.facing === NORTH) tile = { x: across.x, y: front.y - (height - 1) };
    else if (player.facing === SOUTH) tile = { x: across.x, y: front.y };
    else if (player.facing === EAST) tile = { x: front.x, y: across.y };
    else tile = { x: front.x - (width - 1), y: across.y };
    return freeze({ tile: freeze(tile), entityId });
  }

  /**
   * How far the world has got towards one goal. See `views/objective-view.ts`.
   *
   * A count rather than a yes-or-no, so that "mine 20 iron ore" can say
   * "12 of 20". An id the content table does not have counts nothing rather
   * than throwing: the objectives are words written in `ui/`, and a typo in
   * them should read as a goal nobody can finish, not take the frame down.
   */
  countObjective(goal: ObjectiveGoal): number {
    const simulation = this.simulation;
    switch (goal.kind) {
      case 'carried':
        return simulation.items.has(goal.itemId) ? simulation.inventory.count(goal.itemId) : 0;
      case 'built': {
        if (!simulation.buildings.has(goal.buildingId)) return 0;
        return simulation.entities.byType(simulation.buildings.get(goal.buildingId).entityType).length;
      }
      case 'stored': {
        if (!simulation.items.has(goal.itemId)) return 0;
        const itemId = simulation.items.idOf(goal.itemId);
        let total = 0;
        for (const definition of simulation.buildings.all()) {
          if (definition.storage === undefined) continue;
          for (const entity of simulation.entities.byType(definition.entityType)) {
            const chest = asChest(entity);
            if (chest === null) continue;
            for (const [, id, count] of chest.contents) if (id === itemId) total += count;
          }
        }
        return total;
      }
      case 'running': {
        if (!simulation.buildings.has(goal.buildingId)) return 0;
        let recipe: RecipeId | null = null;
        if (goal.recipeId !== undefined) {
          if (!simulation.recipes.has(goal.recipeId)) return 0;
          recipe = simulation.recipes.get(goal.recipeId).recipeId;
        }
        let working = 0;
        for (const entity of simulation.entities.byType(simulation.buildings.get(goal.buildingId).entityType)) {
          const status = statusOf(entity);
          if (status !== MachineStatus.Running && status !== MachineStatus.LowPower) continue;
          if (recipe !== null && asMachine(entity, simulation.buildings)?.recipe !== recipe) continue;
          working += 1;
        }
        return working;
      }
      case 'researched': {
        if (!simulation.technologies.has(goal.technologyId)) return 0;
        return simulation.research.isUnlocked(simulation.technologies.get(goal.technologyId).technologyId) ? 1 : 0;
      }
    }
  }

  /**
   * The quest steps met in this world, in the order they were met (C31).
   *
   * Kept here beside the hotbar and for the hotbar's reason: it belongs to a
   * factory, so it travels in the save's metadata (§14, schema v6), and no
   * system reads it, so it is not simulation state. The ids are the UI's —
   * `ui/objectives.ts` owns the words — and this only remembers which of them
   * have latched.
   */
  getQuestLog(): readonly string[] {
    return freeze([...this.questLog]);
  }

  /** Replace the log — a loaded save's, or `null` for a world with none yet. */
  setQuestLog(done: readonly string[] | null): void {
    this.questLog.length = 0;
    for (const id of done ?? []) this.noteQuestDone(id);
  }

  /** Remember that a step has been met. Once; a step never un-ticks. */
  noteQuestDone(id: string): void {
    if (this.questLog.length >= MAX_QUEST_LOG || this.questLog.includes(id)) return;
    this.questLog.push(id);
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  /**
   * Listen for one kind of event. Returns the function that stops listening.
   *
   * An unsubscribe function rather than an `off(type, fn)` pair, because a
   * caller that has to hold on to both the type and the exact function
   * reference to detach is a caller that leaks a listener the first time
   * someone wraps the callback.
   */
  subscribe<T extends GameEventType>(type: T, fn: (event: GameEventOf<T>) => void): () => void {
    const listener = fn as Listener;
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  private emit(event: GameEvent): void {
    const set = this.listeners.get(event.type);
    if (set === undefined) return;
    // A copy, so a listener that unsubscribes itself — the normal way a panel
    // is torn down — cannot change the set being walked. This is not a
    // simulation system, so §6 R4 does not apply: no authoritative state is
    // touched and the order two toasts appear in is not part of the save.
    for (const listener of [...set]) listener(event);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * The three facts the build menu shows, flattened into one comparable string.
   *
   * Stock, affordability, selection and — since C22 — whether research has
   * revealed the row. Anything a panel renders that is not in here would be a
   * change the panel never hears about, so a field added to `BuildMenuEntry`
   * belongs in this string too.
   */
  private buildMenuSignature(): string {
    const parts: string[] = [
      this.cursor.buildTool?.buildingId ?? '-',
      this.cursor.heldItem?.itemId ?? '-',
      String(this.cursor.buildRotation),
    ];
    // The hotbar's stacks: ore on the bar changes count as it is mined, and
    // a stack moved in the bag changes which one a slot shows.
    for (const itemId of this.hotbar) {
      parts.push(itemId === null ? '-' : this.stacksOf(itemId).join(','));
    }
    for (const definition of this.simulation.buildings.all()) {
      parts.push(definition.id);
      // C22. Without this the menu would learn about a completed technology
      // only when the next ore landed in the bag — the rows would be right
      // and the moment would be wrong, which is exactly the bug this
      // signature exists to prevent.
      parts.push(this.simulation.unlocks.isBuildingUnlocked(definition.entityType) ? 'u' : 'l');
      for (const stack of definition.buildCost) {
        parts.push(String(this.simulation.inventory.count(stack.itemId)));
      }
    }
    return parts.join('|');
  }

  /**
   * How far through its current piece of work a machine is, `0..1`.
   *
   * Null — not zero — for a building with nothing to be partway through, which
   * is what lets the inspector leave the bar out rather than draw a dead one
   * under every crate in the factory (see `views/building-view.ts`).
   *
   * A miner counts ticks toward the next item; an inserter counts ticks
   * through one swing cycle (C14); a machine counts ticks into the craft it is
   * running (C15). All three are progress in the sense the bar means:
   * something is happening and this is how much of it is left.
   */
  private progressOf(entity: Entity): number | null {
    const machine = asMachine(entity, this.simulation.buildings);
    if (machine !== null) {
      // A machine with no recipe is not partway through anything, and neither
      // is one whose recipe vanished under a content change (C27). The
      // denominator is the craft's length *in this machine* — a recipe's
      // duration at its own speed — which is the same number the simulation
      // counts against, and not the recipe's own (C16 task 5).
      const craftTicks = this.simulation.crafts.ticksFor(entity.type, machine.recipe);
      if (craftTicks === CANNOT_CRAFT) return null;
      return machine.progressTicks / craftTicks;
    }

    // C22. A lab's denominator is the *active technology's* unit length, not
    // the lab's own: a unit of research work is anonymous (`lab-entity.ts`),
    // and what it is worth is decided by whatever is at the head of the queue.
    // Null with nothing queued, because then it is not partway through
    // anything that is going to finish.
    const lab = asLab(entity, this.simulation.buildings);
    if (lab !== null) {
      const active = this.simulation.research.active;
      if (active === NO_TECHNOLOGY || !this.simulation.technologies.isTechnologyId(active)) return null;
      const ticks = this.simulation.technologies.byId(active).durationTicks;
      return ticks > 0 ? lab.progressTicks / ticks : null;
    }

    const miner = asMiner(entity);
    if (miner !== null) {
      const mining = this.simulation.buildings.miningFor(entity.type);
      return mining === null ? null : miner.progressTicks / mining.ticksPerItem;
    }

    const inserter = asInserter(entity);
    if (inserter !== null) {
      const config = this.simulation.buildings.inserterFor(entity.type);
      return config === null ? null : inserterCycleProgress(inserter, config);
    }

    return null;
  }

  /**
   * The recipe a machine is running, as the panel shows it, or null.
   *
   * Null covers three different things that all read the same way on screen: a
   * building that runs no recipes, a machine that has not been given one, and
   * a recipe that no longer exists under changed content (C27).
   */
  private currentRecipeView(entity: Entity): RecipeView | null {
    const machine = asMachine(entity, this.simulation.buildings);
    if (machine === null || !this.simulation.recipes.isRecipeId(machine.recipe)) return null;
    return this.recipeView(entity, this.simulation.recipes.byId(machine.recipe), machine.recipe);
  }

  /**
   * Every recipe this machine could be told to make, or null when nobody is
   * going to tell it (C16 task 3).
   *
   * The list is the machine's *category*, in content order, which is the order
   * `data/recipes.ts` is written in — so the grid does not reshuffle itself
   * between two frames, and adding a recipe puts it where the content author
   * put it. A recipe research has not revealed is filtered out here (C22), so
   * the panel never learns that it happened — and a machine already set to
   * one could not be, because research only ever unlocks.
   */
  private recipeChoicesFor(entity: Entity): readonly RecipeView[] | null {
    const config = this.simulation.buildings.productionFor(entity.type);
    if (config === null || config.recipeSelection !== 'player') return null;
    const machine = asMachine(entity, this.simulation.buildings);
    const selected = machine === null ? NO_RECIPE : machine.recipe;
    const views = this.simulation.recipes
      .byCategory(config.category)
      // C22, closing this method's own note: "every recipe is unlocked until
      // C22, so nothing is filtered out yet; when something is, it is
      // filtered here and the panel never learns that it happened."
      .filter((recipe) => this.simulation.unlocks.isRecipeUnlocked(recipe.recipeId))
      .map((recipe) => this.recipeView(entity, recipe, selected));
    return views.length === 0 ? EMPTY_RECIPES : freeze(views);
  }

  /** One recipe, at the speed of the machine that would run it. */
  private recipeView(entity: Entity, recipe: Recipe, selected: RecipeId): RecipeView {
    const craftTicks = this.simulation.crafts.ticksFor(entity.type, recipe.recipeId);
    const first = recipe.outputs[0];
    const outputs = recipe.outputs.map((stack) => this.partView(stack.itemId, stack.count));
    return freeze({
      id: recipe.id,
      name: outputs[0]?.name ?? recipe.id,
      inputs: freeze(recipe.inputs.map((stack) => this.partView(stack.itemId, stack.count))),
      outputs: freeze(outputs),
      craftTicks,
      // Guarded, because §6 R7 has no exception for a number the UI divides:
      // a recipe this machine cannot run reports no rate rather than Infinity.
      ratePerMinute: craftTicks === CANNOT_CRAFT ? 0 : ((first?.count ?? 0) * TPS * 60) / craftTicks,
      selected: recipe.recipeId === selected,
    });
  }

  /** One ingredient or product, named. See `stackView` on where the name is from. */
  private partView(itemId: ItemId, count: number): RecipePartView {
    const known = this.simulation.items.isItemId(itemId);
    const id = known ? this.simulation.items.byId(itemId).id : `item ${itemId}`;
    return freeze({ itemId: id, name: known ? this.simulation.items.byId(itemId).name : id, count });
  }

  /**
   * One line of a machine's buffer, named and frozen.
   *
   * The name comes from the item registry, which is the only place it exists
   * and the one thing §4 will not let a panel ask for itself. An id the
   * registry has never heard of keeps its own id as its name rather than
   * throwing: a view model is drawn every frame, and a content typo should
   * read as a strange label rather than take the frame down.
   */
  private stackView(stack: PortStack): MachineStack {
    const known = this.simulation.items.isItemId(stack.itemId);
    const itemId = known ? this.simulation.items.byId(stack.itemId).id : `item ${stack.itemId}`;
    const name = known ? this.simulation.items.byId(stack.itemId).name : itemId;
    return freeze({ itemId, name, count: stack.count, capacity: stack.capacity });
  }

}

/** What an empty input slot is called, by what goes in it. */
const SLOT_NAMES: Readonly<Record<MachineSlotView['role'], string>> = Object.freeze({
  ingredient: 'Ingredient',
  fuel: 'Fuel',
  science: 'Science',
});

/** Nothing in, nothing out. Shared so every empty machine view points at one array. */
const EMPTY_STACKS: readonly MachineStack[] = Object.freeze([]);

/** A machine whose category has no recipes at all. Shared and frozen. */
const EMPTY_RECIPES: readonly RecipeView[] = Object.freeze([]);

/** Nothing being made by hand, which is most of the time. Shared and frozen. */
const EMPTY_QUEUE: readonly CraftQueueView[] = Object.freeze([]);

/** An empty research queue, which is most of the time. Shared and frozen. */
const EMPTY_IDS: readonly string[] = Object.freeze([]);

/**
 * Freeze a view before it leaves the controller (§13).
 *
 * Shallow on purpose: each call site freezes its own nested arrays and objects
 * as it builds them, so the freeze happens once per value rather than once per
 * traversal. `Object.freeze` returns its argument, so this reads as a wrapper
 * rather than as a statement between the value and its use.
 */
/**
 * Terrain names indexed by `TileType`, and resource names by `ResourceType`.
 *
 * Built from the two tables rather than written out, so a terrain type added
 * later reaches the map with no line here — and taken as `name`, which is the
 * §11 palette token (`--if-grass`, `--if-iron`). See `views/map-view.ts`.
 */
const TERRAIN_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: TILE_TYPE_COUNT }, (_unused, type) => tileProperties(type as TileType).name),
);

const RESOURCE_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: RESOURCE_TYPE_COUNT }, (_unused, type) => resourceName(type as ResourceType)),
);

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Is `slot` a 1-based hotbar slot? */
function isHotbarSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= HOTBAR_SLOTS;
}
