import type { SourceMapSegment } from './sourcemap-segment';
import type { GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND, TraceMap } from './trace-mapping';

export interface SourceMapV3 {
  file?: string | null;
  names: string[];
  sourceRoot?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  version: 3;
  ignoreList?: number[];
}

export interface EncodedSourceMap extends SourceMapV3 {
  mappings: string;
  rangeMappings?: string;
}

export interface DecodedSourceMap extends SourceMapV3 {
  mappings: SourceMapSegment[][];
  rangeMappings?: number[][];
}

export interface Section {
  offset: { line: number; column: number };
  map: EncodedSourceMap | DecodedSourceMap | SectionedSourceMap;
}

export interface SectionedSourceMap {
  file?: string | null;
  sections: Section[];
  version: 3;
}

export type OriginalMapping = {
  source: string | null;
  line: number;
  column: number;
  name: string | null;
};

export type InvalidOriginalMapping = {
  source: null;
  line: null;
  column: null;
  name: null;
};

export type GeneratedMapping = {
  line: number;
  column: number;
};
export type InvalidGeneratedMapping = {
  line: null;
  column: null;
};

/**
 * A 0-based line and column, like the positions in decoded segments.
 */
export type SegmentPosition = { line: number; column: number };

/**
 * A range of 0-based positions. `end` is exclusive.
 */
export type SegmentRange = { start: SegmentPosition; end: SegmentPosition };

/**
 * A range of a map's generated code. When `generated` is given, the range is
 * the source side of another map's range mapping, and `generated.start` is
 * where `start` is in that map's generated code: results are reported there.
 * A `range` result of `originalMappingsFor` can be passed as-is.
 */
export type RangeNeedle = SegmentRange & { generated?: { start: SegmentPosition } };

/**
 * One mapping found by `originalMappingsFor`, in generated order. All
 * positions are 0-based.
 *
 * - `range`: a range mapping intersected with the needle. Every generated
 *   position in `generated` projects linearly onto `[start, end)` in the source.
 * - `point`: a normal mapping, at the generated position where it starts (or
 *   at the needle's start, for a mapping that started before the needle). A
 *   sourceless mapping is a point whose source, line, column and name are null.
 */
export type OriginalMappingPiece =
  | {
      type: 'range';
      generated: SegmentRange;
      sourcesIndex: number;
      source: string | null;
      start: SegmentPosition;
      end: SegmentPosition;
      name: string | null;
    }
  | {
      type: 'point';
      generated: SegmentPosition;
      sourcesIndex: number;
      source: string | null;
      line: number;
      column: number;
      name: string | null;
    }
  | {
      type: 'point';
      generated: SegmentPosition;
      sourcesIndex: null;
      source: null;
      line: null;
      column: null;
      name: null;
    };

/**
 * Metadata about a range mapping's segment.
 */
export type RangeInfo = {
  /** The 0-based generated line the segment is on. */
  line: number;
};

export type Bias = typeof GREATEST_LOWER_BOUND | typeof LEAST_UPPER_BOUND;

export type XInput = { x_google_ignoreList?: SourceMapV3['ignoreList'] };
export type EncodedSourceMapXInput = EncodedSourceMap & XInput;
export type DecodedSourceMapXInput = DecodedSourceMap & XInput;
export type SectionedSourceMapXInput = Omit<SectionedSourceMap, 'sections'> & {
  sections: SectionXInput[];
};
export type SectionXInput = Omit<Section, 'map'> & {
  map: SectionedSourceMapInput;
};

export type SourceMapInput = string | EncodedSourceMapXInput | DecodedSourceMapXInput | TraceMap;
export type SectionedSourceMapInput = SourceMapInput | SectionedSourceMapXInput;

export type Needle = { line: number; column: number; bias?: Bias };
export type SourceNeedle = { source: string; line: number; column: number; bias?: Bias };

export type EachMapping =
  | {
      generatedLine: number;
      generatedColumn: number;
      source: null;
      originalLine: null;
      originalColumn: null;
      name: null;
    }
  | {
      generatedLine: number;
      generatedColumn: number;
      source: string | null;
      originalLine: number;
      originalColumn: number;
      name: string | null;
    };

export abstract class SourceMap {
  declare version: SourceMapV3['version'];
  declare file: SourceMapV3['file'];
  declare names: SourceMapV3['names'];
  declare sourceRoot: SourceMapV3['sourceRoot'];
  declare sources: SourceMapV3['sources'];
  declare sourcesContent: SourceMapV3['sourcesContent'];
  declare resolvedSources: SourceMapV3['sources'];
  declare ignoreList: SourceMapV3['ignoreList'];
}

export type Ro<T> =
  T extends Array<infer V>
    ? V[] | Readonly<V[]> | RoArray<V> | Readonly<RoArray<V>>
    : T extends object
      ? T | Readonly<T> | RoObject<T> | Readonly<RoObject<T>>
      : T;
type RoArray<T> = Ro<T>[];
type RoObject<T> = { [K in keyof T]: T[K] | Ro<T[K]> };
