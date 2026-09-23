/**
 * The panels, without a mouse. See ironflow.md C30 task 3.
 *
 * C30's first acceptance line is "every action is reachable without a
 * mouse". Most of the UI already was: its controls are `<button>`s, and a
 * browser gives a button Tab, Enter and Space for nothing. This file is the
 * rest, in two helpers every panel shares, so a keyboard gesture means the
 * same thing in the bag, in a chest and on the hotbar.
 *
 * - **`activateRoleButtons`** — a `div` with `role="button"` (a bag cell, a
 *   HUD tile, a chest slot) presses on Enter or Space like a button does.
 *   Shift is carried through, so shift+Enter is shift-click.
 * - **`gridKeys`** — arrows move focus across a grid of cells, and
 *   shift+arrow carries the focused stack one cell over: the keyboard's
 *   drag. Handled keys stop here, so an arrow in the bag moves the focus
 *   and not the camera.
 */

/**
 * Enter and Space press anything inside `root` that says it is a button and
 * is not one. One listener, delegated, so a cell painted later needs nothing.
 */
export function activateRoleButtons(root: HTMLElement): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.tagName === 'BUTTON') return;
    if (target.getAttribute('role') !== 'button') return;
    event.preventDefault();
    event.stopPropagation();
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: event.shiftKey }),
    );
  };
  root.addEventListener('keydown', handler);
  return () => root.removeEventListener('keydown', handler);
}

/** Where an arrow key goes from `index` in a grid, or null for any other key. */
export function gridStep(key: string, index: number, count: number, columns: number): number | null {
  let next: number;
  if (key === 'ArrowLeft') next = index - 1;
  else if (key === 'ArrowRight') next = index + 1;
  else if (key === 'ArrowUp') next = index - columns;
  else if (key === 'ArrowDown') next = index + columns;
  else return null;
  return next >= 0 && next < count ? next : index;
}

export interface GridKeysOptions {
  /** Cells per row, as the stylesheet lays them out. */
  readonly columns: number;
  /** Shift+arrow: move the focused cell's contents to `to`. Omit where nothing moves. */
  readonly onMove?: (from: number, to: number) => void;
}

/**
 * Arrow keys over the `[data-index]` children of `container`.
 *
 * Focus is moved by index rather than by DOM order, so a grid whose cells
 * are reused and repainted (§13) still walks the way it looks.
 */
export function gridKeys(container: HTMLElement, options: GridKeysOptions): () => void {
  const handler = (event: KeyboardEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.parentElement !== container) return;
    const index = Number(target.dataset['index']);
    if (!Number.isInteger(index)) return;
    const cells = container.querySelectorAll<HTMLElement>(':scope > [data-index]');
    const next = gridStep(event.key, index, cells.length, options.columns);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next === index) return;
    if (event.shiftKey && options.onMove !== undefined) options.onMove(index, next);
    cells.item(next)?.focus();
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

/** The digit a number-row key names, 1 to 9, or null. */
export function digitOf(event: KeyboardEvent): number | null {
  const match = /^Digit([1-9])$/.exec(event.code);
  return match === null ? null : Number(match[1]);
}
