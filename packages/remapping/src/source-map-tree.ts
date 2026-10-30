import {
  GenMapping,
  maybeAddMapping,
  maybeAddSegment,
  setIgnore,
  setSourceContent,
} from '@jridgewell/gen-mapping';
import {
  traceSegment,
  decodedMappings,
  isRange,
  originalMappingsFor,
} from '@jridgewell/trace-mapping';

import type {
  TraceMap,
  SourceMapSegment,
  RangeNeedle,
  SegmentPosition,
} from '@jridgewell/trace-mapping';

export type OriginalSource = {
  map: null;
  sources: Sources[];
  source: string;
  content: string | null;
  ignore: boolean;
};

export type MapSource = {
  map: TraceMap;
  sources: Sources[];
  source: string;
  content: null;
  ignore: false;
};

export type Sources = OriginalSource | MapSource;

const EMPTY_SOURCES: Sources[] = [];

function Source(
  map: TraceMap,
  sources: Sources[],
  source: '',
  content: null,
  ignore: false,
): MapSource;
function Source(
  map: null,
  sources: Sources[],
  source: string,
  content: string | null,
  ignore: boolean,
): OriginalSource;
function Source(
  map: TraceMap | null,
  sources: Sources[],
  source: string | '',
  content: string | null,
  ignore: boolean,
): Sources {
  return {
    map,
    sources,
    source,
    content,
    ignore,
  } as any;
}

/**
 * MapSource represents a single sourcemap, with the ability to trace mappings into its child nodes
 * (which may themselves be SourceMapTrees).
 */
export function MapSource(map: TraceMap, sources: Sources[]): MapSource {
  return Source(map, sources, '', null, false);
}

/**
 * A "leaf" node in the sourcemap tree, representing an original, unmodified source file. Recursive
 * segment tracing ends at the `OriginalSource`.
 */
export function OriginalSource(
  source: string,
  content: string | null,
  ignore: boolean,
): OriginalSource {
  return Source(null, EMPTY_SOURCES, source, content, ignore);
}

/**
 * traceMappings is only called on the root level SourceMapTree, and begins the process of
 * resolving each mapping in terms of the original source files.
 */
export function traceMappings(tree: MapSource): GenMapping {
  const { map } = tree;
  // TODO: Eventually support sourceRoot, which has to be removed because the sources are already
  // fully resolved. We'll need to make sources relative to the sourceRoot before adding them.
  const gen = new GenMapping({ file: map.file });
  const rootMappings = decodedMappings(map);

  for (let i = 0; i < rootMappings.length; i++) {
    const segments = rootMappings[i];

    for (let j = 0; j < segments.length; j++) {
      const segment = segments[j];
      if (isRange(map, segment)) {
        // A range covers every position up to the next segment, so trace all
        // of them instead of only its start.
        const start = { line: i, column: segment[0] };
        const end = nextSegmentPosition(rootMappings, i, j);
        originalRangeFor(gen, tree, { start, end }, '');
        continue;
      }
      originalPositionForSegment(gen, i, segment[0], tree, '', segment);
    }
  }

  return gen;
}

function originalPositionForSegment(
  gen: GenMapping,
  genLine: number,
  genCol: number,
  source: MapSource,
  parentName: string,
  segment: Readonly<SourceMapSegment> | null,
): void {
  // 1-length segments only move the current generated column, there's no source information
  // to gather from it.
  if (segment == null || segment.length === 1) {
    maybeAddSegment(gen, genLine, genCol);
    return;
  }

  return originalPositionFor(
    gen,
    genLine,
    genCol,
    source.sources[segment[1]],
    segment[2],
    segment[3],
    segment.length === 5 ? source.map.names[segment[4]] : parentName,
  );
}

export function originalPositionFor(
  gen: GenMapping,
  genLine: number,
  genCol: number,
  source: Sources,
  line: number,
  column: number,
  name: string,
): void {
  if (!source.map) {
    maybeAddSegment(gen, genLine, genCol, source.source, line, column, name);
    if (source.content != null) setSourceContent(gen, source.source, source.content);
    if (source.ignore) setIgnore(gen, source.source, true);
    return;
  }

  const segment = traceSegment(source.map, line, column);
  if (segment != null && isRange(source.map, segment)) {
    // traceSegment returns a range segment as it is at the range's start.
    // Look up the traced position itself, which is offset into the range.
    const at = { line, column };
    const [point] = originalMappingsFor(source.map, { start: at, end: at });
    if (point.type === 'point' && point.sourcesIndex !== null) {
      return originalPositionFor(
        gen,
        genLine,
        genCol,
        source.sources[point.sourcesIndex],
        point.line,
        point.column,
        point.name ?? name,
      );
    }
  }
  return originalPositionForSegment(gen, genLine, genCol, source, name, segment);
}

/**
 * Like originalPositionFor, but for a range of the source's generated code.
 * Points in the range are traced like originalPositionFor does, and ranges are
 * intersected and traced into the next source map. Everything is added at its
 * position in the root's generated code: the needle's `generated` start, or the
 * needle itself for the root.
 */
function originalRangeFor(
  gen: GenMapping,
  source: MapSource,
  needle: RangeNeedle,
  name: string,
): void {
  const pieces = originalMappingsFor(source.map, needle);

  // Nothing covers the range's start, so end whatever mapping came before it.
  const genStart = needle.generated ? needle.generated.start : needle.start;
  const first = pieces[0];
  const firstStart = first && (first.type === 'point' ? first.generated : first.generated.start);
  if (!firstStart || !samePosition(firstStart, genStart)) {
    maybeAddSegment(gen, genStart.line, genStart.column);
  }

  for (const piece of pieces) {
    // A sourceless mapping ends the mapping before it.
    if (piece.sourcesIndex === null) {
      maybeAddSegment(gen, piece.generated.line, piece.generated.column);
      continue;
    }

    const child = source.sources[piece.sourcesIndex];
    const pieceName = piece.name ?? name;

    if (piece.type === 'point') {
      const { line, column } = piece.generated;
      originalPositionFor(gen, line, column, child, piece.line, piece.column, pieceName);
      continue;
    }

    if (child.map) {
      // The range result is the needle for the next source map.
      originalRangeFor(gen, child, piece, pieceName);
      continue;
    }

    // gen-mapping's addMapping takes 1-based lines.
    const { start } = piece.generated;
    maybeAddMapping(gen, {
      generated: { line: start.line + 1, column: start.column },
      source: child.source,
      original: { line: piece.start.line + 1, column: piece.start.column },
      name: pieceName,
      isRange: true,
    });
    if (child.content != null) setSourceContent(gen, child.source, child.content);
    if (child.ignore) setIgnore(gen, child.source, true);
  }
}

/**
 * Where the segment after `mappings[line][index]` starts, which is where a
 * range at that segment ends.
 */
function nextSegmentPosition(
  mappings: readonly SourceMapSegment[][],
  line: number,
  index: number,
): SegmentPosition {
  if (index + 1 < mappings[line].length) return { line, column: mappings[line][index + 1][0] };
  for (let i = line + 1; i < mappings.length; i++) {
    if (mappings[i].length > 0) return { line: i, column: mappings[i][0][0] };
  }
  return { line: Infinity, column: Infinity };
}

function samePosition(a: SegmentPosition, b: SegmentPosition): boolean {
  return a.line === b.line && a.column === b.column;
}
