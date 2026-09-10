import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { createDemoEntities } from './debug/demo-entities.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { tileProperties } from './game/world/tile.js';
import { createCheckerboardGenerator } from './game/world/world-generator.js';
import { World } from './game/world/world.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';
import { Camera } from './renderer/camera.js';
import { CanvasRenderer } from './renderer/canvas-renderer.js';
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

/** A wheel notch is 100 units of `deltaY` on every platform that matters. */
const WHEEL_UNITS_PER_NOTCH = 100;

function bootstrap(): void {
  const canvas = requireElement<HTMLCanvasElement>('#game');
  const uiRoot = requireElement<HTMLElement>('#ui');

  const surface = new CanvasSurface(canvas);
  const overlay = new DebugOverlay(uiRoot);
  // C19 replaces the checkerboard with real generation. The world is empty
  // until something asks about a tile — see World.getChunk.
  const world = new World(createCheckerboardGenerator());
  const simulation = new Simulation(world);
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

  // Scaffolding until C05 owns entities; see debug/demo-entities.ts.
  const demoEntities = createDemoEntities();
  let hover: RenderState['hover'] = null;

  let lastFrameUs = scheduler.now();

  const render = (alpha: number): void => {
    const now = scheduler.now();
    const elapsedMs = (now - lastFrameUs) / 1000;
    lastFrameUs = now;

    // Wall-clock smoothing of a presentation value. §6 permits exactly this and
    // nothing more: the camera is never serialized and no system reads it.
    camera.update(elapsedMs);

    // The read-only view the renderer is allowed to see (C03 task 2). C07's
    // GameController takes this job over; until it exists, assembling it is
    // composition, which is what this file is for.
    const state: RenderState = {
      world: simulation.world,
      entities: demoEntities,
      hover,
      ghost: null,
      selected: null,
    };
    renderer.render(state, camera, alpha);

    const { cssWidth, cssHeight, deviceWidth, deviceHeight, dpr } = surface.getSize();
    const originTile = world.getTile(0, 0);
    const stats = renderer.getStats();

    overlay.update(
      game.getStats(),
      simulation.getTick(),
      `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`,
      `${world.chunkCount} chunk(s), (0,0)=${tileProperties(originTile).name}`,
      `${stats.terrain.cached} cached / ${stats.terrain.direct} direct, ${stats.entities} ent, z${camera.zoom.toFixed(2)}`,
      elapsedMs,
    );
  };

  const game = new Game({ simulation, scheduler, render });

  /* ------------------------------------------------------------------ *
   * Temporary camera controls.
   *
   * C04 owns input and will delete these, replacing them with the real
   * input layer. They are here because three of C03's five acceptance
   * criteria — no seams at any zoom step, panning holds 60 fps, the hovered
   * tile stays under the cursor — cannot be looked at in a view that cannot
   * move. Moving the camera is not a command (§7): it changes no
   * authoritative state, so nothing about the pipeline is being pre-empted.
   * ------------------------------------------------------------------ */
  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    hover = camera.screenToTile(event.clientX - rect.left, event.clientY - rect.top);

    if (dragPointer !== event.pointerId) return;
    camera.pan(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  });

  const endDrag = (event: PointerEvent): void => {
    if (dragPointer !== event.pointerId) return;
    dragPointer = null;
    canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      camera.zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        -event.deltaY / WHEEL_UNITS_PER_NOTCH,
      );
    },
    { passive: false },
  );

  document.addEventListener('keydown', (event) => {
    if (event.code === 'F3') {
      event.preventDefault();
      overlay.toggle();
    }
  });

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
