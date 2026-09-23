/**
 * The UI shell: the panels, and the clock that drives them. See C07 and §13.
 *
 * ```text
 *   GameController  ->  GameUI  ->  Hud / Toolbar / panels / Notifications
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
 * | `hud` | 5 Hz | the status bar's counters, the bag, the tech tree, the map |
 * | `live` | 10 Hz | the inspector's bar and rate, and toast expiry |
 *
 * §13 names the 10 Hz lane for "inspector progress bars, live rates", and C12
 * put the inspector in it. C07 had the lane already, driving the thing that
 * genuinely wanted a sub-second timer before the inspector existed: a toast
 * counting down to its own removal.
 *
 * Everything else is event-driven: the hotbar repaints on `buildMenuChanged`,
 * the HUD additionally on `pauseChanged`, and the inspector on
 * `selectionChanged` — which is what lets the word PAUSED appear, and a
 * clicked machine open, on a frame where both lanes are stopped.
 *
 * The map (C23) is the one panel that keeps a lane **while paused**, because
 * the outline it draws follows the camera and the camera keeps moving. See
 * `update`.
 *
 * The save menu (C25) is on no lane at all. What it shows changes only when
 * something was saved, loaded or deleted, and every one of those is something
 * this UI asked for — so the composition root pushes a new view when one
 * finishes, and §8's "pause the loop outright when a modal save/load dialog is
 * open" means there are no lanes running behind it anyway.
 *
 * ## Escape opens the menu, and closes things
 *
 * The menu is the settings panel with SAVE & LOAD at its top (2026-09-23).
 * The HUD's MENU button and Escape open it; it does not pause. P pauses, and
 * the HUD's clock says PAUSED while it is. The save menu opens from the menu
 * (or F2), and §8 still pauses the loop behind it. Until 2026-09-23 the pause
 * button, P and Escape all opened the save menu instead.
 *
 * Escape backs out one layer at a time, the way the genre does:
 *
 * ```text
 *   a panel is open                  close it
 *   a building, material or machine is held    let the input layer drop it
 *   nothing                          open the menu
 * ```
 *
 * It is caught on `window` in the capture phase so that it works with the
 * cursor in the save menu's name field, where the keyboard layer deliberately
 * hears nothing.
 *
 * There is no build menu. Buildings are picked from the hotbar or from the
 * inventory, and the hotbar is filled by dragging items onto it — buildings
 * and materials alike, one stack per slot. A material in hand feeds the
 * machine it is clicked on.
 */

import type { GameController } from '../game/game-controller.js';
import type { MapPoint } from '../game/views/map-view.js';

import { Hud } from './hud.js';
import { Inspector } from './inspector.js';
import { activateRoleButtons } from './keyboard.js';
import { MapPanel } from './map-panel.js';
import { InventoryPanel } from './inventory.js';
import { Notifications, alertMessage, rejectionMessage } from './notifications.js';
import { OBJECTIVES, ObjectivesPanel, objectivesView } from './objectives.js';
import { ResearchPanel } from './research-panel.js';
import { SaveMenu, type SaveMenuView } from './save-menu.js';
import { SettingsPanel, type MotionChoice, type SettingsView } from './settings-panel.js';
import { Toolbar } from './toolbar.js';

/** The panels that open in the middle of the screen, one at a time. */
type PanelName = 'inventory' | 'research' | 'map' | 'saves' | 'settings';

/** Their roots, for focus (C30). */
const PANEL_SELECTOR = '.if-inventory, .if-research, .if-map, .if-saves, .if-settings';

/** §13's HUD rate: counters, power, research. */
export const HUD_HZ = 5;

/** §13's live rate: inspector progress bars, and here the toast timer. */
export const LIVE_HZ = 10;

const HUD_INTERVAL_MS = 1000 / HUD_HZ;
const LIVE_INTERVAL_MS = 1000 / LIVE_HZ;

export interface GameUIOptions {
  readonly root: HTMLElement;
  readonly controller: GameController;
  /**
   * Centre the world view on a tile — the map panel's "click to jump" (C23
   * task 4).
   *
   * Injected rather than reached for, exactly as `Cursor` is injected into
   * `GameController` in the other direction: §4 forbids `ui/**` from importing
   * `renderer/**`, and the camera is the renderer's. The composition root is
   * the one place that holds both. Optional so that a test mounting the UI
   * need not invent a camera; the panel is then drawn and clickable and the
   * click goes nowhere, which is what it would do with no world on screen.
   */
  readonly onJumpTo?: (x: number, y: number) => void;
  /**
   * The corners of what the world view can see, in tile space, for the outline
   * the map draws over itself. Injected for `onJumpTo`'s reason — see
   * `MapPanelOptions.viewport`. Omitted, the map simply draws no outline.
   */
  readonly viewport?: () => readonly MapPoint[] | null;
  /**
   * Storage, as five verbs and a lock (C25 task 7).
   *
   * Injected for `onJumpTo`'s reason, one layer further out: §4 forbids
   * `ui/**` from importing `persistence/**`, so the panel names an id and a
   * string and the composition root decides what that means. Omitted — a test
   * that mounts the UI without a database — the menu is drawn and its buttons
   * do nothing, which is what they would do with no storage behind them.
   */
  readonly saves?: SaveBridge;
  /**
   * The player's preferences (C30), for the settings panel. Injected for
   * `saves`' reason: they live in `localStorage`, which is the composition
   * root's to touch. Omitted, the panel is not built.
   */
  readonly settings?: SettingsBridge;
  /**
   * The first-run objectives (C30 task 4): whether they are showing, which
   * are done, and where to report a change so it outlives the tab. Omitted,
   * there is no list.
   */
  readonly objectives?: ObjectivesBridge;
}

/** What the settings panel reads and asks for (C30). */
export interface SettingsBridge {
  readonly view: () => SettingsView;
  readonly onVolume: (volume: number) => void;
  readonly onMuted: (muted: boolean) => void;
  readonly onScale: (scale: number) => void;
  readonly onMotion: (motion: MotionChoice) => void;
  readonly onBind: (action: string, code: string) => void;
  readonly onResetBindings: () => void;
}

/** The objectives' remembered state. Structurally `platform/settings-store.ts`'s. */
export interface ObjectiveProgress {
  readonly visible: boolean;
  readonly done: readonly string[];
}

export interface ObjectivesBridge {
  readonly initial: ObjectiveProgress;
  readonly onChange: (progress: ObjectiveProgress) => void;
}

/** What the save menu asks the composition root to do (C25). */
export interface SaveBridge {
  readonly onSave: (name: string) => void;
  readonly onOverwrite: (id: string, name: string) => void;
  readonly onLoad: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  /** C26: write a file — the named slot, or the running game for `null`. */
  readonly onExport: (id: string | null, name: string) => void;
  /** C26: open a file the player chose or dropped. */
  readonly onImport: (file: File) => void;
  readonly onTakeOver: () => void;
  /**
   * The panel opened or closed.
   *
   * §8: "pause the loop outright when a modal save/load dialog is open." The
   * UI cannot pause the loop — that is the controller's — and it should not
   * decide to, because whether a panel is modal is a property of what is
   * behind it. So it reports, and the composition root decides.
   */
  readonly onVisibility: (open: boolean) => void;
}

export class GameUI {
  private readonly root: HTMLElement;
  private readonly controller: GameController;
  private readonly hud: Hud;
  private readonly toolbar: Toolbar;
  private readonly inspector: Inspector;
  private readonly inventory: InventoryPanel;
  private readonly research: ResearchPanel;
  private readonly map: MapPanel;
  private readonly saveMenu: SaveMenu;
  private readonly saves: SaveBridge | null;
  private readonly settingsBridge: SettingsBridge | null;
  private readonly settings: SettingsPanel | null;
  private readonly objectivesBridge: ObjectivesBridge | null;
  private readonly objectives: ObjectivesPanel;
  /** Objectives met so far, in the order they were met. See `refreshObjectives`. */
  private readonly objectivesDone: Set<string>;
  private objectivesVisible: boolean;
  private readonly notifications = new Notifications();
  private readonly unsubscribes: (() => void)[] = [];

  private hudAccumulatorMs = 0;
  private liveAccumulatorMs = 0;
  /** The map's own lane while paused. See `update`. */
  private pausedMapAccumulatorMs = 0;
  private mounted = false;

  constructor(options: GameUIOptions) {
    this.root = options.root;
    this.controller = options.controller;
    this.saves = options.saves ?? null;
    this.settingsBridge = options.settings ?? null;
    this.objectivesBridge = options.objectives ?? null;
    this.objectivesDone = new Set(this.objectivesBridge?.initial.done ?? []);
    this.objectivesVisible = this.objectivesBridge?.initial.visible ?? false;
    this.objectives = new ObjectivesPanel({ onDismiss: () => this.setObjectivesVisible(false) });
    const bridge = this.settingsBridge;
    this.settings =
      bridge === null
        ? null
        : new SettingsPanel({
            onVolume: bridge.onVolume,
            onMuted: bridge.onMuted,
            onScale: bridge.onScale,
            onMotion: bridge.onMotion,
            onObjectives: (visible) => this.setObjectivesVisible(visible),
            onBind: (action, code) => {
              bridge.onBind(action, code);
              this.refreshSettings();
            },
            onResetBindings: () => {
              bridge.onResetBindings();
              this.refreshSettings();
            },
            onOpenSaves: () => this.toggleSaveMenu(),
            onClose: () => this.toggleSettings(),
          });

    this.hud = new Hud({
      onToggleMenu: () => this.toggleMenu(),
      // C22. The RESEARCH tile has shown a dash since C07 with nothing behind
      // it; making it the way in is why the panel is findable without reading
      // a keybinding list — the same argument the ITEMS tile makes.
      onOpenResearch: () => this.toggleResearch(),
      // C21A. The ITEMS tile is where the player has been reading a number
      // with no way to see what it was made of since C07; making it the way
      // in is why the panel is findable without reading a keybinding list.
      onOpenInventory: () => this.toggleInventory(),
    });
    this.toolbar = new Toolbar({
      onSelectSlot: (slot) => this.controller.selectSlot(slot),
      onAssignSlot: (slot, itemId) => this.controller.assignSlot(slot, itemId),
      onClearSlot: (slot) => this.controller.clearSlot(slot),
      onMoveSlot: (from, to) => this.controller.moveSlot(from, to),
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
      // The machine's input slots (2026-09-23): the same arrangement in the
      // other direction. The machine decides what it accepts.
      // A chest's grid (2026-09-23): stacks moved within it, to it from the
      // bag, or clicked to send them to the bag.
      onMoveStack: (from, to) =>
        this.controller.moveStack(from.slot, to?.slot ?? null, from.entityId, to === null ? null : to.entityId),
      onDeposit: (itemId, count) => {
        const selected = this.controller.getSelection();
        if (selected !== null) this.controller.insertItems(selected, itemId, count);
      },
      // C16, and the same arrangement: the panel names a recipe, the
      // controller knows which machine that means, and the simulation decides.
      onSetRecipe: (recipeId) => {
        const selected = this.controller.getSelection();
        if (selected !== null) this.controller.setRecipe(selected, recipeId);
      },
      onClose: () => this.controller.clearSelection(),
    });
    this.inventory = new InventoryPanel({
      // The same arrangement every other panel uses: the panel names a recipe
      // and a count, the controller builds the command, the simulation
      // decides. A panel that could spend the player's iron is a panel §13
      // does not allow.
      onCraft: (recipeId, count) => this.controller.craftItem(recipeId, count),
      onCancel: (index) => this.controller.cancelCraft(index),
      // Picked up — a building to place, or a material to feed a machine
      // with. The panel gets out of the way, so the next click is on the world.
      // A stack dropped on a bag slot, from the bag or from an open chest.
      onMoveStack: (from, to) => this.controller.moveStack(from.slot, to, from.entityId, null),
      // Shift-click sends a stack to the chest being inspected, if it is one.
      onQuickMove: (slot) => {
        const selected = this.controller.getSelection();
        const view = selected === null ? null : this.controller.getBuildingView(selected);
        if (view?.storage != null) this.controller.moveStack(slot, null, null, view.id);
      },
      onPickItem: (itemId) => {
        this.controller.holdItem(itemId);
        this.setInventoryOpen(false);
      },
      // C30: a number pressed on a focused stack, the keyboard's drag.
      onAssignHotbar: (slot, itemId) => this.controller.assignSlot(slot, itemId),
      onClose: () => this.toggleInventory(),
    });
    this.map = new MapPanel({
      // The one panel that asks for something the controller cannot give: a
      // camera is the renderer's (§4), so the composition root supplies it and
      // a UI mounted without one simply does not jump.
      onJumpTo: (x, y) => options.onJumpTo?.(x, y),
      viewport: () => options.viewport?.() ?? null,
      onClose: () => this.toggleMap(),
    });
    // The same arrangement every panel uses, with the verbs wired to whatever
    // the composition root gave us — or to nothing, when it gave us nothing.
    this.saveMenu = new SaveMenu({
      onSave: (name) => this.saves?.onSave(name),
      onOverwrite: (id, name) => this.saves?.onOverwrite(id, name),
      onLoad: (id) => this.saves?.onLoad(id),
      onDelete: (id) => this.saves?.onDelete(id),
      onRename: (id, name) => this.saves?.onRename(id, name),
      onExport: (id, name) => this.saves?.onExport(id, name),
      onImport: (file) => this.saves?.onImport(file),
      onTakeOver: () => this.saves?.onTakeOver(),
      onClose: () => this.toggleSaveMenu(),
    });
    this.research = new ResearchPanel({
      // The same arrangement every other panel uses: the panel names a
      // technology, the controller builds the command, the simulation decides.
      onStart: (technologyId) => this.controller.startResearch(technologyId),
      onCancel: (technologyId) => this.controller.cancelResearch(technologyId),
      onClose: () => this.toggleResearch(),
    });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const menuView = this.controller.getBuildMenuView();

    this.hud.mount(this.root);
    this.inspector.mount(this.root);
    this.inventory.mount(this.root, this.controller.getInventoryView());
    this.research.mount(this.root, this.controller.getResearchView());
    this.map.mount(this.root);
    this.saveMenu.mount(this.root);
    if (this.settings !== null && this.settingsBridge !== null) {
      this.settings.mount(this.root, this.settingsBridge.view());
    }
    this.objectives.mount(this.root);
    this.toolbar.mount(this.root);
    this.notifications.mount(this.root);

    this.toolbar.update(menuView);
    this.refreshHud();
    this.objectives.setOpen(this.objectivesVisible);
    this.refreshObjectives();
    window.addEventListener('keydown', this.handleEscape, true);
    // C30: every `role="button"` in the UI presses on Enter and Space.
    this.unsubscribes.push(activateRoleButtons(this.root));
    // A panel's root takes focus when it opens (see `focusPanel`) and is not
    // a tab stop of its own.
    for (const panel of this.root.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) panel.tabIndex = -1;

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
        // C22's completed technology is the one alert that is not a warning,
        // so it is not drawn as one: an `info` toast, in the blue every other
        // piece of good news in this UI would use.
        this.notifications.push(
          alertMessage(event.alert),
          event.alert.type === 'research_complete' ? 'info' : 'warn',
        );
      }),
      this.controller.subscribe('buildMenuChanged', () => {
        this.toolbar.update(this.controller.getBuildMenuView());
      }),
      // The HUD must repaint while paused, because "paused" is what it has to
      // say. Its periodic lane is stopped at that moment; this is the event
      // that gets the word on screen.
      this.controller.subscribe('pauseChanged', () => this.refreshHud()),
      // C12: the inspector opens on the frame of the click rather than on the
      // next beat of the 10 Hz lane — and while paused, which is exactly when
      // a player stops to read a machine.
      this.controller.subscribe('selectionChanged', () => {
        this.refreshInspector();
        // A chest opens beside the bag, the way the genre does it, so
        // stacks can be dragged between the two.
        const selected = this.controller.getSelection();
        const view = selected === null ? null : this.controller.getBuildingView(selected);
        if (view?.storage != null && !this.inventory.isOpen()) this.toggleInventory();
      }),
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
    //
    // The map is the one exception, and it is a narrow one. Everything it
    // draws is simulation state and cannot move while the simulation is
    // stopped — except the outline showing where the camera is looking, and
    // the camera is a *view* control that keeps working while paused (C07:
    // "a paused game is one the player can still pan around"). An outline
    // frozen halfway through a pan is worse than no outline, and there is no
    // camera event for the HUD's `pauseChanged` trick to hang off.
    if (this.controller.isPaused()) {
      this.pausedMapAccumulatorMs += frameMs;
      if (this.pausedMapAccumulatorMs >= HUD_INTERVAL_MS) {
        this.pausedMapAccumulatorMs %= HUD_INTERVAL_MS;
        this.refreshMap();
      }
      return;
    }
    this.pausedMapAccumulatorMs = 0;

    this.hudAccumulatorMs += frameMs;
    if (this.hudAccumulatorMs >= HUD_INTERVAL_MS) {
      // Modulo rather than zero: a long frame owes one update, not none, and
      // keeping the remainder is what holds the average at exactly 5 Hz
      // instead of drifting down to whatever the frame rate rounds to.
      this.hudAccumulatorMs %= HUD_INTERVAL_MS;
      this.refreshHud();
      // The inventory rides the HUD's lane rather than the live one: it shows
      // counts and a queue, which change at the speed of a pick swing, not a
      // progress bar at the speed of a machine. The one bar it does have is
      // a hand-craft, and five updates a second is smooth for a craft that
      // takes at least fifteen ticks.
      this.refreshInventory();
      // The research panel rides the same lane, for the inventory's reason:
      // what it shows is a unit count and a queue, which change at the speed
      // of a lab rather than of a machine.
      this.refreshResearch();
      // And the map, for a reason one step slower again: what it shows moves
      // at the speed of a walk and of a radar sweep (C23).
      this.refreshMap();
      // The first-run objectives (C30), for the bag's reason: what they
      // count moves at the speed of a pick swing and a placed building.
      this.refreshObjectives();
    }

    this.liveAccumulatorMs += frameMs;
    if (this.liveAccumulatorMs >= LIVE_INTERVAL_MS) {
      const elapsed = this.liveAccumulatorMs;
      this.liveAccumulatorMs %= LIVE_INTERVAL_MS;
      this.notifications.update(elapsed - this.liveAccumulatorMs);
      this.refreshInspector();
    }
  }

  /**
   * Open or close the menu: the HUD's MENU button and Escape. See the header.
   * A UI mounted without settings has no menu panel, and its menu is the save
   * menu alone. Closing the save menu this way counts too, since the menu is
   * where it was opened from.
   */
  toggleMenu(): boolean {
    if (this.settings === null || this.saveMenu.isOpen()) return this.toggleSaveMenu();
    return this.toggleSettings();
  }

  /** Is the menu, or the save menu it opens, on screen? */
  isMenuOpen(): boolean {
    return this.isSettingsOpen() || this.saveMenu.isOpen();
  }

  /**
   * Close whichever panel is open. Returns whether one was.
   *
   * Escape's first meaning; see the header. The panels are exclusive, so at
   * most one closes — but every one is asked, so a panel added later cannot be
   * the one Escape forgets.
   */
  closeDialog(): boolean {
    const open =
      this.saveMenu.isOpen() ||
      this.inventory.isOpen() ||
      this.research.isOpen() ||
      this.map.isOpen() ||
      this.settings?.isOpen() === true;
    this.closeOthers(null);
    return open;
  }

  /** Open or close the inventory. Returns the new state (C21A). */
  toggleInventory(): boolean {
    const open = this.setInventoryOpen(!this.inventory.isOpen());
    if (open) this.closeOthers('inventory');
    return open;
  }

  /** Open or close the research panel. Returns the new state (C22). */
  toggleResearch(): boolean {
    const open = this.setResearchOpen(!this.research.isOpen());
    if (open) this.closeOthers('research');
    return open;
  }

  /** Open or close the settings. Returns the new state (C30). */
  toggleSettings(): boolean {
    if (this.settings === null) return false;
    const open = this.setSettingsOpen(!this.settings.isOpen());
    if (open) this.closeOthers('settings');
    return open;
  }

  /** Is the settings panel on screen? For the composition root and the tests. */
  isSettingsOpen(): boolean {
    return this.settings?.isOpen() === true;
  }

  /** Are the first-run objectives on screen? For the tests. */
  isObjectivesOpen(): boolean {
    return this.objectives.isOpen();
  }

  /**
   * Push a new save list into the menu (C25).
   *
   * Called by the composition root after anything that changes what storage
   * holds. There is no lane behind this: see the header.
   */
  setSaveMenuView(view: SaveMenuView): void {
    this.saveMenu.update(view);
  }

  /**
   * Open the save menu because something outside the UI needs it open.
   *
   * C26's one caller: a save file dropped on the window is imported, and the
   * status line the import writes to is inside this panel — so an import that
   * left the menu closed would be an import that happened in silence, whether
   * it worked or not.
   */
  openSaveMenu(): void {
    if (!this.saveMenu.isOpen()) this.toggleSaveMenu();
  }

  /** Open or close the save menu. Returns the new state (C25). */
  toggleSaveMenu(): boolean {
    const open = this.setSaveMenuOpen(!this.saveMenu.isOpen());
    if (open) this.closeOthers('saves');
    return open;
  }

  /** Is the save menu on screen? For the composition root and the tests. */
  isSaveMenuOpen(): boolean {
    return this.saveMenu.isOpen();
  }

  /** Open or close the map. Returns the new state (C23). */
  toggleMap(): boolean {
    const open = this.setMapOpen(!this.map.isOpen());
    if (open) this.closeOthers('map');
    return open;
  }

  /**
   * Close every panel but `keep` (`null` closes all of them).
   *
   * Panels want the same half of the screen. One at a time: they answer
   * different questions and stacking them answers neither. One method rather
   * than a list in every toggle, so a panel added later — C30's settings was
   * the fifth — cannot be the one some toggle forgets to close.
   */
  private closeOthers(keep: PanelName | null): void {
    if (keep !== 'inventory' && this.inventory.isOpen()) this.setInventoryOpen(false);
    if (keep !== 'research' && this.research.isOpen()) this.setResearchOpen(false);
    if (keep !== 'map' && this.map.isOpen()) this.setMapOpen(false);
    if (keep !== 'saves' && this.saveMenu.isOpen()) this.setSaveMenuOpen(false);
    if (keep !== 'settings' && this.settings?.isOpen() === true) this.setSettingsOpen(false);
  }

  /** Is the map on screen? For the composition root and the tests. */
  isMapOpen(): boolean {
    return this.map.isOpen();
  }

  /** Is the research panel on screen? For the composition root and the tests. */
  isResearchOpen(): boolean {
    return this.research.isOpen();
  }

  /** Is the inventory on screen? For the composition root and the tests. */
  isInventoryOpen(): boolean {
    return this.inventory.isOpen();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.handleEscape, true);
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.notifications.destroy();
    this.objectives.destroy();
    this.settings?.destroy();
    this.saveMenu.destroy();
    this.map.destroy();
    this.research.destroy();
    this.inventory.destroy();
    this.inspector.destroy();
    this.toolbar.destroy();
    this.hud.destroy();
    this.mounted = false;
  }

  /** Escape, before the keyboard layer hears it. See the header and `closeDialog`. */
  private readonly handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat) return;
    // The settings panel is listening for a key to bind, and Escape is how
    // that is cancelled — it is the panel's, not a request to close it.
    if (this.settings?.isCapturing() === true) return;
    if (!this.closeDialog()) {
      // Something in hand: the input layer's Escape drops it (see the header).
      if (
        this.controller.getSelectedBuilding() !== null ||
        this.controller.getHeldItem() !== null ||
        this.controller.getSelection() !== null
      ) {
        return;
      }
      this.toggleMenu();
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * Show or hide the panel, repainting on the way in.
   *
   * The repaint is what lets it open on the frame of the keypress and *while
   * paused*, which is the same reason the inspector listens for
   * `selectionChanged`: a player who stops to plan is exactly the player who
   * opens their bag.
   */
  private setInventoryOpen(open: boolean): boolean {
    this.inventory.setOpen(open);
    if (open) this.refreshInventory();
    this.focusPanel('.if-inventory', open);
    return open;
  }

  /** Repaint the inventory, but only when there is something to look at. */
  private refreshInventory(): void {
    if (!this.inventory.isOpen()) return;
    this.inventory.update(this.controller.getInventoryView());
  }

  /**
   * Show or hide the research panel, repainting on the way in.
   *
   * The repaint is the inventory's, for its reason: a player who pauses to
   * plan is exactly the player who opens the tech tree, and both lanes are
   * stopped then.
   */
  private setResearchOpen(open: boolean): boolean {
    this.research.setOpen(open);
    if (open) this.refreshResearch();
    this.focusPanel('.if-research', open);
    return open;
  }

  private refreshResearch(): void {
    if (!this.research.isOpen()) return;
    this.research.update(this.controller.getResearchView());
  }

  /**
   * Show or hide the map, repainting on the way in.
   *
   * The repaint is the inventory's and the research panel's, for their reason:
   * a player who pauses to plan is exactly the player who opens the map, and
   * both lanes are stopped then.
   */
  private setMapOpen(open: boolean): boolean {
    this.map.setOpen(open);
    if (open) this.refreshMap();
    this.focusPanel('.if-map', open);
    return open;
  }

  private refreshMap(): void {
    if (!this.map.isOpen()) return;
    this.map.update(this.controller.getMapView());
  }

  /**
   * Show or hide the save menu, telling the composition root either way.
   *
   * The report is §8's: a save dialog is the one panel the game is expected to
   * stop behind, and stopping it is a decision only the layer that owns the
   * loop can make.
   */
  private setSaveMenuOpen(open: boolean): boolean {
    if (this.saveMenu.isOpen() === open) return open;
    this.saveMenu.setOpen(open);
    this.hud.setMenuOpen(this.isMenuOpen());
    this.saves?.onVisibility(open);
    this.focusPanel('.if-saves', open);
    return open;
  }

  /** Show or hide the settings, repainting on the way in (C30). */
  private setSettingsOpen(open: boolean): boolean {
    if (this.settings === null) return false;
    this.settings.setOpen(open);
    this.hud.setMenuOpen(this.isMenuOpen());
    if (open) this.refreshSettings();
    this.focusPanel('.if-settings', open);
    return open;
  }

  private refreshSettings(): void {
    if (this.settings === null || this.settingsBridge === null || !this.settings.isOpen()) return;
    this.settings.update(this.settingsBridge.view());
  }

  /**
   * Show or hide the first-run objectives, and remember it (C30 task 4).
   * Called by SKIP, by CLOSE once they are finished, and by the settings
   * checkbox that brings them back.
   */
  private setObjectivesVisible(visible: boolean): void {
    this.objectivesVisible = visible;
    this.objectives.setOpen(visible);
    this.reportObjectives();
    this.refreshObjectives();
    this.refreshSettings();
  }

  /**
   * Count, tick, and tell the composition root when a line newly ticks.
   *
   * Only while the list is showing: a player who skipped it pays nothing for
   * it, and on §12's reference factory the `stored` count walks every chest.
   * A ticked line stays ticked (see `objectives.ts`), which is why the done
   * set is the UI's and not recomputed from the world each time.
   */
  private refreshObjectives(): void {
    if (!this.objectivesVisible) return;
    const view = objectivesView(OBJECTIVES, this.objectivesDone, (goal) => this.controller.countObjective(goal));
    let changed = false;
    for (const line of view.lines) {
      if (line.done && !this.objectivesDone.has(line.id)) {
        this.objectivesDone.add(line.id);
        changed = true;
      }
    }
    this.objectives.update(view);
    if (changed) this.reportObjectives();
  }

  private reportObjectives(): void {
    this.objectivesBridge?.onChange({ visible: this.objectivesVisible, done: [...this.objectivesDone] });
  }

  /**
   * Move focus into a panel as it opens, and out as it closes (C30 task 3).
   *
   * Into the panel's own root, which is focusable but not a tab stop, so the
   * next Tab lands on its first control and nothing is pressed by accident.
   * Out, only if focus was inside it: a panel closing must not take focus
   * away from wherever the player had moved it since.
   */
  private focusPanel(selector: string, open: boolean): void {
    const panel = this.root.querySelector<HTMLElement>(selector);
    if (panel === null) return;
    if (open) {
      panel.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && panel.contains(active)) active.blur();
  }

  /** Read a fresh snapshot of the selected machine, or close the panel. */
  private refreshInspector(): void {
    this.inspector.update(this.controller.getInspectorView());
  }

  private refreshHud(): void {
    this.hud.update(this.controller.getHudView());
  }
}
