/**
 * The full building list. See ironflow.md C07 and §13.
 *
 * Everything the hotbar shows in nine tiles, shown properly: grouped by
 * category, with the cost, what the player holds against it, and whether
 * research has revealed it. It is the panel that answers "what can I build?"
 * when the answer is longer than the number row.
 *
 * ## Built once, from content
 *
 * The building table is frozen at construction (C06), so the rows are frozen
 * too: `mount()` builds one row per entry and every update after that is text
 * and class toggles (§13). That is why this panel takes the first view in
 * `mount()` rather than starting empty — the shape of the list is content, and
 * content does not change while the game runs.
 *
 * ## Categories
 *
 * Six of them (C06 decision 2), each with one of §11's icons. Only categories
 * with a building in them get a heading, so the panel is two groups today and
 * grows as §15's table fills in, with no code change here.
 */

import type { BuildMenuEntry, BuildMenuView } from '../game/views/build-menu-view.js';
import type { BuildingCategory } from '../game/registries/building-registry.js';

import { createIcon, type IconName } from './icons.js';

/** Display order, which is §15's rough order of a factory's life. */
const CATEGORY_ORDER: readonly BuildingCategory[] = Object.freeze([
  'extraction',
  'production',
  'logistics',
  'storage',
  'power',
  'research',
]);

const CATEGORY_ICON: Readonly<Record<BuildingCategory, IconName>> = Object.freeze({
  extraction: 'resource',
  production: 'building',
  logistics: 'building',
  storage: 'inventory',
  power: 'power',
  research: 'research',
});

const CATEGORY_LABEL: Readonly<Record<BuildingCategory, string>> = Object.freeze({
  extraction: 'EXTRACTION',
  production: 'PRODUCTION',
  logistics: 'LOGISTICS',
  storage: 'STORAGE',
  power: 'POWER',
  research: 'RESEARCH',
});

interface Row {
  readonly button: HTMLButtonElement;
  readonly cost: HTMLElement;
  readonly hotkey: HTMLElement;
  /** What research would reveal it. Empty, and hidden, for an unlocked row. */
  readonly lock: HTMLElement;
}

export interface BuildMenuOptions {
  readonly onSelectBuilding: (buildingId: string) => void;
}

export class BuildMenu {
  private readonly root = document.createElement('section');
  private readonly rows = new Map<string, Row>();
  private readonly options: BuildMenuOptions;
  private open = false;

  constructor(options: BuildMenuOptions) {
    this.options = options;
  }

  /** @param view the first snapshot, whose entry list is the panel's shape. */
  mount(parent: HTMLElement, view: BuildMenuView): void {
    this.root.className = 'if-build-menu';
    this.root.hidden = true;

    const title = document.createElement('h2');
    title.className = 'if-build-menu__title';
    title.textContent = 'BUILD';
    this.root.append(title);

    for (const category of CATEGORY_ORDER) {
      const entries = view.entries.filter((entry) => entry.category === category);
      if (entries.length === 0) continue;
      this.root.append(this.createGroup(category, entries));
    }

    parent.append(this.root);
    this.update(view);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.hidden = !open;
  }

  toggle(): boolean {
    this.setOpen(!this.open);
    return this.open;
  }

  /** Repaint from a snapshot. Called on `buildMenuChanged` only (§13). */
  update(view: BuildMenuView): void {
    for (const entry of view.entries) {
      const row = this.rows.get(entry.buildingId);
      if (row === undefined) continue;

      setText(row.cost, describeCost(entry));
      setText(row.hotkey, entry.hotkey === null ? '' : String(entry.hotkey));
      // C22 task 5: "locked buildings appear greyed in the build menu with
      // their unlocking technology named — visible locks are motivating;
      // invisible ones are confusing."
      setText(row.lock, entry.unlocked || entry.unlockedBy === null ? '' : entry.unlockedBy);
      row.lock.hidden = entry.unlocked || entry.unlockedBy === null;
      row.cost.hidden = !entry.unlocked;
      row.button.classList.toggle('is-selected', entry.selected);
      row.button.classList.toggle('is-unaffordable', !entry.affordable);
      row.button.classList.toggle('is-locked', !entry.unlocked);
      // A locked building is visible and unusable, which is the point of
      // showing it: it is the tech tree advertising itself (C22).
      row.button.disabled = !entry.unlocked;
      row.button.title =
        entry.unlocked || entry.unlockedBy === null
          ? entry.name
          : `${entry.name} — researching ${entry.unlockedBy} unlocks it`;
    }
  }

  destroy(): void {
    for (const row of this.rows.values()) row.button.removeEventListener('click', this.handleSelect);
    this.root.remove();
    this.rows.clear();
  }

  private readonly handleSelect = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const buildingId = target.dataset['building'];
    if (buildingId !== undefined) this.options.onSelectBuilding(buildingId);
  };

  private createGroup(category: BuildingCategory, entries: readonly BuildMenuEntry[]): HTMLElement {
    const group = document.createElement('div');
    group.className = 'if-build-menu__group';

    const heading = document.createElement('div');
    heading.className = 'if-build-menu__heading';
    heading.append(createIcon(CATEGORY_ICON[category]));

    const label = document.createElement('span');
    label.textContent = CATEGORY_LABEL[category];
    heading.append(label);
    group.append(heading);

    for (const entry of entries) group.append(this.createRow(entry));
    return group;
  }

  private createRow(entry: BuildMenuEntry): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'if-build-row';
    button.dataset['building'] = entry.buildingId;
    button.addEventListener('click', this.handleSelect);

    const name = document.createElement('span');
    name.className = 'if-build-row__name';
    name.textContent = entry.name;

    const cost = document.createElement('span');
    cost.className = 'if-build-row__cost';

    const hotkey = document.createElement('span');
    hotkey.className = 'if-build-row__hotkey';

    // Drawn in the cost's place rather than beside it: the two are never both
    // interesting, because a building the player cannot build yet is one whose
    // price is not the thing standing in their way.
    const lock = document.createElement('span');
    lock.className = 'if-build-row__lock';
    lock.hidden = true;

    button.append(name, cost, lock, hotkey);
    this.rows.set(entry.buildingId, { button, cost, hotkey, lock });
    return button;
  }
}

function describeCost(entry: BuildMenuEntry): string {
  if (entry.cost.length === 0) return 'free';
  return entry.cost.map((line) => `${line.held}/${line.count}`).join(' ');
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
