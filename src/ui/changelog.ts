/**
 * WHAT'S NEW: the changelog, for players (2026-09-24).
 *
 * The HUD's WHAT'S NEW button, beside MENU, opens it. It is written for the
 * person playing, not for whoever reads the commits: what they can now do or
 * will notice, in their words, with no chunk numbers, schema versions or file
 * names. The commit log is the technical record; this is the other one.
 *
 * The entries are data in this file, newest day first. A change a player can
 * see gets a line here in the same commit — see ironflow.md §13's
 * "WHAT'S NEW" note. It starts on 2026-09-24; nothing earlier is listed.
 *
 * Like the map, the panel does not pause the game: reading it changes
 * nothing, and it is closed by Escape, its × or the button again. Its DOM is
 * built once in `mount()` and never touched after — there is nothing to
 * repaint, since the entries are constants.
 */

import { createIcon } from './icons.js';

/** What sort of change a line is. Drawn as a small tag in front of it. */
export type ChangeKind = 'new' | 'improved' | 'fixed';

export interface ChangelogDay {
  /** ISO date, `YYYY-MM-DD`. Shown as "24 September 2026". */
  readonly date: string;
  readonly changes: readonly { readonly kind: ChangeKind; readonly text: string }[];
}

/** Newest first. Plain language, one thing per line, as a player would say it. */
export const CHANGELOG: readonly ChangelogDay[] = Object.freeze([
  {
    date: '2026-09-24',
    changes: [
      {
        kind: 'new',
        text: 'Rest the pointer on anything in the world to see what it is: the ore left in a tile, how fast a belt or an inserter moves things, how long a miner’s ore will last, and what a machine is making, how far along it is and whether it has power.',
      },
      {
        kind: 'new',
        text: 'Items are shown as pictures everywhere: in your bag, in chests, on the hotbar, in machine slots and in the crafting queue.',
      },
      {
        kind: 'new',
        text: 'Hover over a recipe to see what it costs, how long it takes and how many per minute it makes. Anything you are short of is shown in red.',
      },
      {
        kind: 'new',
        text: 'Hand-crafting makes the missing parts for you. Ask for a miner with only plates in your bag and the gears are made first, all queued as one job. Cancelling any step cancels the whole job and gives your materials back.',
      },
      {
        kind: 'new',
        text: 'A recipe’s tooltip shows its total time from raw materials, counting every part made along the way.',
      },
      {
        kind: 'improved',
        text: 'Each hand-craft button shows in its corner how many you could make from what you are carrying, parts included.',
      },
      {
        kind: 'new',
        text: 'Mining by hand has a sound: a pick striking rock, in time with the swing. The swing is a little slower to match.',
      },
      {
        kind: 'new',
        text: 'Holding an item turns your cursor into its picture, with the number you have left in the corner.',
      },
      {
        kind: 'improved',
        text: 'When the stack in your hand runs out, you pick up the next stack of the same item. When you have none left, your hand empties.',
      },
    ],
  },
]);

/** The words. Central, per C30's out-of-scope line on localisation. */
const TEXT = Object.freeze({
  title: "WHAT'S NEW",
  kinds: Object.freeze({ new: 'NEW', improved: 'IMPROVED', fixed: 'FIXED' } satisfies Record<ChangeKind, string>),
});

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `2026-09-24` → `24 September 2026`. Parsed by hand: no time zone can move it. */
export function formatChangelogDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const name = month === undefined ? undefined : MONTHS[month - 1];
  if (year === undefined || name === undefined || day === undefined) return iso;
  return `${day} ${name} ${year}`;
}

export interface ChangelogPanelOptions {
  readonly onClose: () => void;
}

export class ChangelogPanel {
  private readonly root = document.createElement('section');
  private readonly closeButton = document.createElement('button');
  private readonly options: ChangelogPanelOptions;

  constructor(options: ChangelogPanelOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement, days: readonly ChangelogDay[] = CHANGELOG): void {
    this.root.className = 'if-changelog';
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('aria-label', "What's new");

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = TEXT.title;
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (Esc)';
    this.closeButton.setAttribute('aria-label', "Close what's new");
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('news'), title, this.closeButton);

    const body = document.createElement('div');
    body.className = 'if-changelog__body';
    for (const day of days) {
      const heading = document.createElement('h3');
      heading.className = 'if-changelog__date';
      heading.textContent = formatChangelogDate(day.date);
      const list = document.createElement('ul');
      list.className = 'if-changelog__list';
      for (const change of day.changes) {
        const item = document.createElement('li');
        item.className = 'if-changelog__change';
        const tag = document.createElement('span');
        tag.className = `if-changelog__tag is-${change.kind}`;
        tag.textContent = TEXT.kinds[change.kind];
        const text = document.createElement('span');
        text.textContent = change.text;
        item.append(tag, text);
        list.append(item);
      }
      body.append(heading, list);
    }

    this.root.append(head, body);
    parent.append(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  setOpen(open: boolean): void {
    this.root.hidden = !open;
    // Back to the newest day on every open.
    const body = this.root.querySelector('.if-changelog__body');
    if (open && body !== null) body.scrollTop = 0;
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    this.root.remove();
  }

  private readonly handleClose = (): void => this.options.onClose();
}
