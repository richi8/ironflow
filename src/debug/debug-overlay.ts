import type { Verdict } from './budgets.js';

/**
 * The F3 developer readout. See ironflow.md C00 task 10, §12 and C28 task 2.
 *
 * C00 gave it the loop numbers; C28 made it the profiler's face — every §12
 * metric the browser can measure, each phase of the tick, and the counts that
 * explain them — laid out in titled sections so a person can find the number
 * they came for.
 *
 * It builds its DOM once and updates by assignment (§13). A row is created
 * the first time its label is seen and never again, which lets the composition
 * root add a row without this file having to know it exists. It is throttled,
 * because a readout that re-renders every frame is itself a measurable cost —
 * and the throttle is applied **before** the rows are collected, so on the
 * nine frames in ten that draw nothing, nothing is counted either.
 */
const UPDATE_INTERVAL_MS = 100;

/** What a row's value is judged to be, for its colour. `null` is no opinion. */
export type RowTone = Verdict | null;

/** Where `collect` writes. Sections and rows appear in the order they are written. */
export interface DebugRows {
  /** Start a titled group. Rows after it belong to it until the next one. */
  section(title: string): void;
  row(label: string, value: string, tone?: RowTone): void;
}

interface Row {
  readonly value: HTMLElement;
  tone: RowTone;
}

const TONE_CLASS: Readonly<Record<Verdict, string>> = {
  ok: 'debug-overlay__value--ok',
  over_target: 'debug-overlay__value--warn',
  hard_fail: 'debug-overlay__value--danger',
};

export class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private readonly sections = new Set<string>();
  private visible: boolean;
  private msSinceUpdate = 0;
  private section = '';

  /** The writer handed to `collect`. One object, reused, so a repaint allocates nothing for it. */
  private readonly writer: DebugRows = {
    section: (title) => {
      this.section = title;
      if (this.sections.has(title)) return;
      this.sections.add(title);
      const heading = document.createElement('div');
      heading.className = 'debug-overlay__section';
      heading.textContent = title;
      this.root.append(heading);
    },
    row: (label, value, tone = null) => this.setRow(label, value, tone),
  };

  /**
   * @param visible whether it starts open. Closed unless asked: F3 opens it,
   * and the profiler behind it runs only while it is open.
   */
  constructor(parent: HTMLElement, visible = false) {
    this.root = document.createElement('div');
    this.root.className = 'debug-overlay';

    const title = document.createElement('div');
    title.className = 'debug-overlay__title';
    title.textContent = 'IRONFLOW — F3';
    this.root.append(title);

    this.visible = visible;
    this.root.hidden = !visible;
    parent.append(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.hidden = !this.visible;
    // Paint on the next update rather than waiting out the interval: a panel
    // that opens showing the numbers from when it was closed is lying.
    this.msSinceUpdate = UPDATE_INTERVAL_MS;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Repaint, at most ten times a second and never while hidden.
   *
   * @param frameMs real time since the previous call, used only for throttling.
   * @param collect writes the rows. Called only on a frame that will draw them.
   */
  update(frameMs: number, collect: (rows: DebugRows) => void): void {
    if (!this.visible) return;

    this.msSinceUpdate += frameMs;
    if (this.msSinceUpdate < UPDATE_INTERVAL_MS) return;
    this.msSinceUpdate = 0;

    this.section = '';
    collect(this.writer);
  }

  destroy(): void {
    this.root.remove();
    this.rows.clear();
    this.sections.clear();
  }

  private setRow(label: string, value: string, tone: RowTone): void {
    // Keyed by section as well as label, so "mean" can appear under "tick"
    // and under "render" without the two fighting over one element.
    const key = `${this.section}\u0000${label}`;
    let row = this.rows.get(key);
    if (row === undefined) {
      row = this.addRow(label);
      this.rows.set(key, row);
    }
    // Assign only on change: the DOM is slower than the comparison.
    if (row.value.textContent !== value) row.value.textContent = value;
    if (row.tone !== tone) {
      if (row.tone !== null) row.value.classList.remove(TONE_CLASS[row.tone]);
      if (tone !== null) row.value.classList.add(TONE_CLASS[tone]);
      row.tone = tone;
    }
  }

  private addRow(label: string): Row {
    const row = document.createElement('div');
    row.className = 'debug-overlay__row';

    const key = document.createElement('span');
    key.className = 'debug-overlay__key';
    key.textContent = label;

    const value = document.createElement('span');
    value.className = 'debug-overlay__value';
    value.textContent = '—';

    row.append(key, value);
    this.root.append(row);
    return { value, tone: null };
  }
}
