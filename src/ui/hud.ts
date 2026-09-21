/**
 * The status bar. See ironflow.md C07 task 4, §11 and §13.
 *
 * A row of tiles across the top of the screen, each one icon plus a tabular
 * number, and a pause button at the end. §13 asks for "resources, power,
 * research progress, tick rate, alerts"; §11 supplies the icon set and §13's
 * budget table says this panel updates at 5 Hz.
 *
 * ## One tile that reads "offline", and one that stopped
 *
 * Research has a tile and no data: there is no research until C22. It is drawn
 * dimmed rather than left out, because §11's icon set is decided and a HUD that
 * grows a tile in the middle later is a HUD the player has to re-learn.
 *
 * **Power was the other one until C21.** It now reads the worst network's
 * satisfaction, with supply and demand in the tooltip, and it still shows the
 * dash before the first pole goes up — because then there genuinely is no
 * grid, which is a different thing from a system that does not exist yet.
 * `is-warning` goes on below full satisfaction, which is C21 task 5's "visible
 * HUD indicator": a factory that has outgrown its generators says so in the
 * corner of the screen continuously, where a toast per machine would not.
 *
 * ## Ticks per second is measured here, not in the simulation
 *
 * `HudView` carries the tick count; the rate is this panel's own difference
 * between two samples divided by the wall time between them. That is
 * deliberately on this side of §6: the rate is a presentation number, the
 * simulation has no clock to derive it from (§6 R1), and the number the player
 * wants to see is "is it keeping up", which is exactly a wall-clock question.
 */

import type { HudView } from '../game/views/hud-view.js';

import { createIcon, setIcon, type IconName } from './icons.js';

/** What C21 and C22 will replace. See the file header. */
const OFFLINE = '—';

interface Tile {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
}

export interface HudOptions {
  /** Called when the pause button is pressed. The controller owns the decision. */
  readonly onTogglePause: () => void;
  /**
   * Called when the ITEMS tile is pressed (C21A).
   *
   * The tile has carried a bare total since C07 with nothing behind it. It is
   * the obvious place to look for what that total is made of, so it is the
   * way in — a panel whose only door is a keybinding is a panel most players
   * never find.
   */
  readonly onOpenInventory: () => void;
}

export class Hud {
  private readonly root = document.createElement('div');
  private readonly tiles = new Map<string, Tile>();
  private readonly pauseButton = document.createElement('button');
  private readonly pauseIcon = createIcon('pause');
  private readonly pauseLabel = document.createElement('span');
  private readonly onTogglePause: () => void;
  private readonly onOpenInventory: () => void;

  /** The previous sample, for the measured tick rate. `null` until the second one. */
  private lastTick: number | null = null;
  private msSinceSample = 0;
  private ticksPerSecond = 0;

  constructor(options: HudOptions) {
    this.onTogglePause = options.onTogglePause;
    this.onOpenInventory = options.onOpenInventory;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-hud';

    this.addTile('items', 'inventory', 'ITEMS');
    this.makeButton('items', 'ITEMS — open your inventory (I)', this.onOpenInventory);
    this.addTile('buildings', 'building', 'BUILT');
    this.addTile('power', 'power', 'POWER');
    this.addTile('research', 'research', 'RESEARCH');
    this.addTile('map', 'map', 'CHUNKS');
    this.addTile('alerts', 'alert', 'ALERTS');
    this.addTile('rate', null, 'TPS');
    this.addTile('time', null, 'TIME');

    this.pauseButton.type = 'button';
    this.pauseButton.className = 'if-hud__pause';
    this.pauseButton.title = 'Pause the simulation (P)';
    this.pauseLabel.textContent = 'PAUSE';
    this.pauseButton.append(this.pauseIcon, this.pauseLabel);
    this.pauseButton.addEventListener('click', this.onTogglePause);
    this.root.append(this.pauseButton);

    // Research has no data yet, and this never changes again until C22.
    this.setValue('research', OFFLINE);

    parent.append(this.root);
  }

  /**
   * Repaint from a snapshot. Assignment only — no element is created here (§13).
   *
   * @param elapsedMs wall time since the previous *periodic* update. Zero for an
   * event-driven repaint, which must not be mistaken for a zero-length frame
   * and turned into an infinite tick rate.
   */
  update(view: HudView, elapsedMs: number): void {
    this.sampleRate(view.tick, elapsedMs);

    this.setValue('items', formatCount(view.itemTotal));
    this.setValue('buildings', formatCount(view.entityCount));
    this.setValue('map', formatCount(view.exploredChunks));
    this.setValue('alerts', formatCount(view.alerts));
    this.updatePower(view);
    this.setValue('rate', this.ticksPerSecond.toFixed(1));
    this.setValue('time', formatClock(view.playtimeSeconds));

    this.tiles.get('alerts')?.root.classList.toggle('is-warning', view.alerts > 0);
    this.root.classList.toggle('is-paused', view.paused);
    setIcon(this.pauseIcon, view.paused ? 'play' : 'pause');
    const label = view.paused ? 'PAUSED' : 'PAUSE';
    if (this.pauseLabel.textContent !== label) this.pauseLabel.textContent = label;
    this.pauseButton.setAttribute('aria-pressed', String(view.paused));
  }

  destroy(): void {
    this.pauseButton.removeEventListener('click', this.onTogglePause);
    const items = this.tiles.get('items');
    if (items !== undefined) items.root.removeEventListener('click', this.onOpenInventory);
    this.root.remove();
    this.tiles.clear();
  }

  /**
   * Turn a read-out into something clickable.
   *
   * A `div` with a role rather than a `<button>`, because the tile is laid
   * out by `.if-hud__tile` and its `+` sibling border, and swapping the
   * element would put a second set of button defaults through that rule for
   * one tile out of eight. The role and the tab stop are what a screen reader
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
    this.tiles.set(key, { root, value });
  }

  private setValue(key: string, text: string): void {
    const tile = this.tiles.get(key);
    if (tile === undefined) return;
    // Compare before assigning: the DOM write is far more expensive than the
    // string compare, and most tiles are unchanged on most updates.
    if (tile.value.textContent !== text) tile.value.textContent = text;
  }

  private sampleRate(tick: number, elapsedMs: number): void {
    if (elapsedMs <= 0) return;
    this.msSinceSample += elapsedMs;
    const previous = this.lastTick;
    if (previous === null) {
      this.lastTick = tick;
      this.msSinceSample = 0;
      return;
    }
    if (this.msSinceSample < 250) return;

    this.ticksPerSecond = ((tick - previous) * 1000) / this.msSinceSample;
    this.lastTick = tick;
    this.msSinceSample = 0;
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
