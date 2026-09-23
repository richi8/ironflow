/**
 * The game menu: NEW GAME, SAVE & LOAD and SETTINGS (2026-09-23).
 *
 * Until 2026-09-23 the settings panel was the menu, with SAVE & LOAD at its
 * top. Now the menu is three buttons, and the settings are a dialog of their
 * own that SETTINGS opens in the menu's place, as SAVE & LOAD opens the save
 * menu. The HUD's MENU button and Escape open it, and the game pauses behind
 * it and behind both dialogs it opens (`GameUI`'s `onMenuVisibility`).
 *
 * NEW GAME throws the running factory away, so it takes two clicks, like the
 * save menu's DELETE: the first arms it, the second starts over, and the
 * arming expires. Not a `confirm()`, for DELETE's reason.
 */

import { createIcon } from './icons.js';
import { DELETE_ARM_MS } from './save-menu.js';

export interface GameMenuOptions {
  /** Start a new world. Omitted, NEW GAME is not shown. */
  readonly onNewGame?: () => void;
  readonly onOpenSaves: () => void;
  readonly onOpenSettings: () => void;
  readonly onClose: () => void;
}

/** The words. Central, per C30's out-of-scope line on localisation. */
const TEXT = Object.freeze({
  title: 'MENU',
  newGame: 'NEW GAME',
  newGameArmed: 'NEW GAME? Click again',
  newGameTitle: 'Start a new world. Anything not saved is lost.',
  saves: 'SAVE & LOAD',
  savesTitle: 'Save, load, import and export factories',
  settings: 'SETTINGS',
  settingsTitle: 'Sound, display, help and keys',
});

export class GameMenu {
  private readonly root = document.createElement('section');
  private readonly closeButton = document.createElement('button');
  private readonly newGameButton = document.createElement('button');
  private readonly savesButton = document.createElement('button');
  private readonly settingsButton = document.createElement('button');
  private readonly options: GameMenuOptions;
  /** When NEW GAME was armed, or null. */
  private armedAt: number | null = null;

  constructor(options: GameMenuOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-menu';
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('aria-label', 'Menu');

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = TEXT.title;
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (Esc)';
    this.closeButton.setAttribute('aria-label', 'Close the menu');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('settings'), title, this.closeButton);

    const body = document.createElement('div');
    body.className = 'if-menu__body';
    if (this.options.onNewGame !== undefined) {
      body.append(menuButton(this.newGameButton, TEXT.newGame, TEXT.newGameTitle, this.handleNewGame));
      this.newGameButton.classList.add('is-danger');
    }
    body.append(
      menuButton(this.savesButton, TEXT.saves, TEXT.savesTitle, this.handleSaves),
      menuButton(this.settingsButton, TEXT.settings, TEXT.settingsTitle, this.handleSettings),
    );

    this.root.append(head, body);
    parent.append(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  setOpen(open: boolean): void {
    this.root.hidden = !open;
    this.disarm();
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    this.newGameButton.removeEventListener('click', this.handleNewGame);
    this.savesButton.removeEventListener('click', this.handleSaves);
    this.settingsButton.removeEventListener('click', this.handleSettings);
    this.root.remove();
  }

  private disarm(): void {
    this.armedAt = null;
    this.newGameButton.textContent = TEXT.newGame;
    this.newGameButton.classList.remove('is-armed');
  }

  private readonly handleClose = (): void => this.options.onClose();

  private readonly handleSaves = (): void => this.options.onOpenSaves();

  private readonly handleSettings = (): void => this.options.onOpenSettings();

  /** First click arms, second starts over. See the header. */
  private readonly handleNewGame = (): void => {
    const now = Date.now();
    if (this.armedAt !== null && now - this.armedAt <= DELETE_ARM_MS) {
      this.disarm();
      this.options.onNewGame?.();
      return;
    }
    this.armedAt = now;
    this.newGameButton.textContent = TEXT.newGameArmed;
    this.newGameButton.classList.add('is-armed');
  };
}

function menuButton(button: HTMLButtonElement, text: string, title: string, onClick: () => void): HTMLButtonElement {
  button.type = 'button';
  button.className = 'if-saves__action if-menu__action';
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}
