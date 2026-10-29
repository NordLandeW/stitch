import { Range } from './project.location.js';
import type { Signifier } from './signifiers.js';
import { assertIsValidIdentifier } from './util.js';
import { GmlLexer } from './lexer.js';

export interface RenameEdit {
  readonly range: Range;
  readonly text: string;
}

/** Validate the complete physical edit plan before any caller publishes writes. */
export function createRenameEdits(
  symbol: Signifier,
  newName: string,
  replacement?: Signifier,
): RenameEdit[] {
  assertIsValidIdentifier(newName);
  if (
    replacement &&
    (!symbol.asset ||
      !replacement.asset ||
      replacement.parent !== symbol.parent ||
      replacement.name !== newName)
  ) {
    throw new Error(
      'A rename replacement must be the corresponding asset in the same project',
    );
  }
  if (
    !symbol.macro &&
    GmlLexer.tokenize(newName).tokens[0]?.tokenType.name !== 'Identifier'
  ) {
    throw new Error(`Reserved word is not a variable identifier: ${newName}`);
  }
  if (!symbol.isRenameable) throw new Error('Cannot rename this symbol');
  if (symbol.macro && ![...symbol.refs].some((reference) => reference.isDef)) {
    throw new Error('This macro has no editable GML declaration');
  }
  const project = symbol.refs.values().next().value?.file.project;
  if (
    symbol.macro &&
    newName !== symbol.name &&
    project?.macros.hasUnexpandedCodeUse(symbol.name)
  ) {
    throw new Error(
      'Select an active configuration for this macro before renaming its unexpanded uses',
    );
  }
  const edits = new Map<string, RenameEdit>();
  const bindings = new Map<Range['file'], Map<string, Set<Signifier>>>();
  const spanKey = (range: Range) => `${range.start.offset}:${range.end.offset}`;
  const symbolsAt = (source: Range) => {
    let index = bindings.get(source.file);
    if (!index) {
      bindings.set(source.file, (index = new Map()));
      for (const reference of source.file.sourceRefs) {
        const key = spanKey(reference.source);
        let items = index.get(key);
        if (!items) index.set(key, (items = new Set()));
        items.add(reference.item);
      }
    }
    return index.get(spanKey(source)) || new Set<Signifier>();
  };
  for (const reference of symbol.refs) {
    if (
      !reference.sourceEditable &&
      reference.itemNamePattern.test(reference.text)
    ) {
      throw new Error(
        'Cannot safely rename a symbol with a non-editable source spelling',
      );
    }
    if (!reference.isScopeKeyword && reference.hasScopeKeywordUse) {
      throw new Error(
        'Cannot rename a shared spelling used as a fixed scope keyword',
      );
    }
    if (!reference.isRenameable) continue;
    const source = reference.source;
    const project = reference.file.project;
    if (newName !== symbol.name) {
      if (
        project.macros.hasName(newName) ||
        (symbol.macro && project.macros.hasIdentifier(newName))
      ) {
        throw new Error(
          `Renaming to ${newName} would capture an existing macro or identifier`,
        );
      }
      const scope = symbol.macro
        ? reference.file.getScopeRangeAt(source.start.offset)
        : reference.file.getAnalysisScopeAt(reference.start.offset);
      // Literal member declarations and qualified accesses resolve in their
      // own container; unrelated lexical globals cannot capture those names.
      const memberOnly =
        scope?.isDotAccessor ||
        (reference.isDef && symbol.instance && symbol.parent !== scope?.self);
      const owners = memberOnly
        ? [symbol.parent]
        : [symbol.parent, scope?.local, scope?.self, project.self];
      for (const owner of owners) {
        const existing = owner?.getMember(newName);
        if (existing && existing !== symbol && existing !== replacement)
          throw new Error(
            `A different symbol named ${newName} is already in scope`,
          );
      }
    }
    if ([...symbolsAt(source)].some((other) => other !== symbol)) {
      throw new Error(
        'Cannot rename a shared macro spelling that binds to different symbols',
      );
    }
    const text = reference.toRenamed(newName);
    if (text === reference.text) continue;
    const key = `${source.file.path.absolute}:${source.start.offset}:${source.end.offset}`;
    const previous = edits.get(key);
    if (previous && previous.text !== text)
      throw new Error('Conflicting replacements for a shared source spelling');
    edits.set(key, { range: source, text });
  }
  const ordered = [...edits.values()].sort(
    (a, b) =>
      a.range.file.path.absolute.localeCompare(b.range.file.path.absolute) ||
      a.range.start.offset - b.range.start.offset,
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1].range;
    const current = ordered[index].range;
    if (
      previous.file === current.file &&
      current.start.offset <= previous.end.offset
    ) {
      throw new Error('Overlapping source ranges cannot be renamed safely');
    }
  }
  return ordered;
}
