/**
 * First steps: a short list of things to do, for a first run. See C30 task 4.
 *
 * > A short, skippable, non-modal objective list for the first run ("mine 20
 * > iron", "place a miner", "connect a belt"). Not a scripted tutorial —
 * > objectives that teach by being achievable.
 *
 * So there is no arrow, no forced order and no pause. The list sits in a
 * corner; each line is a thing the game can check (`ObjectiveGoal`), and it
 * ticks when the world says it is true — whichever order the player does them
 * in. The first unticked line carries a hint in words, which is the only
 * teaching there is. The last line is C20's own milestone, "first automated
 * plate", read as the balance test reads it: a plate in a chest that nobody
 * carried there.
 *
 * ## What is remembered, and where
 *
 * A line once ticked stays ticked: iron ore gets smelted, belts get picked
 * back up, and an objective that un-ticks itself is a list that nags. Which
 * lines are done, and whether the list is showing, is a UI preference (the
 * composition root keeps it beside the volume, in `localStorage`) — it is
 * about this player on this browser, not about a factory, and it must not
 * come back every time a new world is started.
 *
 * ## The words live here
 *
 * C30's out-of-scope line says to keep strings central so a later
 * translation is one file per panel. Everything a player reads in this panel
 * is in `OBJECTIVES` or in the three constants under it.
 */

import type { ObjectiveGoal } from '../game/views/objective-view.js';

import { createIcon, setIcon } from './icons.js';

export interface ObjectiveDefinition {
  readonly id: string;
  /** The line itself. Short, imperative. */
  readonly text: string;
  /** How, shown while it is the next one to do. Mouse first, then keys. */
  readonly hint: string;
  readonly goal: ObjectiveGoal;
  /** How many `goal` counts before the line ticks. */
  readonly target: number;
}

/**
 * The list. Content ids are §15's; a goal naming one that does not exist
 * counts nothing (see `GameController.countObjective`), and a test asserts
 * that none does.
 */
export const OBJECTIVES: readonly ObjectiveDefinition[] = Object.freeze([
  {
    id: 'mine-iron',
    text: 'Mine 20 iron ore',
    hint: 'Hold right-click on the blue-grey ore. Keyboard: walk up to it and hold Enter.',
    goal: { kind: 'carried', itemId: 'iron_ore' },
    target: 20,
  },
  {
    id: 'place-miner',
    text: 'Place a miner on ore',
    hint: 'Press the number of the miner on the hotbar, then click on ore. R turns it.',
    goal: { kind: 'built', buildingId: 'miner' },
    target: 1,
  },
  {
    id: 'place-furnace',
    text: 'Place a furnace',
    hint: 'Put it near the miner. Ore gets from one to the other by belt or by inserter.',
    goal: { kind: 'built', buildingId: 'furnace' },
    target: 1,
  },
  {
    id: 'lay-belt',
    text: 'Connect a belt',
    hint: 'Drag a belt out from the side the miner faces. Belts carry items the way their arrows point.',
    goal: { kind: 'built', buildingId: 'belt' },
    target: 1,
  },
  {
    id: 'first-plate',
    text: 'Get an iron plate into a chest untouched',
    hint: 'Inserters lift items from behind them to in front: ore into the furnace, plates out to a chest. Feed the furnace coal.',
    goal: { kind: 'stored', itemId: 'iron_plate' },
    target: 1,
  },
]);

const TITLE = 'FIRST STEPS';
const SKIP = 'Skip';
const FINISHED = 'That is a factory. Everything from here is making it bigger.';

/** One line, as the panel paints it. */
export interface ObjectiveLineView {
  readonly id: string;
  readonly text: string;
  readonly progress: number;
  readonly target: number;
  readonly done: boolean;
}

export interface ObjectivesView {
  readonly lines: readonly ObjectiveLineView[];
  /** The hint for the first line not done, or the closing sentence. */
  readonly hint: string;
  readonly finished: boolean;
}

/**
 * Which lines are done now, given which were done before and what the world
 * counts. Pure, so the latching rule has a test of its own.
 */
export function objectivesView(
  definitions: readonly ObjectiveDefinition[],
  done: ReadonlySet<string>,
  count: (goal: ObjectiveGoal) => number,
): ObjectivesView {
  const lines = definitions.map((definition) => {
    const already = done.has(definition.id);
    const progress = already ? definition.target : Math.min(definition.target, count(definition.goal));
    return Object.freeze({
      id: definition.id,
      text: definition.text,
      progress,
      target: definition.target,
      done: already || progress >= definition.target,
    });
  });
  const next = definitions.find((_definition, index) => lines[index]?.done !== true);
  return Object.freeze({
    lines: Object.freeze(lines),
    hint: next?.hint ?? FINISHED,
    finished: next === undefined,
  });
}

interface Line {
  readonly root: HTMLElement;
  readonly icon: SVGSVGElement;
  readonly text: HTMLElement;
  readonly count: HTMLElement;
}

export interface ObjectivesPanelOptions {
  /** Skip, or close once finished. The list goes away and stays away. */
  readonly onDismiss: () => void;
}

/**
 * The panel. Non-modal: it takes no focus, blocks nothing and pauses
 * nothing, and it is one tab stop — its close button — so a keyboard player
 * is not made to walk through it.
 */
export class ObjectivesPanel {
  private readonly root = document.createElement('section');
  private readonly hint = document.createElement('p');
  private readonly dismiss = document.createElement('button');
  private readonly lines: Line[] = [];
  private readonly options: ObjectivesPanelOptions;

  constructor(options: ObjectivesPanelOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-objectives';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'First steps');

    const head = document.createElement('div');
    head.className = 'if-objectives__head';
    const title = document.createElement('h2');
    title.className = 'if-objectives__title';
    title.textContent = TITLE;
    this.dismiss.type = 'button';
    this.dismiss.className = 'if-objectives__skip';
    this.dismiss.textContent = SKIP;
    this.dismiss.title = 'Hide these. Settings can bring them back.';
    this.dismiss.addEventListener('click', this.handleDismiss);
    head.append(title, this.dismiss);

    const list = document.createElement('ol');
    list.className = 'if-objectives__list';
    for (const definition of OBJECTIVES) {
      const root = document.createElement('li');
      root.className = 'if-objective';
      root.dataset['id'] = definition.id;
      const icon = createIcon('idle');
      const text = document.createElement('span');
      text.className = 'if-objective__text';
      const count = document.createElement('span');
      count.className = 'if-objective__count';
      root.append(icon, text, count);
      list.append(root);
      this.lines.push({ root, icon, text, count });
    }

    this.hint.className = 'if-objectives__hint';
    this.root.append(head, list, this.hint);
    parent.append(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  setOpen(open: boolean): void {
    this.root.hidden = !open;
  }

  /** Repaint. Assignment and toggles only (§13). */
  update(view: ObjectivesView): void {
    view.lines.forEach((line, index) => {
      const element = this.lines[index];
      if (element === undefined) return;
      setText(element.text, line.text);
      setText(element.count, line.target > 1 && !line.done ? `${line.progress}/${line.target}` : '');
      element.root.classList.toggle('is-done', line.done);
      // A tick for done, a ring for not yet: the state is a shape, not only a
      // colour or a strike-through (C30).
      setIcon(element.icon, line.done ? 'check' : 'idle');
      element.root.setAttribute('aria-label', `${line.text}: ${line.done ? 'done' : 'not done yet'}`);
    });
    setText(this.hint, view.hint);
    setText(this.dismiss, view.finished ? 'Close' : SKIP);
  }

  destroy(): void {
    this.dismiss.removeEventListener('click', this.handleDismiss);
    this.root.remove();
  }

  private readonly handleDismiss = (): void => {
    this.options.onDismiss();
  };
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
