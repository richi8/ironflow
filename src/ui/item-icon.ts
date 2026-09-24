/**
 * An item drawn as a picture rather than a word. See ironflow.md C32.
 *
 * Every place the UI shows an item — a bag cell, a chest cell, a hotbar slot,
 * a recipe — shows this, and the name moves into the tooltip, as the genre
 * does it.
 *
 * ## Where the pictures come from
 *
 * The pictures are the renderer's: an iron plate in the bag is the same
 * drawing as the iron plate riding a belt. §4 forbids `ui/**` from importing
 * `renderer/**`, so the UI is handed an `ItemIconSource`, a function from an
 * item id to an image URL. The composition root bakes each one from the
 * sprite atlas on first request (`renderer/item-icons.ts`).
 *
 * With no source, or where the browser gives no 2D context (the DOM tests),
 * the icon is two letters on the item's §11 colour token. That keeps the
 * panel drawable and still tells items apart.
 *
 * The element is built once and repainted by assignment (§13). The `<img>` is
 * not draggable and takes no pointer events, so a drag starts on the cell
 * around it and carries the cell's payload rather than an image.
 */

/** An item id to an image URL, or null when there is no picture for it. */
export type ItemIconSource = (itemId: string) => string | null;

export interface ItemIcon {
  readonly root: HTMLElement;
  readonly image: HTMLImageElement;
  readonly fallback: HTMLElement;
}

/** A blank icon, ready to be painted. */
export function createItemIcon(extraClass?: string): ItemIcon {
  const root = document.createElement('span');
  root.className = extraClass === undefined ? 'if-item-icon' : `if-item-icon ${extraClass}`;
  root.setAttribute('aria-hidden', 'true');

  const image = document.createElement('img');
  image.className = 'if-item-icon__image';
  image.alt = '';
  image.draggable = false;
  image.hidden = true;

  const fallback = document.createElement('span');
  fallback.className = 'if-item-icon__fallback';

  root.append(image, fallback);
  return { root, image, fallback };
}

/**
 * Point an icon at an item, or blank it for `null`. Only what changed is
 * written, so a repaint at 10 Hz of the same item touches nothing.
 */
export function paintItemIcon(
  icon: ItemIcon,
  itemId: string | null,
  name: string,
  source: ItemIconSource | null,
): void {
  if (icon.root.dataset['item'] === (itemId ?? '')) return;
  icon.root.dataset['item'] = itemId ?? '';
  if (itemId === null) {
    icon.image.hidden = true;
    icon.image.removeAttribute('src');
    icon.fallback.textContent = '';
    icon.fallback.hidden = true;
    icon.root.style.removeProperty('--if-item-tint');
    return;
  }
  const url = source?.(itemId) ?? null;
  icon.image.hidden = url === null;
  if (url === null) icon.image.removeAttribute('src');
  else icon.image.src = url;
  icon.fallback.hidden = url !== null;
  icon.fallback.textContent = url === null ? initials(name) : '';
  // §11: an item's colour is the token its id strips to, as on the belts.
  icon.root.style.setProperty('--if-item-tint', `var(--if-${itemId.replace(/_(ore|plate|wire)$/, '')}, var(--if-panel-high))`);
}

/** "Iron Plate" -> "IP", "Gear" -> "GE": two letters that tell items apart. */
export function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}
