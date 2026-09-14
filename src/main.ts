import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { GameController } from './game/game-controller.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { createPlaygroundGenerator } from './game/world/world-generator.js';
import { World } from './game/world/world.js';
import { InputManager } from './input/input-manager.js';
import type { InputAction } from './input/keybindings.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
import { describeEntities } from './renderer/entity-view.js';
import { ScenePicker } from './renderer/picker.js';
import type { GhostView, RenderState } from './renderer/render-state.js';
import type { SpriteId } from './renderer/sprite-atlas.js';
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
 * the rejection readout became real toasts. What is left is wiring, plus the
 * one translation §4 will not let the controller do — turning a building's
 * content id into a sprite id for the ghost.
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
    simulation.inventory.add(definition.id, 50);
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
      sprite: simulation.buildings.get(placement.buildingId).sprite as SpriteId,
      valid: placement.valid,
    };
  }

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

    // The read-only view the renderer is allowed to see (C03 task 2).
    const state: RenderState = {
      world: simulation.world,
      entities: renderEntities,
      hover: input.hover,
      ghost: currentGhost(),
      selected: input.selected,
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
