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

import type { Alert, AlertType } from '../game/views/alert.js';
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
  out_of_reach: 'Too far away — walk closer.',
  inventory_full: 'You cannot carry any more of that.',
  unknown_entity: 'That machine is no longer there.',
  nothing_to_take: 'There is none of that in there.',
  not_accepted: 'That machine does not take items.',
  nothing_to_give: 'You are not carrying any of that.',
  not_craftable: 'That needs a machine — your hands cannot make it.',
  craft_queue_full: 'You are already making as many different things as you can.',
  nothing_queued: 'There is nothing there to cancel.',
  // C22. One sentence for a locked building and a locked recipe alike: the
  // player does the same thing about either, and *which* technology it needs
  // is printed beside the thing itself on the hotbar and in the research
  // panel, where it can be read without a toast going past.
  locked: 'You have not researched that yet.',
  unknown_technology: 'No such technology.',
  already_researched: 'You have already researched that.',
  already_queued: 'That is already in the research queue.',
  missing_prerequisites: 'Something that leads to that has not been researched yet.',
  research_queue_full: 'The research queue is full.',
  // C23. The number is not in the sentence because the sentence is not where
  // it belongs: the limit is the building's, and a toast is read after the
  // mistake rather than before it.
  span_too_long: 'The other end of that underground belt is too far away.',
  empty_slot: 'There is nothing in that slot to move.',
});

export function rejectionMessage(reason: CommandRejectionReason): string {
  return REJECTION_TEXT[reason];
}

/**
 * What a player is told when the world stops doing something (C11 task 5).
 *
 * Exhaustive by type, exactly as the rejection table is: a machine that stops
 * silently is the same bug as a command that fails silently, and the sentence
 * has to name the thing that stopped *and* what to do about it — "a miner has
 * run out of ore" is a fact; "move it to a fresh patch" is the instruction.
 */
const ALERT_TEXT: Readonly<Record<AlertType, (alert: Alert) => string>> = Object.freeze({
  miner_no_resource: (alert) => `Miner at ${alert.x}, ${alert.y} has run out of ore — move it to a fresh patch.`,
  machine_no_fuel: (alert) => `The machine at ${alert.x}, ${alert.y} is out of fuel — feed it coal to carry on.`,
  inserter_no_destination: (alert) =>
    `The inserter at ${alert.x}, ${alert.y} has nowhere to put anything — turn it towards a belt, a chest or a machine.`,
  no_power_network: (alert) =>
    `The building at ${alert.x}, ${alert.y} is not on a power network — run a pole out to it.`,
  machine_no_recipe: (alert) =>
    `The machine at ${alert.x}, ${alert.y} has not been told what to make — open it and pick a recipe.`,
  craft_blocked: () => 'What you are making has nowhere to go — your bag is full.',
  // The one alert that is good news, so it names the thing rather than a tile:
  // research happens to the player, not somewhere on the map (C22).
  research_complete: (alert) => `Research complete: ${alert.subject ?? 'a technology'}.`,
});

export function alertMessage(alert: Alert): string {
  return ALERT_TEXT[alert.type](alert);
}

type ToastKind = 'reject' | 'warn' | 'info';

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
