import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The composition root, started for real. See ironflow.md C25 and §4.
 *
 * `main.ts` has never had a test, and until C25 that was defensible: it was
 * wiring, and every piece it wired had one of its own. C25 changed its shape —
 * `bootstrap` became **asynchronous**, it opens storage before it builds a
 * world, and it now has a binding (`simulation`) that is replaced rather than
 * fixed. Those are ordering bugs waiting to happen, and an ordering bug in a
 * composition root is invisible to every unit test underneath it.
 *
 * So this imports the module and lets it run. It does not let it *draw*:
 * `requestAnimationFrame` is stubbed to a callback that is never called, so
 * the loop starts, schedules, and renders nothing. What is under test is the
 * wiring — which is what would break — and not the renderer, which has its own
 * tests and would need a complete 2D context here.
 *
 * jsdom has no `indexedDB`, which makes this §14's first failure row as well:
 * the game must start, warn clearly, and stay playable.
 */

/** Frames requested by the loop. Never invoked, so nothing is ever drawn. */
let framesRequested = 0;

beforeAll(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => ++framesRequested);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: () => undefined,
    setTransform: () => undefined,
  } as unknown as CanvasRenderingContext2D);

  document.body.innerHTML = '<canvas id="game"></canvas><div id="ui"></div>';
  await import('../../src/main.js');
  // `bootstrap` awaits storage before it builds a world, so the panels appear
  // a turn or two after the import resolves.
  await vi.waitFor(() => expect(document.querySelector('.if-saves')).not.toBeNull());
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
}

/**
 * One physical press, down and up.
 *
 * Both halves, because `KeyboardInput` suppresses a second `keydown` on a key
 * it still believes is held — which is how a held build hotkey stays one
 * selection rather than sixty (C04).
 */
/** Escape as the UI hears it: by `key`, on `window`. */
function escape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

function action(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.if-saves__action')].find((button) =>
    (button.textContent ?? '').startsWith(label),
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

describe('the game as main.ts starts it', () => {
  it('starts, draws a world and runs its loop', () => {
    expect(framesRequested).toBeGreaterThan(0);
    expect(query('.if-toolbar')).not.toBeNull();
    expect(query('.if-hud')).not.toBeNull();
  });

  it('stays playable with no IndexedDB, and says why (§14)', () => {
    // jsdom has no database, so `openStorage` fell back to the in-memory
    // repository and the warning is standing in the save menu — which is the
    // whole of "detect at startup, tell the player clearly, keep the game
    // playable".
    const status = query<HTMLElement>('.if-saves__status');
    expect(status.textContent).toContain('Storage is unavailable');
    expect(status.classList.contains('is-warn')).toBe(true);
  });

  it('opens the save menu from the menu, and pauses the game behind both', () => {
    const panel = query<HTMLElement>('.if-saves');
    expect(panel.hidden).toBe(true);

    query<HTMLButtonElement>('.if-hud__menu').click();
    expect(query<HTMLElement>('.if-menu').hidden).toBe(false);
    const button = [...document.querySelectorAll<HTMLButtonElement>('.if-menu button')].find(
      (candidate) => candidate.textContent === 'SAVE & LOAD',
    );
    button?.click();
    expect(panel.hidden).toBe(false);
    expect(query<HTMLElement>('.if-menu').hidden).toBe(true);
    expect(query<HTMLElement>('.if-hud').classList.contains('is-paused')).toBe(true);

    escape();
    expect(panel.hidden).toBe(true);
    expect(query<HTMLElement>('.if-hud').classList.contains('is-paused')).toBe(false);

    escape();
    expect(query<HTMLElement>('.if-menu').hidden).toBe(false);
    expect(query<HTMLElement>('.if-hud').classList.contains('is-paused')).toBe(true);
    escape();
    expect(query<HTMLElement>('.if-hud').classList.contains('is-paused')).toBe(false);
  });

  it('settles into being the tab that saves', async () => {
    // `TabLock` starts `pending` — it cannot know whether another tab has the
    // game open until one has had a chance to answer — so SAVE is held for the
    // first few milliseconds of the session and then released. Waiting for
    // that here is what the rest of this file depends on, and asserting it is
    // cheaper than discovering it as a flake.
    await vi.waitFor(() => expect(action('SAVE').disabled).toBe(false));
    expect(action('TAKE OVER').hidden).toBe(true);
  });

  it('saves the running factory and lists it', async () => {
    const name = query<HTMLInputElement>('.if-saves__name');
    name.value = 'Smoke test';
    action('SAVE').click();

    await vi.waitFor(() => {
      expect(query<HTMLElement>('.if-saves__status').textContent).toBe('Saved "Smoke test".');
    });

    const rows = [...document.querySelectorAll<HTMLButtonElement>('.if-save-row')].filter((row) => !row.hidden);
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('Smoke test');
    // The slot this session is playing, which is how the row is marked.
    expect(rows[0]?.classList.contains('is-current')).toBe(true);
  });

  it('loads it back over the running world', async () => {
    const [row] = [...document.querySelectorAll<HTMLButtonElement>('.if-save-row')].filter((r) => !r.hidden);
    row?.click();
    action('LOAD').click();

    // The path this whole chunk exists for: read, decode, deserialize, and
    // re-point everything that held the old `Simulation` — in a real
    // composition root rather than in a harness.
    await vi.waitFor(() => {
      expect(query<HTMLElement>('.if-saves__status').textContent).toBe('Loaded "Smoke test".');
    });
  });

  it('deletes it, on the second click', async () => {
    action('DELETE').click();
    expect(action('DELETE').textContent).toBe('DELETE?');
    action('DELETE').click();

    await vi.waitFor(() => {
      expect(query<HTMLElement>('.if-saves__status').textContent).toBe('Deleted.');
    });
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.if-save-row')].filter((r) => !r.hidden);
    expect(rows.length).toBe(0);
  });
});
