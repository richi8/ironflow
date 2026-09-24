/**
 * What the tooltips say. See ironflow.md C32 and `tooltip.ts`.
 *
 * Each function turns a view model into a `TooltipContent`. They are plain
 * functions of their arguments, so a test can read a tooltip without a
 * pointer, and so the bag, a chest and the hotbar describe a stack in the
 * same words.
 *
 * The world readout follows the genre: the name, then the status in words,
 * then the numbers that belong to that kind of building. A belt says how fast
 * it runs, an inserter how often it swings, a miner how much ore is left
 * under it and how long that lasts, an assembler what it is making and from
 * what. Bare ore says how much is left in the tile.
 */

import type { MachineStack, MachineView } from '../game/views/building-view.js';
import type { HoverView } from '../game/views/hover-view.js';
import type { CraftOptionView } from '../game/views/inventory-view.js';
import type { RecipeView } from '../game/views/recipe-view.js';

import { STATUS_TEXT, STATUS_TONE, describePower } from './status-text.js';
import type { TooltipContent, TooltipRow, TooltipSection } from './tooltip.js';

/**
 * Ticks per simulated second.
 *
 * Written here rather than imported: §4 lets the UI reach the controller and
 * the view models, and `simulation-clock.ts` is neither. The views carry tick
 * counts because ticks are what the simulation is exact in (§6 R3); this is
 * the one division that turns them into the seconds a player reads.
 * `tests/unit/inventory-panel.dom.test.ts` asserts the two agree.
 */
export const TICKS_PER_SECOND = 30;

/** How many a shift-click queues. The genre's "a handful", written down once. */
export const BATCH_CRAFT = 5;

/** A stack in the bag, a chest or on the hotbar. */
export function stackContent(
  itemId: string,
  name: string,
  count: number,
  stackSize: number,
  hint: string | null,
): TooltipContent {
  return {
    title: name,
    itemId,
    sections: [{ heading: null, rows: [{ label: 'Holding', value: `${formatCount(count)} / ${formatCount(stackSize)}` }] }],
    hint,
  };
}

/** A building on the hotbar: what placing one costs, and whether it may be. */
export function buildingSlotContent(
  itemId: string,
  name: string,
  count: number,
  stackSize: number,
  lockedBy: string | null,
  hint: string,
): TooltipContent {
  const sections: TooltipSection[] = [
    { heading: null, rows: [{ label: 'In this slot', value: `${formatCount(count)} / ${formatCount(stackSize)}` }] },
  ];
  return {
    title: name,
    itemId,
    status: lockedBy === null ? null : { text: `Locked — research ${lockedBy}`, tone: 'danger' },
    sections,
    hint: count === 0 && lockedBy === null ? `None carried. Craft one in the inventory (I). ${hint}` : hint,
  };
}

/** A hand-craft button: the bill against the bag, the time, how many. */
export function craftContent(option: CraftOptionView): TooltipContent {
  const ingredients: TooltipRow[] = option.inputs.map((part) => ({
    itemId: part.itemId,
    label: part.name,
    value: `${formatCount(part.held)} / ${formatCount(part.count)}`,
    // Short but coverable is not a problem: a click makes it first.
    tone: part.held < part.count && !option.chained ? 'danger' : null,
  }));
  const facts: TooltipRow[] = [
    { label: 'Time by hand', value: formatSeconds(option.craftTicks) },
  ];
  // Only when parts are made under it: otherwise it is the line above again.
  if (option.rawCraftTicks > option.craftTicks) {
    facts.push({ label: 'Total from raw', value: formatSeconds(option.rawCraftTicks) });
  }
  facts.push({ label: 'You could make', value: formatCount(option.craftable) });
  return {
    title: option.yield === 1 ? option.name : `${option.yield} × ${option.name}`,
    itemId: option.productId,
    sections: [
      { heading: 'INGREDIENTS', rows: ingredients },
      { heading: null, rows: facts },
    ],
    hint:
      option.craftable === 0
        ? 'Missing ingredients — the red lines are short.'
        : option.chained
          ? `Click to craft one, shift-click for ${BATCH_CRAFT}. The missing parts are crafted first.`
          : `Click to craft one, shift-click for ${BATCH_CRAFT}.`,
  };
}

/** A recipe in a machine's picker: its bill and its pace in this machine. */
export function recipeContent(recipe: RecipeView): TooltipContent {
  return {
    title: recipe.name,
    itemId: recipe.outputs[0]?.itemId ?? null,
    status: recipe.selected ? { text: 'Selected — this machine is making it', tone: 'ok' } : null,
    sections: [
      { heading: 'INGREDIENTS', rows: recipe.inputs.map((part) => partRow(part.itemId, part.name, part.count)) },
      { heading: 'PRODUCTS', rows: recipe.outputs.map((part) => partRow(part.itemId, part.name, part.count)) },
      {
        heading: null,
        rows: [
          { label: 'Time in this machine', value: formatSeconds(recipe.craftTicks) },
          { label: 'At full speed', value: `${formatRate(recipe.ratePerMinute)} /min` },
        ],
      },
    ],
    hint: recipe.selected ? 'Click to stop making it — the ingredients come back.' : 'Click to make this.',
  };
}

/** The world readout: the building under the pointer, or the ore. */
export function hoverContent(view: HoverView): TooltipContent | null {
  const building = view.building;
  if (building === null) {
    const resource = view.resource;
    if (resource === null) return null;
    return {
      title: resource.name,
      itemId: resource.itemId,
      sections: [{ heading: null, rows: [{ label: 'Left in this tile', value: formatCount(resource.amount) }] }],
      hint: 'Hold right-click to mine it by hand.',
    };
  }

  const facts: TooltipRow[] = [];
  const details = view.details;
  if (details !== null) {
    if (details.beltTilesPerSecond !== null && details.beltItemsPerSecond !== null) {
      facts.push({
        label: 'Speed',
        value: `${formatRate(details.beltTilesPerSecond)} tiles/s · ${formatRate(details.beltItemsPerSecond)} items/s`,
      });
    }
    if (details.inserterItemsPerSecond !== null) {
      facts.push({ label: 'Speed', value: `${formatRate(details.inserterItemsPerSecond)} items/s` });
    }
    if (details.miningItemsPerSecond !== null) {
      facts.push({ label: 'Mining speed', value: `${formatRate(details.miningItemsPerSecond)} items/s` });
    }
    const ore = details.oreUnder;
    if (ore !== null) {
      facts.push({ itemId: ore.itemId, label: `${ore.name} left`, value: formatCount(ore.remaining) });
      facts.push({ label: 'Tiles with ore', value: String(ore.tiles) });
      if (details.miningItemsPerSecond !== null && ore.remaining > 0) {
        facts.push({ label: 'Lasts at full speed', value: formatDuration(ore.remaining / details.miningItemsPerSecond) });
      }
    }
    if (details.craftingSpeed !== null) {
      facts.push({ label: 'Crafting speed', value: `×${formatRate(details.craftingSpeed)}` });
    }
  }
  // Only once something is under way: an inserter waiting at 0% says it
  // twice, and its status already says why.
  if (building.progress !== null && building.progress > 0) {
    facts.push({ label: 'Progress', value: `${Math.round(clamp01(building.progress) * 100)}%` });
  }
  if (building.power !== null) facts.push({ label: 'Power', value: describePower(building.power) });
  if (building.nextOutput !== null) {
    facts.push({ label: 'Next item to', value: `${building.nextOutput.x}, ${building.nextOutput.y}` });
  }
  // Ore under something that does not mine it: a belt laid across a patch.
  if (view.resource !== null && details?.oreUnder == null) {
    facts.push({ itemId: view.resource.itemId, label: `${view.resource.name} in this tile`, value: formatCount(view.resource.amount) });
  }

  const sections: TooltipSection[] = [{ heading: null, rows: facts }];
  const recipe = building.recipe;
  if (recipe !== null) {
    sections.push({
      heading: `RECIPE — ${formatSeconds(recipe.craftTicks)}`,
      rows: [
        ...recipe.inputs.map((part) => partRow(part.itemId, part.name, part.count)),
        ...recipe.outputs.map((part) => ({ ...partRow(part.itemId, part.name, part.count), label: `→ ${part.name}` })),
      ],
    });
  }
  const contents = contentsOf(building);
  if (contents.length > 0) sections.push({ heading: 'CONTENTS', rows: contents });

  return {
    title: building.name,
    itemId: building.buildingId,
    status: hasStatus(building) ? { text: STATUS_TEXT[building.status], tone: STATUS_TONE[building.status] } : null,
    sections,
    hint: 'Click to open it. Right-click to take it down.',
  };
}

/**
 * A status line only for a building that can be stalled. A belt, a pole or
 * a chest is idle by nature, and "Nothing to do" under every one is noise.
 */
function hasStatus(building: MachineView): boolean {
  return (
    building.status !== 'idle' ||
    building.progress !== null ||
    building.recipe !== null ||
    building.recipes !== null
  );
}

/** Everything in a building, one row per item, a chest's grid summed. */
function contentsOf(building: MachineView): TooltipRow[] {
  const totals = new Map<string, { name: string; count: number }>();
  const add = (itemId: string, name: string, count: number): void => {
    if (count <= 0) return;
    const line = totals.get(itemId);
    if (line === undefined) totals.set(itemId, { name, count });
    else line.count += count;
  };
  const stacks: readonly MachineStack[] = [...building.inputs, ...building.outputs];
  for (const stack of stacks) add(stack.itemId, stack.name, stack.count);
  for (const cell of building.storage ?? []) if (cell.itemId !== null) add(cell.itemId, cell.name, cell.count);
  return [...totals].map(([itemId, line]) => ({ itemId, label: line.name, value: formatCount(line.count) }));
}

function partRow(itemId: string, name: string, count: number): TooltipRow {
  return { itemId, label: name, value: `× ${count}` };
}

/** Whole numbers with thin grouping: 12 345. Not locale formatting, so a test reads the same everywhere. */
export function formatCount(value: number): string {
  const whole = Math.round(value);
  const sign = whole < 0 ? '-' : '';
  return sign + String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** A rate or a multiplier: at most two decimals, trailing zeros dropped. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Math.round(value * 100) / 100);
}

/** A tick count as seconds: "0.5 s". */
export function formatSeconds(ticks: number): string {
  return `${formatRate(ticks / TICKS_PER_SECOND)} s`;
}

/** A length of time for a player: "45 s", "12 min", "3.5 h". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${formatRate(Math.round((minutes / 60) * 10) / 10)} h`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}
