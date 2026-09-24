/**
 * The tooltip: one box, shared by every panel and by the world. See
 * ironflow.md C32.
 *
 * The browser's own `title` tooltip is plain text, arrives after a second and
 * cannot show an ingredient list with pictures. This is the genre's
 * replacement: a panel-coloured box with a title, an optional status line,
 * sections of rows (an icon, a label, a value), and a hint about what a
 * click does.
 *
 * ```text
 *   hovered element  --attach(provider)-->  Tooltip.showFor(anchor)
 *   the world        --GameUI------------>  Tooltip.showAt(x, y)
 * ```
 *
 * ## One box, built once
 *
 * §13: the DOM is built once and updated by assignment. The box holds a fixed
 * pool of sections and rows, made in `mount()`, and a repaint hides the ones
 * it does not need. Nothing is created or destroyed while the pointer moves.
 *
 * ## Content is asked for, not pushed
 *
 * A panel attaches a *provider* to an element: a function returning what to
 * say about it, from the panel's latest view. The tooltip calls it on
 * `pointerenter` and `focus` (so the keyboard gets it too, C30), and again
 * whenever `GameUI` calls `refresh()` on its 10 Hz lane, so a stack count or
 * a held-ingredient count moves while the pointer rests on it.
 *
 * The world readout is the other owner. An element's tooltip wins over the
 * world's: the pointer cannot be on both, and a panel is on top.
 */

import { TONE_ICONS, createIcon, setIcon, type Tone } from './icons.js';
import { createItemIcon, paintItemIcon, type ItemIcon, type ItemIconSource } from './item-icon.js';

/** Sections in the pool. More than any tooltip in C32 uses. */
export const TOOLTIP_SECTIONS = 5;

/** Rows per section. A recipe has at most four ingredients (§15). */
export const TOOLTIP_ROWS = 8;

/** Gap between the pointer, or the element, and the box. */
const OFFSET_PX = 14;

/** Keep the box this far inside the window. */
const MARGIN_PX = 8;

/** An element this close to the window's foot gets its tooltip above it. */
const BOTTOM_EDGE_PX = 100;

export interface TooltipRow {
  /** Drawn as an icon before the label. */
  readonly itemId?: string | null;
  readonly label: string;
  readonly value?: string;
  /** Paints the value, for a count that falls short. */
  readonly tone?: Tone | null;
}

export interface TooltipSection {
  /** A small caps label above the rows, or null for none. */
  readonly heading: string | null;
  readonly rows: readonly TooltipRow[];
}

export interface TooltipContent {
  readonly title: string;
  /** An icon beside the title. */
  readonly itemId?: string | null;
  /** A line under the title, with the tone's shape (C30: never colour alone). */
  readonly status?: { readonly text: string; readonly tone: Tone } | null;
  readonly sections: readonly TooltipSection[];
  /** What clicking does, in the dim colour at the foot. */
  readonly hint?: string | null;
}

/** What an attached element's tooltip says, or null to show none. */
export type TooltipProvider = () => TooltipContent | null;

interface RowSlot {
  readonly root: HTMLElement;
  readonly icon: ItemIcon;
  readonly label: HTMLElement;
  readonly value: HTMLElement;
}

interface SectionSlot {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly rows: readonly RowSlot[];
}

/** Who the box is showing for: an element, or the world under the pointer. */
type Owner = HTMLElement | 'world';

export class Tooltip {
  private readonly root = document.createElement('div');
  private readonly titleIcon: ItemIcon;
  private readonly title = document.createElement('span');
  private readonly status = document.createElement('div');
  private readonly statusIcon = createIcon('info');
  private readonly statusText = document.createElement('span');
  private readonly hint = document.createElement('div');
  private readonly sections: SectionSlot[] = [];
  private readonly providers = new WeakMap<HTMLElement, TooltipProvider>();
  private readonly icons: ItemIconSource | null;
  private owner: Owner | null = null;

  constructor(icons: ItemIconSource | null = null) {
    this.icons = icons;
    this.titleIcon = createItemIcon('if-tooltip__icon');
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-tooltip';
    this.root.hidden = true;
    this.root.setAttribute('role', 'tooltip');

    const head = document.createElement('div');
    head.className = 'if-tooltip__head';
    this.title.className = 'if-tooltip__title';
    head.append(this.titleIcon.root, this.title);

    this.status.className = 'if-tooltip__status';
    this.status.append(this.statusIcon, this.statusText);

    this.root.append(head, this.status);
    for (let s = 0; s < TOOLTIP_SECTIONS; s++) {
      const section = document.createElement('div');
      section.className = 'if-tooltip__section';
      const heading = document.createElement('div');
      heading.className = 'if-tooltip__heading';
      section.append(heading);
      const rows: RowSlot[] = [];
      for (let r = 0; r < TOOLTIP_ROWS; r++) {
        const row = document.createElement('div');
        row.className = 'if-tooltip__row';
        const icon = createItemIcon('if-tooltip__row-icon');
        const label = document.createElement('span');
        label.className = 'if-tooltip__label';
        const value = document.createElement('span');
        value.className = 'if-tooltip__value';
        row.append(icon.root, label, value);
        section.append(row);
        rows.push({ root: row, icon, label, value });
      }
      this.root.append(section);
      this.sections.push({ root: section, heading, rows });
    }
    this.hint.className = 'if-tooltip__hint';
    this.root.append(this.hint);
    parent.append(this.root);
  }

  /** Is the box on screen? */
  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Is it showing for an element, rather than for the world or nothing? */
  get isAnchored(): boolean {
    return this.owner !== null && this.owner !== 'world';
  }

  /**
   * Give `element` a tooltip. Replaces any provider it had. The listeners
   * are shared functions, so `detach` removes exactly what this added.
   */
  attach(element: HTMLElement, provider: TooltipProvider): void {
    if (!this.providers.has(element)) {
      element.addEventListener('pointerenter', this.handleEnter);
      element.addEventListener('pointerleave', this.handleLeave);
      element.addEventListener('focus', this.handleEnter);
      element.addEventListener('blur', this.handleLeave);
      // Out of the way while a stack is carried or a button pressed.
      element.addEventListener('dragstart', this.handleLeave);
    }
    this.providers.set(element, provider);
  }

  detach(element: HTMLElement): void {
    if (!this.providers.has(element)) return;
    element.removeEventListener('pointerenter', this.handleEnter);
    element.removeEventListener('pointerleave', this.handleLeave);
    element.removeEventListener('focus', this.handleEnter);
    element.removeEventListener('blur', this.handleLeave);
    element.removeEventListener('dragstart', this.handleLeave);
    this.providers.delete(element);
    if (this.owner === element) this.hide();
  }

  /** Show `content` beside `anchor`. */
  showFor(anchor: HTMLElement, content: TooltipContent): void {
    this.owner = anchor;
    this.paint(content);
    this.placeBeside(anchor);
  }

  /** Show `content` beside a point in the window: the world readout. */
  showAt(clientX: number, clientY: number, content: TooltipContent): void {
    // An element's tooltip is never displaced by the world's.
    if (this.isAnchored) return;
    this.owner = 'world';
    this.paint(content);
    this.placeAt(clientX, clientY);
  }

  /** Move the world readout with the pointer without repainting it. */
  moveTo(clientX: number, clientY: number): void {
    if (this.owner === 'world') this.placeAt(clientX, clientY);
  }

  /** Hide the world readout, if that is what is showing. */
  hideWorld(): void {
    if (this.owner === 'world') this.hide();
  }

  hide(): void {
    this.owner = null;
    this.root.hidden = true;
  }

  /**
   * Ask the anchored element's provider again. `GameUI` calls this on its
   * 10 Hz lane. An anchor that has left the page, or been hidden, closes it.
   */
  refresh(): void {
    const owner = this.owner;
    if (owner === null || owner === 'world') return;
    const provider = this.providers.get(owner);
    const content = owner.isConnected && !isHidden(owner) ? (provider?.() ?? null) : null;
    if (content === null) {
      this.hide();
      return;
    }
    this.paint(content);
    this.placeBeside(owner);
  }

  /**
   * Hide an element's tooltip whose element has gone: removed, or its panel
   * closed under the pointer. Cheap, so `GameUI` asks every frame, paused or
   * not — the 10 Hz `refresh` stops with the game.
   */
  dropStale(): void {
    const owner = this.owner;
    if (owner !== null && owner !== 'world' && (!owner.isConnected || isHidden(owner))) this.hide();
  }

  destroy(): void {
    this.hide();
    this.root.remove();
  }

  private readonly handleEnter = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const content = this.providers.get(target)?.() ?? null;
    if (content === null) {
      if (this.owner === target) this.hide();
      return;
    }
    this.showFor(target, content);
  };

  private readonly handleLeave = (event: Event): void => {
    if (event.currentTarget === this.owner) this.hide();
  };

  /** Assignment only (§13): every slot exists; the unused ones are hidden. */
  private paint(content: TooltipContent): void {
    this.root.hidden = false;
    setText(this.title, content.title);
    const titleItem = content.itemId ?? null;
    this.titleIcon.root.hidden = titleItem === null;
    paintItemIcon(this.titleIcon, titleItem, content.title, this.icons);

    const status = content.status ?? null;
    this.status.hidden = status === null;
    if (status !== null) {
      setText(this.statusText, status.text);
      this.status.dataset['tone'] = status.tone;
      setIcon(this.statusIcon, TONE_ICONS[status.tone]);
    }

    this.sections.forEach((slot, index) => {
      const section = content.sections[index];
      const rows = section?.rows ?? [];
      slot.root.hidden = section === undefined || (rows.length === 0 && section.heading === null);
      if (section === undefined) return;
      slot.heading.hidden = section.heading === null;
      setText(slot.heading, section.heading ?? '');
      slot.rows.forEach((rowSlot, r) => {
        const row = rows[r];
        rowSlot.root.hidden = row === undefined;
        if (row === undefined) return;
        const itemId = row.itemId ?? null;
        rowSlot.icon.root.hidden = itemId === null;
        paintItemIcon(rowSlot.icon, itemId, row.label, this.icons);
        setText(rowSlot.label, row.label);
        setText(rowSlot.value, row.value ?? '');
        if (row.tone === undefined || row.tone === null) delete rowSlot.root.dataset['tone'];
        else rowSlot.root.dataset['tone'] = row.tone;
      });
    });

    const hint = content.hint ?? null;
    this.hint.hidden = hint === null;
    setText(this.hint, hint ?? '');
  }

  /**
   * To the right of the element, or its left when there is no room. An
   * element along the bottom edge — the hotbar — gets it above instead, so
   * the box does not cover the slots beside the one it describes.
   */
  private placeBeside(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const { width, height } = this.size();
    if (rect.bottom > window.innerHeight - BOTTOM_EDGE_PX && rect.top - OFFSET_PX / 2 - height >= MARGIN_PX) {
      this.place(rect.left, rect.top - OFFSET_PX / 2 - height, width, height);
      return;
    }
    let left = rect.right + OFFSET_PX / 2;
    if (left + width > window.innerWidth - MARGIN_PX) left = rect.left - OFFSET_PX / 2 - width;
    this.place(left, rect.top, width, height);
  }

  /** Below and right of the pointer, flipped at the window's edges. */
  private placeAt(clientX: number, clientY: number): void {
    const { width, height } = this.size();
    let left = clientX + OFFSET_PX;
    let top = clientY + OFFSET_PX;
    if (left + width > window.innerWidth - MARGIN_PX) left = clientX - OFFSET_PX - width;
    if (top + height > window.innerHeight - MARGIN_PX) top = clientY - OFFSET_PX - height;
    this.place(left, top, width, height);
  }

  /**
   * Put the box's corner at a point in window pixels. C30's UI scale is
   * `zoom` on the UI layer, so a translate inside it is multiplied by the
   * scale: the point is divided by it first.
   */
  private place(left: number, top: number, width: number, height: number): void {
    const x = clamp(left, MARGIN_PX, window.innerWidth - MARGIN_PX - width);
    const y = clamp(top, MARGIN_PX, window.innerHeight - MARGIN_PX - height);
    const scale = this.scale(width);
    const transform = `translate(${Math.round(x / scale)}px, ${Math.round(y / scale)}px)`;
    if (this.root.style.transform !== transform) this.root.style.transform = transform;
  }

  /** The box's size in window pixels, which the bounding rectangle gives. */
  private size(): { width: number; height: number } {
    const rect = this.root.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /** Window pixels per UI pixel: the UI scale, read off the box itself. */
  private scale(windowWidth: number): number {
    const own = this.root.offsetWidth;
    return own > 0 && windowWidth > 0 ? windowWidth / own : 1;
  }
}

function isHidden(element: HTMLElement): boolean {
  return element.hidden || element.closest('[hidden]') !== null;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
