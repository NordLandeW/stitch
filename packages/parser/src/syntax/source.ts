/** Physical source offsets are zero-based and inclusive, like public Range. */
export interface SourceSpan {
  readonly uri: string;
  readonly start: number;
  readonly end: number;
}

export interface SourceOrigin {
  /** The author-written spelling, possibly in another macro's definition. */
  readonly spelling: SourceSpan;
  /** The outermost invocation, used to anchor expansion diagnostics/queries. */
  readonly expansion?: SourceSpan;
  readonly macroName?: string;
  /** True only for a contiguous one-to-one author-written spelling. */
  readonly editable: boolean;
  readonly expansionStack?: readonly SourceSpan[];
}

export interface SourceSegment {
  readonly start: number;
  readonly end: number;
  readonly origin: SourceOrigin;
}

export interface SourceDocument {
  readonly uri: string;
  readonly text: string;
}

/** Piecewise mapping for original text and recursively expanded macro text. */
export class SourceMap {
  readonly segments: readonly SourceSegment[];

  constructor(
    readonly document: SourceDocument,
    segments?: readonly SourceSegment[],
  ) {
    this.document = Object.freeze({ ...document });
    this.segments =
      segments ||
      (document.text.length
        ? [
            {
              start: 0,
              end: Math.max(0, document.text.length - 1),
              origin: {
                spelling: {
                  uri: document.uri,
                  start: 0,
                  end: Math.max(0, document.text.length - 1),
                },
                editable: true,
              },
            },
          ]
        : []);
  }

  *segmentsInRange(start: number, end: number): Iterable<SourceSegment> {
    if (end < start) return;
    let lower = 0;
    let upper = this.segments.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.segments[middle].end < start) lower = middle + 1;
      else upper = middle;
    }
    for (let index = lower; index < this.segments.length; index++) {
      const segment = this.segments[index];
      if (segment.start > end) break;
      yield segment;
    }
  }

  origin(start: number, end: number = start): SourceOrigin {
    start = Number.isFinite(start) ? Math.max(0, start) : 0;
    end = Number.isFinite(end) ? Math.max(start, end) : start;
    const first = this.segmentAt(start);
    const last = this.segmentAt(end);
    if (!first) {
      const offset = Math.min(
        start,
        Math.max(0, this.document.text.length - 1),
      );
      return {
        spelling: { uri: this.document.uri, start: offset, end: offset },
        editable: false,
      };
    }
    const contiguous = first === last;
    const oneToOne =
      first.end - first.start ===
      first.origin.spelling.end - first.origin.spelling.start;
    if (contiguous && oneToOne) {
      return {
        ...first.origin,
        spelling: {
          uri: first.origin.spelling.uri,
          start: first.origin.spelling.start + start - first.start,
          end: Math.min(
            first.origin.spelling.end,
            first.origin.spelling.start + end - first.start,
          ),
        },
      };
    }
    // A syntax node can combine original code and several macro expansions.
    // Such a range is useful for display, but not a direct source edit.
    const firstSpelling = oneToOne
      ? {
          ...first.origin.spelling,
          start: first.origin.spelling.start + start - first.start,
        }
      : first.origin.spelling;
    const lastOneToOne =
      last &&
      last.end - last.start ===
        last.origin.spelling.end - last.origin.spelling.start;
    const lastSpelling =
      last && lastOneToOne
        ? {
            ...last.origin.spelling,
            end: last.origin.spelling.start + end - last.start,
          }
        : last?.origin.spelling;
    const anchor = first.origin.expansion || firstSpelling;
    const lastAnchor = last?.origin.expansion || lastSpelling;
    return {
      ...first.origin,
      spelling: first.origin.spelling,
      expansion:
        lastAnchor?.uri === anchor.uri
          ? {
              uri: anchor.uri,
              start: Math.min(anchor.start, lastAnchor.start),
              end: Math.max(anchor.end, lastAnchor.end),
            }
          : anchor,
      editable: false,
    };
  }

  private segmentAt(offset: number): SourceSegment | undefined {
    let lower = 0;
    let upper = this.segments.length - 1;
    while (lower <= upper) {
      const middle = (lower + upper) >>> 1;
      const segment = this.segments[middle];
      if (offset < segment.start) upper = middle - 1;
      else if (offset > segment.end) lower = middle + 1;
      else return segment;
    }
    return undefined;
  }
}
