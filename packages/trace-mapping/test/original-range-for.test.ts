import assert from 'node:assert/strict';

import {
  TraceMap,
  originalPositionFor,
  originalRangeFor,
  type DecodedSourceMap,
  type SourceMapSegment,
} from '../src/trace-mapping';

type Pos = { line: number; column: number };
type Needle = { start: Pos; end: Pos };
type Piece = ReturnType<typeof originalRangeFor>[number];

// Scenario letters from range_mappings_composition.md, as concrete columns.
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
const gen = (sc: number, ec: number, sl = 1, el = sl): Needle => ({
  start: pos(sl, sc),
  end: pos(el, ec),
});

/**
 * Moves `p` from the space that starts at `from` into the space that starts at
 * `to`, with the same rules as a range mapping: columns shift on the first
 * line, and are kept as-is on the following lines. Swapping `from` and `to`
 * gives the inverse.
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

/**
 * Traces a needle through several maps (outermost first) using only
 * originalRangeFor, rebasing each child piece onto the outermost generated
 * space.
 */
function chain(layers: TraceMap[], needle: Needle): Piece[] {
  const [layer, ...rest] = layers;
  const pieces = originalRangeFor(layer, needle);
  if (rest.length === 0) return pieces;
  return pieces.flatMap((p): Piece[] => {
    if (p.type === 'point') {
      // Scenario 1/2: a point stays a point, whatever the child has there.
      const at = pos(p.line, p.column);
      return chain(rest, { start: at, end: at }).map(
        (q) => ({ ...q, generated: p.generated }) as Piece,
      );
    }
    const rebase = (g: Pos) => project(p.start, p.generated.start, g);
    return chain(rest, { start: p.start, end: p.end }).map(
      (q): Piece =>
        q.type === 'point'
          ? { ...q, generated: rebase(q.generated) }
          : { ...q, generated: { start: rebase(q.generated.start), end: rebase(q.generated.end) } },
    );
  });
}

/** Composes originalPositionFor through every layer, one position at a time. */
function pointwise(layers: TraceMap[], p: Pos) {
  let result = originalPositionFor(layers[0], p);
  for (let i = 1; i < layers.length && result.source != null; i++) {
    result = originalPositionFor(layers[i], { line: result.line, column: result.column });
  }
  return result;
}

/** Every generated position in the needle, up to `width` columns on lines it fully covers. */
function* positions({ start, end }: Needle, width = 40): Generator<Pos> {
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
 * - every position inside a range piece resolves to its linear projection;
 * - every position that resolves to something is explained by the last piece
 *   starting at or before it: a range covering it, or a point on its line.
 * A position after a point that resolves to nothing is the one case the pieces
 * can't describe, since unmapped stretches aren't reported.
 */
function assertAgrees(pieces: Piece[], needle: Needle, lookup: (p: Pos) => any) {
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

    if (last?.type === 'range' && before(p, last.generated.end)) {
      const o = project(last.generated.start, last.start, p);
      const expected = { source: last.source, line: o.line, column: o.column, name: last.name };
      assert.deepEqual(actual, expected, at);
    } else if (actual.source != null) {
      assert.ok(last?.type === 'point' && last.generated.line === p.line, at);
      const { source, line, column, name } = last;
      assert.deepEqual(actual, { source, line, column, name }, at);
    }
  }
}

/** Compact form for asserting: [type, generated, original]. */
function summary(pieces: Piece[]) {
  const fmt = (p: Pos) => `${p.line}:${p.column}`;
  return pieces.map((p) =>
    p.type === 'point'
      ? [p.type, fmt(p.generated), fmt(p)]
      : [
          p.type,
          `${fmt(p.generated.start)}-${fmt(p.generated.end)}`,
          `${fmt(p.start)}-${fmt(p.end)}`,
        ],
  );
}

describe('originalRangeFor', () => {
  describe('composition scenarios (single line)', () => {
    it('scenario 2: zero-width needle inside a child range resolves to a point', () => {
      const child = map([[[D, 0, 0, E], [D + 8]]], [[0]]);
      assert.deepEqual(summary(originalRangeFor(child, gen(D + 4, D + 4))), [
        ['point', `1:${D + 4}`, `1:${E + 4}`],
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
      assert.deepEqual(summary(originalRangeFor(child, gen(D, D + 5))), [
        ['point', `1:${D + 2}`, `1:${E}`],
        ['point', `1:${D + 3}`, `1:${F}`],
        ['point', `1:${D + 4}`, `1:${G}`],
      ]);
    });

    it('scenario 4A: a child range is intersected (truncated) with the needle', () => {
      const child = map([[[D + 6, 0, 0, G], [D + 9]]], [[0]]);
      assert.deepEqual(summary(originalRangeFor(child, gen(D, D + 8))), [
        ['range', `1:${D + 6}-1:${D + 8}`, `1:${G}-1:${G + 2}`],
      ]);
    });

    it('scenario 4B: a needle inside a larger child range keeps its width', () => {
      const child = map([[[D, 0, 0, F], [D + 20]]], [[0]]);
      assert.deepEqual(summary(originalRangeFor(child, gen(D + 2, D + 4))), [
        ['range', `1:${D + 2}-1:${D + 4}`, `1:${F + 2}-1:${F + 4}`],
      ]);
      assert.deepEqual(summary(originalRangeFor(child, gen(D + 13, D + 16))), [
        ['range', `1:${D + 13}-1:${D + 16}`, `1:${F + 13}-1:${F + 16}`],
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
      assert.deepEqual(summary(originalRangeFor(child, gen(D, D + 4))), [
        ['point', `1:${D}`, `1:${E}`],
        ['point', `1:${D + 2}`, `1:${F}`],
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
      assert.deepEqual(summary(chain([middle, bottom], gen(D, D + 8))), [
        ['point', `1:${D + 2}`, `1:${J}`], // doc: C+2 -> J
        ['point', `1:${D + 3}`, `1:${K}`], // doc: C+3 -> K
      ]);
    });
  });

  describe('multiline', () => {
    it('scenario 4A: a range continuing over lines is truncated by the needle', () => {
      // RANGE from 2:5 -> 8:20 that runs until the sourceless segment at 4:3.
      const child = map([[], [[5, 0, 7, 20]], [], [[3]]], [[], [0], [], []]);
      assert.deepEqual(summary(originalRangeFor(child, gen(10, 8, 1, 3))), [
        // The first line shifts columns; the next lines keep them as-is.
        ['range', '2:5-3:8', '8:20-9:8'],
      ]);
      assert.deepEqual(summary(originalRangeFor(child, gen(7, 9, 2, 6))), [
        ['range', '2:7-4:3', '8:22-10:3'],
      ]);
    });

    it('reports points and ranges, but not the unmapped stretches between them', () => {
      const child = map([[[2, 0, 0, 0]], [], [[4, 0, 5, 0]], [], [[1]]], [[], [], [0], [], []]);
      assert.deepEqual(summary(originalRangeFor(child, gen(0, 2, 1, 5))), [
        ['point', '1:2', '1:0'],
        ['range', '3:4-5:1', '6:0-8:1'],
      ]);
    });

    it('scenario 5: rebasing a split range across lines', () => {
      // Middle: RANGE 1:4 -> 11:0, until the sourceless segment at 3:6.
      const middle = map([[[4, 0, 10, 0]], [], [[6]]], [[0], [], []]);
      // Bottom: point 12:2 -> J, and an open-ended RANGE 13:0 -> 30:50.
      const bottomLines: SourceMapSegment[][] = Array.from({ length: 13 }, () => []);
      bottomLines[11] = [[2, 0, 0, J]];
      bottomLines[12] = [[0, 0, 29, 50]];
      const bottomRanges = bottomLines.map((_, i) => (i === 12 ? [0] : []));
      const bottom = map(bottomLines, bottomRanges);

      assert.deepEqual(summary(chain([middle, bottom], gen(0, 10, 1, 3))), [
        ['point', '2:2', `1:${J}`],
        ['range', '3:0-3:6', '30:50-30:56'],
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
          [[0, 0, 1, 0, 0]], // RANGE, continues over line 3 and into line 4
          [],
          [
            [20, 0, 0, 20, 0],
            [30, 0, 2, 15],
          ],
          [[5, 0, 5, 0]], // RANGE until the end of the map
        ],
        rangeMappings: [[0], [], [0], [], [], [0]],
      } satisfies DecodedSourceMap);

      const needle = gen(3, 12, 1, 7);
      const pieces = originalRangeFor(tracer, needle);
      assert.deepEqual(summary(pieces), [
        ['range', '1:3-1:20', '1:3-1:20'],
        ['point', '1:20', '1:20'],
        ['range', '3:0-5:20', '2:0-4:20'], // one piece, although it covers three lines
        ['point', '5:20', '1:20'],
        ['point', '5:30', '3:15'],
        ['range', '6:5-7:12', '6:0-7:12'],
      ]);
      assertAgrees(pieces, needle, (p) => originalPositionFor(tracer, p));
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

    function randomNeedle(rand: () => number): Needle {
      const int = (n: number) => Math.floor(rand() * n);
      const start = pos(1 + int(9), int(35));
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
