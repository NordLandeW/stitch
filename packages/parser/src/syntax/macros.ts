import { createHash } from 'node:crypto';
import { tokenMatcher, type ILexingResult, type IToken } from 'chevrotain';
import { GmlLexer } from '../lexer.js';
import {
  SourceMap,
  type SourceDocument,
  type SourceOrigin,
  type SourceSegment,
  type SourceSpan,
} from './source.js';
import { c } from '../tokens.categories.js';

// Preprocessing precedes keyword interpretation. String/comment tokens are not
// code words, while keywords (including named literals) can be macro names.
export const isMacroWord = (token: IToken): boolean =>
  token.tokenType.name === 'Identifier' ||
  (tokenMatcher(token, c.Keyword) && /^[a-zA-Z_]\w*$/.test(token.image));

export interface MacroDiagnostic {
  readonly message: string;
  readonly span: SourceSpan;
}

export interface MacroDefinition {
  readonly name: string;
  readonly configuration?: string;
  readonly source: SourceSpan;
  readonly directive: SourceSpan;
  readonly body: string;
  readonly bodyMap: SourceMap;
}

export interface MacroCollection {
  readonly document: SourceDocument;
  readonly definitions: readonly MacroDefinition[];
  readonly diagnostics: readonly MacroDiagnostic[];
  readonly maskedText: string;
  readonly lexed: ILexingResult;
  readonly key: string;
}

export interface MacroReference {
  readonly name: string;
  readonly definition: MacroDefinition;
  readonly origin: SourceOrigin;
}

export interface PreprocessedDocument {
  readonly text: string;
  readonly sourceMap?: SourceMap;
  /** Reusable when expansion has not changed token positions. */
  readonly lexed?: ILexingResult;
  readonly references: readonly MacroReference[];
  readonly diagnostics: readonly MacroDiagnostic[];
  /** Unresolved identifiers are included so adding a macro refreshes users. */
  readonly dependencies: ReadonlySet<string>;
}

export interface MacroExpansionOptions {
  cancelled?: () => boolean;
  /** Analysis resource protection, not a GML language limit. */
  maxExpandedCharacters?: number;
  maxExpansionSteps?: number;
}

export class MacroExpansionCancelled extends Error {
  constructor() {
    super('Macro expansion cancelled');
    this.name = 'MacroExpansionCancelled';
  }
}

const mask = (text: string) => text.replace(/[^\r\n]/g, ' ');
const span = (uri: string, start: number, end: number): SourceSpan => ({
  uri,
  start,
  end: Math.max(start, end),
});
const checkCancelled = (options: MacroExpansionOptions) => {
  if (options.cancelled?.()) throw new MacroExpansionCancelled();
};

class MappedText {
  readonly chunks: string[] = [];
  readonly segments: SourceSegment[] = [];
  length = 0;

  append(text: string, origin: SourceOrigin) {
    if (!text.length) return;
    this.chunks.push(text);
    this.segments.push({
      start: this.length,
      end: this.length + text.length - 1,
      origin,
    });
    this.length += text.length;
  }

  finish(document: SourceDocument) {
    return {
      text: this.chunks.join(''),
      sourceMap: new SourceMap(document, this.segments),
    };
  }
}

function withoutComments(text: string, lexed: ILexingResult): string {
  const comments = [
    ...(lexed.groups.comments || []),
    ...lexed.tokens.filter((token) =>
      ['JsdocGmlLine', 'JsdocJs'].includes(token.tokenType.name),
    ),
  ].sort((a, b) => a.startOffset - b.startOffset);
  if (!comments.length) return text;
  const chunks: string[] = [];
  let cursor = 0;
  for (const comment of comments) {
    const end = (comment.endOffset ?? comment.startOffset) + 1;
    chunks.push(
      text.slice(cursor, comment.startOffset),
      mask(text.slice(comment.startOffset, end)),
    );
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

/** Collect all global directives before interpreting any usage. */
export function collectMacros(
  document: SourceDocument,
  lexed?: ILexingResult,
  options: MacroExpansionOptions = {},
): MacroCollection {
  checkCancelled(options);
  lexed ??= GmlLexer.tokenize(document.text);
  const definitions: MacroDefinition[] = [];
  const diagnostics: MacroDiagnostic[] = [];
  const removals: { start: number; end: number }[] = [];
  if (!document.text.includes('#macro')) {
    return {
      document,
      definitions,
      diagnostics,
      maskedText: document.text,
      lexed,
      key: '',
    };
  }
  const commentFree = withoutComments(document.text, lexed);
  const escapes = new Set(
    lexed.tokens
      .filter((token) => token.tokenType.name === 'Escape')
      .map((token) => token.startOffset),
  );
  const continuations = new Map<number, { start: number; end: number }>();
  for (const match of commentFree.matchAll(/\\[\t ]*(\r\n|\r|\n)/g)) {
    if (!escapes.has(match.index)) continue;
    const end = match.index + match[0].length;
    continuations.set(end - match[1].length, { start: match.index, end });
  }
  const breaks = [...document.text.matchAll(/\r\n|\r|\n/g)].map(
    (match) => match.index,
  );
  breaks.push(document.text.length);
  const stringBreaks = new Set(
    lexed.tokens
      .filter(
        (token) =>
          tokenMatcher(token, c.MultilineStringLiteral) &&
          /[\r\n]/.test(token.image),
      )
      .map((token) => token.startOffset),
  );
  let breakIndex = 0;
  let consumed = -1;
  for (const token of lexed.tokens) {
    if (token.tokenType.name !== 'Macro' || token.startOffset <= consumed)
      continue;
    checkCancelled(options);
    const start = token.startOffset;
    while (breaks[breakIndex] < start) breakIndex++;
    const joined: { start: number; end: number }[] = [];
    let end = breaks[breakIndex];
    while (
      end < document.text.length &&
      (continuations.has(end) || stringBreaks.has(end))
    ) {
      if (continuations.has(end)) joined.push(continuations.get(end)!);
      end = breaks[++breakIndex];
    }
    consumed = end - 1;
    removals.push({ start, end });
    const directive = span(document.uri, start, end - 1);
    const header =
      /^#macro[\t ]+(?:(?<configuration>[^\s:]+):)?(?<name>[a-zA-Z_][a-zA-Z0-9_]*)(?=[\t ]|$)/.exec(
        commentFree.slice(start, end),
      );
    if (!header?.groups) {
      diagnostics.push({
        message:
          'Expected #macro NAME expression or #macro Configuration:NAME expression',
        span: directive,
      });
      continue;
    }
    const name = header.groups.name;
    const nameStart = start + header[0].length - name.length;
    const bodyStart = start + header[0].length;
    const body = new MappedText();
    let cursor = bodyStart;
    for (const continuation of joined) {
      body.append(commentFree.slice(cursor, continuation.start), {
        spelling: span(document.uri, cursor, continuation.start - 1),
        editable: true,
      });
      body.append(' ', {
        spelling: span(document.uri, continuation.start, continuation.end - 1),
        editable: false,
      });
      cursor = continuation.end;
    }
    body.append(commentFree.slice(cursor, end), {
      spelling: span(document.uri, cursor, end - 1),
      editable: true,
    });
    const result = body.finish(document);
    if (!result.text.trim())
      diagnostics.push({
        message: `Macro ${name} has no expression`,
        span: span(document.uri, nameStart, nameStart + name.length - 1),
      });
    definitions.push({
      name,
      configuration: header.groups.configuration,
      source: span(document.uri, nameStart, nameStart + name.length - 1),
      directive,
      body: result.text,
      bodyMap: result.sourceMap,
    });
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const removal of removals) {
    chunks.push(
      document.text.slice(cursor, removal.start),
      mask(document.text.slice(removal.start, removal.end)),
    );
    cursor = removal.end;
  }
  chunks.push(document.text.slice(cursor));
  let removalIndex = 0;
  const outsideDirective = (offset: number) => {
    while (removals[removalIndex]?.end <= offset) removalIndex++;
    const removal = removals[removalIndex];
    return !removal || offset < removal.start;
  };
  const tokens = lexed.tokens.filter((token) =>
    outsideDirective(token.startOffset),
  );
  removalIndex = 0;
  // Closing delimiter tokens can legitimately pop a context supplied at use.
  // Invalid characters have no token and remain errors even in unused macros.
  const delimiters = new Set(
    lexed.tokens
      .filter(
        (token) =>
          token.tokenType.name === 'EndBrace' || token.tokenType.name === 'End',
      )
      .map((token) => token.startOffset),
  );
  const errors = lexed.errors.filter((error) => {
    if (outsideDirective(error.offset)) return true;
    if (!delimiters.has(error.offset))
      diagnostics.push({
        message: error.message,
        span: span(document.uri, error.offset, error.offset + error.length - 1),
      });
    return false;
  });
  const key =
    definitions.length || diagnostics.length
      ? createHash('sha256')
          .update(
            JSON.stringify([
              definitions.map((definition) => [
                definition.name,
                definition.configuration,
                definition.body,
                definition.source,
                definition.directive,
                definition.bodyMap.segments,
              ]),
              diagnostics,
              breaks.filter((offset) => offset <= (removals.at(-1)?.end ?? 0)),
            ]),
          )
          .digest('hex')
      : '';
  return {
    document,
    definitions,
    diagnostics,
    maskedText: chunks.join(''),
    lexed: { ...lexed, tokens, errors },
    key,
  };
}

/** Selection and pure token caches only; types are evaluated separately at each use. */
export class MacroEnvironment {
  readonly definitions = new Map<string, MacroDefinition>();
  readonly diagnostics: readonly MacroDiagnostic[];
  private readonly tokenCache = new Map<MacroDefinition, ILexingResult>();

  constructor(
    readonly collections: readonly MacroCollection[],
    readonly configLineage: readonly string[] = ['Default'],
  ) {
    const diagnostics: MacroDiagnostic[] = [];
    const priorities = new Map<string, number>();
    for (const collection of [...collections].sort((a, b) =>
      a.document.uri.localeCompare(b.document.uri),
    )) {
      diagnostics.push(...collection.diagnostics);
      for (const definition of collection.definitions) {
        const priority =
          definition.configuration === undefined
            ? -1
            : configLineage.indexOf(definition.configuration);
        if (definition.configuration !== undefined && priority < 0) continue;
        const previous = priorities.get(definition.name);
        if (previous === priority) {
          diagnostics.push({
            message: `Duplicate macro ${definition.name} for configuration ${definition.configuration || '(all)'}`,
            span: definition.source,
          });
        } else if (previous === undefined || priority > previous) {
          priorities.set(definition.name, priority);
          this.definitions.set(definition.name, definition);
        }
      }
    }
    this.diagnostics = diagnostics;
  }

  tokensFor(definition: MacroDefinition): ILexingResult {
    let lexed = this.tokenCache.get(definition);
    if (!lexed) {
      lexed = GmlLexer.tokenize(definition.body);
      this.tokenCache.set(definition, lexed);
    }
    return lexed;
  }

  expand(
    source: MacroCollection,
    options: MacroExpansionOptions = {},
  ): PreprocessedDocument {
    checkCancelled(options);
    const { document } = source;
    const dependencies = new Set(
      source.lexed.tokens.filter(isMacroWord).map((token) => token.image),
    );
    const references: MacroReference[] = [];
    const diagnostics = this.diagnostics.filter(
      (item) => item.span.uri === document.uri,
    );
    if (![...dependencies].some((name) => this.definitions.has(name))) {
      return {
        text: source.maskedText,
        lexed: source.lexed,
        references,
        diagnostics,
        dependencies,
      };
    }
    const maximum =
      options.maxExpandedCharacters ??
      Math.max(1_048_576, document.text.length * 32);
    const maximumSteps =
      options.maxExpansionSteps ?? Math.max(262_144, document.text.length * 8);
    let characters = 0;
    let steps = 0;
    let changed = false;
    const output = new MappedText();
    interface Frame {
      text: string;
      mapping: SourceMap;
      tokens: readonly IToken[];
      cursor: number;
      index: number;
      name?: string;
      invocation?: SourceSpan;
    }
    const root: Frame = {
      text: source.maskedText,
      mapping: new SourceMap(document),
      tokens: source.lexed.tokens,
      cursor: 0,
      index: 0,
    };
    const frames = [root];
    const active = new Set<string>();
    let checkpoint:
      | {
          chunks: number;
          segments: number;
          length: number;
          refs: number;
          characters: number;
          token: IToken;
          origin: SourceOrigin;
        }
      | undefined;
    const resourceFailure = {};
    const append = (text: string, origin: SourceOrigin) => {
      if (origin.expansion) {
        if (characters + text.length > maximum) throw resourceFailure;
        characters += text.length;
      }
      output.append(text, origin);
    };
    const originAt = (frame: Frame, from: number, to: number): SourceOrigin => {
      const origin = frame.mapping.origin(from, to);
      return frame.invocation
        ? { ...origin, expansion: frame.invocation, macroName: frame.name }
        : origin;
    };
    const mappedAppend = (frame: Frame, from: number, to: number) => {
      for (const segment of frame.mapping.segmentsInRange(from, to)) {
        const start = Math.max(from, segment.start);
        const end = Math.min(to, segment.end);
        append(frame.text.slice(start, end + 1), originAt(frame, start, end));
      }
    };
    while (frames.length) {
      checkCancelled(options);
      try {
        const frame = frames[frames.length - 1];
        if (frame !== root && ++steps > maximumSteps) throw resourceFailure;
        const token = frame.tokens[frame.index++];
        if (!token) {
          mappedAppend(frame, frame.cursor, frame.text.length - 1);
          frames.pop();
          if (frame.name) active.delete(frame.name);
          continue;
        }
        if (!isMacroWord(token)) continue;
        dependencies.add(token.image);
        const definition = this.definitions.get(token.image);
        if (!definition) continue;
        mappedAppend(frame, frame.cursor, token.startOffset - 1);
        const origin = originAt(
          frame,
          token.startOffset,
          token.endOffset ?? token.startOffset,
        );
        references.push({ name: definition.name, definition, origin });
        frame.cursor = (token.endOffset ?? token.startOffset) + 1;
        if (frame === root) {
          changed = true;
          checkpoint = {
            chunks: output.chunks.length,
            segments: output.segments.length,
            length: output.length,
            refs: references.length,
            characters,
            token,
            origin,
          };
        }
        if (active.has(definition.name)) {
          diagnostics.push({
            message: `Recursive macro expansion: ${[...active].slice(-8).concat(definition.name).join(' -> ')}`,
            span: frame.invocation || origin.spelling,
          });
          append(token.image, { ...origin, editable: false });
          continue;
        }
        // Stable logical work accounting: token caching saves CPU but never
        // changes whether the same source fits the analysis budget.
        steps += definition.body.length;
        if (steps > maximumSteps) throw resourceFailure;
        const lexed = this.tokensFor(definition);
        if (!lexed.tokens.length && !lexed.errors.length) {
          // Keep an incomplete invocation intact instead of erasing its context.
          append(token.image, { ...origin, editable: false });
          continue;
        }
        // A replacement may be a delimiter fragment. Lexical validity is
        // checked on the complete expanded document, in its real context.
        active.add(definition.name);
        frames.push({
          text: definition.body,
          mapping: definition.bodyMap,
          tokens: lexed.tokens,
          cursor: 0,
          index: 0,
          name: definition.name,
          invocation: frame.invocation || origin.spelling,
        });
      } catch (error) {
        if (error !== resourceFailure || !checkpoint) throw error;
        output.chunks.length = checkpoint.chunks;
        output.segments.length = checkpoint.segments;
        output.length = checkpoint.length;
        references.length = checkpoint.refs;
        characters = checkpoint.characters;
        output.append(checkpoint.token.image, checkpoint.origin);
        diagnostics.push({
          message: 'Macro expansion exceeded the analysis resource budget',
          span: checkpoint.origin.spelling,
        });
        frames.splice(1);
        active.clear();
        checkpoint = undefined;
      }
    }
    if (!changed)
      return {
        text: source.maskedText,
        lexed: source.lexed,
        references,
        diagnostics,
        dependencies,
      };
    return {
      ...output.finish(document),
      references,
      diagnostics,
      dependencies,
    };
  }
}
