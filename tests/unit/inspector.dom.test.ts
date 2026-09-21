import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { MACHINE_STATUS_COUNT, machineStatusName } from '../../src/game/entities/machine-status.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { Inspector } from '../../src/ui/inspector.js';
import { GameUI, LIVE_HZ } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The inspector panel. See ironflow.md C12 and §13.
 *
 * The acceptance criteria this file carries:
 *
 * - clicking an entity **opens the inspector within one frame** with correct
 *   data — here, the `selectionChanged` event rather than a pointer, because
 *   the pointer belongs to `input-manager.dom.test.ts`;
 * - a stalled machine always shows a **specific reason**, never a bare "idle";
 * - the panel updates at 10 Hz and **does not rebuild its DOM**, checked with
 *   a real `MutationObserver`, exactly as C07's panels are;
 * - it **cannot mutate simulation state except via commands**.
 *
 * jsdom, which is where every UI test belongs and where none of the
 * simulation's do (§17).
 */

const PATCH = Object.freeze({ x: 4, y: 4 });
const STANDING = Object.freeze({ x: 3, y: 3 });

function testWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        if (x < PATCH.x || x > PATCH.x + 1 || y < PATCH.y || y > PATCH.y + 1) continue;
        const index = localIndex(lx, ly);
        chunk.resource[index] = ResourceType.Iron;
        chunk.resourceAmount[index] = 1000;
      }
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
  readonly miner: MinerEntity;
}

let harness: Harness;

function mountUi(): Harness {
  const simulation = new Simulation({ world: testWorld() });
  simulation.player.setTilePosition(STANDING.x, STANDING.y);
  const miner = simulation.entities.create<MinerEntity>(newMiner(PATCH.x, PATCH.y, NORTH));

  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  const controller = new GameController({ game, cursor });

  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);

  const ui = new GameUI({ root, controller });
  ui.mount();
  return { root, ui, controller, simulation, cursor, miner };
}

/** One frame of a 60 Hz display, in ms. */
const FRAME_MS = 1000 / 60;

function runFrames(count: number): void {
  for (let i = 0; i < count; i++) harness.ui.update(FRAME_MS);
}

/** A tick and the frame that reports it, as the composition root pairs them. */
function runTicks(count: number): void {
  for (let i = 0; i < count; i++) {
    harness.simulation.tick();
    harness.controller.pump();
    harness.ui.update(FRAME_MS);
  }
}

function select(entityId: number | null): void {
  harness.cursor.setSelectedEntity(entityId);
  harness.controller.pump();
}

function query<T extends Element>(selector: string): T {
  const element = harness.root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

function text(selector: string): string {
  return query(selector).textContent ?? '';
}

function panel(): HTMLElement {
  return query<HTMLElement>('.if-inspector');
}

/** The panel's INPUT or OUTPUT section. */
function section(label: 'INPUT' | 'OUTPUT'): HTMLElement {
  for (const group of harness.root.querySelectorAll<HTMLElement>('.if-inspector__section')) {
    if (group.querySelector('.if-inspector__label')?.textContent === label) return group;
  }
  throw new Error(`missing section: ${label}`);
}

/**
 * The take button on the first visible output row.
 *
 * Found through the section rather than by `querySelector`, which would reach
 * the hidden input rows first — those are a pool waiting for C15 and carry no
 * item, so a test clicking one would pass while the player's click did nothing.
 */
function takeButton(): HTMLButtonElement {
  for (const row of section('OUTPUT').querySelectorAll<HTMLElement>('.if-stack')) {
    if (row.hidden) continue;
    const button = row.querySelector<HTMLButtonElement>('.if-stack__take');
    if (button !== null) return button;
  }
  throw new Error('no output row is visible');
}

/**
 * Run frames until the 10 Hz lane has fired, so the DOM has caught up with the
 * view model. Every assertion about *text* needs this; that the lane waits is
 * itself under test above.
 */
function settle(): void {
  runFrames(Math.ceil(1000 / LIVE_HZ / FRAME_MS) + 1);
}

/** Visible stack rows, as `name count` pairs. */
function stacks(section: 'INPUT' | 'OUTPUT'): string[] {
  const out: string[] = [];
  for (const group of harness.root.querySelectorAll('.if-inspector__section')) {
    if (group.querySelector('.if-inspector__label')?.textContent !== section) continue;
    if ((group as HTMLElement).hidden) return out;
    for (const row of group.querySelectorAll<HTMLElement>('.if-stack')) {
      if (row.hidden) continue;
      out.push(`${row.querySelector('.if-stack__name')?.textContent} ${row.querySelector('.if-stack__count')?.textContent}`);
    }
  }
  return out;
}

beforeEach(() => {
  harness = mountUi();
});

afterEach(() => {
  harness.ui.destroy();
  harness.root.remove();
});

describe('opening and closing', () => {
  it('starts closed, with its DOM already built', () => {
    expect(panel().hidden).toBe(true);
    // Built once at mount, not on the first selection (§13).
    expect(harness.root.querySelectorAll('.if-stack').length).toBeGreaterThan(0);
  });

  it('opens on the frame of the selection, with the machine\'s data', () => {
    runTicks(61);
    select(harness.miner.id);

    // No `ui.update()` between the selection and the assertion: the panel is
    // already correct, which is the "within one frame" criterion.
    expect(panel().hidden).toBe(false);
    expect(text('.if-inspector__title')).toBe('Miner');
    expect(stacks('OUTPUT')).toEqual(['Iron Ore 1/50']);
    expect(text('.if-inspector__where')).toContain(`${PATCH.x}, ${PATCH.y}`);
  });

  it('opens while the game is paused', () => {
    harness.controller.setPaused(true);
    select(harness.miner.id);

    // The 10 Hz lane is stopped at this moment. A panel that only repainted
    // from that lane would stay blank until the player un-paused, which is
    // exactly when they are least likely to be looking at the world.
    expect(panel().hidden).toBe(false);
    expect(text('.if-inspector__title')).toBe('Miner');
  });

  it('closes on its own button, and on a selection of nothing', () => {
    select(harness.miner.id);
    query<HTMLButtonElement>('.if-inspector__close').click();
    harness.controller.pump();
    expect(panel().hidden).toBe(true);

    select(harness.miner.id);
    expect(panel().hidden).toBe(false);
    select(null);
    expect(panel().hidden).toBe(true);
  });

  it('closes when the machine it is showing is demolished', () => {
    select(harness.miner.id);
    harness.simulation.entities.remove(harness.miner.id);
    runTicks(1);

    expect(panel().hidden).toBe(true);
    expect(harness.controller.getSelection()).toBeNull();
  });
});

describe('status', () => {
  it('has a sentence for every status a machine can be in', () => {
    select(harness.miner.id);

    for (let status = 0; status < MACHINE_STATUS_COUNT; status++) {
      harness.miner.status = status;
      harness.controller.pump();
      settle();

      const line = text('.if-inspector__status');
      expect(line.length).toBeGreaterThan(0);
      // The panel never shows the enum's own name; it shows a sentence.
      expect(line).not.toBe(machineStatusName(status));
      expect(line).not.toContain('undefined');
    }
  });

  it('names the reason a machine is stalled, never a bare "idle"', () => {
    select(harness.miner.id);
    // A 2x2 patch with a tick's worth of ore left in it, run dry.
    for (const tile of [0, 1]) {
      harness.simulation.world.consumeResource(PATCH.x + tile, PATCH.y, 1000);
      harness.simulation.world.consumeResource(PATCH.x + tile, PATCH.y + 1, 1000);
    }
    runTicks(2);
    settle();

    expect(harness.controller.getInspectorView()?.status).toBe('no_resource');
    expect(text('.if-inspector__status')).toContain('No ore left');
    expect(panel().querySelector('.if-inspector__status')?.getAttribute('data-tone')).toBe('danger');
  });

  it('shows nothing about power for a building that has none', () => {
    const chest = harness.simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    select(chest.id);
    expect(query<HTMLElement>('.if-inspector__power').hidden).toBe(true);
  });

  it('says what a machine draws and how its network is doing (C21)', () => {
    const furnace = harness.simulation.entities.create<MachineEntity>(
      newMachine(EntityType.ElectricFurnace, 0, 0, NORTH),
    );
    select(furnace.id);
    runTicks(1);
    settle();

    // No pole anywhere: the status says it is not running and this row says
    // why, which is the difference between a verdict and an explanation.
    expect(text('.if-inspector__status')).toContain('Not connected');
    expect(query<HTMLElement>('.if-inspector__power').hidden).toBe(false);
    expect(text('.if-inspector__power')).toContain('150 kW drawn');
    expect(text('.if-inspector__power')).toContain('no network');

    // A pole beside it, placed the way a player would (§7). The row changes
    // its mind rather than its shape.
    harness.simulation.inventory.add('power_pole', 1);
    harness.controller.dispatch({ type: 'build', buildingId: 'power_pole', x: 2, y: 0, rotation: NORTH });
    runTicks(1);
    settle();

    expect(text('.if-inspector__power')).toContain('network at 0%');
  });

  it('gives a chest no progress bar and no rate, rather than two zeroes', () => {
    const chest = harness.simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    select(chest.id);

    expect(query<HTMLElement>('.if-inspector__progress').hidden).toBe(true);
    expect(query<HTMLElement>('.if-inspector__rate').hidden).toBe(true);
    expect(stacks('OUTPUT')).toEqual([]);
    expect(text('.if-inspector__status')).toBe('Nothing to do');
  });
});

describe('the live lane', () => {
  it('follows the machine at 10 Hz and not every frame', () => {
    select(harness.miner.id);
    runTicks(30);

    const before = text('.if-inspector__percent');
    // One frame is well under the 100 ms the lane waits for.
    harness.simulation.tick();
    harness.controller.pump();
    harness.ui.update(FRAME_MS);
    expect(text('.if-inspector__percent')).toBe(before);

    runTicks(20);
    expect(text('.if-inspector__percent')).not.toBe(before);
  });

  it('shows the measured rate, not the nominal one', () => {
    select(harness.miner.id);
    runTicks(600);

    // §15's tier-1 miner is 0.5 items/s, which is 30 a minute.
    expect(text('.if-inspector__rate')).toContain('30.0 /min');
  });
});

describe('no rebuild, and no reach into the game', () => {
  it('adds and removes no elements while a machine runs', () => {
    select(harness.miner.id);
    runTicks(20);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(panel(), { childList: true, subtree: true, characterData: true, attributes: true });

    // Long enough for the buffer to fill a row, the bar to move many times and
    // the status to change from running to output_full and back.
    runTicks(400);

    records.push(...observer.takeRecords());
    observer.disconnect();

    let added = 0;
    let removed = 0;
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1) added += 1;
      for (const node of record.removedNodes) if (node.nodeType === 1) removed += 1;
    }
    expect(added).toBe(0);
    expect(removed).toBe(0);
    // It did repaint: text nodes and the bar's width changed.
    expect(records.length).toBeGreaterThan(0);
  });

  it('takes items by dispatching a command and nothing else', () => {
    select(harness.miner.id);
    runTicks(3 * 60);

    settle();
    const take = takeButton();
    expect(take.disabled).toBe(false);
    take.click();

    // The click queued a command; the miner still has its ore until a tick
    // judges it (§7, and C12's last acceptance criterion).
    expect(harness.miner.outputCount).toBe(3);
    expect(harness.simulation.commands.pending).toBe(1);

    runTicks(1);
    expect(harness.miner.outputCount).toBe(0);
    expect(harness.simulation.player.inventory.count(harness.simulation.items.idOf('iron_ore'))).toBe(3);
  });

  it('greys out a take the player has walked away from', () => {
    select(harness.miner.id);
    runTicks(60);
    settle();
    expect(takeButton().disabled).toBe(false);

    harness.simulation.player.setTilePosition(STANDING.x + 40, STANDING.y);
    runTicks(10);
    settle();
    // A pre-check only: §7 keeps the simulation the authority, and the button
    // is grey because the answer it would get is "walk closer".
    expect(takeButton().disabled).toBe(true);
  });

  it('hides the whole input section for a building that has no input buffer', () => {
    select(harness.miner.id);
    runTicks(60);

    // A miner has no way in, so the section is hidden whole — rows, buttons
    // and all. C20 made those buttons *exist* (an input row is takeable now,
    // which is C16's stranded-ingredients note), and a hidden section is still
    // the right answer for a building with nothing in the section.
    const inputs = section('INPUT');
    expect(inputs.hidden).toBe(true);
    expect(inputs.querySelectorAll('.if-stack__take').length).toBeGreaterThan(0);
  });

  it('lets the player take an ingredient back out of a machine (C20)', () => {
    // C16's note: ingredients left in a machine because the bag was full could
    // only be recovered by switching the recipe twice. An inserter still
    // cannot touch them — that rule lives in `items/item-port.ts` and is
    // tested there — but the hand can.
    const furnace = harness.simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Furnace, PATCH.x + 2, PATCH.y + 2, NORTH),
    );
    const ore = harness.simulation.items.idOf('iron_ore');
    furnace.input.push([ore, 10]);

    select(furnace.id);
    runTicks(1);
    settle();

    const inputs = section('INPUT');
    expect(inputs.hidden).toBe(false);
    const button = inputs.querySelector<HTMLButtonElement>('.if-stack__take');
    expect(button?.hidden).toBe(false);
    expect(button?.dataset['item']).toBe('iron_ore');
    expect(button?.disabled).toBe(false);

    button?.click();
    runTicks(1);
    expect(harness.simulation.commands.takeRejections()).toEqual([]);
    expect(harness.simulation.player.inventory.count(ore)).toBeGreaterThan(0);
  });
});

describe('the recipe picker (C16)', () => {
  /** An assembler clear of the miner, close enough for the player to reach. */
  function assembler(): MachineEntity {
    return harness.simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Assembler, PATCH.x + 2, PATCH.y + 2, NORTH),
    );
  }

  function buttons(): HTMLButtonElement[] {
    return [...harness.root.querySelectorAll<HTMLButtonElement>('.if-recipe')];
  }

  function picker(): HTMLElement {
    return query<HTMLElement>('.if-inspector__recipes');
  }

  it('offers every recipe the machine could run, and none for a machine that chooses', () => {
    select(assembler().id);

    expect(picker().hidden).toBe(false);
    // Every crafting recipe, C20's seven building ones included: with them the
    // assembler is the machine that makes the factory's own parts.
    expect(buttons().map((button) => button.dataset['recipe'])).toEqual([
      'make_gear',
      'make_wire',
      'make_circuit',
      'make_miner',
      'make_belt',
      'make_splitter',
      'make_inserter',
      'make_furnace',
      'make_assembler',
      'make_chest',
      // C21's three power buildings.
      'make_generator',
      'make_power_pole',
      'make_electric_furnace',
    ]);
    // The ingredients and the rate, which is what task 3 asks the grid to show.
    expect(buttons()[0]?.textContent).toContain('2 Iron Plate');
    expect(buttons()[0]?.textContent).toContain('30 /min');

    // A miner runs no recipes at all, and a furnace picks its own: neither
    // gets a grid of buttons that would not mean anything.
    select(harness.miner.id);
    expect(picker().hidden).toBe(true);
  });

  it('sets a recipe by dispatching a command and nothing else', () => {
    const machine = assembler();
    select(machine.id);
    settle();

    buttons()[1]?.click();
    // The click queued a command; the machine is unchanged until a tick
    // judges it (§7), exactly as the take button is.
    expect(machine.recipe).toBe(0);
    expect(harness.simulation.commands.pending).toBe(1);

    runTicks(1);
    settle();
    expect(harness.simulation.recipes.byId(machine.recipe).id).toBe('make_wire');
    expect(buttons()[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(buttons()[0]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('clears the recipe when the chosen one is clicked again', () => {
    const machine = assembler();
    select(machine.id);
    buttons()[0]?.click();
    runTicks(1);
    settle();

    buttons()[0]?.click();
    runTicks(1);
    settle();
    expect(machine.recipe).toBe(0);
    expect(buttons()[0]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('rebuilds no buttons while the machine runs', () => {
    const machine = assembler();
    machine.input.push([harness.simulation.items.idOf('iron_plate'), 60]);
    select(machine.id);
    buttons()[0]?.click();
    runTicks(2);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(picker(), { childList: true, subtree: true, characterData: true, attributes: true });

    runTicks(300);
    records.push(...observer.takeRecords());
    observer.disconnect();

    let touched = 0;
    for (const record of records) {
      touched += record.addedNodes.length + record.removedNodes.length;
    }
    // §13: the grid is built when the choices change, and the ten repaints a
    // second that follow move nothing.
    expect(touched).toBe(0);
  });

  it('shows what a furnace chose for itself, without offering a choice', () => {
    const furnace = harness.simulation.entities.create<MachineEntity>(
      newMachine(EntityType.Furnace, PATCH.x + 6, PATCH.y, NORTH),
    );
    furnace.input.push([harness.simulation.items.idOf('iron_ore'), 4]);
    furnace.fuel.push([harness.simulation.items.idOf('coal'), 1]);
    runTicks(2);
    select(furnace.id);
    settle();

    expect(picker().hidden).toBe(true);
    // It still says what it is making — the choice is simply not the
    // player's, so it is a line rather than a grid.
    expect(query<HTMLElement>('.if-inspector__making').hidden).toBe(false);
    expect(text('.if-inspector__making')).toContain('Iron Plate');
  });
});

describe('the row pool', () => {
  it('is built once and hidden rather than created per stack', () => {
    const inspector = new Inspector({ onTake: () => {}, onSetRecipe: () => {}, onClose: () => {} });
    const root = document.createElement('div');
    inspector.mount(root);

    // Two sections' worth, all of them present before anything is selected.
    expect(root.querySelectorAll('.if-stack').length).toBeGreaterThanOrEqual(2);
    for (const row of root.querySelectorAll<HTMLElement>('.if-stack')) expect(row.hidden).toBe(true);
    inspector.destroy();
  });
});
