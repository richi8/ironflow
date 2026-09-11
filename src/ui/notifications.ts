/**
 * Transient toasts, including every command rejection. See C07 task 5 and §7.
 *
 * §7 is blunt about why this panel exists: "Never fail silently — invisible
 * rejection is the single most common 'the game feels broken' bug in this
 * genre." So every reason in `CommandRejectionReason` has a sentence here, and
 * the mapping is exhaustive by type rather than by a default arm — adding a
 * reason in a later chunk fails the build until someone writes the sentence a
 * player will read.
 *
 * Toasts appear on an event and leave on a timer. The timer is driven from the
 * UI's 10 Hz lane (§13), which means it stops while the game is paused: a
 * paused game is stopped, and a message that expires behind a pause is a
 * message the player never got to read.
 */

import type { CommandRejectionReason } from '../game/commands/command.js';

/** How long a toast stays up. Long enough to read twice, short enough to forgive. */
export const TOAST_LIFETIME_MS = 4000;

/** Toasts on screen at once. Older ones go first; the newest is what just happened. */
export const MAX_TOASTS = 5;

/**
 * What a player is told when a command is refused.
 *
 * `Record<CommandRejectionReason, string>` and not a function with a default:
 * an unhandled reason must be a type error today rather than the word
 * "undefined" in a toast three chunks from now.
 */
const REJECTION_TEXT: Readonly<Record<CommandRejectionReason, string>> = Object.freeze({
  malformed: 'That instruction made no sense.',
  queue_full: 'Too many actions at once — slow down.',
  not_implemented: 'Nothing can do that yet.',
  occupied: 'Something is already standing there.',
  unaffordable: 'You cannot afford that.',
  out_of_range: 'That is outside the world.',
  unknown_recipe: 'No such recipe.',
  unknown_building: 'No such building.',
  bad_terrain: 'That ground will not take a building.',
  no_resource: 'There is no ore under that.',
  nothing_there: 'There is nothing there to remove.',
});

export function rejectionMessage(reason: CommandRejectionReason): string {
  return REJECTION_TEXT[reason];
}

type ToastKind = 'reject' | 'info';

interface Toast {
  readonly element: HTMLElement;
  remainingMs: number;
}

export class Notifications {
  private readonly root = document.createElement('div');
  private readonly toasts: Toast[] = [];

  mount(parent: HTMLElement): void {
    this.root.className = 'if-toasts';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    parent.append(this.root);
  }

  /**
   * Show a message. One call, one toast — never a deduplicating counter.
   *
   * C07's acceptance criterion is that a rejected command produces *exactly
   * one* notification, and collapsing repeats into "×3" would quietly make a
   * fast drag across occupied tiles look like one event when it was thirty.
   */
  push(text: string, kind: ToastKind = 'info'): void {
    const element = document.createElement('div');
    element.className = `if-toast if-toast--${kind}`;
    element.textContent = text;
    this.root.append(element);
    this.toasts.push({ element, remainingMs: TOAST_LIFETIME_MS });

    while (this.toasts.length > MAX_TOASTS) this.expireOldest();
  }

  /** How many toasts are on screen. For the tests and for the HUD's alert tile. */
  get count(): number {
    return this.toasts.length;
  }

  /**
   * Age the toasts. Driven by the UI's 10 Hz lane, not by a frame.
   *
   * Adds and removes children, which is the one thing §13's "never rebuild a
   * subtree" is not about: a toast appearing *is* the update. The toasts that
   * stay are untouched — no element is recreated to make room for a new one.
   */
  update(elapsedMs: number): void {
    if (elapsedMs <= 0 || this.toasts.length === 0) return;
    for (const toast of this.toasts) toast.remainingMs -= elapsedMs;
    while (this.toasts.length > 0 && (this.toasts[0]?.remainingMs ?? 0) <= 0) this.expireOldest();
  }

  clear(): void {
    while (this.toasts.length > 0) this.expireOldest();
  }

  destroy(): void {
    this.clear();
    this.root.remove();
  }

  private expireOldest(): void {
    const toast = this.toasts.shift();
    toast?.element.remove();
  }
}
