import { createHash } from 'node:crypto';
import { GmlLexer } from '../lexer.js';
import {
  SourceMap,
  type SourceDocument,
  type SourceOrigin,
  type SourceSegment,
  type SourceSpan,
} from './source.js';

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
}

export interface MacroReference {
  readonly name: string;
  readonly definition: MacroDefinition;
  readonly origin: SourceOrigin;
}

export interface PreprocessedDocument {
  readonly text: string;
  readonly sourceMap: SourceMap;
  readonly definitions: readonly MacroDefinition[];
  readonly references: readonly MacroReference[];
  readonly diagnostics: readonly MacroDiagnostic[];
  /** Includes currently unresolved names, so adding a macro invalidates users. */
  readonly dependencies: ReadonlySet<string>;
}

function mask(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

function span(uri: string, start: number, end: number): SourceSpan {
  return { uri, start, end: Math.max(start, end) };
}

class MappedText {
  readonly chunks: string[] = [];
  readonly segments: SourceSegment[] = [];
  length = 0;

  append(text: string, origin: SourceOrigin): void {
    if (!text.length) return;
    this.chunks.push(text);
    this.segments.push({
      start: this.length,
      end: this.length + text.length - 1,
      origin,
    });
    this.length += text.length;
  }

  finish(document: SourceDocument): { text: string; sourceMap: SourceMap } {
    return {
      text: this.chunks.join(''),
      sourceMap: new SourceMap(document, this.segments),
    };
  }
}

function withoutComments(
  text: string,
  lexed: ReturnType<typeof GmlLexer.tokenize>,
): string {
  const comments = [
    ...(lexed.groups.comments || []),
    ...lexed.tokens.filter(
      (token) =>
        token.tokenType.name === 'JsdocGmlLine' ||
        token.tokenType.name === 'JsdocJs',
    ),
  ].sort((left, right) => left.startOffset - right.startOffset);
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

/** Collect directives before expansion: a macro is global, including forward uses. */
export function collectMacros(document: SourceDocument): MacroCollection {
  const definitions: MacroDefinition[] = [];
  const diagnostics: MacroDiagnostic[] = [];
  const removals: { start: number; end: number }[] = [];
  const lexed = GmlLexer.tokenize(document.text);
  const tokens = lexed.tokens;
  const commentFree = withoutComments(document.text, lexed);
  const continuations = new Map<number, { start: number; end: number }>();
  for (const token of tokens) {
    if (token.tokenType.name !== 'Escape') continue;
    const breakAt = document.text.slice(token.startOffset).search(/[\r\n]/);
    if (breakAt < 0) continue;
    const lineEnd = token.startOffset + breakAt;
    if (
      !continuations.has(lineEnd) &&
      /^[\t \\]*$/.test(commentFree.slice(token.startOffset + 1, lineEnd))
    ) {
      continuations.set(lineEnd, {
        start: token.startOffset,
        end: lineEnd + (document.text.startsWith('\r\n', lineEnd) ? 2 : 1),
      });
    }
  }
  let consumed = -1;
  for (const token of tokens) {
    if (token.tokenType.name !== 'Macro' || token.startOffset <= consumed)
      continue;
    const start = token.startOffset;
    let lineStart = start;
    let end = start;
    const joined: { start: number; end: number }[] = [];
    while (true) {
      const breakAt = document.text.slice(lineStart).search(/[\r\n]/);
      const lineEnd = breakAt < 0 ? document.text.length : lineStart + breakAt;
      end = lineEnd;
      const continuation = continuations.get(lineEnd);
      if (!continuation || lineEnd === document.text.length) break;
      joined.push(continuation);
      lineStart = continuation.end;
    }
    consumed = end - 1;
    removals.push({ start, end });
    const directive = span(document.uri, start, end - 1);
    const logical = document.text.slice(start, end);
    const header =
      /^#macro[\t ]+(?:(?<configuration>[^\s:]+):)?(?<name>[a-zA-Z_][a-zA-Z0-9_]*)(?=[\t ]|$)/.exec(
        logical,
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
    const body = document.text.slice(bodyStart, end);
    const mapped = new MappedText();
    let cursor = 0;
    for (const continuation of joined) {
      const offset = continuation.start - bodyStart;
      mapped.append(body.slice(cursor, offset), {
        spelling: span(
          document.uri,
          bodyStart + cursor,
          bodyStart + offset - 1,
        ),
        editable: true,
      });
      mapped.append(' ', {
        spelling: span(document.uri, bodyStart + offset, continuation.end - 1),
        editable: false,
      });
      cursor = continuation.end - bodyStart;
    }
    mapped.append(body.slice(cursor), {
      spelling: span(document.uri, bodyStart + cursor, end - 1),
      editable: true,
    });
    const result = mapped.finish(document);
    if (!result.text.trim()) {
      diagnostics.push({
        message: `Macro ${name} has no expression`,
        span: span(document.uri, nameStart, nameStart + name.length - 1),
      });
    }
    // Ordinary comments must not leak into the invocation's surrounding line.
    // Named lexer groups preserve their exact spans without another GML lexer.
    const bodyLexed = GmlLexer.tokenize(result.text);
    const cleaned = withoutComments(result.text, bodyLexed);
    for (const error of bodyLexed.errors) {
      diagnostics.push({
        message: `Macro ${name}: ${error.message}`,
        span: result.sourceMap.origin(
          error.offset,
          error.offset + Math.max(1, error.length) - 1,
        ).spelling,
      });
    }
    definitions.push({
      name,
      configuration: header.groups.configuration,
      source: span(document.uri, nameStart, nameStart + name.length - 1),
      directive,
      body: cleaned,
      bodyMap: result.sourceMap,
    });
  }
  let maskedText = document.text;
  for (const removal of removals.reverse()) {
    maskedText =
      maskedText.slice(0, removal.start) +
      mask(maskedText.slice(removal.start, removal.end)) +
      maskedText.slice(removal.end);
  }
  return { document, definitions, diagnostics, maskedText };
}

export interface MacroExpansionOptions {
  cancelled?: () => boolean;
  /** A resource budget, not a language nesting limit. Failure is explicit. */
  maxExpandedCharacters?: number;
}

export class MacroExpansionCancelled extends Error {
  constructor() {
    super('Macro expansion cancelled');
    this.name = 'MacroExpansionCancelled';
  }
}

/** One selected configuration's global macro definitions. */
export class MacroEnvironment {
  readonly definitions = new Map<string, MacroDefinition>();
  readonly diagnostics: readonly MacroDiagnostic[];
  readonly key: string;
  private readonly collections = new Map<string, MacroCollection>();

  constructor(
    collections: readonly MacroCollection[],
    readonly configLineage: readonly string[] = ['Default'],
  ) {
    const diagnostics: MacroDiagnostic[] = [];
    const ranked = new Map<
      string,
      { definition: MacroDefinition; priority: number }
    >();
    const ordered = [...collections].sort((left, right) =>
      left.document.uri.localeCompare(right.document.uri),
    );
    for (const collection of ordered) {
      this.collections.set(collection.document.uri, collection);
      diagnostics.push(...collection.diagnostics);
      for (const definition of collection.definitions) {
        const priority =
          definition.configuration === undefined
            ? -1
            : configLineage.indexOf(definition.configuration);
        if (definition.configuration !== undefined && priority < 0) continue;
        const previous = ranked.get(definition.name);
        if (previous?.priority === priority) {
          diagnostics.push({
            message: `Duplicate macro ${definition.name} for configuration ${definition.configuration || '(all)'}`,
            span: definition.source,
          });
          continue;
        }
        if (!previous || priority > previous.priority)
          ranked.set(definition.name, { definition, priority });
      }
    }
    for (const [name, item] of ranked)
      this.definitions.set(name, item.definition);
    this.diagnostics = diagnostics;
    this.key = createHash('sha256')
      .update(
        JSON.stringify([
          configLineage,
          [...this.definitions].map(([name, definition]) => [
            name,
            definition.body,
            definition.source,
            definition.configuration,
            definition.bodyMap.segments,
          ]),
        ]),
      )
      .digest('hex');
  }

  expand(
    document: SourceDocument,
    options: MacroExpansionOptions = {},
  ): PreprocessedDocument {
    const collection = this.collections.get(document.uri);
    const source =
      collection?.document.text === document.text
        ? collection
        : collectMacros(document);
    const output = new MappedText();
    const references: MacroReference[] = [];
    const diagnostics: MacroDiagnostic[] = this.diagnostics.filter(
      (diagnostic) => diagnostic.span.uri === document.uri,
    );
    if (!collection) diagnostics.push(...source.diagnostics);
    const dependencies = new Set<string>();
    // Acyclic macros can still expand exponentially. Bound materialization and
    // report the affected invocation rather than exhausting the editor host.
    const maximum =
      options.maxExpandedCharacters ??
      Math.max(1_048_576, document.text.length * 32);
    let budgetExceeded = false;
    const append = (text: string, origin: SourceOrigin): boolean => {
      if (budgetExceeded) return false;
      if (output.length + text.length > maximum) {
        diagnostics.push({
          message: 'Macro expansion exceeded the analysis resource budget',
          span: origin.expansion || origin.spelling,
        });
        budgetExceeded = true;
        return false;
      }
      output.append(text, origin);
      return true;
    };
    type Tokens = ReturnType<typeof GmlLexer.tokenize>['tokens'];
    interface Frame {
      text: string;
      mapping: SourceMap;
      tokens: Tokens;
      cursor: number;
      index: number;
      name?: string;
      expansionStack: readonly SourceSpan[];
    }
    const tokenCache = new Map<MacroDefinition, Tokens>();
    const frames: Frame[] = [
      {
        text: source.maskedText,
        mapping: new SourceMap(document),
        tokens: GmlLexer.tokenize(source.maskedText).tokens,
        cursor: 0,
        index: 0,
        expansionStack: [],
      },
    ];
    const active = new Set<string>();
    const mappedAppend = (frame: Frame, from: number, to: number) => {
      for (const segment of frame.mapping.segmentsInRange(from, to)) {
        const start = Math.max(from, segment.start);
        const end = Math.min(to, segment.end);
        const original = frame.mapping.origin(start, end);
        const origin: SourceOrigin = frame.expansionStack.length
          ? {
              ...original,
              expansion: frame.expansionStack[0],
              expansionStack: frame.expansionStack,
              macroName: frame.name,
            }
          : original;
        if (!append(frame.text.slice(start, end + 1), origin)) return;
      }
    };
    // Use an explicit stack: a deep acyclic chain is valid and must not depend
    // on the JavaScript call-stack limit. The active set detects actual cycles.
    while (frames.length && !budgetExceeded) {
      if (options.cancelled?.()) throw new MacroExpansionCancelled();
      const frame = frames[frames.length - 1];
      const token = frame.tokens[frame.index++];
      if (!token) {
        mappedAppend(frame, frame.cursor, frame.text.length - 1);
        frames.pop();
        if (frame.name) active.delete(frame.name);
        continue;
      }
      if (token.tokenType.name !== 'Identifier') continue;
      dependencies.add(token.image);
      const definition = this.definitions.get(token.image);
      if (!definition) continue;
      mappedAppend(frame, frame.cursor, token.startOffset - 1);
      const original = frame.mapping.origin(
        token.startOffset,
        token.endOffset ?? token.startOffset,
      );
      const origin: SourceOrigin = frame.expansionStack.length
        ? {
            ...original,
            expansion: frame.expansionStack[0],
            expansionStack: frame.expansionStack,
            macroName: frame.name,
          }
        : original;
      references.push({ name: definition.name, definition, origin });
      frame.cursor = (token.endOffset ?? token.startOffset) + 1;
      if (active.has(definition.name)) {
        diagnostics.push({
          message: `Recursive macro expansion: ${[...active, definition.name].join(' -> ')}`,
          span: frame.expansionStack[0] || original.spelling,
        });
        append(token.image, { ...origin, editable: false });
        continue;
      }
      let tokens = tokenCache.get(definition);
      if (!tokens) {
        tokens = GmlLexer.tokenize(definition.body).tokens;
        tokenCache.set(definition, tokens);
      }
      active.add(definition.name);
      frames.push({
        text: definition.body,
        mapping: definition.bodyMap,
        tokens,
        cursor: 0,
        index: 0,
        name: definition.name,
        expansionStack: [...frame.expansionStack, original.spelling],
      });
    }
    const result = output.finish(document);
    return {
      ...result,
      definitions: source.definitions,
      references,
      diagnostics,
      dependencies,
    };
  }
}
