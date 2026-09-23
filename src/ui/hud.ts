/**
 * The status bar. See ironflow.md C07 task 4, §11 and §13.
 *
 * A row of tiles across the top of the screen, each one icon plus a tabular
 * number, and the MENU button at the end. §13 asks for "resources, power,
 * research progress, tick rate, alerts"; §11 supplies the icon set and §13's
 * budget table says this panel updates at 5 Hz.
 *
 * ## What left, 2026-09-23
 *
 * BUILT, CHUNKS and TPS were counters a player never acted on. The building
 * and chunk counts are in the F3 readout's world section already, and the
 * tick rate moved there too — it is a question about the machine the game is
 * running on, not about the factory. The pause button went with them: the menu
 * pauses the game, and the TIME tile says PAUSED while it is. The settings
 * button took its place as MENU, which Escape also opens.
 *
 * ## The two tiles that had no data, and now have
 *
 * Research had a tile and nothing behind it from C07 to C22: it was drawn
 * dimmed rather than left out, because §11's icon set is decided and a HUD
 * that grows a tile in the middle later is a HUD the player has to re-learn.
 * C22 filled it in, and it is a button as well — the tech tree opens from the
 * thing that says how research is going.
 *
 * **Power was the other one until C21.** It now reads the worst network's
 * satisfaction, with supply and demand in the tooltip, and it still shows the
 * dash before the first pole goes up — because then there genuinely is no
 * grid, which is a different thing from a system that does not exist yet.
 * `is-warning` goes on below full satisfaction, which is C21 task 5's "visible
 * HUD indicator": a factory that has outgrown its generators says so in the
 * corner of the screen continuously, where a toast per machine would not.
 */

import type { HudView } from '../game/views/hud-view.js';

import { createIcon, type IconName } from './icons.js';

/** What a tile says when the thing it reads does not exist yet. */
const OFFLINE = '—';

interface Tile {
  readonly root: HTMLElement;
  readonly label: HTMLElement;
  readonly value: HTMLElement;
}

export interface HudOptions {
  /** Called when the MENU button is pressed. */
  readonly onToggleMenu: () => void;
  /**
   * Called when the ITEMS tile is pressed (C21A).
   *
   * The tile has carried a bare total since C07 with nothing behind it. It is
   * the obvious place to look for what that total is made of, so it is the
   * way in — a panel whose only door is a keybinding is a panel most players
   * never find.
   */
  readonly onOpenInventory: () => void;
  /**
   * Called when the RESEARCH tile is pressed (C22).
   *
   * The tile has shown a dash since C07 with nothing behind it; it is the
   * obvious place to look for what is being researched, so it is the way in —
   * the ITEMS tile's argument, one tile along.
   */
  readonly onOpenResearch: () => void;
}

export class Hud {
  private readonly root = document.createElement('div');
  private readonly tiles = new Map<string, Tile>();
  private readonly menuButton = document.createElement('button');
  private readonly onToggleMenu: () => void;
  private readonly onOpenInventory: () => void;
  private readonly onOpenResearch: () => void;

  constructor(options: HudOptions) {
    this.onToggleMenu = options.onToggleMenu;
    this.onOpenInventory = options.onOpenInventory;
    this.onOpenResearch = options.onOpenResearch;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-hud';

    this.addTile('items', 'inventory', 'ITEMS');
    this.makeButton('items', 'ITEMS — open your inventory (I)', this.onOpenInventory);
    this.addTile('research', 'research', 'RESEARCH');
    this.makeButton('research', 'RESEARCH — open the technology tree (T)', this.onOpenResearch);
    this.addTile('power', 'power', 'POWER');
    this.addTile('alerts', 'alert', 'ALERTS');
    this.addTile('time', null, 'TIME');

    this.menuButton.type = 'button';
    this.menuButton.className = 'if-hud__menu';
    this.menuButton.title = 'Menu: save and load, sound, size, motion and keys. Pauses the game (Esc)';
    const label = document.createElement('span');
    label.textContent = 'MENU';
    this.menuButton.append(createIcon('settings'), label);
    this.menuButton.addEventListener('click', this.onToggleMenu);
    this.root.append(this.menuButton);

    parent.append(this.root);
  }

  /** Repaint from a snapshot. Assignment only — no element is created here (§13). */
  update(view: HudView): void {
    this.setValue('items', formatCount(view.itemTotal));
    this.setValue('alerts', formatCount(view.alerts));
    this.updatePower(view);
    this.updateResearch(view);
    // C30's speed control says so on the clock, and only when it is on: a
    // factory at 4x that looked like 1x would look broken.
    this.setValue('time', view.speed === 1 ? formatClock(view.playtimeSeconds) : `${formatClock(view.playtimeSeconds)} ×${view.speed}`);

    this.tiles.get('alerts')?.root.classList.toggle('is-warning', view.alerts > 0);
    this.root.classList.toggle('is-paused', view.paused);
    // With no pause button, the clock is what says the game is stopped.
    const time = this.tiles.get('time');
    if (time !== undefined) {
      const label = view.paused ? 'PAUSED' : 'TIME';
      if (time.label.textContent !== label) time.label.textContent = label;
      time.root.classList.toggle('is-paused', view.paused);
      time.root.classList.toggle('is-fast', view.speed !== 1);
      time.root.title = view.paused
        ? 'PAUSED — closing the menu resumes'
        : `TIME — simulated play time${view.speed === 1 ? '' : `, at ${view.speed}x speed`}. [ and ] change the speed`;
    }
  }

  /** Light the MENU button while the menu, or the save menu it opens, is up. */
  setMenuOpen(open: boolean): void {
    this.menuButton.classList.toggle('is-active', open);
    this.menuButton.setAttribute('aria-pressed', String(open));
  }

  destroy(): void {
    this.menuButton.removeEventListener('click', this.onToggleMenu);
    const items = this.tiles.get('items');
    if (items !== undefined) items.root.removeEventListener('click', this.onOpenInventory);
    const research = this.tiles.get('research');
    if (research !== undefined) research.root.removeEventListener('click', this.onOpenResearch);
    this.root.remove();
    this.tiles.clear();
  }

  /**
   * Turn a read-out into something clickable.
   *
   * A `div` with a role rather than a `<button>`, because the tile is laid
   * out by `.if-hud__tile` and its `+` sibling border, and swapping the
   * element would put a second set of button defaults through that rule for
   * one tile out of five. The role and the tab stop are what a screen reader
   * and a keyboard actually need.
   */
  private makeButton(key: string, title: string, onActivate: () => void): void {
    const tile = this.tiles.get(key);
    if (tile === undefined) return;
    tile.root.classList.add('is-button');
    tile.root.title = title;
    tile.root.setAttribute('role', 'button');
    tile.root.tabIndex = 0;
    tile.root.addEventListener('click', onActivate);
  }

  /**
   * The power tile: a percentage, a tooltip and a warning state (C21 task 5).
   *
   * The percentage is the *worst* network's, because the one the player has to
   * act on is the one that is short — an aggregate across the factory would
   * read 100% while a network on the far side of it sat dark.
   */
  private updatePower(view: HudView): void {
    const tile = this.tiles.get('power');
    if (tile === undefined) return;
    const power = view.power;

    if (power === null) {
      this.setValue('power', OFFLINE);
      tile.root.title = 'POWER — no network yet';
      tile.root.classList.remove('is-warning');
      return;
    }

    this.setValue('power', `${power.satisfactionPercent}%`);
    const networks = power.networks === 1 ? '1 network' : `${power.networks} networks`;
    tile.root.title = `POWER — ${formatKw(power.supplyKw)} supplied of ${formatKw(power.demandKw)} demanded, ${networks}`;
    tile.root.classList.toggle('is-warning', power.satisfactionPercent < 100);
  }

  /**
   * The research tile: how far through the active technology, and a warning
   * when nothing is turning it (C22 task 5).
   *
   * A dash when nothing is queued, which is a real state rather than missing
   * data — the distinction the power tile has drawn since C21. The warning
   * tone is for a factory that *is* researching and has no lab working: the
   * bar would otherwise sit still with nothing on screen to say why.
   */
  private updateResearch(view: HudView): void {
    const tile = this.tiles.get('research');
    if (tile === undefined) return;
    const research = view.research;

    if (research === null) {
      this.setValue('research', OFFLINE);
      tile.root.title = 'RESEARCH — nothing queued';
      tile.root.classList.remove('is-warning');
      return;
    }

    this.setValue('research', `${research.progressPercent}%`);
    const labs = research.labs === 0 ? 'no labs' : `${research.labsWorking} of ${research.labs} labs working`;
    tile.root.title = `RESEARCH — ${research.name}, ${research.unitsDone} of ${research.units} units, ${labs}`;
    tile.root.classList.toggle('is-warning', research.labsWorking === 0);
  }

  private addTile(key: string, icon: IconName | null, label: string): void {
    const root = document.createElement('div');
    root.className = 'if-hud__tile';
    root.title = label;

    if (icon !== null) root.append(createIcon(icon));

    const name = document.createElement('span');
    name.className = 'if-hud__label';
    name.textContent = label;

    const value = document.createElement('span');
    value.className = 'if-hud__value';
    value.textContent = OFFLINE;

    root.append(name, value);
    this.root.append(root);
    this.tiles.set(key, { root, label: name, value });
  }

  private setValue(key: string, text: string): void {
    const tile = this.tiles.get(key);
    if (tile === undefined) return;
    // Compare before assigning: the DOM write is far more expensive than the
    // string compare, and most tiles are unchanged on most updates.
    if (tile.value.textContent !== text) tile.value.textContent = text;
  }

}

/** Kilowatts, or megawatts once there are enough of them to read badly. */
function formatKw(value: number): string {
  return value < 1000 ? `${value} kW` : `${(value / 1000).toFixed(1)} MW`;
}

function formatCount(value: number): string {
  if (value < 10_000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `m:ss` up to an hour, then `h:mm:ss`. Simulated time, from the tick count. */
function formatClock(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
