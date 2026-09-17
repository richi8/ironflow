/**
 * Render a seed's world as a PNG, so seeds can be eyeballed. C19 task 7.
 *
 * ```sh
 * npm run minimap                       # the default seed, 64x64 world chunks
 * npm run minimap -- --seed=1234
 * npm run minimap -- --seed=1 --count=20 --chunks=24   # a contact sheet
 * npm run minimap -- --seed=7 --chunks=8 --scale=4     # the starting area, close up
 * ```
 *
 * Why a tool rather than a test: C19's third acceptance criterion is "20 seeds
 * inspected by eye produce visibly different resource layouts", and no
 * assertion can stand in for that. A test can say two maps differ; only a
 * person can say they differ in a way that would make someone build a
 * different factory. The tool also prints the terrain histogram and the
 * starting-area report, which is what the balance numbers in
 * `world-generator.ts` are actually tuned against.
 *
 * It lives outside `src/` because it is not part of the game, and it reads
 * `renderer/palette.ts` directly because a minimap that did not use the §11
 * terrain colours would be a second opinion about what the world looks like.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CHUNK_SIZE } from '../src/game/world/chunk.js';
import { NOMINAL_RESOURCE_AMOUNT, ResourceType, resourceName } from '../src/game/world/resource.js';
import { TileType, tileProperties } from '../src/game/world/tile.js';
import { START_RADIUS, WORLD_SPAWN, inspectStartingArea } from '../src/game/world/starting-area.js';
import { createWorldGenerator, GENERATOR_VERSION } from '../src/game/world/world-generator.js';
import { World } from '../src/game/world/world.js';
import { PALETTE } from '../src/renderer/palette.js';
import { encodePng } from './png.js';

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function blend(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/** §11's terrain colours, indexed by `TileType`. */
const TERRAIN_COLORS: readonly Rgb[] = [
  parseHex(PALETTE['terrain-grass']),
  parseHex(PALETTE['terrain-dirt']),
  parseHex(PALETTE['terrain-sand']),
  parseHex(PALETTE['terrain-stone']),
  parseHex(PALETTE['terrain-water']),
];

/** §11's resource colours, indexed by `ResourceType`. Index 0 is unused. */
const RESOURCE_COLORS: readonly (Rgb | null)[] = [
  null,
  parseHex(PALETTE.iron),
  parseHex(PALETTE.copper),
  parseHex(PALETTE.coal),
  parseHex(PALETTE.stone),
];

const SPAWN_COLOR: Rgb = parseHex(PALETTE.accent);

interface Options {
  readonly seed: number;
  readonly count: number;
  readonly chunks: number;
  readonly scale: number;
  readonly outDir: string;
  readonly validate: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) throw new Error(`minimap: unrecognised argument "${arg}".`);
    flags.set(match[1] ?? '', match[2] ?? 'true');
  }

  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`minimap: --${name} must be a number, got "${raw}".`);
    return value;
  };

  return {
    seed: number('seed', 0x1f0f10),
    count: Math.max(1, Math.trunc(number('count', 1))),
    chunks: Math.max(1, Math.trunc(number('chunks', 64))),
    scale: Math.max(1, Math.trunc(number('scale', 1))),
    outDir: flags.get('out-dir') ?? 'dist/minimap',
    validate: flags.get('validate') !== 'false',
  };
}

interface Rendered {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly terrain: Readonly<Record<string, number>>;
  readonly ore: Readonly<Record<string, number>>;
  readonly milliseconds: number;
}

/**
 * Draw `chunks × chunks` world chunks centred on the origin.
 *
 * The generator is called directly rather than through a `World`, because a
 * 64×64-chunk overview is four thousand world chunks and there is no reason to
 * keep any of them after their pixels are written. That also makes the timing
 * printed below the honest answer to C19's "< 500 ms for 40×40 world chunks",
 * with no map bookkeeping mixed in.
 */
function render(seed: number, chunks: number, scale: number): Rendered {
  const generate = createWorldGenerator(seed);
  const tiles = chunks * CHUNK_SIZE;
  const width = tiles * scale;
  const pixels = new Uint8Array(width * width * 3);

  const terrain: Record<string, number> = {};
  const ore: Record<string, number> = {};
  const first = 0 - Math.floor(chunks / 2);

  const started = process.hrtime.bigint();

  for (let cy = first; cy < first + chunks; cy++) {
    for (let cx = first; cx < first + chunks; cx++) {
      const chunk = generate(cx, cy);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const index = ly * CHUNK_SIZE + lx;
          const type = (chunk.terrain[index] ?? TileType.Grass) as TileType;
          const resource = (chunk.resource[index] ?? ResourceType.None) as ResourceType;
          const amount = chunk.resourceAmount[index] ?? 0;

          terrain[tileProperties(type).name] = (terrain[tileProperties(type).name] ?? 0) + 1;
          if (resource !== ResourceType.None) {
            ore[resourceName(resource)] = (ore[resourceName(resource)] ?? 0) + 1;
          }

          const px = ((cx - first) * CHUNK_SIZE + lx) * scale;
          const py = ((cy - first) * CHUNK_SIZE + ly) * scale;
          fill(pixels, width, px, py, scale, tileColor(type, resource, amount));
        }
      }
    }
  }

  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;

  drawSpawn(pixels, width, first, scale);

  return { seed, width, height: width, pixels, terrain, ore, milliseconds };
}

function tileColor(type: TileType, resource: ResourceType, amount: number): Rgb {
  const base = TERRAIN_COLORS[type] ?? TERRAIN_COLORS[0];
  if (base === undefined) throw new Error(`minimap: no colour for terrain ${type}.`);
  if (resource === ResourceType.None) return base;

  const ink = RESOURCE_COLORS[resource];
  if (ink == null) return base;
  // Ore reads as ore at any zoom, but a rich tile still reads richer than a
  // rim tile — the same two cues the terrain layer uses (C09).
  const fullness = Math.min(1, amount / NOMINAL_RESOURCE_AMOUNT);
  return blend(base, ink, 0.55 + 0.45 * fullness);
}

function fill(pixels: Uint8Array, width: number, px: number, py: number, scale: number, color: Rgb): void {
  for (let dy = 0; dy < scale; dy++) {
    let offset = ((py + dy) * width + px) * 3;
    for (let dx = 0; dx < scale; dx++) {
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
      offset += 3;
    }
  }
}

/** Mark spawn and ring the disc the starting-area guarantees are measured over. */
function drawSpawn(pixels: Uint8Array, width: number, firstChunk: number, scale: number): void {
  const originTile = 0 - firstChunk * CHUNK_SIZE;
  const toPixel = (tile: number): number => (originTile + tile) * scale;

  // The ring is walked as a box of tiles and filtered by distance, not by
  // trigonometry. `Math.cos` is banned anywhere near the generator (see
  // `noise.ts`) and the habit is easier to keep than to remember to break.
  const outer = START_RADIUS + 1;
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const distance = Math.sqrt(dx * dx + dy * dy);
      const onRing = distance > START_RADIUS - 0.5 && distance < START_RADIUS + 0.5;
      const onSpawn = Math.abs(dx) <= 2 && Math.abs(dy) <= 2;
      if (!onRing && !onSpawn) continue;
      plot(pixels, width, toPixel(WORLD_SPAWN.x + dx), toPixel(WORLD_SPAWN.y + dy), scale);
    }
  }
}

function plot(pixels: Uint8Array, width: number, px: number, py: number, scale: number): void {
  if (px < 0 || py < 0 || px >= width || py >= width) return;
  fill(pixels, width, px, py, Math.min(scale, width - Math.max(px, py)), SPAWN_COLOR);
}

/** Lay several maps out in as square a grid as their count allows. */
function contactSheet(maps: readonly Rendered[], gap: number): { width: number; pixels: Uint8Array } {
  const first = maps[0];
  if (first === undefined) throw new Error('minimap: nothing to compose.');

  const columns = Math.ceil(Math.sqrt(maps.length));
  const rows = Math.ceil(maps.length / columns);
  const cell = first.width + gap;
  const width = columns * cell + gap;
  const height = rows * cell + gap;
  const pixels = new Uint8Array(width * height * 3);

  const background = parseHex(PALETTE['bg-deep']);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = background.r;
    pixels[i * 3 + 1] = background.g;
    pixels[i * 3 + 2] = background.b;
  }

  maps.forEach((map, index) => {
    const ox = (index % columns) * cell + gap;
    const oy = Math.floor(index / columns) * cell + gap;
    for (let y = 0; y < map.height; y++) {
      const from = y * map.width * 3;
      const to = ((oy + y) * width + ox) * 3;
      pixels.set(map.pixels.subarray(from, from + map.width * 3), to);
    }
  });

  return { width, pixels: pixels.subarray(0, width * height * 3) };
}

function percent(counts: Readonly<Record<string, number>>): string {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total === 0) return '—';
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${((n / total) * 100).toFixed(1)}%`)
    .join('  ');
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const maps: Rendered[] = [];

  console.log(`generator v${GENERATOR_VERSION}, ${options.chunks}x${options.chunks} world chunks per map\n`);

  for (let i = 0; i < options.count; i++) {
    const seed = (options.seed + i) >>> 0;
    const map = render(seed, options.chunks, options.scale);
    maps.push(map);

    const tiles = options.chunks * options.chunks * CHUNK_SIZE * CHUNK_SIZE;
    const oreTiles = Object.values(map.ore).reduce((sum, n) => sum + n, 0);
    console.log(`seed ${seed}  ${map.milliseconds.toFixed(0)} ms`);
    console.log(`  terrain  ${percent(map.terrain)}`);
    console.log(`  ore      ${((oreTiles / tiles) * 100).toFixed(2)}% of tiles — ${percent(map.ore)}`);

    if (options.validate) {
      const report = inspectStartingArea(new World(createWorldGenerator(seed)));
      const patches = Object.entries(report.largestPatch)
        .map(([name, n]) => `${name} ${n}`)
        .join('  ');
      console.log(
        `  start    ${report.ok ? 'PASS' : `FAIL (${report.failures.join('; ')})`} — ` +
          `${report.buildableTiles} buildable, patches ${patches}`,
      );
    }
    console.log('');
  }

  const outDir = resolve(process.cwd(), options.outDir);
  if (maps.length === 1) {
    const map = maps[0];
    if (map === undefined) throw new Error('minimap: nothing rendered.');
    const file = resolve(outDir, `minimap-${map.seed}.png`);
    writeFileSync(file, encodePng(map.width, map.height, map.pixels));
    console.log(`wrote ${file}`);
    return;
  }

  const gap = Math.max(4, Math.floor((maps[0]?.width ?? 0) / 48));
  const sheet = contactSheet(maps, gap);
  const height = sheet.pixels.length / sheet.width / 3;
  const file = resolve(outDir, `minimap-sheet-${options.seed}-x${maps.length}.png`);
  writeFileSync(file, encodePng(sheet.width, height, sheet.pixels));
  console.log(`wrote ${file}`);
}

main();
