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
import { footprintExtent } from './entities/entity.js';
import { asInserter, inserterCycleProgress } from './entities/inserter-entity.js';
import { machineStatusName, statusOf } from './entities/machine-status.js';
import { asMachine } from './entities/machine-entity.js';
import { splitterOutputTile, asSplitter } from './entities/splitter-entity.js';
import { asMiner } from './entities/miner-entity.js';
import type { Game } from './game.js';
import { ProductionRate } from './production.js';
import { BuildingRegistry, type BuildingDefinition } from './registries/building-registry.js';
import { CANNOT_CRAFT } from './registries/craft-durations.js';
import { NO_RECIPE, type Recipe, type RecipeId } from './registries/recipe-registry.js';
import type { Simulation } from './simulation.js';
import { NO_TECHNOLOGY, type Technology, type Unlock } from './registries/technology-registry.js';
import { asLab, type LabEntity } from './entities/lab-entity.js';
import { MachineStatus } from './entities/machine-status.js';
import { TPS } from './simulation-clock.js';
import type { BuildMenuCost, BuildMenuEntry, BuildMenuView } from './views/build-menu-view.js';
import type { Inventory } from './items/inventory.js';
import type { PortStack } from './items/item-port.js';
import type { ItemId } from './registries/item-registry.js';
import type { MachinePowerView, MachineStack, MachineView } from './views/building-view.js';
import type { GameEvent, GameEventOf, GameEventType } from './views/game-event.js';
import type { HudItemCount, HudPowerView, HudResearchView, HudView } from './views/hud-view.js';
import type {
  CraftOptionView,
  CraftPartView,
  CraftQueueView,
  InventorySlotView,
  InventoryView,
} from './views/inventory-view.js';
import { MAP_CELL_TILES, type MapChunkView, type MapEntityView, type MapView } from './views/map-view.js';
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
import { NORTH, type Rotation, type TileCoord } from './world/coordinates.js';
import { CHUNK_SIZE } from './world/chunk.js';
import { unpackChunkKey } from './world/explored.js';
import { TILE_TYPE_COUNT, tileProperties, type TileType } from './world/tile.js';
import { RESOURCE_TYPE_COUNT, resourceName, type ResourceType } from './world/resource.js';

/** Hotbar slots the number row reaches. §13's toolbar, C07 task 3. */
export const HOTBAR_SLOTS = 9;

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
  readonly selectedEntityId: EntityId | null;
  setBuildTool(tool: HeldBuilding | null): void;
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
}

/** A `Cursor` with nothing on the other end of it. For tests and headless use. */
export class DetachedCursor implements Cursor {
  buildTool: HeldBuilding | null = null;
  buildRotation: Rotation = NORTH;
  hover: TileCoord | null = null;
  selectedEntityId: EntityId | null = null;

  setBuildTool(tool: HeldBuilding | null): void {
    if (tool === null || this.buildTool?.buildingId !== tool.buildingId) this.buildRotation = NORTH;
    this.buildTool = tool;
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

  constructor(options: GameControllerOptions) {
    this.game = options.game;
    this.cursor = options.cursor ?? new DetachedCursor();
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

    this.simulation.buildings.all().forEach((definition, index) => {
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
          hotkey: index < HOTBAR_SLOTS ? index + 1 : null,
        }),
      );
    });

    return freeze({
      entries: freeze(entries),
      selectedBuildingId: held?.buildingId ?? null,
      rotation: this.cursor.buildRotation,
    });
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
        }),
      );
    }

    const crafts = this.simulation.recipes
      .handCraftable()
      // C22: a recipe research has not revealed is left out rather than
      // greyed. A hand-craft button is about what is in the bag — a row that
      // said "you cannot make this" for a reason that has nothing to do with
      // the bag would be answering a different question than the panel asks.
      // The research panel is where a lock is explained.
      .filter((recipe) => this.simulation.unlocks.isRecipeUnlocked(recipe.recipeId))
      .map((recipe) => this.craftOptionView(recipe, bag));

    const queue = this.simulation.player.crafts.map((order, index) => this.craftQueueView(order, index));

    return freeze({
      items: freeze(items),
      slots: bag.slots,
      usedSlots: bag.usedSlots,
      crafts: freeze(crafts),
      queue: queue.length === 0 ? EMPTY_QUEUE : freeze(queue),
    });
  }

  /** One row of the craft grid: a recipe, its bill, and how many are payable. */
  private craftOptionView(recipe: Recipe, bag: Inventory): CraftOptionView {
    let craftable = MAX_CRAFT_BATCH;
    const inputs: CraftPartView[] = recipe.inputs.map((stack) => {
      const held = bag.count(stack.itemId);
      craftable = Math.min(craftable, Math.floor(held / stack.count));
      const part = this.partView(stack.itemId, stack.count);
      return freeze({ itemId: part.itemId, name: part.name, count: part.count, held });
    });

    const first = recipe.outputs[0];
    return freeze({
      id: recipe.id,
      name: first === undefined ? recipe.id : this.partView(first.itemId, first.count).name,
      yield: first?.count ?? 1,
      inputs: freeze(inputs),
      craftTicks: this.simulation.crafts.handTicksFor(recipe.recipeId),
      craftable,
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
    return freeze({
      index,
      recipeId: recipe.id,
      name: first === undefined ? recipe.id : this.partView(first.itemId, first.count).name,
      remaining: order.remaining,
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
      outputs: outputs.length === 0 ? EMPTY_STACKS : freeze(outputs),
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
    if (buildingId === null || !this.simulation.buildings.has(buildingId)) {
      this.cursor.setBuildTool(null);
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
   * Select hotbar slot `slot` (1-based). Slots past the content table do nothing.
   *
   * This is C06's composition-root hotkey resolution, moved where §4 puts it.
   * The mapping is still pure content: slot *n* is the *n*th entry of
   * `data/buildings.ts`, so a building added there gains a hotkey, a toolbar
   * tile and a menu row with no code change anywhere.
   */
  selectSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > HOTBAR_SLOTS) return;
    const definition: BuildingDefinition | undefined = this.simulation.buildings.all()[slot - 1];
    this.selectBuilding(definition?.id ?? null);
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
    const parts: string[] = [this.cursor.buildTool?.buildingId ?? '-', String(this.cursor.buildRotation)];
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
