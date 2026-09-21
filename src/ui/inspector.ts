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
 * §15 has ingredients — C16's widest recipe takes two, and the widest §15
 * ever gets to is three. A recipe that wanted more would show the first four,
 * which is a visible bug rather than a silent one.
 *
 * The **recipe picker** (C16 task 3) is the one thing here that is not a fixed
 * pool, because the number of choices is a property of the *machine* rather
 * than of what is happening inside it: a furnace has none, an assembler has
 * every crafting recipe, and C22 will unlock more of them. So its buttons are
 * rebuilt when the choices change and never otherwise — a repaint at 10 Hz
 * moves one attribute, which is what §13's rule is actually about.
 *
 * ## It cannot change anything
 *
 * Every control here calls back into `GameUI`, which dispatches a command
 * (§7). The panel holds no entity, no inventory and no controller — it is
 * handed a frozen snapshot and hands back an intention, which is what makes
 * C12's last acceptance criterion ("the inspector cannot mutate simulation
 * state except via commands") a property of the types. C16's picker is the
 * first control here that changes what a machine *does* rather than what is
 * in it, and it goes the same way: a recipe id out, a `setRecipe` command
 * queued, and a machine that may still refuse it.
 *
 * ## Why the rate is the interesting number
 *
 * A miner's *nominal* rate is content and never changes; what the player wants
 * to know is whether this particular miner is achieving it. A 2x2 rig lined up
 * on two ore tiles instead of four, or one being emptied too slowly, reads
 * exactly right in the status and yet produces half of what it should. The
 * measured rate is the number that says so.
 */

import type {
  MachinePowerView,
  MachineStack,
  MachineStatus,
  MachineView,
} from '../game/views/building-view.js';
import type { RecipeView } from '../game/views/recipe-view.js';

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
  no_power: 'Not connected to a power network',
  no_input: 'Missing ingredients',
  no_recipe: 'No recipe set',
  no_fuel: 'Out of fuel — progress is paused, not lost',
  no_destination: 'Nowhere to put anything — it is not pointed at a belt, a chest or a machine',
  low_power: 'Low power — the network cannot keep up',
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
  // C21: the factory works, it is just stretched. Amber for the same reason
  // `output_full` is — it is a number to grow, not a thing that is broken.
  low_power: 'warn',
  no_resource: 'danger',
  no_power: 'danger',
  // Misconfigured rather than stalled: nothing will ever come of it, and it
  // will not announce itself again (C20).
  no_destination: 'danger',
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
  /** Make `recipeId`, or `null` to make nothing at all (C16 task 3). */
  readonly onSetRecipe: (recipeId: string | null) => void;
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

  /** The MAKING line, for a machine that chooses its own recipe. */
  private readonly makingRow = document.createElement('div');
  private readonly makingValue = document.createElement('span');

  /**
   * "The next item goes to…", for a splitter. C20, closing C17's note.
   *
   * Its own row rather than a line in the OUTPUT section, because a splitter
   * has no output *buffer* — what it has is a decision about which of two
   * belts the next item takes, and that is a different kind of fact from "12
   * plates are sitting in here".
   */
  private readonly nextRow = document.createElement('div');
  private readonly nextValue = document.createElement('span');

  /**
   * "POWER — 150 kW, network at 62%", for anything on the grid (C21 task 5).
   *
   * Its own row for the splitter row's reason: what it reports is neither a
   * buffer nor a progress bar. It is also the row that makes `no_power` and
   * `low_power` actionable — the status says a machine is not running, and
   * this says whether nothing reaches it or what does cannot keep up.
   */
  private readonly powerRow = document.createElement('div');
  private readonly powerValue = document.createElement('span');

  /** The picker, for a machine the player chooses for (C16 task 3). */
  private readonly recipeSection = document.createElement('div');
  private readonly recipeGrid = document.createElement('div');
  private recipeButtons: HTMLButtonElement[] = [];
  /**
   * The recipe ids the grid is currently built from.
   *
   * §13 forbids rebuilding a panel's subtree *on update*, which is about the
   * ten times a second this panel repaints while a machine runs — not about
   * the moment the player selects a different kind of machine, where the
   * choices genuinely are different ones. So the buttons are rebuilt when this
   * string changes and never otherwise, and selecting a machine of the same
   * kind moves an attribute rather than a subtree.
   */
  private recipeSignature = '';

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

    // The rate row's layout, and a class of its own so a test — and a
    // stylesheet — can name the line rather than the shape.
    this.makingRow.className = 'if-inspector__rate if-inspector__making';
    this.makingRow.hidden = true;
    const makingLabel = document.createElement('span');
    makingLabel.className = 'if-inspector__label';
    makingLabel.textContent = 'MAKING';
    this.makingValue.className = 'if-inspector__value';
    this.makingRow.append(makingLabel, this.makingValue);

    this.nextRow.className = 'if-inspector__rate if-inspector__next';
    this.nextRow.hidden = true;
    const nextLabel = document.createElement('span');
    nextLabel.className = 'if-inspector__label';
    nextLabel.textContent = 'NEXT OUT';
    this.nextValue.className = 'if-inspector__value';
    this.nextRow.append(nextLabel, this.nextValue);

    this.powerRow.className = 'if-inspector__rate if-inspector__power';
    this.powerRow.hidden = true;
    const powerLabel = document.createElement('span');
    powerLabel.className = 'if-inspector__label';
    powerLabel.textContent = 'POWER';
    this.powerValue.className = 'if-inspector__value';
    this.powerRow.append(powerLabel, this.powerValue);

    this.recipeSection.className = 'if-inspector__recipes';
    this.recipeSection.hidden = true;
    const recipeLabel = document.createElement('div');
    recipeLabel.className = 'if-inspector__label';
    recipeLabel.textContent = 'RECIPE';
    this.recipeGrid.className = 'if-recipes';
    this.recipeSection.append(recipeLabel, this.recipeGrid);

    // Takeable since C20. C15 left the INPUT section read-only because the
    // TAKE button belongs to outputs — and C16 then noticed the hole that
    // leaves: ingredients stranded in a machine because the player's bag was
    // full could only be got back by switching the recipe twice. Reaching into
    // a machine is a hand action and the hand does not care which buffer it is
    // (see `systems/hand-system.ts`); what must never take from an input is an
    // *inserter*, and that is still enforced where it always was, in
    // `items/item-port.ts`.
    this.inputs = this.createSection('INPUT', true);
    this.outputs = this.createSection('OUTPUT', true);

    const where = document.createElement('div');
    where.className = 'if-inspector__where';
    const whereLabel = document.createElement('span');
    whereLabel.className = 'if-inspector__label';
    whereLabel.textContent = 'AT';
    this.whereValue.className = 'if-inspector__value';
    where.append(whereLabel, this.whereValue);

    this.root.append(
      head,
      this.statusRow,
      this.progressRow,
      this.rateRow,
      this.makingRow,
      this.nextRow,
      this.powerRow,
      this.recipeSection,
      this.inputs.root,
      this.outputs.root,
      where,
    );
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

    this.powerRow.hidden = view.power === null;
    if (view.power !== null) setText(this.powerValue, describePower(view.power));

    // A splitter's whole panel was empty before C20: it has no ports, so
    // there was nothing to list. This is the one thing it does have.
    this.nextRow.hidden = view.nextOutput === null;
    if (view.nextOutput !== null) {
      setText(this.nextValue, `${view.nextOutput.x}, ${view.nextOutput.y}`);
    }

    this.fillRecipes(view);
    this.fill(this.inputs, view.inputs, view.inReach);
    this.fill(this.outputs, view.outputs, view.inReach);

    setText(this.whereValue, `${view.x}, ${view.y}`);
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    for (const section of [this.inputs, this.outputs]) {
      for (const row of section.rows) row.take.removeEventListener('click', this.handleTake);
    }
    this.clearRecipes();
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
    //
    // Either section, since C20 made the input rows takeable too. One lookup
    // across both rather than a flag on the button: an item cannot be in both
    // buffers of one machine — `RecipeRegistry` refuses a recipe that has the
    // same item as an ingredient and a product — so there is nothing for the
    // two to disagree about.
    const stack =
      this.view.outputs.find((line) => line.itemId === itemId) ??
      this.view.inputs.find((line) => line.itemId === itemId);
    if (stack !== undefined && stack.count > 0) this.options.onTake(itemId, stack.count);
  };

  private readonly handleRecipe = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const recipeId = target.dataset['recipe'];
    if (recipeId === undefined) return;
    // Clicking what it is already making stops it, which is the only way to
    // say "nothing" without a button whose whole label would be a negative.
    // The machine hands the ingredients back either way (C16 task 2).
    this.options.onSetRecipe(target.getAttribute('aria-pressed') === 'true' ? null : recipeId);
  };

  /**
   * The MAKING line and the picker grid, for whichever of the two this machine
   * has. See `views/recipe-view.ts` for why they are different fields.
   */
  private fillRecipes(view: MachineView): void {
    const choices = view.recipes;
    this.recipeSection.hidden = choices === null || choices.length === 0;
    // The line is for machines that choose for themselves; a machine with a
    // picker already says what it is making by which button is lit.
    this.makingRow.hidden = choices !== null || view.recipe === null;
    if (view.recipe !== null && choices === null) setText(this.makingValue, view.recipe.name);
    if (choices === null) {
      this.rebuildRecipes(NO_RECIPES);
      return;
    }

    this.rebuildRecipes(choices);
    for (let i = 0; i < this.recipeButtons.length; i++) {
      const button = this.recipeButtons[i];
      const choice = choices[i];
      if (button === undefined || choice === undefined) continue;
      // An attribute rather than a class, for the reason the status tone is
      // one: there is then no stale state to remember to remove, and a button
      // that says what it is out loud is one a screen reader can read.
      const pressed = choice.selected ? 'true' : 'false';
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }
  }

  /** Build the grid, but only when the choices themselves have changed. */
  private rebuildRecipes(choices: readonly RecipeView[]): void {
    const signature = choices.map((choice) => choice.id).join('|');
    if (signature === this.recipeSignature) return;
    this.recipeSignature = signature;
    this.clearRecipes();

    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'if-recipe';
      button.dataset['recipe'] = choice.id;
      button.setAttribute('aria-pressed', 'false');

      const name = document.createElement('span');
      name.className = 'if-recipe__name';
      name.textContent = amountOf(choice.outputs[0]?.count ?? 1, choice.name);

      const rate = document.createElement('span');
      rate.className = 'if-recipe__rate';
      rate.textContent = `${choice.ratePerMinute.toFixed(0)} /min`;

      const parts = document.createElement('span');
      parts.className = 'if-recipe__parts';
      // C29 puts a real icon beside each of these; until then the count and
      // the name are the icon, which is what the player reads anyway.
      parts.textContent = choice.inputs.map((part) => amountOf(part.count, part.name)).join(' + ');

      button.append(name, rate, parts);
      button.addEventListener('click', this.handleRecipe);
      this.recipeButtons.push(button);
      this.recipeGrid.append(button);
    }
  }

  private clearRecipes(): void {
    for (const button of this.recipeButtons) button.removeEventListener('click', this.handleRecipe);
    this.recipeButtons = [];
    this.recipeGrid.replaceChildren();
  }

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

/** No choices: a machine that picks its own recipe, or a building with none. */
const NO_RECIPES: readonly RecipeView[] = Object.freeze([]);

/** "2 Iron Plate", and "Gear" for a single one — the count is the news. */
function amountOf(count: number, name: string): string {
  return count === 1 ? name : `${count} ${name}`;
}

/**
 * The POWER line: what this building does to the grid, then how the grid is
 * doing (C21).
 *
 * A generator reads "900 kW supplied", a machine "150 kW drawn", and both then
 * carry the network's own state — because the useful sentence is not "this
 * machine wants 150 kW", it is "it wants 150 kW and its network is at 62%".
 */
function describePower(power: MachinePowerView): string {
  const role =
    power.productionKw > 0 ? `${power.productionKw} kW supplied` : `${power.consumptionKw} kW drawn`;
  if (!power.connected) return `${role} — no network`;
  return `${role}, network at ${power.satisfactionPercent}%`;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** `progress` is 0..1, but a machine one tick past its period is briefly over. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : progress * 100;
}
