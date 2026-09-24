import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newBelt } from '../../src/game/entities/belt-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk, localIndex } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { initials } from '../../src/ui/item-icon.js';
import { Tooltip, TOOLTIP_ROWS, TOOLTIP_SECTIONS } from '../../src/ui/tooltip.js';
import { formatCount, formatDuration, hoverContent } from '../../src/ui/tooltip-content.js';
import { GameUI, LIVE_HZ } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * Item icons and tooltips. See ironflow.md C32.
 *
 * - every item in a panel is a **picture**, with its name kept for screen
 *   readers and said by the tooltip;
 * - a hand-craft and a machine recipe describe their **bill** on hover, and a
 *   short ingredient is marked;
 * - the **world readout** follows the pointer over the canvas and describes
 *   the ore or the building under it, and stays away while a building is
 *   held;
 * - the tooltip is **one box built once** (§13): showing it creates nothing.
 */

/** One iron tile at (2, 2) holding 750 units. */
function oreWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    if (cx === 0 && cy === 0) {
      chunk.resource[localIndex(2, 2)] = ResourceType.Iron;
      chunk.resourceAmount[localIndex(2, 2)] = 750;
    }
    return chunk;
  });
}

interface Harness {
  readonly root: HTMLElement;
  readonly ui: GameUI;
  readonly controller: GameController;
  readonly simulation: Simulation;
  readonly cursor: DetachedCursor;
  readonly canvas: HTMLCanvasElement;
}

let harness: Harness;

function mountUi(itemIcons?: (itemId: string) => string | null): Harness {
  const simulation = new Simulation({ world: oreWorld() });
  simulation.world.getTile(0, 0);
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  const controller = new GameController({ game, cursor });

  // The world's canvas sits outside the UI layer, as `#game` does.
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);

  const ui = new GameUI({ root, controller, ...(itemIcons === undefined ? {} : { itemIcons }) });
  ui.mount();
  return { root, ui, controller, simulation, cursor, canvas };
}

function tooltip(root: ParentNode): HTMLElement {
  const element = root.querySelector<HTMLElement>('.if-tooltip');
  if (element === null) throw new Error('no tooltip');
  return element;
}

/** The tooltip's visible rows, as "label value". */
function rows(root: ParentNode): string[] {
  return [...tooltip(root).querySelectorAll<HTMLElement>('.if-tooltip__row')]
    .filter((row) => !row.hidden && row.closest('[hidden]') === null)
    .map((row) =>
      `${row.querySelector('.if-tooltip__label')?.textContent ?? ''} ${row.querySelector('.if-tooltip__value')?.textContent ?? ''}`.trim(),
    );
}

function hover(element: Element): void {
  element.dispatchEvent(new Event('pointerenter'));
}

/** The pointer resting on the world canvas at a window point. */
function pointAtWorld(h: Harness, x = 100, y = 100): void {
  h.canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

function frames(ui: GameUI, count: number): void {
  for (let i = 0; i < count; i++) ui.update(1000 / 60);
}

function give(simulation: Simulation, itemId: string, count: number): void {
  simulation.player.inventory.add(simulation.items.idOf(itemId), count);
}

beforeEach(() => {
  harness = mountUi();
});

afterEach(() => {
  harness.ui.destroy();
  document.body.replaceChildren();
});

describe('items are pictures', () => {
  it('draws a bag stack as an icon and a count, with the name kept for screen readers', () => {
    give(harness.simulation, 'iron_plate', 12);
    harness.ui.toggleInventory();
    const cell = harness.root.querySelector<HTMLElement>('.if-bag-cell:not(.is-empty)');
    expect(cell?.querySelector('.if-item-icon')).not.toBeNull();
    expect(cell?.querySelector('.if-bag-cell__count')?.textContent).toBe('12');
    expect(cell?.querySelector('.if-bag-cell__name')?.classList.contains('if-sr-only')).toBe(true);
    expect(cell?.getAttribute('aria-label')).toBe('Iron Plate, 12');
    // No picture source here, so the icon is two letters.
    expect(cell?.querySelector('.if-item-icon__fallback')?.textContent).toBe('IP');
    expect(cell?.title).toBe('');
  });

  it('uses the picture it is given', () => {
    harness.ui.destroy();
    document.body.replaceChildren();
    harness = mountUi((itemId) => `data:image/png;base64,${itemId}`);
    give(harness.simulation, 'gear', 3);
    harness.ui.toggleInventory();
    const icon = harness.root.querySelector<HTMLElement>('.if-bag-cell:not(.is-empty) .if-item-icon');
    const image = icon?.querySelector<HTMLImageElement>('img');
    expect(image?.hidden).toBe(false);
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,gear');
    expect(image?.draggable).toBe(false);
    expect(icon?.querySelector<HTMLElement>('.if-item-icon__fallback')?.hidden).toBe(true);
  });

  it('names a stack in its tooltip', () => {
    give(harness.simulation, 'iron_plate', 12);
    harness.ui.toggleInventory();
    const cell = harness.root.querySelector<HTMLElement>('.if-bag-cell:not(.is-empty)');
    if (cell === null) throw new Error('no stack');
    hover(cell);
    expect(tooltip(harness.root).hidden).toBe(false);
    expect(tooltip(harness.root).querySelector('.if-tooltip__title')?.textContent).toBe('Iron Plate');
    expect(rows(harness.root)).toContain('Holding 12 / 100');
    cell.dispatchEvent(new Event('pointerleave'));
    expect(tooltip(harness.root).hidden).toBe(true);
  });

  it('has no tooltip on an empty slot', () => {
    harness.ui.toggleInventory();
    const cell = harness.root.querySelector<HTMLElement>('.if-bag-cell.is-empty');
    if (cell === null) throw new Error('no empty slot');
    hover(cell);
    expect(tooltip(harness.root).hidden).toBe(true);
  });

  it('hides when the panel under it closes, even while paused', () => {
    give(harness.simulation, 'iron_plate', 12);
    harness.ui.toggleInventory();
    const cell = harness.root.querySelector<HTMLElement>('.if-bag-cell:not(.is-empty)');
    if (cell === null) throw new Error('no stack');
    hover(cell);
    harness.controller.setPaused(true);
    harness.ui.toggleInventory();
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(true);
  });
});

describe('recipes describe their bill', () => {
  it('a hand-craft: each ingredient against the bag, the short one marked', () => {
    give(harness.simulation, 'iron_plate', 1);
    harness.ui.toggleInventory();
    const button = harness.root.querySelector<HTMLElement>('.if-craft[data-recipe="make_gear"]');
    if (button === null) throw new Error('no gear button');
    expect(button.querySelector('.if-item-icon')).not.toBeNull();
    hover(button);
    expect(tooltip(harness.root).querySelector('.if-tooltip__title')?.textContent).toBe('Gear');
    expect(rows(harness.root)).toContain('Iron Plate 1 / 2');
    const short = [...tooltip(harness.root).querySelectorAll<HTMLElement>('.if-tooltip__row')].find((row) =>
      row.textContent?.includes('Iron Plate'),
    );
    expect(short?.dataset['tone']).toBe('danger');
    expect(tooltip(harness.root).querySelector('.if-tooltip__hint')?.textContent).toContain('Missing');
  });

  it('keeps its count current while the pointer rests on it', () => {
    harness.ui.toggleInventory();
    const button = harness.root.querySelector<HTMLElement>('.if-craft[data-recipe="make_gear"]');
    if (button === null) throw new Error('no gear button');
    hover(button);
    expect(rows(harness.root)).toContain('Iron Plate 0 / 2');
    give(harness.simulation, 'iron_plate', 4);
    frames(harness.ui, 20);
    expect(rows(harness.root)).toContain('Iron Plate 4 / 2');
    expect(rows(harness.root)).toContain('You could make 2');
  });

  it('a machine recipe: ingredients, products, time and rate in that machine', () => {
    const { simulation, controller, cursor, root } = harness;
    simulation.player.setTilePosition(0, 0);
    const assembler = simulation.entities.create(newMachine(EntityType.Assembler, 1, 1, NORTH));
    cursor.setSelectedEntity(assembler.id);
    controller.pump();
    const button = root.querySelector<HTMLElement>('.if-recipe[data-recipe="make_gear"]');
    if (button === null) throw new Error('no recipe button');
    expect(button.querySelector('.if-item-icon')).not.toBeNull();
    hover(button);
    const text = rows(root);
    expect(text).toContain('Iron Plate × 2');
    expect(text).toContain('Gear × 1');
    expect(text.some((line) => line.startsWith('Time in this machine'))).toBe(true);
    expect(text.some((line) => line.startsWith('At full speed'))).toBe(true);
  });
});

describe('the world readout', () => {
  it('names the ore under the pointer and what is left of it', () => {
    harness.cursor.hover = { x: 2, y: 2 };
    pointAtWorld(harness);
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(false);
    expect(tooltip(harness.root).querySelector('.if-tooltip__title')?.textContent).toBe('Iron Ore');
    expect(rows(harness.root)).toContain('Left in this tile 750');
  });

  it('describes a belt by its speed', () => {
    const belt = harness.simulation.entities.create(newBelt(5, 5, NORTH));
    harness.cursor.hover = { x: 5, y: 5 };
    harness.cursor.hoverEntity = belt.id;
    pointAtWorld(harness);
    frames(harness.ui, 1);
    expect(tooltip(harness.root).querySelector('.if-tooltip__title')?.textContent).toBe('Transport Belt');
    expect(rows(harness.root)).toContain('Speed 2 tiles/s · 8 items/s');
  });

  it('changes at once when the pointer moves to something else', () => {
    harness.cursor.hover = { x: 2, y: 2 };
    pointAtWorld(harness);
    frames(harness.ui, 1);
    const belt = harness.simulation.entities.create(newBelt(5, 5, NORTH));
    harness.cursor.hover = { x: 5, y: 5 };
    harness.cursor.hoverEntity = belt.id;
    frames(harness.ui, 1);
    expect(tooltip(harness.root).querySelector('.if-tooltip__title')?.textContent).toBe('Transport Belt');
  });

  it('works while paused', () => {
    harness.controller.setPaused(true);
    harness.cursor.hover = { x: 2, y: 2 };
    pointAtWorld(harness);
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(false);
  });

  it('stays away over bare ground, over the UI, and while a building is held', () => {
    harness.cursor.hover = { x: 9, y: 9 };
    pointAtWorld(harness);
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(true);

    harness.cursor.hover = { x: 2, y: 2 };
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(false);

    harness.root.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 5, bubbles: true }));
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(true);

    pointAtWorld(harness);
    harness.cursor.setBuildTool({ buildingId: 'chest', rotationCount: 1, lineBuild: false });
    frames(harness.ui, 1);
    expect(tooltip(harness.root).hidden).toBe(true);
  });

  it('refreshes at the live rate under a resting pointer', () => {
    harness.cursor.hover = { x: 2, y: 2 };
    pointAtWorld(harness);
    frames(harness.ui, 1);
    harness.simulation.world.consumeResource(2, 2, 50);
    frames(harness.ui, Math.ceil(60 / LIVE_HZ) + 1);
    expect(rows(harness.root)).toContain('Left in this tile 700');
  });
});

describe('the box', () => {
  it('is built once: showing and repainting create nothing', () => {
    const box = new Tooltip();
    const parent = document.createElement('div');
    document.body.append(parent);
    box.mount(parent);
    expect(parent.querySelectorAll('.if-tooltip__section').length).toBe(TOOLTIP_SECTIONS);
    expect(parent.querySelectorAll('.if-tooltip__row').length).toBe(TOOLTIP_SECTIONS * TOOLTIP_ROWS);

    const added: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) added.push(...record.addedNodes);
    });
    observer.observe(parent, { childList: true, subtree: true });
    box.showAt(10, 10, { title: 'A', sections: [{ heading: 'X', rows: [{ label: 'one', value: '1' }] }] });
    box.showAt(20, 20, { title: 'B', sections: [], hint: 'h' });
    observer.disconnect();
    // Text changes replace text nodes; no element is created.
    expect(added.filter((node) => node.nodeType === Node.ELEMENT_NODE)).toEqual([]);
    box.destroy();
  });

  it('never lets the world displace an element tooltip', () => {
    const box = new Tooltip();
    const parent = document.createElement('div');
    document.body.append(parent);
    box.mount(parent);
    const anchor = document.createElement('button');
    parent.append(anchor);
    box.attach(anchor, () => ({ title: 'Element', sections: [] }));
    hover(anchor);
    box.showAt(5, 5, { title: 'World', sections: [] });
    expect(parent.querySelector('.if-tooltip__title')?.textContent).toBe('Element');
    box.detach(anchor);
    expect(box.isOpen).toBe(false);
    box.destroy();
  });
});

describe('the words', () => {
  it('groups counts with a thin space, the same in every locale', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(12345)).toBe('12 345');
    expect(formatCount(1234567)).toBe('1 234 567');
  });

  it('says how long ore lasts in the unit a player would', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3.5 * 3600)).toBe('3.5 h');
  });

  it('gives an icon two letters when there is no picture', () => {
    expect(initials('Iron Plate')).toBe('IP');
    expect(initials('Gear')).toBe('GE');
    expect(initials('Assembler Mk2')).toBe('AM');
  });

  it('gives bare ground no readout', () => {
    expect(hoverContent({ x: 0, y: 0, building: null, details: null, resource: null })).toBeNull();
  });
});
