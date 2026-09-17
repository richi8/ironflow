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
import { TPS } from './simulation-clock.js';
import type { BuildMenuCost, BuildMenuEntry, BuildMenuView } from './views/build-menu-view.js';
import type { PortStack } from './items/item-port.js';
import type { ItemId } from './registries/item-registry.js';
import type { MachineStack, MachineView } from './views/building-view.js';
import type { GameEvent, GameEventOf, GameEventType } from './views/game-event.js';
import type { HudItemCount, HudView } from './views/hud-view.js';
import type { PlacementView } from './views/placement-view.js';
import type { RecipePartView, RecipeView } from './views/recipe-view.js';
import type { SelectionView } from './views/selection-view.js';
import type { PlayerActivity, PlayerView } from './views/player-view.js';
import { BUILD_RANGE_TILES, MINE_RANGE_TILES } from './player/player-state.js';
import { NORTH, type Rotation, type TileCoord } from './world/coordinates.js';

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
  private readonly simulation: Simulation;
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

  constructor(options: GameControllerOptions) {
    this.game = options.game;
    this.simulation = options.game.simulation;
    this.cursor = options.cursor ?? new DetachedCursor();
    this.menuSignature = this.buildMenuSignature();
    this.lastSelection = this.cursor.selectedEntityId;
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
          // Every building is unlocked until C22 has a technology tree.
          unlocked: true,
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
   * Stock, affordability and selection. Anything a panel renders that is not in
   * here would be a change the panel never hears about, so a field added to
   * `BuildMenuEntry` belongs in this string too.
   */
  private buildMenuSignature(): string {
    const parts: string[] = [this.cursor.buildTool?.buildingId ?? '-', String(this.cursor.buildRotation)];
    for (const definition of this.simulation.buildings.all()) {
      parts.push(definition.id);
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
   * put it. Every recipe is unlocked until C22, so nothing is filtered out
   * yet; when something is, it is filtered here and the panel never learns
   * that it happened.
   */
  private recipeChoicesFor(entity: Entity): readonly RecipeView[] | null {
    const config = this.simulation.buildings.productionFor(entity.type);
    if (config === null || config.recipeSelection !== 'player') return null;
    const machine = asMachine(entity, this.simulation.buildings);
    const selected = machine === null ? NO_RECIPE : machine.recipe;
    const views = this.simulation.recipes
      .byCategory(config.category)
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

/**
 * Freeze a view before it leaves the controller (§13).
 *
 * Shallow on purpose: each call site freezes its own nested arrays and objects
 * as it builds them, so the freeze happens once per value rather than once per
 * traversal. `Object.freeze` returns its argument, so this reads as a wrapper
 * rather than as a statement between the value and its use.
 */
function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
