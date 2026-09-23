import './styles/main.css';

import { takeCensus } from './debug/census.js';
import { DebugOverlay } from './debug/debug-overlay.js';
import { writePerformanceRows, type FrameTimes, type Milestones } from './debug/perf-readout.js';
import { Profiler, RollingWindow } from './debug/profiler.js';
import type { CommandSink } from './game/commands/command-processor.js';
import { GameController } from './game/game-controller.js';
import { Game } from './game/game.js';
import type { SerializedGameState } from './game/save/save-format.js';
import { deserialize, serialize } from './game/save/save-serializer.js';
import { Simulation } from './game/simulation.js';
import { TPS } from './game/simulation-clock.js';
import { ResourceType, resourceName } from './game/world/resource.js';
import { createStartingWorld, WORLD_SPAWN } from './game/world/starting-area.js';
import { toChunkCoord, toLocalCoord, localIndex } from './game/world/chunk.js';
import type { World } from './game/world/world.js';
import { InputManager } from './input/input-manager.js';
import type { InputAction } from './input/keybindings.js';
import { Autosave, AUTOSAVE_IDS } from './persistence/autosave.js';
import { downloadSaveFile, watchSaveFileDrops } from './persistence/export-import.js';
import { IndexedDbSaveRepository } from './persistence/indexeddb-save-repository.js';
import { MemorySaveRepository } from './persistence/memory-save-repository.js';
import { SaveController, type SaveSessionState, type SaveSnapshot } from './persistence/save-controller.js';
import { SaveError, saveErrorMessage, type SaveRepository, type SaveSlot } from './persistence/save-repository.js';
import { SaveService } from './persistence/save-service.js';
import { TabLock } from './persistence/tab-lock.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
import {
  buildingSprite,
  describeAnnotations,
  describeBeltItems,
  describeEntities,
  describePlayer,
} from './renderer/entity-view.js';
import type { PlayerView } from './game/views/player-view.js';
import { ScenePicker } from './renderer/picker.js';
import type { GhostView, MachineAnnotation, RenderState } from './renderer/render-state.js';
import { spriteLift } from './renderer/sprite-atlas.js';
import { SAVE_ROWS, type SaveMenuView, type SaveSlotRow } from './ui/save-menu.js';
import { GameUI } from './ui/ui.js';

/**
 * Composition root. See ironflow.md §4.
 *
 * This is the only file allowed to know about every layer at once. Its whole
 * job is to construct the pieces and hand them to each other; if logic starts
 * accumulating here, it belongs somewhere else.
 *
 * C07 took three things out of it, which is why it is shorter than it was:
 * hotkey resolution and the placement preview moved into `GameController`, and
 * the rejection readout became real toasts. C12 took a fourth — the `machine`
 * debug row, which the inspector now says properly, and a second copy of the
 * same information in a developer readout is a second thing to keep in step
 * (the same reasoning that retired C04's `reject` row). What is left is wiring,
 * plus the one translation §4 will not let the controller do — turning a
 * building's content id into a sprite id for the ghost.
 *
 * ## C25 made it asynchronous, and made the world replaceable
 *
 * Two things changed here and nowhere else.
 *
 * `bootstrap` now **awaits storage before it builds a world**. If there is a
 * save, generating a fresh map first would be a second of worldgen thrown away
 * and a visible flash of a world the player never played — so the database
 * opens first, the newest slot is read, and only a browser with no save
 * reaches `newSimulation()`.
 *
 * And `simulation` is a `let`. Loading a save replaces it, because
 * `deserialize` builds a fresh `Simulation` rather than mutating one (C24), so
 * everything downstream has to reach it through this binding, through
 * `Game.simulation`, or through a closure over it. The two places that would
 * otherwise have held their own reference were each given one indirection:
 * `InputManager` takes a `CommandSink` that forwards, and `GameController`
 * reads `game.simulation` instead of a field. See `applyLoadedState`.
 */

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`IronFlow: missing required element "${selector}".`);
  return el;
}

/**
 * The resource on a tile, for the debug overlay.
 *
 * `peekChunk` rather than `World.getResource`, because this runs every frame on
 * whatever the cursor is over: the accessor generates a world chunk on a miss,
 * and a debug readout must not be the thing that decides how much of the map
 * exists. A tile the player can point at has been drawn, so its world chunk is
 * already there; a miss means the cursor is off the rendered world entirely.
 */
function describeOre(world: World, x: number, y: number): string {
  const chunk = world.peekChunk(toChunkCoord(x), toChunkCoord(y));
  if (chunk === undefined) return '—';
  const index = localIndex(toLocalCoord(x), toLocalCoord(y));
  const type = chunk.resource[index] ?? ResourceType.None;
  if (type === ResourceType.None) return 'none';
  return `${resourceName(type)} ${chunk.resourceAmount[index] ?? 0}`;
}

/**
 * What the player starts with (C10, retuned in C20).
 *
 * Every chunk up to C19 grew this list, because a building the player could
 * not make was a building they had to be given: C06 handed out fifty of
 * everything, and C13 through C17 each added their own with a paragraph of
 * arithmetic behind it. C20's building recipes end that. A starting stock is
 * now a decision about **the first five minutes** and nothing else, so it
 * shrank by about three quarters.
 *
 * What it buys, and why each number is the number:
 *
 * ```text
 * 2 miner      one on iron, one on coal — the smallest factory that runs
 *              itself, and one short of the copper the assembler wants
 * 40 belt      twenty tiles each way; enough to reach ore that is not
 *              underfoot, not enough to cross the map (C13)
 * 6 inserter   two per furnace and two spare: ore in, plates out
 * 2 furnace    §15 says a miner feeds 1.6 of them, so two is one miner's
 *              worth and the ratio is visible in the first thing built
 * 1 assembler  the machine that makes everything else, including more of
 *              itself. One, so the second one is earned
 * 4 chest      somewhere to put plates, and the answer to a full bag
 * ```
 *
 * **No splitter.** It is the one building here whose recipe needs a circuit,
 * and C17's layout puzzle is worth more when it arrives as something the
 * player built than as something they woke up holding.
 *
 * The whole kit is worth about 90 iron plates and 20 copper, which at one
 * miner and two furnaces is roughly five minutes of production — so it reads
 * as a head start rather than as a finished factory. All of these are
 * **balance numbers**; the acceptance they are tuned against is C20's "first
 * automated plate within 10 minutes", measured in
 * `tests/balance/first-factory.test.ts`.
 *
 * It is granted in `newSimulation` and nowhere else, so that loading a save
 * does not hand it out a second time (C25).
 */
const STARTING_MATERIALS: Readonly<Record<string, number>> = Object.freeze({
  miner: 2,
  belt: 40,
  inserter: 6,
  furnace: 2,
  assembler: 1,
  chest: 4,
});

/** The alt-mode overlay, off. Shared and frozen: every frame the key is not on. */
const NO_ANNOTATIONS: readonly MachineAnnotation[] = Object.freeze([]);

/** The player, for the debug overlay. See the row it fills in. */
function describePlayerState(view: PlayerView): string {
  const where = `${view.x.toFixed(2)},${view.y.toFixed(2)} r${view.facing} ${view.activity}`;
  const bag = `bag ${view.usedSlots}/${view.slots}`;
  if (view.mining === null) return `${where}, ${bag}`;
  return `${where}, ${bag}, mining ${view.mining.x},${view.mining.y} ${Math.round(view.mining.progress * 100)}%`;
}

/**
 * The world seed (§6 R2, §10, §14).
 *
 * One fixed number until C25's new-game dialog makes it a player decision.
 * From C19 it is the only thing that decides what the map looks like, and
 * `createStartingWorld` may hand back a *different* seed than this one — the
 * perturb-and-retry of C19 task 5 — which is why the simulation is given the
 * seed that was accepted rather than the one asked for.
 */
const WORLD_SEED = 0x1f0f10;

/**
 * A brand-new world, with the player standing in it holding the starter kit.
 *
 * Lifted out of `bootstrap` in C25 because a session now starts in one of two
 * ways, and the other one — a save — must not run a line of this: the starting
 * materials are a decision about the first five minutes, and handing them out
 * again on every load would be an unlimited supply of belts.
 */
function newSimulation(): Simulation {
  // C19: a generated world, validated before the player is put in it. The
  // returned seed is the one that passed, which is not necessarily WORLD_SEED
  // — see `starting-area.ts`. Validation has already generated the world
  // chunks around spawn; everything beyond them is still empty until something
  // asks about a tile (see World.getChunk).
  const started = createStartingWorld(WORLD_SEED);
  // The simulation builds its own registry from `data/buildings.ts` and hands
  // the entity store the footprint lookup that comes with it (C05, C06). The
  // seed is chosen here because §4 makes the composition root the place
  // decisions are wired; it is authoritative state from C18 (§6 R2, §10) and
  // becomes a *player* decision at a new-game dialog, at which point this
  // constant is what that dialog replaces.
  const simulation = new Simulation({ world: started.world, seed: started.seed });
  simulation.player.setTilePosition(WORLD_SPAWN.x, WORLD_SPAWN.y);
  for (const [buildingId, count] of Object.entries(STARTING_MATERIALS)) {
    simulation.inventory.add(buildingId, count);
  }
  return simulation;
}

/**
 * Storage, or the best substitute available. See §14's first failure row.
 *
 * > IndexedDB unavailable (private mode, blocked) — detect at startup, tell
 * > the player clearly, keep the game playable with export/import only. Never
 * > crash, never silently lose a factory.
 *
 * The substitute is `MemorySaveRepository`, which is the test double doing a
 * second job: with it the save menu still works for as long as the tab lives,
 * so a factory can still be saved and — from C26 — written out to a file. The
 * warning is the other half, and it is a standing line in the save menu rather
 * than a toast, because it is true for the whole session rather than for four
 * seconds of it.
 */
async function openStorage(): Promise<{ repository: SaveRepository; warning: string | null }> {
  try {
    return { repository: await IndexedDbSaveRepository.open(), warning: null };
  } catch (cause) {
    console.warn('IronFlow: IndexedDB is unavailable; saves will not survive this tab.', cause);
    return {
      repository: new MemorySaveRepository(),
      warning: saveErrorMessage(cause instanceof SaveError ? cause : new SaveError('unavailable', 'No IndexedDB.')),
    };
  }
}

/** What an autosave slot is called in the list. */
function autosaveName(id: string): string {
  const index = AUTOSAVE_IDS.indexOf(id);
  return index < 0 ? id : `Autosave ${index + 1}`;
}

/** One stored slot, as the save menu reads it. */
function slotRow(slot: SaveSlot, currentId: string | null): SaveSlotRow {
  return {
    id: slot.id,
    name: slot.name,
    kind: slot.kind,
    savedAt: slot.updatedAt,
    // Ticks are the simulation's unit and seconds are the player's. §6 R3
    // keeps that conversion out of `game/`; this is the far side of it.
    playtimeSeconds: slot.playtimeTicks / TPS,
    bytes: slot.bytes,
    current: slot.id === currentId,
  };
}

/** The save session as the panel's view model — frozen, like every other (§13). */
function saveMenuView(state: SaveSessionState): SaveMenuView {
  return Object.freeze({
    slots: Object.freeze(state.slots.slice(0, SAVE_ROWS).map((slot) => slotRow(slot, state.currentId))),
    hidden: Math.max(0, state.slots.length - SAVE_ROWS),
    status: state.status,
    tone: state.tone,
    canWrite: state.canWrite,
    busy: state.busy,
    offerTakeOver: state.offerTakeOver,
  });
}

/** Where the hotbar arrangement is kept between sessions. */
const HOTBAR_KEY = 'ironflow.hotbar';

/**
 * The hotbar the player left, or `undefined` for the default.
 *
 * Storage that is missing, blocked or holding something else is the default
 * rather than an error: a preference lost is a hotbar to fill again, and a
 * private window is allowed to forget.
 */
function loadHotbar(): readonly (string | null)[] | undefined {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HOTBAR_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map((value) => (typeof value === 'string' ? value : null));
  } catch {
    return undefined;
  }
}

function saveHotbar(layout: readonly (string | null)[]): void {
  try {
    localStorage.setItem(HOTBAR_KEY, JSON.stringify(layout));
  } catch {
    // See `loadHotbar`: a hotbar that is not remembered still works.
  }
}

async function bootstrap(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#game');
  const uiRoot = requireElement<HTMLElement>('#ui');

  const surface = new CanvasSurface(canvas);
  // Closed until F3 opens it, in every build. The profiler is attached only
  // while it is open, so the game ticks with no timer at all unless somebody
  // asks — which is C28's "zero-cost when disabled" without a build flag.
  const overlay = new DebugOverlay(uiRoot, false);

  /**
   * Performance numbers measured once, or once per event (C28). Written where
   * each thing happens and read only by the overlay; `null` is "not yet".
   */
  const milestones: { -readonly [K in keyof Milestones]: Milestones[K] } = {
    coldStart: null,
    worldgen: null,
    serialize: null,
    saveBytes: null,
    load: null,
  };

  /**
   * Is the UI built yet?
   *
   * Declared **before** anything asynchronous, which is the whole of why it is
   * up here: the tab lock settles on a timer that can fire during the `await`s
   * below, and a resumed session publishes its slot before the panels exist.
   * Both reach `publishSaves`, and a `let` read before its declaration is a
   * `ReferenceError` rather than an `undefined` — inside a timer, where it
   * would be invisible.
   */
  let wired = false;

  /** Was the game running when the save menu opened? §8's modal pause. */
  let pausedByMenu = false;

  /* ------------------------------------------------------------------ *
   * Storage, before there is a world (C25).
   *
   * The order is the point: whether a world has to be *generated* depends on
   * whether one is already stored. A fresh map takes about a second of
   * worldgen, and throwing it away a moment later is both that second and a
   * visible flash of somewhere the player has never been.
   * ------------------------------------------------------------------ */
  const storage = await openStorage();
  // The lock settles a moment after the tab opens (see `tab-lock.ts`), so the
  // menu has to be told when it does — that is the difference between "SAVE is
  // greyed out" and "SAVE is greyed out and nobody said why".
  const lock = new TabLock({ onChange: () => publishSaves() });
  const service = new SaveService({ repository: storage.repository, lock });

  let bootWarning = storage.warning;
  let bootSlots: readonly SaveSlot[] = [];
  let resumed: { readonly id: string; readonly simulation: Simulation } | null = null;
  try {
    bootSlots = await service.list();
    const newest = bootSlots[0];
    if (newest !== undefined) {
      const file = await service.read(newest.id);
      // Timed around `deserialize` alone, here and in `applyLoadedState`, so
      // the overlay's `load` row is §12's "load + rebuildDerived" whichever
      // way the world arrived, rather than including an IndexedDB read one
      // time and not the other.
      const loadStarted = performance.now();
      resumed = { id: newest.id, simulation: deserialize(file.state) };
      milestones.load = performance.now() - loadStarted;
    }
  } catch (cause) {
    // §14: a corrupt or unreadable save is refused and **kept**, never
    // deleted — it is still there to be exported (C26) — and the game starts
    // rather than failing to start, which is the difference between a lost
    // factory and a lost afternoon.
    console.warn('IronFlow: the most recent save could not be opened.', cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    bootWarning = `Your most recent save could not be opened, so a new world was started. It has been kept, not deleted. (${detail})`;
  }

  /**
   * The world. A `let`, because loading a save replaces it — see the header.
   */
  let simulation: Simulation = resumed?.simulation ?? timedNewSimulation();

  /** A new world, with the time its generation took on the overlay's `worldgen` row. */
  function timedNewSimulation(): Simulation {
    const started = performance.now();
    const created = newSimulation();
    milestones.worldgen = performance.now() - started;
    return created;
  }

  /**
   * Per-phase tick timings (C28). Attached to the simulation only while the
   * overlay is open — see `syncProfiler` — and re-attached to a loaded world,
   * which is a different `Simulation` from the one it was timing.
   */
  const profiler = new Profiler(() => performance.now());

  /** Frame times over the last five seconds at 60 fps. See `perf-readout.ts`. */
  const frames: FrameTimes = { render: new RollingWindow(300), interval: new RollingWindow(300) };

  /** Time the simulation's phases while the overlay is open, and not otherwise. */
  function syncProfiler(): void {
    profiler.reset();
    simulation.setPhaseTimer(overlay.isVisible() ? profiler : null);
  }
  syncProfiler();
  /** Where this world came from. The debug overlay's `world` row says so. */
  let origin = resumed === null ? 'new' : 'loaded';
  const scheduler = new BrowserFrameScheduler();

  const camera = new Camera({ x: WORLD_SPAWN.x, y: WORLD_SPAWN.y });
  const renderer = new CanvasRenderer(surface.ctx);

  const applySize = (): void => {
    const { cssWidth, cssHeight, dpr } = surface.getSize();
    camera.setViewport(cssWidth, cssHeight);
    renderer.resize(cssWidth, cssHeight, dpr);
  };
  applySize();
  surface.onResize(applySize);

  /**
   * The renderer's view of the entity store, rebuilt at the top of every frame.
   *
   * The picker reads the same array the frame drew, so what the cursor picks is
   * always what is on screen. This stayed on the renderer's side of §4 when the
   * rest of the composition root's derivations moved into `GameController`: a
   * drawable names a sprite, and `game/**` may not know what a sprite is.
   */
  let renderEntities = describeEntities(simulation.entities, simulation.buildings);

  /**
   * Wall time since the first frame, in seconds. Belt chevrons and nothing else.
   *
   * §6 allows the renderer a clock and allows nothing else one. It is
   * accumulated from the frame delta rather than read from `performance.now()`
   * directly so that the pause button stops the chevrons with the belts —
   * a paused factory whose belts are still visibly running would be lying.
   */
  let renderSeconds = 0;

  /**
   * Is the alt-mode overlay on? C20 task 5.
   *
   * Presentation state and nothing else: it changes what is drawn over the
   * world and touches neither the simulation nor the DOM, so it lives here
   * beside `renderSeconds` rather than in `GameController` — §13's rule is
   * that a view model carries what exists, and "is the player holding a key"
   * is not a fact about the game.
   */
  let altMode = false;

  /* ------------------------------------------------------------------ *
   * Input (C04).
   *
   * Three objects and one wiring decision. The manager is handed a camera it
   * can only move, a picker it can only ask, and a command sink it can only
   * enqueue to — §4's dependency rules expressed as three narrow interfaces
   * rather than as a comment asking people to be careful. `Camera` and
   * `ScenePicker` satisfy theirs structurally; neither knows this layer exists.
   * ------------------------------------------------------------------ */
  /**
   * The queue, forwarded rather than handed over (C25).
   *
   * `simulation` is replaced when a save is loaded, and an input layer holding
   * the old `CommandProcessor` would go on enqueueing into a world nobody is
   * playing — silently, because a queue nothing drains never complains.
   */
  const commandSink: CommandSink = { enqueue: (command) => simulation.commands.enqueue(command) };

  const picker = new ScenePicker(camera, () => renderEntities);
  const input: InputManager = new InputManager({
    canvas,
    keyTarget: document,
    camera,
    picker,
    commands: commandSink,
    // Copy-settings (C20 task 5). Deferred through a closure because the
    // controller is built *from* this manager — it is the cursor — so the two
    // cannot both be constructed first. It is only ever called from a click,
    // which is long after both exist.
    recipeOf: (entityId): string | null => controller.getBuildingView(entityId)?.recipe?.id ?? null,
    onAction: (action, phase) => {
      if (phase === 'down') handleAction(action);
    },
  });
  input.attach();

  /**
   * Keyboard actions no layer below owns. See `input/keybindings.ts`.
   *
   * The number row goes through exactly the call the toolbar's tiles do, so a
   * hotkey and a click are the same event by construction rather than by two
   * code paths kept in step.
   */
  function handleAction(action: InputAction): void {
    if (action === 'debug.toggleOverlay') {
      overlay.toggle();
      syncProfiler();
      return;
    }
    if (action === 'ui.toggleInventory') {
      ui.toggleInventory();
      return;
    }
    if (action === 'ui.toggleResearch') {
      ui.toggleResearch();
      return;
    }
    if (action === 'ui.toggleMap') {
      ui.toggleMap();
      return;
    }
    if (action === 'ui.toggleSaveMenu') {
      ui.toggleSaveMenu();
      return;
    }
    if (action === 'ui.toggleAltMode') {
      altMode = !altMode;
      return;
    }
    if (action === 'game.togglePause') {
      // Pausing is opening the game menu, which pauses behind it (§8).
      ui.togglePauseMenu();
      return;
    }
    const slot = /^build\.slot([1-9])$/.exec(action);
    if (slot !== null) controller.selectSlot(Number(slot[1]));
  }

  /**
   * The placement preview (C06 task 7), with its sprite attached.
   *
   * The controller answers everything except what it looks like: §4 forbids
   * `game/**` from naming a sprite, so the id-to-sprite step happens here, the
   * same way `describeEntities` does it for placed buildings.
   */
  function currentGhost(): GhostView | null {
    const placement = controller.getPlacementView();
    if (placement === null) return null;
    // The same translation `describeEntities` makes for a placed building, so
    // a belt ghost points the way the belt will actually run (C13).
    const ghostSprite = buildingSprite(simulation.buildings.get(placement.buildingId), placement.rotation);
    return {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      sprite: ghostSprite,
      valid: placement.valid,
      resourceTiles: placement.resourceTiles,
      // The ore count floats above the preview, which stands up like the
      // building it previews — see `MachineAnnotation.lift`.
      lift: spriteLift(ghostSprite),
    };
  }

  /**
   * Centre the view on the player, every time they move.
   *
   * Presentation only — it moves the camera, which is not simulation state
   * (§6). C10 shipped this as a **deadzone**: a box half the viewport across,
   * inside which the camera did not move at all. That was replaced on request
   * with what the genre actually does — the character stays in the middle and
   * the world slides under them — because a deadzone makes the view lurch when
   * the player crosses an edge they cannot see, and a factory is a thing you
   * walk around continuously rather than room by room.
   *
   * ## Why it re-centres on *movement* rather than every frame
   *
   * Centring unconditionally would make the camera unpannable: a drag, an
   * arrow-key pan or the map panel's jump-to would be undone on the next
   * frame, and three real features would quietly stop working. Re-centring
   * only when the player's position has actually changed keeps all of them
   * while the player is standing still — which is when someone looking around
   * *is* standing still — and hands the view straight back to the player the
   * moment they take a step. That is also the literal request: the camera
   * moves with every character move.
   *
   * Comparing positions rather than watching for a `movePlayer` command is
   * deliberate. The player can also be moved by something that is not a
   * command — a load, a respawn, a teleport a later chunk invents — and a
   * camera that tracked the *input* instead of the *position* would be left
   * behind by all three.
   */
  function followPlayer(tileX: number, tileY: number): void {
    if (tileX === followedX && tileY === followedY) return;
    followedX = tileX;
    followedY = tileY;
    camera.setPosition(tileX, tileY);
  }

  /**
   * Where the player was when the camera last centred on them.
   *
   * `NaN` until the first frame, which is what makes that frame centre: `NaN`
   * is not equal to itself, so no position can match it and the comparison
   * above needs no "have we started yet" flag beside it.
   */
  let followedX = Number.NaN;
  let followedY = Number.NaN;

  let lastFrameUs = scheduler.now();

  const render = (alpha: number): void => {
    const renderStarted = performance.now();
    const now = scheduler.now();
    const elapsedMs = (now - lastFrameUs) / 1000;
    lastFrameUs = now;
    frames.interval.push(elapsedMs);
    // The first frame drawn is the moment the page became something a player
    // can use; `performance.now()` counts from navigation, so this is §12's
    // "cold start to interactive" without a second clock.
    milestones.coldStart ??= renderStarted;
    if (!game.isPaused()) renderSeconds += elapsedMs / 1000;

    renderEntities = describeEntities(simulation.entities, simulation.buildings, renderSeconds);

    // Wall-clock smoothing of a presentation value. §6 permits exactly this and
    // nothing more: the camera is never serialized and no system reads it.
    camera.update(elapsedMs);
    // After the camera, before the draw: held keys move the view and the tile
    // under a stationary cursor changes when it does.
    input.update(elapsedMs);

    const player = describePlayer(controller.getPlayerView());
    followPlayer(player.x, player.y);

    // The read-only view the renderer is allowed to see (C03 task 2).
    const state: RenderState = {
      world: simulation.world,
      entities: renderEntities,
      // Belt items are described per frame like everything else, and kept out
      // of `entities` so the picker cannot return one (§9: not entities).
      items: describeBeltItems(simulation.entities, simulation.buildings, simulation.items),
      player,
      hover: input.hover,
      ghost: currentGhost(),
      selected: controller.getSelectionView(),
      // Only walked while the mode is on: a player who never presses the key
      // pays nothing, and `NO_ANNOTATIONS` is shared so an off frame allocates
      // nothing either.
      annotations: altMode
        ? describeAnnotations(simulation.entities, simulation.buildings, simulation.recipes, simulation.items)
        : NO_ANNOTATIONS,
    };
    renderer.render(state, camera, alpha);

    // §13: never from inside a tick. The simulation records, the frame ends,
    // and only then does the controller hand anything to the UI.
    controller.pump();
    ui.update(elapsedMs);
    // C25 task 4. Driven from the frame rather than from a timer, so "every
    // three minutes" is three minutes of *play* — see `autosave.ts` — and so
    // the snapshot it takes is between ticks by construction: the loop has
    // finished stepping by the time `render` is called.
    autosave.update(elapsedMs);

    // Everything the frame did besides ticking, which is what §12's render
    // budget is about. Taken before the overlay's own repaint, so the readout
    // does not count itself.
    frames.render.push(performance.now() - renderStarted);

    overlay.update(elapsedMs, (rows) => {
      const { cssWidth, cssHeight, deviceWidth, deviceHeight, dpr } = surface.getSize();
      const stats = renderer.getStats();
      const hover = input.hover;
      const held = controller.getSelectedBuilding();
      const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
      const current = saves.getState();

      writePerformanceRows(rows, {
        loop: game.getStats(),
        frames,
        profile: overlay.isVisible() ? profiler.snapshot() : null,
        census: takeCensus(simulation),
        drawn: stats.entities,
        visibleChunks: stats.terrain.visible,
        loadedChunks: simulation.world.chunkCount,
        heapMB: memory === undefined ? null : memory.usedJSHeapSize / (1024 * 1024),
        once: {
          ...milestones,
          // The save being played, as stored — which is the size that matters,
          // and the one the save menu shows beside it.
          saveBytes: current.slots.find((slot) => slot.id === current.currentId)?.bytes ?? null,
        },
      });

      rows.section('session');
      rows.row('tick', String(simulation.getTick()));
      rows.row('size', `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`);
      // C19: the seed is the first thing to check when a map looks wrong,
      // and it is not necessarily the one `WORLD_SEED` asked for.
      rows.row('world', `seed ${simulation.seed} (${origin})`);
      rows.row(
        'build',
        held === null
          ? '— (1-9, or pick from the bag; R rotates)'
          : `${held} r${input.buildRotation} x${simulation.inventory.count(held)}`,
      );
      rows.row(
        'terrain',
        `${stats.terrain.cached} cached / ${stats.terrain.direct} direct, z${camera.zoom.toFixed(2)}`,
      );
      rows.row(
        'hover',
        hover === null ? '—' : `${hover.x},${hover.y}${input.hoverEntity === null ? '' : ` #${input.hoverEntity}`}`,
      );
      // C09's readout: the number behind the tint and the pile. It stays
      // after C12 because it is about the *world*, not about a machine —
      // the inspector answers for buildings and has nothing to say about a
      // bare ore tile.
      rows.row('ore', hover === null ? '—' : describeOre(simulation.world, hover.x, hover.y));
      // C10's readout: where the player is between tiles, which way they
      // face and how far into the current lump they are. An inventory panel
      // is where the bag becomes player-facing; the subtile arithmetic is
      // checked by eye here and nowhere else.
      rows.row('player', describePlayerState(controller.getPlayerView()));
    });
  };

  const game = new Game({ simulation, scheduler, render });
  // `InputManager` satisfies `BuildCursor` structurally and has never heard of
  // it: what the player holds is pointer state (C04) and the UI has to see it
  // without importing `input/**` (§4).
  const controller: GameController = new GameController({ game, cursor: input, hotbar: loadHotbar() });
  // The hotbar is the player's arrangement, remembered between sessions. It
  // is a preference rather than game state (§10), so it lives beside the
  // browser's other preferences and not in the save; every change to it is a
  // `buildMenuChanged`, and writing nine short strings is cheaper than
  // working out whether this one was the hotbar.
  controller.subscribe('buildMenuChanged', () => saveHotbar(controller.getHotbarLayout()));

  /* ------------------------------------------------------------------ *
   * Saving and loading (C25).
   *
   * Three objects and four closures. `SaveController` owns the *flow* — what
   * happens between a click and a message — and everything it cannot do
   * itself is one of the closures below, because each is a thing only the
   * layer that owns the loop can promise.
   * ------------------------------------------------------------------ */

  /**
   * A snapshot, taken between ticks (§14, C24 task 5).
   *
   * Pausing is belt and braces rather than the mechanism: this runs either
   * from a DOM event or from the tail of `render`, and a tick cannot be
   * half-finished in either, since the loop is synchronous. The pause is what
   * makes the *guarantee* independent of where the caller happens to be, and
   * `serialize` throws rather than writing a half-advanced tick if it is not.
   *
   * Nothing is awaited inside it. The bytes go out afterwards — task 4's
   * "serialize between ticks; write asynchronously" — so the frame pays for
   * the snapshot (about 9 ms on §12's 20,007-entity factory) and nothing else.
   */
  function captureSave(): SaveSnapshot {
    const wasPaused = game.isPaused();
    game.setPaused(true);
    try {
      const started = performance.now();
      const state = serialize(simulation);
      milestones.serialize = performance.now() - started;
      return { state, playtimeTicks: simulation.getTick() };
    } finally {
      game.setPaused(wasPaused);
    }
  }

  /** Point the camera at the player, for a world that has just appeared. */
  function centreOnPlayer(): void {
    const player = controller.getPlayerView();
    camera.setPosition(player.x, player.y);
  }

  /**
   * Play a loaded world. The other half of `captureSave`.
   *
   * Everything that held the old world is re-pointed here, and the list is
   * deliberately short — one binding, one field, one cache — because C24 made
   * `deserialize` build a fresh `Simulation` rather than mutate one, and
   * §4 made everything else reach the simulation through the controller.
   *
   * It throws rather than reporting: a save that will not deserialize has
   * changed nothing, so the caller can say so and the player keeps playing the
   * factory they were in.
   */
  function applyLoadedState(state: SerializedGameState): void {
    const started = performance.now();
    const loaded = deserialize(state);
    milestones.load = performance.now() - started;
    milestones.worldgen = null;
    simulation = loaded;
    syncProfiler();
    game.replaceSimulation(loaded);
    controller.reload();
    // The terrain cache is keyed by world chunk and revision, and a loaded
    // world starts both again from where the old one did — see
    // `TerrainLayer.invalidate`.
    renderer.invalidate();
    renderEntities = describeEntities(loaded.entities, loaded.buildings, renderSeconds);
    centreOnPlayer();
    origin = 'loaded';
  }

  const autosave = new Autosave({
    write: async (id) => {
      const snapshot = captureSave();
      await service.write(id, {
        name: autosaveName(id),
        kind: 'auto',
        state: snapshot.state,
        playtimeTicks: snapshot.playtimeTicks,
      });
      saves.noteAutosave();
    },
    onError: (error) => saves.noteAutosaveFailed(error),
  });
  autosave.prime(bootSlots);

  const saves = new SaveController({
    service,
    autosave,
    capture: captureSave,
    apply: applyLoadedState,
    // C26 task 1. The controller stays headless — an anchor and an object URL
    // are the browser's, not its — so the one line of DOM a download needs is
    // wired here, where every other browser dependency is.
    download: (bytes, filename) => downloadSaveFile(bytes, filename),
    onChange: (state) => {
      if (wired) ui.setSaveMenuView(saveMenuView(state));
    },
    warning: bootWarning,
  });
  if (resumed !== null) saves.setCurrentId(resumed.id);

  /** Push the current save state at the menu. See `TabLock`'s `onChange`. */
  function publishSaves(): void {
    if (wired) ui.setSaveMenuView(saveMenuView(saves.getState()));
  }

  const ui = new GameUI({
    root: uiRoot,
    controller,
    // C23's map, click to jump. The composition root is the one place that
    // holds both the UI and the camera (§4), so it is where the two meet.
    onJumpTo: (x, y) => camera.setPosition(x, y),
    // And the other direction: the four corners of what the world view can
    // see, so the map can outline it. Unprojected here rather than in the
    // panel because the transform belongs to the camera (§5), and taken as
    // *corners* rather than as `visibleTileBounds` because that method returns
    // the axis-aligned box a culler wants, which covers about twice the ground
    // a player can see — see `MapPanelOptions.viewport`.
    viewport: () => {
      const { cssWidth, cssHeight } = surface.getSize();
      if (cssWidth <= 0 || cssHeight <= 0) return null;
      return [
        camera.screenToWorld(0, 0),
        camera.screenToWorld(cssWidth, 0),
        camera.screenToWorld(cssWidth, cssHeight),
        camera.screenToWorld(0, cssHeight),
      ];
    },
    // C25 task 7. §4 forbids `ui/**` from importing `persistence/**`, so the
    // panel names an id and a string and this is where that becomes a write.
    saves: {
      onSave: (name) => void saves.saveNew(name),
      onOverwrite: (id, name) => void saves.overwrite(id, name),
      onLoad: (id) => void saves.load(id),
      onDelete: (id) => void saves.remove(id),
      onRename: (id, name) => void saves.rename(id, name),
      // C26. A selected slot exports that slot; nothing selected exports the
      // factory on screen, which is the only export a browser with no
      // IndexedDB can offer (§14's first row).
      onExport: (id, name) => void (id === null ? saves.exportCurrent(name) : saves.exportSlot(id)),
      onImport: (file) => void saves.importFile(file, file.name),
      onTakeOver: () => saves.takeOver(),
      // §8: "pause the loop outright when a modal save/load dialog is open."
      // Remembered rather than toggled, so closing the menu does not start a
      // game the player had deliberately paused before opening it.
      onVisibility: (open) => {
        if (open) {
          pausedByMenu = !game.isPaused();
          if (pausedByMenu) controller.setPaused(true);
          void saves.refresh();
        } else if (pausedByMenu) {
          pausedByMenu = false;
          controller.setPaused(false);
        }
      },
    },
  });
  ui.mount();
  wired = true;
  centreOnPlayer();
  publishSaves();

  // C26 task 2's other half: a save dropped anywhere on the window is
  // imported. The listener is here rather than in the panel because a drop
  // that only worked over one panel is a drop the player has to discover, and
  // because §4 keeps `ui/**` clear of `persistence/**` either way. Opening the
  // menu is part of the import: the status line is where the answer appears.
  watchSaveFileDrops(window, (file) => {
    ui.openSaveMenu();
    void saves.importFile(file, file.name);
  });

  // §8: the game does not run in a background tab. Time away costs nothing and
  // produces nothing, and resyncing on return avoids a pointless catch-up lurch.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // §14: autosave on the way out. The snapshot is taken synchronously,
      // before the loop stops, so what is written is the world as it was left;
      // the bytes go out afterwards, which a tab being closed may not finish —
      // which is why this is insurance on top of the three-minute timer and
      // not instead of it.
      void autosave.trigger();
      game.stop();
    } else {
      // start() already rebases the clock, so no gap is credited on return.
      game.start();
    }
  });

  game.start();
}

void bootstrap();
