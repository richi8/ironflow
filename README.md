# IronFlow

A seeded, replayable 2D isometric factory-automation game for the browser.
Vite + pure TypeScript + Canvas 2D + IndexedDB. No engine, no UI framework.

The full plan lives in [`ironflow.md`](./ironflow.md). Read Part I before
writing any code — those are contracts, not suggestions.

**Status:** C00 complete. Next chunk: **C01 — Tile space, camera, isometric projection.**

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` over `src/` and over `tests/` |
| `npm run test` | Run the suite once |
| `npm run test:watch` | Run the suite in watch mode |
| `npm run lint` | ESLint, including the architecture and determinism rules |
| `npm run check` | typecheck + lint + test. **The gate for "done".** |

Press **F3** in the running app to toggle the debug overlay.

## Layout

```text
src/
  game/       simulation core — no DOM, no Canvas, no Vite, ever
  platform/   browser adapters behind interfaces the core defines
  debug/      developer overlay
  styles/     design tokens (§11) and layout
  main.ts     composition root: the only file that knows every layer
tests/
  unit/       *.test.ts run in Node; *.dom.test.ts run in jsdom
  fixtures/   shared test doubles
```

## The rules that are enforced, not just documented

**`src/game/**` may not touch the browser** (ironflow.md §4). No DOM, no Canvas,
no `requestAnimationFrame`, no imports from `renderer/`, `ui/`, `input/`,
`persistence/`, `debug/` or `platform/`. Depend on an injected interface and
wire it up in `main.ts` — `FrameScheduler` is the worked example.

**`src/game/**` may not use wall-clock time or `Math.random`** (§6 R1, R2). The
simulation must be reproducible from a seed and a command sequence. Randomness
comes from the seeded PRNG (arriving in C18); time comes from the tick counter.

Both are enforced twice over, by ESLint and by
`tests/unit/no-dom-in-game.dom.test.ts` — which runs under jsdom on purpose, so
that removing the DOM proves something. It is one of the four tests in §17 that
must never be deleted.

**Progress is counted in integer ticks, never accumulated floats** (§6 R3). This
already applies to `SimulationClock`, whose accumulator is exact integer
arithmetic.

## Adding a file to the simulation core

Ask the question from §4:

> Could this run in a Node process with `document` deleted?

If no, it does not belong in `src/game/`.
