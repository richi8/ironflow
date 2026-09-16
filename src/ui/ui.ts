/**
 * The UI shell: the panels, and the clock that drives them. See C07 and §13.
 *
 * ```text
 *   GameController  ->  GameUI  ->  Hud / Toolbar / BuildMenu / Notifications
 *   frozen views        rates       build once, update by assignment
 * ```
 *
 * `GameUI` owns two things and nothing else: which panels exist, and **when**
 * they are allowed to repaint. The panels themselves know only their own DOM
 * and the view model they are handed — none of them has a reference to the
 * controller, the simulation or the renderer, which is why
 * `grep -r "simulation\." src/ui/` finds nothing.
 *
 * ## The update budget (§13)
 *
 * > The world canvas renders every frame. The DOM does not.
 *
 * Two lanes, both fed from the render loop rather than from a `setInterval`,
 * exactly as §13 asks — so when the game stops, the UI stops with it, and a
 * paused tab is not quietly repainting a status bar thirty times a second.
 *
 * | Lane | Rate | Drives |
 * |---|---|---|
 * | `hud` | 5 Hz | the status bar's counters |
 * | `live` | 10 Hz | the inspector's bar and rate, and toast expiry |
 *
 * §13 names the 10 Hz lane for "inspector progress bars, live rates", and C12
 * put the inspector in it. C07 had the lane already, driving the thing that
 * genuinely wanted a sub-second timer before the inspector existed: a toast
 * counting down to its own removal.
 *
 * Everything else is event-driven: the build menu and hotbar repaint on
 * `buildMenuChanged`, the HUD additionally on `pauseChanged`, and the inspector
 * on `selectionChanged` — which is what lets the word PAUSED appear, and a
 * clicked machine open, on a frame where both lanes are stopped.
 */

import type { GameController } from '../game/game-controller.js';

import { BuildMenu } from './build-menu.js';
import { Hud } from './hud.js';
import { Inspector } from './inspector.js';
import { Notifications, alertMessage, rejectionMessage } from './notifications.js';
import { Toolbar } from './toolbar.js';

/** §13's HUD rate: counters, power, research. */
export const HUD_HZ = 5;

/** §13's live rate: inspector progress bars, and here the toast timer. */
export const LIVE_HZ = 10;

const HUD_INTERVAL_MS = 1000 / HUD_HZ;
const LIVE_INTERVAL_MS = 1000 / LIVE_HZ;

export interface GameUIOptions {
  readonly root: HTMLElement;
  readonly controller: GameController;
}

export class GameUI {
  private readonly root: HTMLElement;
  private readonly controller: GameController;
  private readonly hud: Hud;
  private readonly toolbar: Toolbar;
  private readonly buildMenu: BuildMenu;
  private readonly inspector: Inspector;
  private readonly notifications = new Notifications();
  private readonly unsubscribes: (() => void)[] = [];

  private hudAccumulatorMs = 0;
  private liveAccumulatorMs = 0;
  /** Wall time since the HUD last read a snapshot, so it can measure a rate. */
  private hudElapsedMs = 0;
  private mounted = false;

  constructor(options: GameUIOptions) {
    this.root = options.root;
    this.controller = options.controller;

    this.hud = new Hud({ onTogglePause: () => this.controller.togglePause() });
    this.toolbar = new Toolbar({
      onSelectSlot: (slot) => this.controller.selectSlot(slot),
      onToggleBuildMenu: () => this.toggleBuildMenu(),
    });
    this.buildMenu = new BuildMenu({
      onSelectBuilding: (buildingId) => this.controller.selectBuilding(buildingId),
    });
    this.inspector = new Inspector({
      // The panel names an item and a count; which machine that means is the
      // controller's answer, read at the moment of the click rather than
      // remembered by the panel — a panel holding an entity id is a panel that
      // can act on a machine the player is no longer looking at.
      onTake: (itemId, count) => {
        const selected = this.controller.getSelection();
        if (selected !== null) this.controller.takeItems(selected, itemId, count);
      },
      onClose: () => this.controller.clearSelection(),
    });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const menuView = this.controller.getBuildMenuView();

    this.hud.mount(this.root);
    this.buildMenu.mount(this.root, menuView);
    this.inspector.mount(this.root);
    this.toolbar.mount(this.root);
    this.notifications.mount(this.root);

    this.toolbar.update(menuView);
    this.toolbar.setBuildMenuOpen(this.buildMenu.isOpen());
    this.refreshHud();

    this.unsubscribes.push(
      // §7: never fail silently. Every rejection — the shape ones refused at
      // enqueue and the ones a system refuses in phase 1 — arrives here, and
      // each produces exactly one toast.
      this.controller.subscribe('rejected', (event) => {
        this.notifications.push(rejectionMessage(event.reason), 'reject');
      }),
      // C11: the other half of "never fail silently" — a machine that stops.
      // Warned rather than rejected: nothing the player did was refused, and
      // the factory is still running, minus one miner.
      this.controller.subscribe('alert', (event) => {
        this.notifications.push(alertMessage(event.alert), 'warn');
      }),
      this.controller.subscribe('buildMenuChanged', () => {
        const view = this.controller.getBuildMenuView();
        this.toolbar.update(view);
        this.buildMenu.update(view);
      }),
      // The HUD must repaint while paused, because "paused" is what it has to
      // say. Its periodic lane is stopped at that moment; this is the event
      // that gets the word on screen.
      this.controller.subscribe('pauseChanged', () => this.refreshHud()),
      // C12: the inspector opens on the frame of the click rather than on the
      // next beat of the 10 Hz lane — and while paused, which is exactly when
      // a player stops to read a machine.
      this.controller.subscribe('selectionChanged', () => this.refreshInspector()),
    );
  }

  /**
   * Advance the UI's own clocks. Once per rendered frame, after `pump()`.
   *
   * @param frameMs real time since the previous frame. Wall-clock time is
   * allowed here and nowhere in `game/`: §6 lists "UI throttling" among the
   * things that are deliberately non-deterministic.
   */
  update(frameMs: number): void {
    if (!this.mounted || frameMs <= 0) return;
    // A paused game updates nothing on a timer. The panels that must still
    // change while paused do it on an event, which is where the acceptance
    // criterion "both stopping when paused" and a HUD that says PAUSED meet.
    if (this.controller.isPaused()) return;

    this.hudAccumulatorMs += frameMs;
    this.hudElapsedMs += frameMs;
    if (this.hudAccumulatorMs >= HUD_INTERVAL_MS) {
      // Modulo rather than zero: a long frame owes one update, not none, and
      // keeping the remainder is what holds the average at exactly 5 Hz
      // instead of drifting down to whatever the frame rate rounds to.
      this.hudAccumulatorMs %= HUD_INTERVAL_MS;
      this.refreshHud();
    }

    this.liveAccumulatorMs += frameMs;
    if (this.liveAccumulatorMs >= LIVE_INTERVAL_MS) {
      const elapsed = this.liveAccumulatorMs;
      this.liveAccumulatorMs %= LIVE_INTERVAL_MS;
      this.notifications.update(elapsed - this.liveAccumulatorMs);
      this.refreshInspector();
    }
  }

  /** Open or close the build menu. Returns the new state. */
  toggleBuildMenu(): boolean {
    const open = this.buildMenu.toggle();
    this.toolbar.setBuildMenuOpen(open);
    return open;
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.notifications.destroy();
    this.inspector.destroy();
    this.toolbar.destroy();
    this.buildMenu.destroy();
    this.hud.destroy();
    this.mounted = false;
  }

  /** Read a fresh snapshot of the selected machine, or close the panel. */
  private refreshInspector(): void {
    this.inspector.update(this.controller.getInspectorView());
  }

  private refreshHud(): void {
    const elapsed = this.hudElapsedMs;
    this.hudElapsedMs = 0;
    this.hud.update(this.controller.getHudView(), elapsed);
  }
}
