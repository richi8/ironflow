import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The projection boundary. See ironflow.md §5 and §19 rule 11.
 *
 * §5 says `projection.ts` is the only file that converts between tile space and
 * screen space, and that "nothing else in the codebase may contain TILE_W,
 * `/ 2`-style projection math, or the words iso/diamond". This is the
 * grep-checkable form of the C01 acceptance criterion that says so.
 *
 * The failure it exists to catch is not malice, it is convenience: someone
 * three chunks from now writes `(x - y) * 32` inline in a draw call because
 * importing felt like ceremony, and then a change to TILE_W silently breaks
 * one layer and not the others.
 *
 * If a future chunk genuinely needs a tile dimension — a sprite atlas sizing
 * its cells, say — the right move is to import `TILE_W` and add that file to
 * ALLOWED below with a note. The point is that it becomes a decision.
 */

// Vitest runs from the project root; the "finds source files" test below fails
// loudly if that ever stops holding.
const REPO_ROOT = process.cwd();
const SRC_DIR = resolve(REPO_ROOT, 'src');

/** Files permitted to contain projection arithmetic. */
const ALLOWED = new Set([resolve(SRC_DIR, 'renderer/projection.ts')]);

const HALF_W = 32;
const HALF_H = 16;

const FORBIDDEN = [
  {
    pattern: /\bTILE_[WH]\b/,
    why: 'the tile dimensions belong to projection.ts — call tileToScreen/screenToTile instead',
  },
  {
    pattern: /\b(?:isometric|diamond)\b/i,
    why: '§5: isometry is a renderer detail and must not leak into names or logic',
  },
  {
    pattern: new RegExp(`\\(\\s*\\w+\\s*[-+]\\s*\\w+\\s*\\)\\s*\\*\\s*(?:${HALF_W}|${HALF_H})\\b`),
    why: '§5: that is tileToScreen written out by hand',
  },
  {
    pattern: new RegExp(`\\/\\s*(?:${HALF_W}|${HALF_H})\\b[^\\n]{0,40}\\/\\s*(?:${HALF_W}|${HALF_H})\\b`),
    why: '§5: that is screenToTile written out by hand',
  },
] as const;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Strip comments, so prose explaining the rule does not trip it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = listSourceFiles(SRC_DIR).filter((f) => !ALLOWED.has(f));

describe('projection lives in exactly one file', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('still finds the projection itself, so the exclusion is not a typo', () => {
    for (const allowed of ALLOWED) {
      const source = readFileSync(allowed, 'utf8');
      expect(source).toMatch(/\bTILE_W\b/);
    }
  });

  it.each(files.map((f) => [relative(REPO_ROOT, f), f] as const))(
    'contains no projection arithmetic: %s',
    (label, file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, why } of FORBIDDEN) {
        const match = pattern.exec(source);
        expect(match, `${label} contains "${match?.[0] ?? ''}" — ${why}`).toBeNull();
      }
    },
  );
});
