import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { GameController } from './game/game-controller.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { ResourceType, resourceName } from './game/world/resource.js';
import { createPlaygroundGenerator } from './game/world/world-generator.js';
import { toChunkCoord, toLocalCoord, localIndex } from './game/world/chunk.js';
import { World } from './game/world/world.js';
import { InputManager } from './input/input-manager.js';
import type { InputAction } from './input/keybindings.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
import { buildingSprite, describeBeltItems, describeEntities, describePlayer } from './renderer/entity-view.js';
import type { PlayerView } from './game/views/player-view.js';
import { ScenePicker } from './renderer/picker.js';
import type { GhostView, RenderState } from './renderer/render-state.js';
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

/** Where a new game starts. On grass, within reach of the playground's iron. */
const START_TILE = Object.freeze({ x: 6, y: 6 });

/** What the player starts carrying. See the note at the assignment below. */
const STARTING_MATERIALS: Readonly<Record<string, number>> = Object.freeze({
  miner: 5,
  belt: 100,
  splitter: 10,
  inserter: 20,
  furnace: 10,
  assembler: 3,
  chest: 10,
});

/** Fraction of the viewport the player may roam before the camera follows. */
const FOLLOW_DEADZONE = 0.5;

/** How far `value` is outside `[min, max]`, signed. Zero when it is inside. */
function overflow(value: number, min: number, max: number): number {
  if (value < min) return value - min;
  if (value > max) return value - max;
  return 0;
}

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
 * One fixed number while worldgen is still C19's playground generator, which
 * ignores it. It is passed anyway rather than left to default, because a
 * composition root that lets a piece of authoritative state default is a
 * composition root that has not decided — and the day the generator starts
 * reading it, "which seed is this world?" must already have an answer the save
 * can carry.
 */
const WORLD_SEED = 0x1f0f10;

function bootstrap(): void {
  const canvas = requireElement<HTMLCanvasElement>('#game');
  const uiRoot = requireElement<HTMLElement>('#ui');

  const surface = new CanvasSurface(canvas);
  const overlay = new DebugOverlay(uiRoot);
  // C09 places real resource patches and C19 replaces the generator entirely.
  // The world is empty until something asks about a tile — see World.getChunk.
  const world = new World(createPlaygroundGenerator());
  // The simulation builds its own registry from `data/buildings.ts` and hands
  // the entity store the footprint lookup that comes with it (C05, C06).
  // The seed is chosen here because §4 makes the composition root the place
  // decisions are wired; it is authoritative state from C18 (§6 R2, §10) and
  // becomes a *player* decision at C25's new-game dialog, at which point this
  // constant is what that dialog replaces.
  const simulation = new Simulation({ world, seed: WORLD_SEED });
  simulation.player.setTilePosition(START_TILE.x, START_TILE.y);
  const scheduler = new BrowserFrameScheduler();

  const camera = new Camera({ x: START_TILE.x, y: START_TILE.y });
  const renderer = new CanvasRenderer(surface.ctx);

  const applySize = (): void => {
    const { cssWidth, cssHeight, dpr } = surface.getSize();
    camera.setViewport(cssWidth, cssHeight);
    renderer.resize(cssWidth, cssHeight, dpr);
  };
  applySize();
  surface.onResize(applySize);

  /**
   * What the player starts with (C10).
   *
   * C06 handed out fifty of everything, which was scaffolding to make "place a
   * building" reachable at all. This is the real thing: enough to get a first
   * miner onto ore, a run of belt away from it and a chest at the end, and not
   * enough to cover the map without ever mining. A hundred belts is the odd
   * one out — belts are cheap, they are spent a dozen at a time, and running
   * out of them mid-drag is the one shortage that makes the game feel broken
   * rather than constrained (C13). Twenty inserters is four per miner, which is
   * enough to wire a first factory and not enough to skip thinking about where
   * they go (C14). Ten furnaces is two per miner, which is just over §15's
   * 1.6 and is the first number here that comes out of the content table
   * rather than out of the feel of the thing (C15). Three assemblers is the
   * same arithmetic one step along: §15 says a gear assembler needs 3.2 plate
   * furnaces, so ten furnaces feed three of them (C16). Ten splitters is
   * two per miner, which is the number it takes to fan one ore line out to
   * four consumers — one split, then a split of each half — and the first
   * layout the player has to think about rather than the last (C17). All of
   * them are **balance numbers**, and all of them are still temporary in one respect —
   * §15's building recipes make buildings craftable, and a starting stock then
   * becomes a decision about the first five minutes rather than about whether
   * the game can be played at all.
   */
  for (const [buildingId, count] of Object.entries(STARTING_MATERIALS)) {
    simulation.inventory.add(buildingId, count);
  }

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

  /* ------------------------------------------------------------------ *
   * Input (C04).
   *
   * Three objects and one wiring decision. The manager is handed a camera it
   * can only move, a picker it can only ask, and a command sink it can only
   * enqueue to — §4's dependency rules expressed as three narrow interfaces
   * rather than as a comment asking people to be careful. `Camera` and
   * `ScenePicker` satisfy theirs structurally; neither knows this layer exists.
   * ------------------------------------------------------------------ */
  const picker = new ScenePicker(camera, () => renderEntities);
  const input = new InputManager({
    canvas,
    keyTarget: document,
    camera,
    picker,
    commands: simulation.commands,
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
      return;
    }
    if (action === 'ui.toggleBuildMenu') {
      ui.toggleBuildMenu();
      return;
    }
    if (action === 'game.togglePause') {
      controller.togglePause();
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
    return {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      // The same translation `describeEntities` makes for a placed building,
      // so a belt ghost points the way the belt will actually run (C13).
      sprite: buildingSprite(simulation.buildings.get(placement.buildingId), placement.rotation),
      valid: placement.valid,
      resourceTiles: placement.resourceTiles,
    };
  }

  /**
   * Keep the player on screen by nudging the camera when they leave a deadzone.
   *
   * Presentation only — it pans the camera, which is not simulation state (§6)
   * — and deliberately not a follow-cam: inside the box the camera does not
   * move at all, so the arrow keys still put the view where the player wants it
   * and looking around does not fight with walking. It exists because C10 is
   * the chunk that lets the player walk out of the viewport, and a game where
   * the character can be lost off-screen with no way to find them is not one
   * the acceptance criteria can be checked in.
   */
  function followPlayer(tileX: number, tileY: number): void {
    const { cssWidth, cssHeight } = surface.getSize();
    if (cssWidth <= 0 || cssHeight <= 0) return;

    const screen = camera.worldToScreen(tileX, tileY);
    const marginX = (cssWidth * (1 - FOLLOW_DEADZONE)) / 2;
    const marginY = (cssHeight * (1 - FOLLOW_DEADZONE)) / 2;

    const overX = overflow(screen.x, marginX, cssWidth - marginX);
    const overY = overflow(screen.y, marginY, cssHeight - marginY);
    if (overX !== 0 || overY !== 0) camera.pan(0 - overX, 0 - overY);
  }

  let lastFrameUs = scheduler.now();

  const render = (alpha: number): void => {
    const now = scheduler.now();
    const elapsedMs = (now - lastFrameUs) / 1000;
    lastFrameUs = now;
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
    };
    renderer.render(state, camera, alpha);

    // §13: never from inside a tick. The simulation records, the frame ends,
    // and only then does the controller hand anything to the UI.
    controller.pump();
    ui.update(elapsedMs);

    const { cssWidth, cssHeight, deviceWidth, deviceHeight, dpr } = surface.getSize();
    const stats = renderer.getStats();
    const hover = input.hover;
    const held = controller.getSelectedBuilding();

    overlay.update(
      game.getStats(),
      simulation.getTick(),
      {
        size: `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`,
        world: `${world.chunkCount} chunk(s), ${simulation.entities.size} entities`,
        build:
          held === null
            ? '— (1-9 or B to select, R rotates)'
            : `${held} r${input.buildRotation} x${simulation.inventory.count(held)}`,
        terrain: `${stats.terrain.cached} cached / ${stats.terrain.direct} direct, ${stats.entities} ent, z${camera.zoom.toFixed(2)}`,
        hover:
          hover === null
            ? '—'
            : `${hover.x},${hover.y}${input.hoverEntity === null ? '' : ` #${input.hoverEntity}`}`,
        // C09's readout: the number behind the tint and the pile. It stays
        // after C12 because it is about the *world*, not about a machine —
        // the inspector answers for buildings and has nothing to say about a
        // bare ore tile.
        ore: hover === null ? '—' : describeOre(world, hover.x, hover.y),
        // C10's readout: where the player is between tiles, which way they
        // face and how far into the current lump they are. An inventory panel
        // is where the bag becomes player-facing; the subtile arithmetic is
        // checked by eye here and nowhere else.
        player: describePlayerState(controller.getPlayerView()),
      },
      elapsedMs,
    );
  };

  const game = new Game({ simulation, scheduler, render });
  // `InputManager` satisfies `BuildCursor` structurally and has never heard of
  // it: what the player holds is pointer state (C04) and the UI has to see it
  // without importing `input/**` (§4).
  const controller = new GameController({ game, cursor: input });
  const ui = new GameUI({ root: uiRoot, controller });
  ui.mount();

  // §8: the game does not run in a background tab. Time away costs nothing and
  // produces nothing, and resyncing on return avoids a pointless catch-up lurch.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      game.stop();
    } else {
      // start() already rebases the clock, so no gap is credited on return.
      game.start();
    }
  });

  game.start();
}

bootstrap();
