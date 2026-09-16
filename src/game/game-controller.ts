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
 * it through `BuildCursor`, a four-member interface that `InputManager`
 * satisfies structurally and has never heard of — the same arrangement C04 used
 * in the other direction for `CameraControl` and `TilePicker`. Nothing is
 * cached: every view reads the cursor live, so a rotation pressed between two
 * frames can never leave the toolbar showing the wrong one.
 */

import type { Command } from './commands/command.js';
import type { EntityId } from './entities/entity.js';
import { footprintExtent } from './entities/entity.js';
import { machineStatusName } from './entities/machine-status.js';
import { asMiner, minerOutput } from './entities/miner-entity.js';
import type { Game } from './game.js';
import { BuildingRegistry, type BuildingDefinition } from './registries/building-registry.js';
import type { Simulation } from './simulation.js';
import { TPS } from './simulation-clock.js';
import type { BuildMenuCost, BuildMenuEntry, BuildMenuView } from './views/build-menu-view.js';
import type { MachineView } from './views/building-view.js';
import type { GameEvent, GameEventOf, GameEventType } from './views/game-event.js';
import type { HudItemCount, HudView } from './views/hud-view.js';
import type { PlacementView } from './views/placement-view.js';
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
}

/** What the player is holding and where they are pointing. See the file header. */
export interface BuildCursor {
  readonly buildTool: HeldBuilding | null;
  readonly buildRotation: Rotation;
  readonly hover: TileCoord | null;
  setBuildTool(tool: HeldBuilding | null): void;
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
  readonly cursor?: BuildCursor;
}

/** A `BuildCursor` with nothing on the other end of it. For tests and headless use. */
export class DetachedCursor implements BuildCursor {
  buildTool: HeldBuilding | null = null;
  buildRotation: Rotation = NORTH;
  hover: TileCoord | null = null;

  setBuildTool(tool: HeldBuilding | null): void {
    if (tool === null || this.buildTool?.buildingId !== tool.buildingId) this.buildRotation = NORTH;
    this.buildTool = tool;
  }
}

type Listener = (event: GameEvent) => void;

export class GameController {
  private readonly game: Game;
  private readonly simulation: Simulation;
  private readonly cursor: BuildCursor;
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

  constructor(options: GameControllerOptions) {
    this.game = options.game;
    this.simulation = options.game.simulation;
    this.cursor = options.cursor ?? new DetachedCursor();
    this.menuSignature = this.buildMenuSignature();
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

    // Everything the player is carrying, in two passes because they carry it
    // in two containers — see `player/player-state.ts` on why, and C16 on when
    // that stops being true. Real items first, in content order, so the row a
    // player watches while mining does not move when a building is bought.
    for (const [itemId, count] of this.simulation.player.inventory.toJSON()) {
      const definition = this.simulation.items.byId(itemId);
      itemTotal += count;
      items.push(freeze({ itemId: definition.id, name: definition.name, count }));
    }
    // `toJSON` is sorted by item id, so the HUD's rows never reorder under the
    // player's cursor as counts change.
    for (const [itemId, count] of Object.entries(this.simulation.inventory.toJSON())) {
      itemTotal += count;
      items.push(freeze({ itemId, name: this.itemName(itemId), count }));
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

  getBuildingView(id: EntityId): MachineView | null {
    const entity = this.simulation.entities.get(id);
    if (entity === undefined) return null;
    const definition = this.simulation.buildings.forEntityType(entity.type);

    const miner = asMiner(entity);
    const mining = miner === null ? null : this.simulation.buildings.miningFor(entity.type);
    const output = miner === null ? null : minerOutput(miner);

    return freeze({
      id: entity.id,
      buildingId: definition.id,
      name: definition.name,
      // A building with no system behind it — a chest — is honestly idle. A
      // miner says which of C11's three things it is doing, which is §13's
      // "status must always explain a stall" becoming true for the first time.
      status: miner === null ? ('idle' as const) : machineStatusName(miner.status),
      // Derived from the tick count every frame, never stored (§10). The
      // denominator is content, so a `null` config is 0 rather than a divide
      // by zero (§6 R7).
      progress: miner === null || mining === null ? 0 : miner.progressTicks / mining.ticksPerItem,
      inputs: EMPTY_STACKS,
      outputs: output === null ? EMPTY_STACKS : freeze([freeze(output)]),
      // C12 measures this as a rolling average over 300 ticks; until then a
      // rate nobody has computed is 0 rather than a number that looks measured.
      ratePerMinute: 0,
      x: entity.x,
      y: entity.y,
      rotation: entity.rotation,
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
    this.cursor.setBuildTool({ buildingId: definition.id, rotationCount: definition.rotationCount });
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
   * The player-facing name of an item.
   *
   * Until C08 there is no item registry, and every item in the game is a
   * building's own build cost (§15), so the building table is the only place a
   * name exists. C08 gives items their own definitions and this asks that
   * instead — one lookup changing, not a panel.
   */
  private itemName(itemId: string): string {
    return this.simulation.buildings.has(itemId) ? this.simulation.buildings.get(itemId).name : itemId;
  }
}

/** Nothing in, nothing out. Shared so every empty machine view points at one array. */
const EMPTY_STACKS = Object.freeze([]);

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
