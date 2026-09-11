import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { DEMO_FOOTPRINTS, seedDemoEntities, toRenderEntities } from './debug/demo-entities.js';
import { EntityStore } from './game/entities/entity-store.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { tileProperties } from './game/world/tile.js';
import { createCheckerboardGenerator } from './game/world/world-generator.js';
import { World } from './game/world/world.js';
import { InputManager } from './input/input-manager.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
import { ScenePicker } from './renderer/picker.js';
import type { RenderState } from './renderer/render-state.js';

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
  const world = new World(createCheckerboardGenerator());
  // The store is told how big each building type is (C05). C06 replaces the
  // debug table with the building registry, and this line stops being scaffolding.
  const entities = new EntityStore({ footprintOf: DEMO_FOOTPRINTS });
  const simulation = new Simulation(world, entities);
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

  // Scaffolding until C06 places buildings from data; see debug/demo-entities.ts.
  // The entities are real ones in the real store — only the decision of what to
  // place, and what it looks like, is fake.
  seedDemoEntities(entities);

  /**
   * The renderer's view of the entity store, rebuilt at the top of every frame.
   *
   * The picker reads the same array the frame drew, so what the cursor picks is
   * always what is on screen. C07's `GameController` owns this derivation.
   */
  let renderEntities = toRenderEntities(entities);

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
      if (action === 'debug.toggleOverlay' && phase === 'down') overlay.toggle();
    },
  });
  input.attach();

  /** The last command rejection, for the F3 readout until C07 has toasts. */
  let lastRejection = '—';
  let rejectionCount = 0;

  let lastFrameUs = scheduler.now();

  const render = (alpha: number): void => {
    renderEntities = toRenderEntities(entities);

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
      ghost: null,
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
    const originTile = world.getTile(0, 0);
    const stats = renderer.getStats();
    const hover = input.hover;

    overlay.update(
      game.getStats(),
      simulation.getTick(),
      {
        size: `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`,
        world: `${world.chunkCount} chunk(s), (0,0)=${tileProperties(originTile).name}`,
        entities: `${entities.size} live, next #${entities.nextId}`,
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
