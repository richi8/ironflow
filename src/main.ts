import './styles/main.css';

import { DebugOverlay } from './debug/debug-overlay.js';
import { Game } from './game/game.js';
import { Simulation } from './game/simulation.js';
import { BrowserFrameScheduler } from './platform/browser-clock.js';
import { CanvasSurface } from './platform/canvas-surface.js';

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

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function bootstrap(): void {
  const canvas = requireElement<HTMLCanvasElement>('#game');
  const uiRoot = requireElement<HTMLElement>('#ui');

  const surface = new CanvasSurface(canvas);
  const overlay = new DebugOverlay(uiRoot);
  const simulation = new Simulation();
  const scheduler = new BrowserFrameScheduler();

  // C03 replaces this with the real Renderer. Until then: a flat background,
  // which is enough to prove the loop runs and the canvas is sized correctly.
  const background = readToken('--if-bg-deep', '#0b111c');

  let lastOverlayUs = scheduler.now();

  const render = (_alpha: number): void => {
    const { cssWidth, cssHeight, deviceWidth, deviceHeight, dpr } = surface.getSize();
    const ctx = surface.ctx;

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const now = scheduler.now();
    const elapsedMs = (now - lastOverlayUs) / 1000;
    lastOverlayUs = now;
    overlay.update(
      game.getStats(),
      simulation.getTick(),
      `${cssWidth}x${cssHeight} @${dpr}x (${deviceWidth}x${deviceHeight})`,
      elapsedMs,
    );
  };

  const game = new Game({ simulation, scheduler, render });

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
