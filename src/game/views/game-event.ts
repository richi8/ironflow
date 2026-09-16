/**
 * What the controller tells the UI has happened. See ironflow.md C07 task 1.
 *
 * §13 gives the UI three update rates: a few things poll on a timer, and
 * everything else updates "on change event only". This union is that event.
 *
 * Each member has a real producer and a real consumer in the chunk that added
 * it — §19 rule 10 forbids one invented for a panel that does not exist.
 * `'rejected'` is produced by the command processor's rejection
 * list and consumed by the toasts; `'buildMenuChanged'` is produced by the
 * controller noticing that the affordability, stock or selection behind the
 * build menu differs from the last frame, and consumed by the toolbar and the
 * menu; `'pauseChanged'` is produced by the pause control and consumed by the
 * HUD, which is the one panel that must still update while the game is stopped.
 *
 * Events are **pulled, not pushed from inside a tick** (§13): the simulation
 * records, the controller's `pump()` collects after the frame, and only then do
 * listeners run. A listener that ran mid-phase could write to the DOM from
 * inside a simulation phase, which §13 forbids outright.
 */

import type { Alert } from './alert.js';
import type { Command, CommandRejectionReason } from '../commands/command.js';

export type GameEventType = 'rejected' | 'alert' | 'buildMenuChanged' | 'pauseChanged' | 'selectionChanged';

/** A command did not happen, and here is the reason a player can be shown. */
export interface CommandRejectedEvent {
  readonly type: 'rejected';
  readonly command: Command;
  readonly reason: CommandRejectionReason;
}

/**
 * The world stopped doing something, and the player has to be told (C11).
 *
 * The counterpart to `'rejected'`: that one says an instruction did not
 * happen, this one says something that *was* happening has stopped. A
 * machine that silently stops is the same bug as a silently refused command
 * (§7), one tick later.
 */
export interface AlertEvent {
  readonly type: 'alert';
  readonly alert: Alert;
}

/**
 * Something behind the build menu moved: stock, affordability or selection.
 *
 * Deliberately carries no payload. The panels re-read `getBuildMenuView()`,
 * which is one frozen snapshot of the whole menu — a diff in the event would
 * be a second description of the same state, kept in step by hand.
 */
export interface BuildMenuChangedEvent {
  readonly type: 'buildMenuChanged';
}

export interface PauseChangedEvent {
  readonly type: 'pauseChanged';
  readonly paused: boolean;
}

/**
 * The player selected a different machine, or none (C12 task 4).
 *
 * The event exists because of one acceptance criterion: "clicking any entity
 * opens the inspector **within one frame**". The inspector otherwise lives on
 * §13's 10 Hz lane, which would leave up to a tenth of a second between the
 * click and the panel — long enough to feel like the click was missed. It is
 * also the lane that stops while the game is paused, and selecting a machine
 * to read it is exactly what a player does while paused.
 *
 * It carries the id rather than the view so that the panel re-reads a frozen
 * snapshot, for the reason `buildMenuChanged` carries nothing at all.
 */
export interface SelectionChangedEvent {
  readonly type: 'selectionChanged';
  readonly entityId: number | null;
}

export type GameEvent =
  | CommandRejectedEvent
  | AlertEvent
  | BuildMenuChangedEvent
  | PauseChangedEvent
  | SelectionChangedEvent;

/** The event a given type name carries. Lets `subscribe` narrow its callback. */
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;
