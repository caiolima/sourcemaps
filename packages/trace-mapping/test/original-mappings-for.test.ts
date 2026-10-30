import assert from 'node:assert/strict';

import {
  TraceMap,
  originalPositionFor,
  originalMappingsFor,
  type DecodedSourceMap,
  type RangeNeedle,
  type SourceMapSegment,
} from '../src/trace-mapping';

// All positions here are 0-based, like originalMappingsFor's.
type Pos = { line: number; column: number };
type Piece = ReturnType<typeof originalMappingsFor>[number];

// Scenario letters from range_mappings_composition.md, as concrete columns.
const C = 10;
const D = 100;
const E = 200;
const F = 300;
const G = 400;
const J = 500;
const K = 600;

function map(segments: SourceMapSegment[][], ranges: number[][]): TraceMap {
  return new TraceMap({
    version: 3,
    sources: ['a.js'],
    names: [],
    mappings: segments,
    rangeMappings: ranges,
  } satisfies DecodedSourceMap);
}

const pos = (line: number, column: number): Pos => ({ line, column });
const span = (start: Pos, end: Pos): RangeNeedle => ({ start, end });

/**
 * Moves `p` from the space that starts at `from` into the space that starts at
 * `to`, with the same rules as a range mapping: columns shift on the first
 * line, and are kept as-is on the following lines.
 */
function project(from: Pos, to: Pos, p: Pos): Pos {
  const lineDelta = p.line - from.line;
  return pos(
    to.line + lineDelta,
    lineDelta === 0 ? to.column + (p.column - from.column) : p.column,
  );
}

function startOf(piece: Piece): Pos {
  return piece.type === 'point' ? piece.generated : piece.generated.start;
}

function samePos(a: Pos, b: Pos) {
  return a.line === b.line && a.column === b.column;
}

/** A sourceless mapping: a point to no source. */
function nullPoint(generated: Pos): Piece {
  return {
    type: 'point',
    generated,
    sourcesIndex: null,
    source: null,
    line: null,
    column: null,
    name: null,
  };
}

/**
 * Traces a needle through several maps (outermost first) using only
 * originalMappingsFor. Each result is traced into the next map with its
 * generated position as the needle's `generated` start, so everything comes
 * back in the outermost map's generated code.
 */
function chain(layers: TraceMap[], needle: RangeNeedle): Piece[] {
  const [layer, ...rest] = layers;
  const pieces = originalMappingsFor(layer, needle);
  if (rest.length === 0) return pieces;
  return pieces.flatMap((p): Piece[] => {
    if (p.type === 'point') {
      if (p.line === null) return [p];
      // Scenario 1/2: a point stays a point, whatever the child has there. If
      // nothing covers it in the child, it maps to no source.
      const at = pos(p.line, p.column);
      const [q] = chain(rest, { start: at, end: at, generated: { start: p.generated } });
      return [q ?? nullPoint(p.generated)];
    }
    // A range result is itself the needle for the next map.
    const inner = chain(rest, p);
    // If nothing covers the range's start in the child, it maps to no source.
    if (inner.length === 0 || !samePos(startOf(inner[0]), p.generated.start)) {
      inner.unshift(nullPoint(p.generated.start));
    }
    return inner;
  });
}

/** originalPositionFor, with 0-based lines in and out. */
function lookup(map: TraceMap, p: Pos) {
  const result = originalPositionFor(map, { line: p.line + 1, column: p.column });
  return result.line === null ? result : { ...result, line: result.line - 1 };
}

/** Composes originalPositionFor through every layer, one position at a time. */
function pointwise(layers: TraceMap[], p: Pos) {
  let result = lookup(layers[0], p);
  for (let i = 1; i < layers.length && result.line !== null; i++) {
    result = lookup(layers[i], { line: result.line, column: result.column! });
  }
  return result;
}

/** Every generated position in the needle, up to `width` columns on lines it fully covers. */
function* positions({ start, end }: RangeNeedle, width = 40): Generator<Pos> {
  for (let line = start.line; line <= end.line; line++) {
    const from = line === start.line ? start.column : 0;
    const to = line === end.line ? end.column : width;
    for (let column = from; column < to; column++) yield pos(line, column);
  }
}

function before(a: Pos, b: Pos) {
  return a.line < b.line || (a.line === b.line && a.column < b.column);
}

/**
 * Checks the pieces against a position-by-position lookup:
 * - pieces are ordered, inside the needle, and ranges don't overlap what follows;
 * - every position resolves as the last piece starting at or before it says:
 *   the linear projection of a range covering it, or a point on its line
 *   (possibly a sourceless one), and otherwise to nothing.
 */
function assertAgrees(pieces: Piece[], needle: RangeNeedle, lookup: (p: Pos) => any) {
  let prevEnd = needle.start;
  for (const piece of pieces) {
    assert.ok(!before(startOf(piece), prevEnd), 'pieces are ordered and do not overlap');
    prevEnd = piece.type === 'range' ? piece.generated.end : startOf(piece);
  }
  assert.ok(!before(needle.end, prevEnd), 'pieces end inside the needle');

  for (const p of positions(needle)) {
    const actual = lookup(p);
    let last: Piece | undefined;
    for (const piece of pieces) if (!before(p, startOf(piece))) last = piece;
    const at = `${p.line}:${p.column}`;

    let expected: object = { source: null, line: null, column: null, name: null };
    if (last?.type === 'range' && before(p, last.generated.end)) {
      const o = project(last.generated.start, last.start, p);
      expected = { source: last.source, line: o.line, column: o.column, name: last.name };
    } else if (last?.type === 'point' && last.generated.line === p.line) {
      const { source, line, column, name } = last;
      expected = { source, line, column, name };
    }
    assert.deepEqual(actual, expected, at);
  }
}

/** Compact form for asserting: [type, generated, original]. */
function summary(pieces: Piece[]) {
  const fmt = (p: Pos) => `${p.line}:${p.column}`;
  return pieces.map((p) =>
    p.type === 'point'
      ? [p.type, fmt(p.generated), p.line === null ? 'null' : fmt(p)]
      : [
          p.type,
          `${fmt(p.generated.start)}-${fmt(p.generated.end)}`,
          `${fmt(p.start)}-${fmt(p.end)}`,
        ],
  );
}

describe('originalMappingsFor', () => {
  describe('composition scenarios (single line)', () => {
    it('scenario 2: zero-width needle inside a child range resolves to a point', () => {
      const child = map([[[D, 0, 0, E], [D + 8]]], [[0]]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D + 4), pos(0, D + 4)))), [
        ['point', `0:${D + 4}`, `0:${E + 4}`],
      ]);
    });

    it('scenario 3: point mappings inside the needle are reported as points', () => {
      const child = map(
        [
          [
            [D + 2, 0, 0, E],
            [D + 3, 0, 0, F],
            [D + 4, 0, 0, G],
          ],
        ],
        [[]],
      );
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D), pos(0, D + 5)))), [
        ['point', `0:${D + 2}`, `0:${E}`],
        ['point', `0:${D + 3}`, `0:${F}`],
        ['point', `0:${D + 4}`, `0:${G}`],
      ]);
    });

    it('scenario 4A: a child range is intersected (truncated) with the needle', () => {
      const child = map([[[D + 6, 0, 0, G], [D + 9]]], [[0]]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D), pos(0, D + 8)))), [
        ['range', `0:${D + 6}-0:${D + 8}`, `0:${G}-0:${G + 2}`],
      ]);
    });

    it('scenario 4B: a needle inside a larger child range keeps its width', () => {
      const child = map([[[D, 0, 0, F], [D + 20]]], [[0]]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D + 2), pos(0, D + 4)))), [
        ['range', `0:${D + 2}-0:${D + 4}`, `0:${F + 2}-0:${F + 4}`],
      ]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D + 13), pos(0, D + 16)))), [
        ['range', `0:${D + 13}-0:${D + 16}`, `0:${F + 13}-0:${F + 16}`],
      ]);
    });

    it('a point mapping started before the needle is reported at its start', () => {
      const child = map(
        [
          [
            [D - 5, 0, 0, E],
            [D + 2, 0, 0, F],
          ],
        ],
        [[]],
      );
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D), pos(0, D + 4)))), [
        ['point', `0:${D}`, `0:${E}`],
        ['point', `0:${D + 2}`, `0:${F}`],
      ]);
    });

    it('reports every segment, even ones sharing a column', () => {
      const child = map([[[D, 0, 0, E], [D], [D + 2, 0, 0, F]]], [[]]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, D), pos(0, D + 4)))), [
        ['point', `0:${D}`, `0:${E}`],
        ['point', `0:${D}`, 'null'],
        ['point', `0:${D + 2}`, `0:${F}`],
      ]);
    });

    it('scenario 5: a range piece is split by the next layer and rebased onto the top', () => {
      // D+7 -> G points at a line where the bottom has nothing.
      const middle = map([[[D + 2, 0, 0, F], [D + 4], [D + 7, 0, 1, G]]], [[0]]);
      const bottom = map(
        [
          [
            [F, 0, 0, J],
            [F + 1, 0, 0, K],
          ],
        ],
        [[]],
      );
      assert.deepEqual(summary(chain([middle, bottom], span(pos(0, D), pos(0, D + 8)))), [
        ['point', `0:${D + 2}`, `0:${J}`], // doc: C+2 -> J
        ['point', `0:${D + 3}`, `0:${K}`], // doc: C+3 -> K
        ['point', `0:${D + 4}`, 'null'], // the middle's sourceless segment
        ['point', `0:${D + 7}`, 'null'], // G has nothing in the bottom
      ]);
    });
  });

  describe("reporting in the caller's generated code", () => {
    const child = map([[[D + 2, 0, 0, E], [D + 6, 0, 0, G], [D + 9]]], [[1]]);

    it("reports results relative to the needle's generated start", () => {
      const needle = { ...span(pos(0, D), pos(0, D + 8)), generated: { start: pos(3, 10) } };
      assert.deepEqual(summary(originalMappingsFor(child, needle)), [
        ['point', '3:12', `0:${E}`],
        ['range', '3:16-3:18', `0:${G}-0:${G + 2}`],
      ]);
    });

    it('keeps columns as-is after the first line, like a range mapping', () => {
      const multi = map([[], [[5, 0, 7, 20]], [], [[3]]], [[], [0], [], []]);
      const needle = { ...span(pos(0, 10), pos(2, 8)), generated: { start: pos(4, 30) } };
      assert.deepEqual(summary(originalMappingsFor(multi, needle)), [
        ['range', '5:5-6:8', '7:20-8:8'],
      ]);
    });

    it('accepts a range result as the needle', () => {
      const parent = map([[[C, 0, 0, D], [C + 8]]], [[0]]);
      const [range] = originalMappingsFor(parent, span(pos(0, C), pos(0, C + 8)));
      assert.equal(range.type, 'range');
      assert.deepEqual(summary(originalMappingsFor(child, range as RangeNeedle)), [
        ['point', `0:${C + 2}`, `0:${E}`],
        ['range', `0:${C + 6}-0:${C + 8}`, `0:${G}-0:${G + 2}`],
      ]);
    });
  });

  describe('multiline', () => {
    it('scenario 4A: a range continuing over lines is truncated by the needle', () => {
      // RANGE from 1:5 -> 7:20 that runs until the sourceless segment at 3:3.
      const child = map([[], [[5, 0, 7, 20]], [], [[3]]], [[], [0], [], []]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, 10), pos(2, 8)))), [
        // The first line shifts columns; the next lines keep them as-is.
        ['range', '1:5-2:8', '7:20-8:8'],
      ]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(1, 7), pos(5, 9)))), [
        ['range', '1:7-3:3', '7:22-9:3'],
        ['point', '3:3', 'null'],
      ]);
    });

    it('reports points, ranges and sourceless points, but not unmapped stretches', () => {
      const child = map([[[2, 0, 0, 0]], [], [[4, 0, 5, 0]], [], [[1]]], [[], [], [0], [], []]);
      assert.deepEqual(summary(originalMappingsFor(child, span(pos(0, 0), pos(4, 2)))), [
        ['point', '0:2', '0:0'],
        ['range', '2:4-4:1', '5:0-7:1'],
        ['point', '4:1', 'null'],
      ]);
    });

    it('scenario 5: rebasing a split range across lines', () => {
      // Middle: RANGE 0:4 -> 10:0, until the sourceless segment at 2:6.
      const middle = map([[[4, 0, 10, 0]], [], [[6]]], [[0], [], []]);
      // Bottom: point 11:2 -> J, and an open-ended RANGE 12:0 -> 29:50.
      const bottomLines: SourceMapSegment[][] = Array.from({ length: 13 }, () => []);
      bottomLines[11] = [[2, 0, 0, J]];
      bottomLines[12] = [[0, 0, 29, 50]];
      const bottomRanges = bottomLines.map((_, i) => (i === 12 ? [0] : []));
      const bottom = map(bottomLines, bottomRanges);

      assert.deepEqual(summary(chain([middle, bottom], span(pos(0, 0), pos(2, 10)))), [
        ['point', '0:4', 'null'], // nothing in the bottom covers 10:0
        ['point', '1:2', `0:${J}`],
        ['range', '2:0-2:6', '29:50-29:56'],
        ['point', '2:6', 'null'], // the middle's sourceless segment
      ]);
    });
  });

  describe('agrees with originalPositionFor', () => {
    it('on a hand-written map with multiline ranges', () => {
      const tracer = new TraceMap({
        version: 3,
        sources: ['input.js'],
        names: ['foo'],
        mappings: [
          [
            [0, 0, 0, 0], // RANGE
            [20, 0, 0, 20],
          ],
          [],
          [[0, 0, 1, 0, 0]], // RANGE, continues over line 3 and into line 4 (0-based)
          [],
          [
            [20, 0, 0, 20, 0],
            [30, 0, 2, 15],
          ],
          [[5, 0, 5, 0]], // RANGE until the end of the map
        ],
        rangeMappings: [[0], [], [0], [], [], [0]],
      } satisfies DecodedSourceMap);

      const needle = span(pos(0, 3), pos(6, 12));
      const pieces = originalMappingsFor(tracer, needle);
      assert.deepEqual(summary(pieces), [
        ['range', '0:3-0:20', '0:3-0:20'],
        ['point', '0:20', '0:20'],
        ['range', '2:0-4:20', '1:0-3:20'], // one piece, although it covers three lines
        ['point', '4:20', '0:20'],
        ['point', '4:30', '2:15'],
        ['range', '5:5-6:12', '5:0-6:12'],
      ]);
      assertAgrees(pieces, needle, (p) => lookup(tracer, p));
    });

    // Seeded PRNG (mulberry32), so failures are reproducible.
    function random(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randomMap(rand: () => number): TraceMap {
      const int = (n: number) => Math.floor(rand() * n);
      const segments: SourceMapSegment[][] = [];
      const ranges: number[][] = [];
      const lineCount = 1 + int(8);
      for (let i = 0; i < lineCount; i++) {
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
        segments.push(line);
        ranges.push(lineRanges);
      }
      return map(segments, ranges);
    }

    function randomNeedle(rand: () => number): RangeNeedle {
      const int = (n: number) => Math.floor(rand() * n);
      const start = pos(int(9), int(35));
      const endLine = start.line + int(4);
      const endColumn = endLine === start.line ? start.column + int(10) : int(35);
      return { start, end: pos(endLine, endColumn) };
    }

    for (const depth of [1, 2, 3]) {
      it(`on random maps, chaining ${depth} layer(s)`, () => {
        const rand = random(depth);
        for (let i = 0; i < 300; i++) {
          const layers = Array.from({ length: depth }, () => randomMap(rand));
          const needle = randomNeedle(rand);
          const pieces = chain(layers, needle);
          assertAgrees(pieces, needle, (p) => pointwise(layers, p));
        }
      });
    }
  });
});
