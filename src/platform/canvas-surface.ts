/**
 * Owns canvas sizing so nothing else has to think about device pixel ratio.
 *
 * The canvas has two sizes: its CSS size in layout pixels, and its backing
 * store size in device pixels. Getting this wrong is what makes a canvas game
 * look soft on a retina display, so it is handled once, here, rather than being
 * rediscovered in C03.
 */
export interface SurfaceSize {
  /** Backing-store size in device pixels. */
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  /** Layout size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export class CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private size: SurfaceSize;
  private readonly observer: ResizeObserver;
  private readonly listeners = new Set<(size: SurfaceSize) => void>();

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) {
      throw new Error('IronFlow: could not acquire a 2D canvas context.');
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.size = { deviceWidth: 0, deviceHeight: 0, cssWidth: 0, cssHeight: 0, dpr: 1 };

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);

    // devicePixelRatio changes when a window moves between displays or the user
    // zooms; ResizeObserver alone does not fire for that.
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  getSize(): SurfaceSize {
    return this.size;
  }

  onResize(fn: (size: SurfaceSize) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.observer.disconnect();
    window.removeEventListener('resize', this.resize);
    this.listeners.clear();
  }

  private readonly resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const deviceWidth = Math.max(1, Math.round(cssWidth * dpr));
    const deviceHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (deviceWidth === this.size.deviceWidth && deviceHeight === this.size.deviceHeight) {
      return;
    }

    this.canvas.width = deviceWidth;
    this.canvas.height = deviceHeight;
    this.size = { deviceWidth, deviceHeight, cssWidth, cssHeight, dpr };

    // Draw in CSS pixels; the transform maps them to device pixels.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const fn of this.listeners) fn(this.size);
  };
}
