import assert from 'node:assert/strict';
import {
  TraceMap,
  originalPositionFor,
  type DecodedSourceMap,
  type SourceMapSegment,
} from '@jridgewell/trace-mapping';

import remapping from '../../src/remapping';

// Scenario letters from range_mappings_composition.md, as concrete columns.
const C = 10;
const D = 100;
const E = 200;
const F = 300;
const G = 400;
const J = 500;
const K = 600;

/** A single-source decoded map; `ranges` holds each line's range segment indices. */
function map(
  source: string,
  mappings: SourceMapSegment[][],
  ranges: number[][] = mappings.map(() => []),
): DecodedSourceMap {
  return { version: 3, sources: [source], names: [], mappings, rangeMappings: ranges };
}

/** Remaps the layers (outermost first) and returns the decoded mappings and range indices. */
function remap(layers: DecodedSourceMap[]) {
  const out = remapping(layers, () => null, { decodedMappings: true });
  return { mappings: out.mappings, rangeMappings: out.rangeMappings };
}

/**
 * Checks that the remapped map resolves every position exactly like tracing it
 * through each layer with originalPositionFor.
 */
function assertComposes(layers: DecodedSourceMap[], lines = 10, width = 40) {
  const out = new TraceMap(remapping(layers, () => null, { decodedMappings: true }) as any);
  const tracers = layers.map((m) => new TraceMap(m));
  for (let line = 1; line <= lines; line++) {
    for (let column = 0; column < width; column++) {
      let expected = originalPositionFor(tracers[0], { line, column });
      for (let i = 1; i < tracers.length && expected.source != null; i++) {
        expected = originalPositionFor(tracers[i], expected as { line: number; column: number });
      }
      assert.deepEqual(originalPositionFor(out, { line, column }), expected, `${line}:${column}`);
    }
  }
}

describe('range mappings', () => {
  it('keeps the range mappings of a single map', () => {
    const only = map('a.js', [[[0, 0, 0, 0], [5, 0, 3, 0], [9]], [[2, 0, 4, 2]]], [[0], [0]]);
    assert.deepEqual(remap([only]), { mappings: only.mappings, rangeMappings: [[0], [0]] });
  });

  describe('composition scenarios (single line)', () => {
    it('scenario 2: a point inside a child range is offset', () => {
      const outer = map('mid.js', [[[C, 0, 0, D + 4]]]);
      const inner = map('app.ts', [[[D, 0, 0, E], [D + 8]]], [[0]]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[[C, 0, 0, E + 4]]],
        rangeMappings: undefined,
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('scenario 3: points inside an outer range become points', () => {
      const outer = map('mid.js', [[[C, 0, 0, D], [C + 5]]], [[0]]);
      const inner = map('app.ts', [
        [
          [D + 2, 0, 0, E],
          [D + 3, 0, 0, F],
          [D + 4, 0, 0, G],
        ],
      ]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[[C + 2, 0, 0, E], [C + 3, 0, 0, F], [C + 4, 0, 0, G], [C + 5]]],
        rangeMappings: undefined,
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('scenario 4A: overlapping ranges become their intersection', () => {
      const outer = map('mid.js', [[[C, 0, 0, D], [C + 8]]], [[0]]);
      const inner = map('app.ts', [[[D + 6, 0, 0, G], [D + 9]]], [[0]]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[[C + 6, 0, 0, G], [C + 8]]], // [C+6, C+8) -> [G, G+2)
        rangeMappings: [[0]],
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('scenario 4B: ranges inside a larger child range are kept', () => {
      const outer = map(
        'mid.js',
        [[[C + 1, 0, 0, D + 2], [C + 3], [C + 6, 0, 0, D + 13], [C + 9]]],
        [[0, 2]],
      );
      const inner = map('app.ts', [[[D, 0, 0, F], [D + 20]]], [[0]]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[[C + 1, 0, 0, F + 2], [C + 3], [C + 6, 0, 0, F + 13], [C + 9]]],
        rangeMappings: [[0, 2]],
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('a child mapping that started before the range applies at its start', () => {
      const outer = map('mid.js', [[[C, 0, 0, 20], [C + 20]]], [[0]]);
      const inner = map('app.ts', [
        [
          [15, 0, 4, 4],
          [25, 0, 5, 0],
        ],
      ]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[[C, 0, 4, 4], [C + 5, 0, 5, 0], [C + 20]]],
        rangeMappings: undefined,
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('nothing at the start of a range ends the previous mapping', () => {
      // The point at 0 goes to mid line 2; the range to mid line 1, where
      // nothing is mapped before D+2.
      const outer = map('mid.js', [[[0, 0, 1, 0], [C, 0, 0, D], [C + 8]]], [[1]]);
      const inner = map('app.ts', [[[D + 2, 0, 0, E]], [[0, 0, 0, 0]]]);
      assert.deepEqual(remap([outer, inner]), {
        // [C] stops the point at 0 from covering C and C+1.
        mappings: [[[0, 0, 0, 0], [C], [C + 2, 0, 0, E], [C + 8]]],
        rangeMappings: undefined,
      });
      assertComposes([outer, inner], 1, 2 * K);
    });

    it('scenario 5: three layers', () => {
      const top = map('mid.js', [[[C, 0, 0, D], [C + 8]]], [[0]]);
      // D+7 -> G points at a line where the bottom has nothing.
      const middle = map('low.js', [[[D + 2, 0, 0, F], [D + 4], [D + 7, 0, 1, G]]], [[0]]);
      const bottom = map('app.ts', [
        [
          [F, 0, 0, J],
          [F + 1, 0, 0, K],
        ],
      ]);
      assert.deepEqual(remap([top, middle, bottom]), {
        mappings: [[[C + 2, 0, 0, J], [C + 3, 0, 0, K], [C + 4]]], // C+2 -> J, C+3 -> K
        rangeMappings: undefined,
      });
      assertComposes([top, middle, bottom], 1, 2 * K);
    });
  });

  describe('multiline', () => {
    it('scenario 4A: a child range continuing over lines is truncated', () => {
      // Outer RANGE 1:0 -> mid 1:10, until 3:8 (mid 3:8).
      const outer = map('mid.js', [[[0, 0, 0, 10]], [], [[8]]], [[0], [], []]);
      // Inner RANGE mid 2:5 -> app 8:20, until mid 4:3.
      const inner = map('app.ts', [[], [[5, 0, 7, 20]], [], [[3]]], [[], [0], [], []]);
      assert.deepEqual(remap([outer, inner]), {
        mappings: [[], [[5, 0, 7, 20]], [[8]]],
        rangeMappings: [[], [0]],
      });
      assertComposes([outer, inner]);
    });

    it('scenario 5: a range split by the bottom layer across lines', () => {
      // Top RANGE 1:0 -> mid 1:0, until 3:10.
      const top = map('mid.js', [[[0, 0, 0, 0]], [], [[10]]], [[0], [], []]);
      // Middle RANGE 1:4 -> low 11:0, until 3:6.
      const middle = map('low.js', [[[4, 0, 10, 0]], [], [[6]]], [[0], [], []]);
      // Bottom: point low 12:2 -> J, and an open-ended RANGE low 13:0 -> app 30:50.
      const lines: SourceMapSegment[][] = Array.from({ length: 13 }, () => []);
      lines[11] = [[2, 0, 0, J]];
      lines[12] = [[0, 0, 29, 50]];
      const bottom = map(
        'app.ts',
        lines,
        lines.map((_, i) => (i === 12 ? [0] : [])),
      );
      assert.deepEqual(remap([top, middle, bottom]), {
        mappings: [[], [[2, 0, 0, J]], [[0, 0, 29, 50], [6]]],
        rangeMappings: [[], [], [0]],
      });
      assertComposes([top, middle, bottom]);
    });
  });

  describe('agrees with tracing each position through every layer', () => {
    // Seeded PRNG (mulberry32), so failures are reproducible.
    function random(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randomMap(rand: () => number, source: string): DecodedSourceMap {
      const int = (n: number) => Math.floor(rand() * n);
      const mappings: SourceMapSegment[][] = [];
      const ranges: number[][] = [];
      for (let i = 1 + int(8); i > 0; i--) {
        // Unique columns: duplicates make originalPositionFor itself
        // inconsistent between exact and inexact matches.
        const columns = [...new Set(Array.from({ length: int(4) }, () => int(30)))].sort(
          (a, b) => a - b,
        );
        const line: SourceMapSegment[] = [];
        const lineRanges: number[] = [];
        columns.forEach((column, j) => {
          if (rand() < 0.15) return line.push([column]);
          line.push([column, 0, int(10), int(30)]);
          if (rand() < 0.5) lineRanges.push(j);
        });
        mappings.push(line);
        ranges.push(lineRanges);
      }
      return map(source, mappings, ranges);
    }

    for (const depth of [2, 3]) {
      it(`with ${depth} layers`, () => {
        const rand = random(depth);
        for (let i = 0; i < 300; i++) {
          const layers = Array.from({ length: depth }, (_, j) => randomMap(rand, `${j}.js`));
          assertComposes(layers);
        }
      });
    }
  });
});
