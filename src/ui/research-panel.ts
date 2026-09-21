/**
 * The tech tree. See ironflow.md C22 task 5 and §13.
 *
 * > Research panel: tree layout, prerequisites, costs, current progress, and a
 * > queue.
 *
 * ```text
 *   RESEARCH        the active technology, its bar, and how many labs are on it
 *   TREE            one row per tier, one card per technology
 *   QUEUE           what is lined up, head first, each with a cancel
 * ```
 *
 * ## The tree is drawn as rows, not as wires
 *
 * `TechnologyView.tier` is the longest path from a root, so a row of cards is
 * the honest layout: everything in row *n* needs something in a row above it,
 * and each card names its own prerequisites. Drawing the edges would mean
 * absolute positioning, a layout pass and a second geometry to keep in step
 * with a content table that is allowed to grow — for a tree that is five nodes
 * deep and whose dependencies fit on one line of each card. If the tree ever
 * becomes wide enough that the rows stop being readable, that is the chunk
 * that earns an SVG.
 *
 * ## It builds its DOM once, from content
 *
 * A card per technology, made in `mount()` from the first view and never
 * created or destroyed again (§13) — the same rule `BuildMenu` and
 * `InventoryPanel` follow, and for the same reason: the tree's *shape* is
 * content, and content does not change while the game runs. An update is
 * `textContent`, a class and a bar width.
 *
 * ## It cannot change anything
 *
 * Clicking a card asks `GameUI` to dispatch `startResearch`; clicking a queue
 * row's × asks for `cancelResearch`. The panel greys out what it expects to be
 * refused, which §7 permits as a pre-check — the simulation refuses it again
 * on its own terms one tick later.
 */

import type { ResearchView, TechnologyView } from '../game/views/research-view.js';

import { createIcon } from './icons.js';

/** Queue rows drawn. More than `MAX_RESEARCH_QUEUE`, which a test asserts. */
export const RESEARCH_QUEUE_ROWS = 12;

interface Card {
  readonly root: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly summary: HTMLElement;
  readonly cost: HTMLElement;
  readonly needs: HTMLElement;
  readonly grants: HTMLElement;
  readonly bar: HTMLElement;
}

interface QueueRow {
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly progress: HTMLElement;
  readonly cancel: HTMLButtonElement;
}

export interface ResearchPanelOptions {
  /** Put a technology in the queue. */
  readonly onStart: (technologyId: string) => void;
  /** Take one out again. */
  readonly onCancel: (technologyId: string) => void;
  readonly onClose: () => void;
}

export class ResearchPanel {
  private readonly root = document.createElement('section');
  private readonly closeButton = document.createElement('button');
  private readonly activeName = document.createElement('span');
  private readonly activeDetail = document.createElement('span');
  private readonly activeBar = document.createElement('span');
  private readonly labs = document.createElement('span');
  private readonly tree = document.createElement('div');
  private readonly queueList = document.createElement('div');
  private readonly queueEmpty = document.createElement('div');
  private readonly options: ResearchPanelOptions;

  private readonly cards = new Map<string, Card>();
  private readonly queueRows: QueueRow[] = [];

  private open = false;

  constructor(options: ResearchPanelOptions) {
    this.options = options;
  }

  /** @param view the first snapshot, whose technology list is the panel's shape. */
  mount(parent: HTMLElement, view: ResearchView): void {
    this.root.className = 'if-research';
    this.root.hidden = true;

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = 'RESEARCH';
    this.labs.className = 'if-inventory__slots';
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (T)';
    this.closeButton.setAttribute('aria-label', 'Close the research panel');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('research'), title, this.labs, this.closeButton);

    const active = document.createElement('div');
    active.className = 'if-research__active';
    this.activeName.className = 'if-research__active-name';
    this.activeDetail.className = 'if-research__active-detail';
    const track = document.createElement('span');
    track.className = 'if-research__track';
    this.activeBar.className = 'if-research__bar';
    track.append(this.activeBar);
    active.append(this.activeName, this.activeDetail, track);

    this.tree.className = 'if-research__tree';
    for (const row of this.rowsByTier(view)) this.tree.append(row);

    const queueLabel = label('QUEUE');
    this.queueList.className = 'if-queue';
    for (let i = 0; i < RESEARCH_QUEUE_ROWS; i++) this.queueList.append(this.createQueueRow());
    this.queueEmpty.className = 'if-inventory__empty';
    this.queueEmpty.textContent = 'Nothing queued. Pick a technology above.';

    this.root.append(head, active, this.tree, queueLabel, this.queueList, this.queueEmpty);
    parent.append(this.root);
    this.update(view);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.hidden = !open;
  }

  toggle(): boolean {
    this.setOpen(!this.open);
    return this.open;
  }

  /** Repaint from a snapshot. Assignment and class toggles only (§13). */
  update(view: ResearchView): void {
    this.paintActive(view);
    for (const technology of view.technologies) {
      const card = this.cards.get(technology.id);
      if (card !== undefined) this.paintCard(card, technology);
    }
    this.paintQueue(view);
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    for (const card of this.cards.values()) card.root.removeEventListener('click', this.handleStart);
    for (const row of this.queueRows) row.cancel.removeEventListener('click', this.handleCancel);
    this.cards.clear();
    this.queueRows.length = 0;
    this.root.remove();
  }

  private readonly handleClose = (): void => {
    this.options.onClose();
  };

  /** One listener for every card, reading the technology off the element. */
  private readonly handleStart = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset['technology'];
    if (id !== undefined) this.options.onStart(id);
  };

  private readonly handleCancel = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset['technology'];
    if (id !== undefined && id.length > 0) this.options.onCancel(id);
  };

  /** One element per tier, in order, each holding that tier's cards. */
  private rowsByTier(view: ResearchView): HTMLElement[] {
    const tiers = new Map<number, HTMLElement>();
    const rows: HTMLElement[] = [];
    // Content order within a tier, and tiers in ascending order: the tree is
    // laid out the way the content table is written, so adding a technology
    // puts it where its author put it rather than wherever a sort lands it.
    const ordered = [...view.technologies].sort((a, b) => a.tier - b.tier);
    for (const technology of ordered) {
      let row = tiers.get(technology.tier);
      if (row === undefined) {
        row = document.createElement('div');
        row.className = 'if-research__row';
        tiers.set(technology.tier, row);
        rows.push(row);
      }
      row.append(this.createCard(technology));
    }
    return rows;
  }

  private createCard(technology: TechnologyView): HTMLButtonElement {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'if-tech';
    root.dataset['technology'] = technology.id;
    root.addEventListener('click', this.handleStart);

    const name = document.createElement('span');
    name.className = 'if-tech__name';
    name.textContent = technology.name;

    const summary = document.createElement('span');
    summary.className = 'if-tech__summary';
    summary.textContent = technology.summary;

    const grants = document.createElement('span');
    grants.className = 'if-tech__grants';

    const cost = document.createElement('span');
    cost.className = 'if-tech__cost';

    const needs = document.createElement('span');
    needs.className = 'if-tech__needs';

    const track = document.createElement('span');
    track.className = 'if-tech__track';
    const bar = document.createElement('span');
    bar.className = 'if-tech__bar';
    track.append(bar);

    root.append(name, summary, grants, cost, needs, track);
    this.cards.set(technology.id, { root, name, summary, cost, needs, grants, bar });
    return root;
  }

  private createQueueRow(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'if-queue-row';
    root.hidden = true;

    const name = document.createElement('span');
    name.className = 'if-queue-row__name';

    const progress = document.createElement('span');
    progress.className = 'if-queue-row__remaining';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'if-queue-row__cancel';
    cancel.title = 'Take this out of the queue — the units already researched are kept';
    cancel.setAttribute('aria-label', 'Cancel this research');
    cancel.textContent = '×';
    cancel.addEventListener('click', this.handleCancel);

    root.append(name, progress, cancel);
    this.queueRows.push({ root, name, progress, cancel });
    return root;
  }

  private paintActive(view: ResearchView): void {
    setText(this.labs, view.labs === 0 ? 'NO LABS' : `${view.labsWorking} / ${view.labs} LABS WORKING`);
    // A factory with labs that are not turning over is the one state the
    // heading has to explain: the bar below is not moving and nothing else on
    // screen would say why (§13, pillar 3).
    this.labs.classList.toggle('is-warning', view.labs > 0 && view.labsWorking === 0);

    const active = view.technologies.find((technology) => technology.state === 'active');
    if (active === undefined) {
      setText(this.activeName, 'Nothing being researched');
      setText(this.activeDetail, view.labs === 0 ? 'Build a lab to begin.' : 'Pick a technology below.');
      this.activeBar.style.width = '0%';
      return;
    }

    setText(this.activeName, active.name);
    setText(this.activeDetail, `${active.unitsDone} / ${active.units} units`);
    this.activeBar.style.width = `${clampPercent(active.progress)}%`;
  }

  private paintCard(card: Card, technology: TechnologyView): void {
    setText(card.grants, technology.unlocks.map((unlock) => unlock.name).join(', '));
    setText(card.cost, technology.cost.map((line) => `${line.count} ${line.name}`).join(', '));
    setText(
      card.needs,
      technology.prerequisites.length === 0 ? '' : `needs ${technology.prerequisites.join(', ')}`,
    );
    // `dataset` rather than a class per state, for the inspector's reason:
    // there is no stale state to remember to clear.
    card.root.dataset['state'] = technology.state;
    card.bar.style.width = `${clampPercent(technology.progress)}%`;
    // Only a technology that can be started is clickable. A researched one has
    // nothing to do, a queued one is cancelled from the queue below, and a
    // locked one is waiting on something the card already names.
    card.root.disabled = technology.state !== 'available';
    card.root.title = describe(technology);
  }

  private paintQueue(view: ResearchView): void {
    this.queueEmpty.hidden = view.queue.length > 0;

    for (let i = 0; i < this.queueRows.length; i++) {
      const row = this.queueRows[i];
      if (row === undefined) continue;

      const id = view.queue[i];
      row.root.hidden = id === undefined;
      if (id === undefined) {
        row.cancel.dataset['technology'] = '';
        continue;
      }

      const technology = view.technologies.find((candidate) => candidate.id === id);
      setText(row.name, technology?.name ?? id);
      setText(row.progress, technology === undefined ? '' : `${technology.unitsDone} / ${technology.units}`);
      row.cancel.dataset['technology'] = id;
      row.root.dataset['state'] = i === 0 ? 'active' : 'waiting';
    }
  }
}

function describe(technology: TechnologyView): string {
  const grants = technology.unlocks.map((unlock) => unlock.name).join(', ');
  const cost = technology.cost.map((line) => `${line.count} ${line.name}`).join(', ');
  switch (technology.state) {
    case 'researched':
      return `${technology.name} — researched. Unlocked ${grants}.`;
    case 'active':
      return `${technology.name} — being researched now, ${technology.unitsDone} of ${technology.units} units.`;
    case 'queued':
      return `${technology.name} — in the queue.`;
    case 'locked':
      return `${technology.name} — needs ${technology.prerequisites.join(', ')} first.`;
    default:
      return `${technology.name} — costs ${cost}, ${technology.unitSeconds.toFixed(0)}s a unit in one lab. Unlocks ${grants}.`;
  }
}

function label(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'if-inspector__label';
  element.textContent = text;
  return element;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** `progress` is 0..1; a finished technology leaves the queue, so 1 is the cap. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : progress * 100;
}
