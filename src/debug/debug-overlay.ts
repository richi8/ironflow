import type { LoopStats } from '../game/game-loop.js';

/**
 * The F3 developer readout. See ironflow.md C00 task 10 and §12.
 *
 * C28 grows this into the full per-phase profiler. For now it shows the loop
 * numbers, which are the ones that prove the fixed timestep works.
 *
 * It builds its DOM once and updates by assignment (§13). It is throttled
 * because a readout that re-renders every frame is itself a measurable cost.
 */
const UPDATE_INTERVAL_MS = 100;

interface Row {
  readonly label: string;
  readonly value: HTMLElement;
}

export class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private visible = true;
  private msSinceUpdate = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'debug-overlay';

    const title = document.createElement('div');
    title.className = 'debug-overlay__title';
    title.textContent = 'IRONFLOW — F3';
    this.root.append(title);

    for (const label of ['fps', 'frame', 'sim', 'render', 'tick', 'steps', 'alpha', 'shed', 'size']) {
      this.addRow(label);
    }

    parent.append(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.hidden = !this.visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * @param frameMs real time since the previous call, used only for throttling.
   */
  update(stats: LoopStats, tick: number, sizeLabel: string, frameMs: number): void {
    if (!this.visible) return;

    this.msSinceUpdate += frameMs;
    if (this.msSinceUpdate < UPDATE_INTERVAL_MS) return;
    this.msSinceUpdate = 0;

    this.setRow('fps', stats.fps.toFixed(1));
    this.setRow('frame', `${stats.frameMs.toFixed(2)} ms`);
    this.setRow('sim', `${stats.simMs.toFixed(2)} ms`);
    this.setRow('render', `${stats.renderMs.toFixed(2)} ms`);
    this.setRow('tick', String(tick));
    this.setRow('steps', String(stats.steps));
    this.setRow('alpha', stats.alpha.toFixed(3));
    this.setRow('shed', String(stats.shedCount));
    this.setRow('size', sizeLabel);
  }

  destroy(): void {
    this.root.remove();
    this.rows.clear();
  }

  private addRow(label: string): void {
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
    this.rows.set(label, { label, value });
  }

  private setRow(label: string, value: string): void {
    const row = this.rows.get(label);
    if (row === undefined) return;
    // Assign only on change: the DOM is slower than the comparison.
    if (row.value.textContent !== value) row.value.textContent = value;
  }
}
