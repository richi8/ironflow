/**
 * The inspector. See ironflow.md C12 and §13.
 *
 * > **Goal.** The player can always see *why* a machine is not running.
 *
 * That is pillar 3, and this panel is where it becomes a thing on screen: a
 * name, a status in words and a colour, how far through the current item the
 * machine is, what is in its buffers, and how much it has actually been making
 * over the last ten seconds.
 *
 * ```text
 *   GameController.getInspectorView()  ->  Inspector.update(view)
 *   a frozen MachineView, or null          assignment only, never a rebuild
 * ```
 *
 * ## It builds its DOM once, including the rows it is not using
 *
 * §13: "Never rebuild a panel's subtree on update — that is what makes
 * hand-written DOM UI feel bad." A buffer has a varying number of lines in it,
 * which is exactly the shape that tempts a panel into `innerHTML = ''` and a
 * loop. So the rows are a **fixed pool**, built in `mount()` and hidden when
 * unused: `STACK_ROWS` of them per section, which is more than any machine in
 * §15 has ingredients. A recipe that wanted more would show the first four,
 * which is a visible bug rather than a silent one — and C16, which is the
 * chunk that could produce one, is the chunk that would raise the number.
 *
 * ## It cannot change anything
 *
 * Every control here calls back into `GameUI`, which dispatches a command
 * (§7). The panel holds no entity, no inventory and no controller — it is
 * handed a frozen snapshot and hands back an intention, which is what makes
 * C12's last acceptance criterion ("the inspector cannot mutate simulation
 * state except via commands") a property of the types.
 *
 * ## Why the rate is the interesting number
 *
 * A miner's *nominal* rate is content and never changes; what the player wants
 * to know is whether this particular miner is achieving it. A 2x2 rig lined up
 * on two ore tiles instead of four, or one being emptied too slowly, reads
 * exactly right in the status and yet produces half of what it should. The
 * measured rate is the number that says so.
 */

import type { MachineStack, MachineStatus, MachineView } from '../game/views/building-view.js';

import { createIcon } from './icons.js';

/** Buffer lines drawn per section. See the file header. */
export const STACK_ROWS = 4;

/**
 * What each status is called on screen.
 *
 * `Record<MachineStatus, …>` rather than a function with a default, for the
 * reason the rejection table in `notifications.ts` is one: a status added in
 * C15 or C21 must be a type error today, not the word "undefined" in front of
 * a player three chunks from now.
 *
 * `'idle'` reads "Nothing to do", which is C12's "never a bare idle" taken at
 * its word. The criterion is about machines that *could* run and are not; a
 * chest has no work to be stalled on, and saying so is the honest version of
 * the same sentence.
 */
const STATUS_TEXT: Readonly<Record<MachineStatus, string>> = Object.freeze({
  idle: 'Nothing to do',
  running: 'Running',
  output_full: 'Output full — nothing is taking from it',
  no_resource: 'No ore left under it',
  no_power: 'No power',
  no_input: 'Missing ingredients',
  no_recipe: 'No recipe set',
  no_fuel: 'Out of fuel — progress is paused, not lost',
});

/** Which of §11's status tokens each one is painted in. */
type StatusTone = 'ok' | 'warn' | 'danger' | 'idle';

const STATUS_TONE: Readonly<Record<MachineStatus, StatusTone>> = Object.freeze({
  idle: 'idle',
  running: 'ok',
  // Stalled, and the player can fix it: take the ore out, feed it, choose a
  // recipe. Amber is "this needs you".
  output_full: 'warn',
  no_input: 'warn',
  no_recipe: 'warn',
  // Stopped for a reason that will not fix itself without moving something.
  no_fuel: 'warn',
  no_resource: 'danger',
  no_power: 'danger',
});

interface StackRow {
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
  readonly take: HTMLButtonElement;
}

interface Section {
  readonly root: HTMLElement;
  readonly rows: readonly StackRow[];
}

export interface InspectorOptions {
  /** Take `count` of `itemId` out of the inspected machine. */
  readonly onTake: (itemId: string, count: number) => void;
  /** Stop inspecting. */
  readonly onClose: () => void;
}

export class Inspector {
  private readonly root = document.createElement('section');
  private readonly title = document.createElement('h2');
  private readonly closeButton = document.createElement('button');
  private readonly statusRow = document.createElement('div');
  private readonly statusText = document.createElement('span');
  private readonly progressRow = document.createElement('div');
  private readonly progressBar = document.createElement('div');
  private readonly progressValue = document.createElement('span');
  private readonly rateRow = document.createElement('div');
  private readonly rateValue = document.createElement('span');
  private readonly whereValue = document.createElement('span');
  private readonly options: InspectorOptions;

  private inputs!: Section;
  private outputs!: Section;

  /** The machine the rows currently describe. Only used to label a take. */
  private view: MachineView | null = null;

  constructor(options: InspectorOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-inspector';
    this.root.hidden = true;

    const head = document.createElement('div');
    head.className = 'if-inspector__head';
    this.title.className = 'if-inspector__title';
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (Esc)';
    this.closeButton.setAttribute('aria-label', 'Close the inspector');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(this.title, this.closeButton);

    this.statusRow.className = 'if-inspector__status';
    this.statusRow.append(createIcon('alert'), this.statusText);

    this.progressRow.className = 'if-inspector__progress';
    const track = document.createElement('div');
    track.className = 'if-inspector__track';
    this.progressBar.className = 'if-inspector__bar';
    track.append(this.progressBar);
    this.progressValue.className = 'if-inspector__percent';
    this.progressRow.append(track, this.progressValue);

    this.rateRow.className = 'if-inspector__rate';
    const rateLabel = document.createElement('span');
    rateLabel.className = 'if-inspector__label';
    rateLabel.textContent = 'RATE';
    this.rateValue.className = 'if-inspector__value';
    this.rateRow.append(rateLabel, this.rateValue);

    this.inputs = this.createSection('INPUT', false);
    this.outputs = this.createSection('OUTPUT', true);

    const where = document.createElement('div');
    where.className = 'if-inspector__where';
    const whereLabel = document.createElement('span');
    whereLabel.className = 'if-inspector__label';
    whereLabel.textContent = 'AT';
    this.whereValue.className = 'if-inspector__value';
    where.append(whereLabel, this.whereValue);

    this.root.append(head, this.statusRow, this.progressRow, this.rateRow, this.inputs.root, this.outputs.root, where);
    parent.append(this.root);
  }

  /** Is the panel on screen? For the tests and for the UI's own bookkeeping. */
  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * Repaint from a snapshot, or close on `null`. Assignment only (§13).
   *
   * Called on `selectionChanged` — so a click opens it on the same frame — and
   * then from the 10 Hz lane, which is what keeps the bar moving and the rate
   * live without putting a DOM write in every frame.
   */
  update(view: MachineView | null): void {
    this.view = view;
    this.root.hidden = view === null;
    if (view === null) return;

    setText(this.title, view.name);

    setText(this.statusText, STATUS_TEXT[view.status]);
    // `dataset` rather than one class per status: the stylesheet selects on
    // the tone, and there is then no set of stale classes to remember to
    // remove when a machine goes from running to stalled and back.
    this.statusRow.dataset['tone'] = STATUS_TONE[view.status];

    const progress = view.progress;
    this.progressRow.hidden = progress === null;
    if (progress !== null) {
      const percent = clampPercent(progress);
      this.progressBar.style.width = `${percent}%`;
      setText(this.progressValue, `${Math.round(percent)}%`);
    }

    const rate = view.ratePerMinute;
    this.rateRow.hidden = rate === null;
    if (rate !== null) setText(this.rateValue, `${rate.toFixed(1)} /min`);

    this.fill(this.inputs, view.inputs, view.inReach);
    this.fill(this.outputs, view.outputs, view.inReach);

    setText(this.whereValue, `${view.x}, ${view.y}`);
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    for (const section of [this.inputs, this.outputs]) {
      for (const row of section.rows) row.take.removeEventListener('click', this.handleTake);
    }
    this.root.remove();
  }

  private readonly handleClose = (): void => {
    this.options.onClose();
  };

  private readonly handleTake = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const itemId = target.dataset['item'];
    if (itemId === undefined || this.view === null) return;

    // The count the button was drawn with, so "take" means what the row says.
    // A machine that produced one more item in between keeps it; a partial
    // transfer is the normal outcome of every transfer in this game (C08).
    const stack = this.view.outputs.find((line) => line.itemId === itemId);
    if (stack !== undefined && stack.count > 0) this.options.onTake(itemId, stack.count);
  };

  /**
   * A heading plus a fixed pool of rows. `takeable` decides whether the rows
   * carry a button at all: there is nothing a player can do to an input buffer
   * by hand until something in the game has one (C15).
   */
  private createSection(label: string, takeable: boolean): Section {
    const root = document.createElement('div');
    root.className = 'if-inspector__section';
    root.hidden = true;

    const heading = document.createElement('div');
    heading.className = 'if-inspector__label';
    heading.textContent = label;
    root.append(heading);

    const rows: StackRow[] = [];
    for (let i = 0; i < STACK_ROWS; i++) {
      const row = this.createRow(takeable);
      rows.push(row);
      root.append(row.root);
    }
    return { root, rows };
  }

  private createRow(takeable: boolean): StackRow {
    const root = document.createElement('div');
    root.className = 'if-stack';
    root.hidden = true;

    const name = document.createElement('span');
    name.className = 'if-stack__name';

    const count = document.createElement('span');
    count.className = 'if-stack__count';

    const take = document.createElement('button');
    take.type = 'button';
    take.className = 'if-stack__take';
    take.textContent = 'TAKE';
    take.hidden = !takeable;
    if (takeable) take.addEventListener('click', this.handleTake);

    root.append(name, count, take);
    return { root, name, count, take };
  }

  /** Point a section's rows at `stacks`, hiding the ones it does not need. */
  private fill(section: Section, stacks: readonly MachineStack[], inReach: boolean): void {
    section.root.hidden = stacks.length === 0;

    for (let i = 0; i < section.rows.length; i++) {
      const row = section.rows[i];
      if (row === undefined) continue;

      const stack = stacks[i];
      row.root.hidden = stack === undefined;
      if (stack === undefined) continue;

      setText(row.name, stack.name);
      setText(row.count, stack.capacity === null ? String(stack.count) : `${stack.count}/${stack.capacity}`);
      row.take.dataset['item'] = stack.itemId;
      // A pre-check, not the rule (§7): the simulation still refuses a take
      // the player walked out of range of between this frame and the tick.
      row.take.disabled = !inReach || stack.count === 0;
    }
  }
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** `progress` is 0..1, but a machine one tick past its period is briefly over. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : progress * 100;
}
