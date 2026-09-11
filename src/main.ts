import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { footprintExtent } from './game/entities/entity.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { createPlaygroundGenerator } from './game/world/world-generator.js';
import { World } from './game/world/world.js';
import { InputManager, type BuildTool } from './input/input-manager.js';
import type { InputAction } from './input/keybindings.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
import { describeEntities } from './renderer/entity-view.js';
import { ScenePicker } from './renderer/picker.js';
import type { GhostView, RenderState } from './renderer/render-state.js';
import type { SpriteId } from './renderer/sprite-atlas.js';

/**
 * Composition root. See ironflow.md §4.
 *
 * This is the only file allowed to know about every layer at once. Its whole
 * job is to construct the pieces and hand them to each other; if logic starts
 * accumulating here, it belongs somewhere else.
 */

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`IronFlow: missing required element "${selector}".`);
  return el;
}

function bootstrap(): void {
  const canvas = requireElement<HTMLCanvasElement>('#game');
  const uiRoot = requireElement<HTMLElement>('#ui');

  const surface = new CanvasSurface(canvas);
  const overlay = new DebugOverlay(uiRoot);
  // C19 replaces the checkerboard with real generation. The world is empty
  // until something asks about a tile — see World.getChunk.
  // C09 places real resource patches and C19 replaces the generator entirely.
  // The world is empty until something asks about a tile — see World.getChunk.
  const world = new World(createPlaygroundGenerator());
  // The simulation builds its own registry from `data/buildings.ts` and hands
  // the entity store the footprint lookup that comes with it (C05, C06).
  const simulation = new Simulation({ world });
  const scheduler = new BrowserFrameScheduler();

  const camera = new Camera({ x: 6, y: 6 });
  const renderer = new CanvasRenderer(surface.ctx);

  const applySize = (): void => {
    const { cssWidth, cssHeight, dpr } = surface.getSize();
    camera.setViewport(cssWidth, cssHeight);
    renderer.resize(cssWidth, cssHeight, dpr);
  };
  applySize();
  surface.onResize(applySize);

  /**
   * Starting items, so there is something to build with (C06).
   *
   * **Scaffolding.** Nothing produces items until C11 mines and C16 crafts, so
   * without a stock the first acceptance criterion — place a building — has no
   * way to be met at all. C10 gives the player a real starting inventory and
   * this line goes with it.
   */
  for (const definition of simulation.buildings.all()) {
    simulation.items.add(definition.id, 50);
  }

  /**
   * The renderer's view of the entity store, rebuilt at the top of every frame.
   *
   * The picker reads the same array the frame drew, so what the cursor picks is
   * always what is on screen. C07's `GameController` owns this derivation.
   */
  let renderEntities = describeEntities(simulation.entities, simulation.buildings);

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
      if (phase !== 'down') return;
      if (action === 'debug.toggleOverlay') overlay.toggle();
      selectBuildSlot(action);
    },
  });
  input.attach();

  /**
   * Number-row hotkeys, resolved against the content table.
   *
   * Slot *n* is the *n*th building in `data/buildings.ts`, so adding a building
   * there gives it a hotkey and a ghost with no code change anywhere — C06's
   * last acceptance criterion. C07's build menu replaces the hotkeys with a
   * panel and sets the same tool.
   */
  function selectBuildSlot(action: InputAction): void {
    const match = /^build\.slot([1-9])$/.exec(action);
    if (match === null) return;

    const definition = simulation.buildings.all()[Number(match[1]) - 1];
    if (definition === undefined) return;

    const held = input.buildTool;
    // The same key twice puts the building down, which is how every toolbar in
    // the genre behaves and the only way to empty a hand without reaching for
    // Escape.
    const tool: BuildTool | null =
      held?.buildingId === definition.id
        ? null
        : { buildingId: definition.id, rotationCount: definition.rotationCount };
    input.setBuildTool(tool);
  }

  /**
   * The placement preview (C06 task 7).
   *
   * Validity comes from the simulation's own check, so the red tint and the
   * rejection notice can never disagree — §7 says the simulation is the
   * authority and this is the UI asking it rather than guessing. Reading is
   * not mutating: nothing here changes authoritative state (§4).
   */
  function currentGhost(): GhostView | null {
    const tool = input.buildTool;
    const tile = input.hover;
    if (tool === null || tile === null) return null;

    const definition = simulation.buildings.get(tool.buildingId);
    const extent = footprintExtent(definition.size, input.buildRotation);
    return {
      x: tile.x,
      y: tile.y,
      width: extent.width,
      height: extent.height,
      sprite: definition.sprite as SpriteId,
      valid: simulation.checkPlacement(tool.buildingId, tile.x, tile.y, input.buildRotation) === null,
    };
  }

  /** The last command rejection, for the F3 readout until C07 has toasts. */
  let lastRejection = '—';
  let rejectionCount = 0;

  let lastFrameUs = scheduler.now();

  const render = (alpha: number): void => {
    renderEntities = describeEntities(simulation.entities, simulation.buildings);

    const now = scheduler.now();
    const elapsedMs = (now - lastFrameUs) / 1000;
    lastFrameUs = now;

    // Wall-clock smoothing of a presentation value. §6 permits exactly this and
    // nothing more: the camera is never serialized and no system reads it.
    camera.update(elapsedMs);
    // After the camera, before the draw: held keys move the view and the tile
    // under a stationary cursor changes when it does.
    input.update(elapsedMs);

    // The read-only view the renderer is allowed to see (C03 task 2). C07's
    // GameController takes this job over; until it exists, assembling it is
    // composition, which is what this file is for.
    const state: RenderState = {
      world: simulation.world,
      entities: renderEntities,
      hover: input.hover,
      ghost: currentGhost(),
      selected: input.selected,
    };
    renderer.render(state, camera, alpha);

    // §13: never from inside a tick. The processor records rejections and the
    // controller collects them afterwards, which is here until C07 exists.
    for (const rejection of simulation.commands.takeRejections()) {
      lastRejection = `${rejection.command.type}: ${rejection.reason}`;
      rejectionCount += 1;
    }

    const { cssWidth, cssHeight, deviceWidth, deviceHeight, dpr } = surface.getSize();
    const tool = input.buildTool;
    const stats = renderer.getStats();
    const hover = input.hover;

    overlay.update(
      game.getStats(),
      simulation.getTick(),
      {
        size: `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`,
        world: `${world.chunkCount} chunk(s), ${simulation.entities.size} entities`,
        build:
          tool === null
            ? '— (1-9 to select, R rotates)'
            : `${tool.buildingId} r${input.buildRotation} x${simulation.items.count(tool.buildingId)}`,
        terrain: `${stats.terrain.cached} cached / ${stats.terrain.direct} direct, ${stats.entities} ent, z${camera.zoom.toFixed(2)}`,
        hover:
          hover === null
            ? '—'
            : `${hover.x},${hover.y}${input.hoverEntity === null ? '' : ` #${input.hoverEntity}`}`,
        reject: rejectionCount === 0 ? '—' : `${lastRejection} (${rejectionCount})`,
      },
      elapsedMs,
    );
  };

  const game = new Game({ simulation, scheduler, render });

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
