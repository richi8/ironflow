/**
 * The quest guide: a chain of steps from the first swing of the pick to every
 * building and technology in the game. See C31 (and C30 task 4 before it).
 *
 * > A short, skippable, non-modal objective list for the first run ("mine 20
 * > iron", "place a miner", "connect a belt"). Not a scripted tutorial —
 * > objectives that teach by being achievable.
 *
 * C30 shipped that as five lines ending at the first automated plate. C31
 * took away the starting kit, so a new player now begins with an empty bag,
 * and the list became a guide: one step on screen at a time, in order, with
 * the step before it ticked and the one after it waiting. It stays a sandbox
 * — no arrow, no forced order, no pause, and nothing the game refuses because
 * a step has not been reached.
 *
 * ## How a step ticks
 *
 * Each step is a thing the game can check (`ObjectiveGoal`), and it ticks the
 * first time the world says it is true — **whichever order** the player does
 * things in. A player who builds a chest before being asked to finds that step
 * already ticked when the guide gets there, rather than being told to do what
 * they did. A step once ticked stays ticked: ore gets smelted, belts get
 * picked back up, and a step that un-ticked itself would be a guide that nags.
 *
 * The **current** step is the first one not ticked, and it carries the hint.
 * SKIP STEP ticks it without the world agreeing, for a player who knows
 * better; HIDE puts the whole guide away, and settings bring it back.
 *
 * ## What is remembered, and where
 *
 * Which steps are ticked belongs to the **world**: `GameController` keeps the
 * log and the save carries it in its metadata (§14, v6). Whether the guide is
 * showing belongs to the player, and stays a preference in `localStorage`.
 * C30 kept both in the preference, which made a second world open with the
 * first one's ticks.
 *
 * ## The words live here
 *
 * C30's out-of-scope line says to keep strings central so a later
 * translation is one file per panel. Everything a player reads in this panel
 * is in `OBJECTIVES` or in the constants under it.
 */

import type { ObjectiveGoal } from '../game/views/objective-view.js';

import { createIcon, setIcon } from './icons.js';

export interface ObjectiveDefinition {
  readonly id: string;
  /** The line itself. Short, imperative. */
  readonly text: string;
  /** How, shown while it is the step to do. Mouse first, then keys. */
  readonly hint: string;
  readonly goal: ObjectiveGoal;
  /** How many `goal` counts before the line ticks. */
  readonly target: number;
}

/**
 * The chain. Content ids are §15's; a goal naming one that does not exist
 * counts nothing (see `GameController.countObjective`), and a test asserts
 * that none does — and that every building and every technology in the
 * content tables is reached by some step, which is C31's definition of done.
 *
 * The numbers are what the *next* craft needs, where there is one: four gears
 * and two circuits are a miner's bill, three steel is an electric furnace's.
 */
export const OBJECTIVES: readonly ObjectiveDefinition[] = Object.freeze([
  // The bag is empty (C31). Everything starts with the pick.
  {
    id: 'mine-iron',
    text: 'Mine 10 iron ore',
    hint: 'Hold right-click on the blue-grey ore. Keyboard: walk up to it and hold Enter.',
    goal: { kind: 'carried', itemId: 'iron_ore' },
    target: 10,
  },
  {
    id: 'mine-stone',
    text: 'Mine 10 stone',
    hint: 'Stone is the pale, warm grey ore. A furnace is made of it.',
    goal: { kind: 'carried', itemId: 'stone' },
    target: 10,
  },
  {
    id: 'mine-coal',
    text: 'Mine 10 coal',
    hint: 'Coal is the near-black ore. Furnaces and generators burn it.',
    goal: { kind: 'carried', itemId: 'coal' },
    target: 10,
  },
  {
    id: 'craft-furnace',
    text: 'Craft a furnace',
    hint: 'Open the bag with I and click Furnace under CRAFT BY HAND. It takes 10 stone.',
    goal: { kind: 'carried', itemId: 'furnace' },
    target: 1,
  },
  {
    id: 'place-furnace',
    text: 'Place the furnace',
    hint: 'Pick it from the hotbar or the bag, then click the ground. R turns it.',
    goal: { kind: 'built', buildingId: 'furnace' },
    target: 1,
  },
  {
    id: 'smelt-iron',
    text: 'Smelt 10 iron plates',
    hint: 'Click the furnace, PUT coal and iron ore in its slots, and TAKE the plates when they are done.',
    goal: { kind: 'carried', itemId: 'iron_plate' },
    target: 10,
  },
  {
    id: 'craft-gears',
    text: 'Craft 4 gears',
    hint: 'Two iron plates make a gear. Nearly every machine has gears in it.',
    goal: { kind: 'carried', itemId: 'gear' },
    target: 4,
  },
  {
    id: 'mine-copper',
    text: 'Mine 5 copper ore',
    hint: 'Copper is the orange ore.',
    goal: { kind: 'carried', itemId: 'copper_ore' },
    target: 5,
  },
  {
    id: 'smelt-copper',
    text: 'Smelt 3 copper plates',
    hint: 'A furnace takes one kind of ore at a time. Let the iron finish first, or craft a second furnace.',
    goal: { kind: 'carried', itemId: 'copper_plate' },
    target: 3,
  },
  {
    id: 'craft-circuits',
    text: 'Craft 2 circuits',
    hint: 'Craft copper wire from copper plates first. A circuit is 3 wire and 1 iron plate.',
    goal: { kind: 'carried', itemId: 'circuit' },
    target: 2,
  },
  {
    id: 'craft-miner',
    text: 'Craft a miner',
    hint: '4 gears, 2 circuits and 4 iron plates. Smelt more plates if you are short.',
    goal: { kind: 'carried', itemId: 'miner' },
    target: 1,
  },
  {
    id: 'place-miner',
    text: 'Place the miner on iron ore',
    hint: 'It digs whatever is under it and puts it out of its front, the way its arrow points.',
    goal: { kind: 'built', buildingId: 'miner' },
    target: 1,
  },
  {
    id: 'place-inserter',
    text: 'Place an inserter',
    hint: 'A gear, a circuit and a plate. It lifts items from behind it to in front: miner to furnace.',
    goal: { kind: 'built', buildingId: 'inserter' },
    target: 1,
  },
  {
    id: 'place-chest',
    text: 'Place a chest',
    hint: 'Four iron plates. A second inserter can move the furnace’s plates into it.',
    goal: { kind: 'built', buildingId: 'chest' },
    target: 1,
  },
  {
    id: 'first-plate',
    text: 'Get an iron plate into a chest untouched',
    hint: 'Miner, inserter, furnace, inserter, chest. Keep coal in the furnace.',
    goal: { kind: 'stored', itemId: 'iron_plate' },
    target: 1,
  },
  {
    id: 'lay-belt',
    text: 'Lay a belt',
    hint: 'A gear and a plate make two. Drag to lay a line; items ride the way the arrows point.',
    goal: { kind: 'built', buildingId: 'belt' },
    target: 1,
  },

  // The machine that makes machines.
  {
    id: 'place-assembler',
    text: 'Place an assembler',
    hint: '8 gears, 4 circuits and 6 iron plates. It makes anything you can craft, without you.',
    goal: { kind: 'built', buildingId: 'assembler' },
    target: 1,
  },
  {
    id: 'assemble-gears',
    text: 'Have an assembler make gears',
    hint: 'Click it and choose Gear under RECIPE. Feed it iron plates with an inserter.',
    goal: { kind: 'running', buildingId: 'assembler', recipeId: 'make_gear' },
    target: 1,
  },

  // Power, and research.
  {
    id: 'bake-bricks',
    text: 'Bake 12 bricks',
    hint: 'Put stone in a furnace: two stone bake one brick. Generators and labs are built of brick.',
    goal: { kind: 'carried', itemId: 'brick' },
    target: 12,
  },
  {
    id: 'place-generator',
    text: 'Place a generator',
    hint: '8 gears, 10 iron plates and 6 bricks. It burns coal to power everything wired to it.',
    goal: { kind: 'built', buildingId: 'generator' },
    target: 1,
  },
  {
    id: 'place-pole',
    text: 'Place a power pole',
    hint: 'A copper wire and 2 plates. Poles link up to 8 tiles apart and power the 5×5 around them.',
    goal: { kind: 'built', buildingId: 'power_pole' },
    target: 1,
  },
  {
    id: 'assemble-cores',
    text: 'Have an assembler make data cores',
    hint: 'A data core is a gear and a copper plate. Labs turn them into research.',
    goal: { kind: 'running', buildingId: 'assembler', recipeId: 'make_data_core' },
    target: 1,
  },
  {
    id: 'place-lab',
    text: 'Place a lab near a pole',
    hint: '10 gears, 10 circuits and 12 bricks. It needs power, and data cores in.',
    goal: { kind: 'built', buildingId: 'lab' },
    target: 1,
  },
  {
    id: 'research-logistics',
    text: 'Research Logistics 1',
    hint: 'Press T and choose Logistics 1. An inserter from the core assembler keeps the lab fed.',
    goal: { kind: 'researched', technologyId: 'logistics_1' },
    target: 1,
  },
  {
    id: 'place-splitter',
    text: 'Place a splitter',
    hint: 'It shares one belt between two, turn about. Drop it across a belt.',
    goal: { kind: 'built', buildingId: 'splitter' },
    target: 1,
  },
  {
    id: 'place-underground',
    text: 'Place an underground belt',
    hint: 'One craft is a pair of mouths, up to 6 tiles apart. Items pass under whatever is between.',
    goal: { kind: 'built', buildingId: 'underground_belt' },
    target: 1,
  },

  // Steel, and electric smelting.
  {
    id: 'research-smelting',
    text: 'Research Smelting 2',
    hint: 'Press T. It unlocks steel.',
    goal: { kind: 'researched', technologyId: 'smelting_2' },
    target: 1,
  },
  {
    id: 'make-steel',
    text: 'Make 3 steel',
    hint: 'Put iron plates in a furnace: five plates make one steel.',
    goal: { kind: 'carried', itemId: 'steel' },
    target: 3,
  },
  {
    id: 'research-power',
    text: 'Research Power 1',
    hint: 'Press T. It unlocks the electric furnace.',
    goal: { kind: 'researched', technologyId: 'power_1' },
    target: 1,
  },
  {
    id: 'run-electric-furnace',
    text: 'Run an electric furnace',
    hint: '12 bricks, 5 circuits and 3 steel. It smelts on power alone: no coal.',
    goal: { kind: 'running', buildingId: 'electric_furnace' },
    target: 1,
  },

  // The rest of the tree.
  {
    id: 'research-exploration',
    text: 'Research Exploration 1',
    hint: 'Press T. It unlocks the radar.',
    goal: { kind: 'researched', technologyId: 'exploration_1' },
    target: 1,
  },
  {
    id: 'run-radar',
    text: 'Run a radar',
    hint: 'Put it under a pole. It reveals the ground around it; press M to watch the map fill in.',
    goal: { kind: 'running', buildingId: 'radar' },
    target: 1,
  },
  {
    id: 'research-mining',
    text: 'Research Mining 2',
    hint: 'Press T. It unlocks a miner twice as fast.',
    goal: { kind: 'researched', technologyId: 'mining_2' },
    target: 1,
  },
  {
    id: 'place-miner-2',
    text: 'Place a Miner Mk2',
    hint: '6 gears, 4 circuits and 4 steel. It mines twice as fast as a miner.',
    goal: { kind: 'built', buildingId: 'miner_2' },
    target: 1,
  },
  {
    id: 'research-construction',
    text: 'Research Construction 1',
    hint: 'Press T. It unlocks structural frames and the Assembler Mk2.',
    goal: { kind: 'researched', technologyId: 'construction_1' },
    target: 1,
  },
  {
    id: 'make-frames',
    text: 'Make 4 structural frames',
    hint: 'Two steel and four bricks each.',
    goal: { kind: 'carried', itemId: 'frame' },
    target: 4,
  },
  {
    id: 'run-assembler-2',
    text: 'Run an Assembler Mk2',
    hint: '10 gears, 6 circuits and 4 frames. It works twice as fast as an assembler.',
    goal: { kind: 'running', buildingId: 'assembler_2' },
    target: 1,
  },
]);

const TITLE = 'QUESTS';
const HIDE = 'Hide';
const CLOSE = 'Close';
const SKIP_STEP = 'Skip step';
const FINISHED = 'Every building and every technology is yours. Everything from here is making it bigger.';

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
  /** Index of the step to do: the first not done. `lines.length` once finished. */
  readonly current: number;
  /** How many steps are done. */
  readonly doneCount: number;
  /** The hint for the current step, or the closing sentence. */
  readonly hint: string;
  readonly finished: boolean;
}

/**
 * Which steps are done now, given which were done before and what the world
 * counts. Pure, so the latching rule has a test of its own. A step already
 * done is not counted again, which is what keeps a long chain cheap: only the
 * steps still open ask the world anything.
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
  const found = lines.findIndex((line) => !line.done);
  const current = found < 0 ? lines.length : found;
  return Object.freeze({
    lines: Object.freeze(lines),
    current,
    doneCount: lines.filter((line) => line.done).length,
    hint: definitions[current]?.hint ?? FINISHED,
    finished: found < 0,
  });
}

/**
 * Is line `index` one of the few on screen? The step before the current one,
 * the current one, and the one after it — or, once finished, the last three.
 */
export function isLineShown(index: number, current: number, total: number): boolean {
  const centre = Math.min(current, total - 2);
  return index >= centre - 1 && index <= centre + 1;
}

interface Line {
  readonly root: HTMLElement;
  readonly icon: SVGSVGElement;
  readonly text: HTMLElement;
  readonly count: HTMLElement;
}

export interface ObjectivesPanelOptions {
  /** HIDE, or CLOSE once finished. The guide goes away and stays away. */
  readonly onDismiss: () => void;
  /** SKIP STEP: tick the current step without the world agreeing. */
  readonly onSkipStep: (id: string) => void;
}

/**
 * The panel. Non-modal: it takes no focus, blocks nothing and pauses
 * nothing, and it is two tab stops — its hide and skip buttons — so a
 * keyboard player is not made to walk through it.
 *
 * Every step has a line, built once in `mount()` (§13); `update` shows the
 * three around the current step and hides the rest.
 */
export class ObjectivesPanel {
  private readonly root = document.createElement('section');
  private readonly progress = document.createElement('p');
  private readonly hint = document.createElement('p');
  private readonly dismiss = document.createElement('button');
  private readonly skip = document.createElement('button');
  private readonly lines: Line[] = [];
  private readonly options: ObjectivesPanelOptions;
  /** The id SKIP STEP ticks, or null when there is none left. */
  private currentId: string | null = null;

  constructor(options: ObjectivesPanelOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-objectives';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Quests');

    const head = document.createElement('div');
    head.className = 'if-objectives__head';
    const title = document.createElement('h2');
    title.className = 'if-objectives__title';
    title.textContent = TITLE;
    this.progress.className = 'if-objectives__progress';
    this.dismiss.type = 'button';
    this.dismiss.className = 'if-objectives__skip';
    this.dismiss.textContent = HIDE;
    this.dismiss.title = 'Hide the guide. Settings can bring it back.';
    this.dismiss.addEventListener('click', this.handleDismiss);
    head.append(title, this.progress, this.dismiss);

    const list = document.createElement('ol');
    list.className = 'if-objectives__list';
    for (const definition of OBJECTIVES) {
      const root = document.createElement('li');
      root.className = 'if-objective';
      root.dataset['id'] = definition.id;
      root.hidden = true;
      const icon = createIcon('idle');
      const text = document.createElement('span');
      text.className = 'if-objective__text';
      const count = document.createElement('span');
      count.className = 'if-objective__count';
      root.append(icon, text, count);
      list.append(root);
      this.lines.push({ root, icon, text, count });
    }

    const foot = document.createElement('div');
    foot.className = 'if-objectives__foot';
    this.hint.className = 'if-objectives__hint';
    this.skip.type = 'button';
    this.skip.className = 'if-objectives__step-skip';
    this.skip.textContent = SKIP_STEP;
    this.skip.title = 'Tick this step and move on to the next.';
    this.skip.addEventListener('click', this.handleSkip);
    foot.append(this.hint, this.skip);

    this.root.append(head, list, foot);
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
    const total = view.lines.length;
    view.lines.forEach((line, index) => {
      const element = this.lines[index];
      if (element === undefined) return;
      const shown = isLineShown(index, view.current, total);
      if (element.root.hidden === shown) element.root.hidden = !shown;
      if (!shown) return;
      setText(element.text, line.text);
      setText(element.count, line.target > 1 && !line.done ? `${line.progress}/${line.target}` : '');
      element.root.classList.toggle('is-done', line.done);
      element.root.classList.toggle('is-current', index === view.current);
      // A tick for done, a ring for not yet: the state is a shape, not only a
      // colour or a strike-through (C30).
      setIcon(element.icon, line.done ? 'check' : 'idle');
      element.root.setAttribute('aria-label', `${line.text}: ${line.done ? 'done' : 'not done yet'}`);
    });
    setText(this.progress, `${view.doneCount}/${total}`);
    setText(this.hint, view.hint);
    setText(this.dismiss, view.finished ? CLOSE : HIDE);
    this.currentId = view.lines[view.current]?.id ?? null;
    this.skip.hidden = view.finished;
  }

  destroy(): void {
    this.dismiss.removeEventListener('click', this.handleDismiss);
    this.skip.removeEventListener('click', this.handleSkip);
    this.root.remove();
  }

  private readonly handleDismiss = (): void => {
    this.options.onDismiss();
  };

  private readonly handleSkip = (): void => {
    if (this.currentId !== null) this.options.onSkipStep(this.currentId);
  };
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
