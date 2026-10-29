/** Physical UTF-16 offsets are zero-based and inclusive, like Range. */
export interface SourceSpan {
  readonly uri: string;
  readonly start: number;
  readonly end: number;
}

export interface SourceOrigin {
  /** Author-written spelling, possibly in a different macro definition. */
  readonly spelling: SourceSpan;
  /** Outermost invocation, used for diagnostics and invocation queries. */
  readonly expansion?: SourceSpan;
  readonly macroName?: string;
  /** A contiguous, one-to-one spelling suitable for a source edit. */
  readonly editable: boolean;
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

/** Immutable piecewise mapping between analysis text and author-written text. */
export class SourceMap {
  readonly segments: readonly SourceSegment[];
  private reverse?: Map<
    string,
    {
      entries: {
        span: SourceSpan;
        segment: SourceSegment;
        spelling: boolean;
      }[];
      maximumEnds: number[];
    }
  >;

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
              end: document.text.length - 1,
              origin: {
                spelling: {
                  uri: document.uri,
                  start: 0,
                  end: document.text.length - 1,
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

  origin(start: number, end = start): SourceOrigin {
    start = Number.isFinite(start) ? Math.max(0, start) : 0;
    end = Number.isFinite(end) ? Math.max(start, end) : start;
    const first = this.segmentAt(start);
    const last = this.segmentAt(end);
    if (!first) {
      // EOF is a valid cursor position. Do not move it onto the last character.
      const generatedEnd = (this.segments.at(-1)?.end ?? -1) + 1;
      const offset =
        start >= generatedEnd
          ? this.document.text.length
          : Math.min(start, this.document.text.length);
      return {
        spelling: { uri: this.document.uri, start: offset, end: offset },
        editable: false,
      };
    }
    const firstSpelling = this.project(first, start, Math.min(end, first.end));
    if (first === last && this.isOneToOne(first)) {
      return { ...first.origin, spelling: firstSpelling };
    }
    const anchor = first.origin.expansion || firstSpelling;
    const lastAnchor =
      last && (last.origin.expansion || this.project(last, last.start, end));
    return {
      ...first.origin,
      spelling: firstSpelling,
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

  /** Every analysis context for an original spelling or macro invocation. */
  generatedOffsets(uri: string, offset: number): number[] {
    if (!this.reverse) {
      this.reverse = new Map();
      const invocations = new Set<SourceSpan>();
      for (const segment of this.segments) {
        for (const spelling of [true, false]) {
          const span = spelling
            ? segment.origin.spelling
            : segment.origin.expansion;
          if (!span || (!spelling && invocations.has(span))) continue;
          if (!spelling) invocations.add(span);
          let index = this.reverse.get(span.uri);
          if (!index)
            this.reverse.set(
              span.uri,
              (index = { entries: [], maximumEnds: [] }),
            );
          index.entries.push({ span, segment, spelling });
        }
      }
      for (const index of this.reverse.values()) {
        index.entries.sort((a, b) => a.span.start - b.span.start);
        let maximum = -1;
        for (const entry of index.entries) {
          maximum = Math.max(maximum, entry.span.end);
          index.maximumEnds.push(maximum);
        }
      }
    }
    const matches = new Set<number>();
    const index = this.reverse.get(uri);
    if (index) {
      let lower = 0;
      let upper = index.entries.length;
      while (lower < upper) {
        const middle = (lower + upper) >>> 1;
        if (index.entries[middle].span.start <= offset) lower = middle + 1;
        else upper = middle;
      }
      for (let i = lower - 1; i >= 0 && index.maximumEnds[i] >= offset; i--) {
        const { span, segment, spelling } = index.entries[i];
        if (offset > span.end) continue;
        matches.add(
          spelling && this.isOneToOne(segment)
            ? segment.start + offset - span.start
            : segment.start,
        );
      }
    }
    if (uri === this.document.uri && offset === this.document.text.length) {
      matches.add((this.segments.at(-1)?.end ?? -1) + 1);
    }
    return [...matches];
  }

  private isOneToOne(segment: SourceSegment): boolean {
    return (
      segment.end - segment.start ===
      segment.origin.spelling.end - segment.origin.spelling.start
    );
  }

  private project(
    segment: SourceSegment,
    start: number,
    end: number,
  ): SourceSpan {
    if (!this.isOneToOne(segment)) return segment.origin.spelling;
    return {
      uri: segment.origin.spelling.uri,
      start: segment.origin.spelling.start + start - segment.start,
      end: Math.min(
        segment.origin.spelling.end,
        segment.origin.spelling.start + end - segment.start,
      ),
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

/** Original-text line index, including CR-only files and UTF-16 columns. */
export class SourceLines {
  private lineStarts?: number[];

  constructor(readonly text: string) {}

  get starts(): readonly number[] {
    if (this.lineStarts) return this.lineStarts;
    const starts = [0];
    for (let index = 0; index < this.text.length; index++) {
      if (this.text[index] === '\r') {
        if (this.text[index + 1] === '\n') index++;
        starts.push(index + 1);
      } else if (this.text[index] === '\n') starts.push(index + 1);
    }
    return (this.lineStarts = starts);
  }

  position(offset: number) {
    offset = Number.isFinite(offset)
      ? Math.max(0, Math.min(offset, this.text.length))
      : 0;
    let lower = 0;
    let upper = this.starts.length;
    while (lower + 1 < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.starts[middle] <= offset) lower = middle;
      else upper = middle;
    }
    return { offset, line: lower + 1, column: offset - this.starts[lower] + 1 };
  }

  offset(position: { line: number; column: number }): number {
    const line = Math.max(
      0,
      Math.min(this.starts.length - 1, position.line - 1),
    );
    let end = this.starts[line + 1] ?? this.text.length;
    if (line + 1 < this.starts.length) {
      if (this.text[end - 1] === '\n') end--;
      if (this.text[end - 1] === '\r') end--;
    }
    return Math.min(end, this.starts[line] + Math.max(0, position.column - 1));
  }
}
