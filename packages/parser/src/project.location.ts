import type { CstNodeLocation, IToken } from 'chevrotain';
import { tokenMatcher } from 'chevrotain';
import { GmlLexer } from './lexer.js';
import { c } from './tokens.categories.js';
import type { Code } from './project.code.js';
import type { Signifier } from './signifiers.js';
import { EnumType, FunctionType, StructType, WithableType } from './types.js';
import { assert } from './util.js';
import type { ReferenceRole, RenameRecipe } from './analysis/model.js';
import type { SourceOrigin } from './syntax/source.js';
import type { Type, TypeStore } from './types.js';

export const firstLineIndex = 1;
export const firstColumnIndex = 1;

export type CstLocation = Required<CstNodeLocation>;
export interface IPosition {
  offset: number;
  line: number;
  column: number;
}

export interface IRange {
  start: IPosition;
  end: IPosition;
}

/**
 * Single-character tokens do not have correct end
 * location information. This function checks the `image`
 * of the token and fixes the end location if necessary.
 */
export function fixITokenLocation(token: IToken) {
  assert(typeof token.image === 'string', 'Token must have an image');
  const length = token.image.length;
  if (token.endOffset === token.startOffset) {
    token.endOffset += length;
  }
  if (token.endColumn === token.startColumn) {
    token.endColumn! += length;
  }
  return token;
}

export type LinePosition = { line: number; column: number };

export class Position implements IPosition {
  readonly $tag = 'Pos';
  constructor(
    readonly file: Code,
    public offset: number,
    public line: number,
    public column: number,
  ) {}

  /**
   * Create a new Positiong instance within this same file
   * at the given location. */
  at(loc: CstNodeLocation): Position {
    return Position.fromCstStart(this.file, loc);
  }

  /**
   * Create a new location starting at the end of
   * the given location.
   */
  atEnd(loc: CstNodeLocation): Position {
    return Position.fromCstEnd(this.file, loc);
  }

  equals(other: Position) {
    return Position.equals(this, other);
  }

  static from(
    file: Code,
    loc: CstNodeLocation | Position | IPosition,
    fromTokenEnd = false,
  ): Position {
    if (loc instanceof Position) {
      return loc;
    }
    if ('offset' in loc) {
      return new Position(file, loc.offset, loc.line, loc.column);
    }
    return fromTokenEnd
      ? Position.fromCstEnd(file, loc)
      : Position.fromCstStart(file, loc);
  }

  static fromFileStart(fileName: Code) {
    return new Position(fileName, 0, firstLineIndex, firstColumnIndex);
  }

  static fromCstStart(fileName: Code, location: CstNodeLocation) {
    return new Position(
      fileName,
      location.startOffset ?? 0,
      location.startLine ?? firstLineIndex,
      location.startColumn ?? firstColumnIndex,
    );
  }

  static fromCstEnd(fileName: Code, location: CstNodeLocation) {
    return new Position(
      fileName,
      location.endOffset ?? 0,
      location.endLine ?? firstLineIndex,
      location.endColumn ?? firstColumnIndex,
    );
  }

  static equals(a: Position, b: Position) {
    return a.file === b.file && a.offset === b.offset;
  }
}

export function isRange(value: unknown): value is Range {
  return value instanceof Range;
}

export class Range implements IRange {
  $tag = 'Range';
  public start: Position;
  public end: Position;

  constructor(start: Position, end?: Position) {
    // We can get into some weird cases when recovering
    // from parse errors, so do some checks with graceful
    // recovery.
    this.start = start;
    this.end = end ?? start;
    if (this.end.offset < this.start.offset) {
      this.end = this.start;
    }
  }

  get file(): Code {
    return this.start.file;
  }

  static from(file: Code, location: IRange | CstNodeLocation): Range {
    if ('start' in location) {
      return new Range(
        Position.from(file, location.start),
        Position.from(file, location.end),
      );
    }
    return Range.fromCst(file, location);
  }

  static fromCst(fileName: Code, location: CstNodeLocation) {
    return new Range(
      Position.fromCstStart(fileName, location),
      Position.fromCstEnd(fileName, location),
    );
  }

  static equals(a: Range, b: Range) {
    return Position.equals(a.start, b.start) && Position.equals(a.end, b.end);
  }
}

/**
 * A code range corresponding with a specific function argument.
 * Useful for providing signature help.
 */
export class FunctionArgRange extends Range {
  override $tag = 'ArgRange';
  hasExpression = false;
  constructor(
    /** The function reference this call belongs to */
    readonly type: FunctionType,
    /** The index of the parameter we're in. */
    readonly idx: number,
    start: Position,
    end?: Position,
  ) {
    super(start, end);
  }

  get param(): Signifier {
    assert(this.type, 'FunctionArgRange must have a type');
    return this.type.getParameter(this.idx)!;
  }
}

export class StructNewMemberRange extends Range {
  override $tag = 'NewMemberRange';
  constructor(
    /** The function reference this call belongs to */
    readonly type: StructType,
    start: Position,
    end?: Position,
  ) {
    super(start, end);
  }
}

export const enum ScopeFlag {
  DotAccessor = 1 << 0,
}

export interface CompletionCandidate {
  readonly name: string;
  /** Real storage identities; a shared name does not create a new symbol. */
  readonly symbols: readonly Signifier[];
  readonly type: TypeStore;
  /** Receiver branch coverage, independent of the number of symbol identities. */
  readonly availability: { readonly present: number; readonly total: number };
}

export class Scope extends Range {
  override readonly $tag = 'Scope';
  /** The immediately adjacent ScopeRange */
  protected _next: Scope | undefined = undefined;
  public flags = 0;
  /** Query-only alternatives. An unknown receiver contributes no members. */
  public dotReceivers: readonly Type[] | undefined;
  public memberTypes: ReadonlyMap<Signifier, TypeStore> | undefined;
  constructor(
    start: Position,
    public local: StructType,
    public self: WithableType | EnumType,
  ) {
    super(start);
  }

  set isDotAccessor(value: boolean) {
    if (value) {
      this.flags |= ScopeFlag.DotAccessor;
    } else {
      this.flags &= ~ScopeFlag.DotAccessor;
    }
  }
  get isDotAccessor(): boolean {
    return !!(this.flags & ScopeFlag.DotAccessor);
  }

  setEnd(atToken: CstNodeLocation | Position, fromTokenEnd = false) {
    this.end = Position.from(this.file, atToken, fromTokenEnd);
  }

  /**
   * Create the next ScopeRange, adjacent to this one.
   * This sets the end location of this scope range to
   * match the start location of the next one. The self
   * and local values default to the same as this scope range,
   * so at least one will need to be changed!
   */
  createNext(atToken: CstNodeLocation, fromTokenEnd = false): Scope {
    assert(
      this.end,
      'Cannot create a next scope range without an end to this one.',
    );
    assert(
      !this._next,
      'Cannot create a next scope range when one already exists.',
    );
    const start = Position.from(this.file, atToken, fromTokenEnd);
    this._next = new Scope(start, this.local, this.self);
    return this._next;
  }
}

export type ReferenceableType = Signifier;

export class Reference extends Range {
  override readonly $tag = 'Ref';
  /** If this is reference marks the declaration */
  isDef = false;
  protected _itemNamePattern: RegExp | undefined = undefined;
  /** Semantic contribution owner; physical spelling may belong to another file. */
  ownerUnitId: string | undefined;
  /** Current-unit query location for a macro expansion. The edit range stays physical. */
  queryRange: Range | undefined;
  origin: SourceOrigin | undefined;
  evaluatedType: TypeStore | undefined;
  role: ReferenceRole | undefined;
  rename: RenameRecipe | undefined;

  constructor(
    public item: Signifier,
    start: Position,
    end: Position,
  ) {
    super(start, end);
  }

  get itemNamePattern(): RegExp {
    if (!this._itemNamePattern) {
      // Qualified annotations refer to their final name, not an equally named
      // namespace prefix (for example the constructor in Struct.Struct).
      this._itemNamePattern = new RegExp(
        `\\b(?<name>${this.item.name})\\b${this.role === 'type' ? '$' : ''}`,
      );
    }
    return this._itemNamePattern;
  }

  /**
   * The text in this ref's range, which does not necessarily match
   * the text of the item it refers to (e.g. it could be `self` or similar)
   */
  get text(): string {
    return this.start.file.content.slice(
      this.start.offset,
      this.end.offset + 1,
    );
  }

  get isRenameable(): boolean {
    const text = this.text;
    return (
      this.rename?.kind !== 'none' &&
      this.rename?.kind !== 'implicit' &&
      (this.rename?.kind === 'string-key'
        ? !this.item.native && !this.item.resourceDefinition && !this.item.asset
        : this.item.isRenameable && this.itemNamePattern.test(text))
    );
  }

  /**
   * Get full text content of this reference if what it referenced were
   * to be renamed to the given name. This **does not** actually rename
   * the identifier!
   */
  toRenamed(newName: string): string {
    switch (this.rename?.kind) {
      case 'none':
      case 'implicit':
        return this.text;
      case 'shorthand-value':
        return `${this.rename.property}: ${newName}`;
      case 'shorthand-property':
        return `${newName}: ${this.rename.value}`;
      case 'string-key':
        // Canonical escaped strings preserve the actual key, including keys
        // originally written as verbatim literals or containing control chars.
        return JSON.stringify(newName);
      default:
        return this.text.replace(this.itemNamePattern, newName);
    }
  }

  static fromRange(range: Range, item: ReferenceableType) {
    assert(range, 'Cannot create a reference from an undefined range.');
    return new Reference(item, range.start, range.end);
  }
}

export interface ReferenceRenameEdit {
  readonly range: Range;
  readonly text: string;
}

/** Validate the complete operation before producing any edits. */
export function planReferenceRename(
  references: Iterable<Reference>,
  newName: string,
  allReferences?: Iterable<Reference>,
): ReferenceRenameEdit[] {
  const selected = [...references];
  const universe = allReferences && [...allReferences];
  const edits = new Map<string, ReferenceRenameEdit>();
  const targets = new Set(selected.map((reference) => reference.item));
  const quotedOnly =
    selected.length > 0 &&
    selected.every((ref) => ref.rename?.kind === 'string-key');
  const tokens = GmlLexer.tokenize(newName);
  const token = tokens.tokens[0];
  const propertyOnly =
    selected.length > 0 &&
    selected.every(
      (reference) =>
        reference.rename?.kind === 'string-key' ||
        reference.rename?.kind === 'shorthand-property' ||
        (reference.rename?.kind === 'identifier' && reference.rename.property),
    );
  if (
    !quotedOnly &&
    (tokens.errors.length ||
      tokens.tokens.length !== 1 ||
      token.image !== newName ||
      !(
        token.tokenType.name === 'Identifier' ||
        (propertyOnly && tokenMatcher(token, c.Keyword))
      ))
  )
    throw new Error(
      'The new name must be a valid GML identifier for every reference.',
    );
  for (const target of targets) {
    const existing = target.parent.getMember(newName);
    if (existing && existing !== target && !existing.placeholder)
      throw new Error(
        `The name ${newName} already exists in this storage scope.`,
      );
  }
  const possibleCaptures = universe || [
    ...new Set(selected.flatMap((reference) => reference.file.refs || [])),
  ];
  for (const reference of possibleCaptures) {
    if (
      targets.has(reference.item) ||
      reference.item.name !== newName ||
      reference.role === 'type'
    )
      continue;
    const recipe = reference.rename;
    if (
      recipe &&
      recipe.kind !== 'shorthand-value' &&
      !(recipe.kind === 'identifier' && !recipe.property)
    )
      continue;
    const query = reference.queryRange || reference;
    const scope = query.file.getScopeRangeAt?.(query.start.offset);
    if (
      [...targets].some(
        (target) => scope?.local.getMember(target.name) === target,
      )
    )
      throw new Error(
        `The name ${newName} would capture another symbol's existing references.`,
      );
  }
  for (const reference of selected) {
    const recipe = reference.rename;
    if (recipe?.kind === 'implicit') continue;
    if (
      reference.role !== 'type' &&
      (recipe?.kind === 'shorthand-value' ||
        (recipe?.kind === 'identifier' && !recipe.property) ||
        !recipe)
    ) {
      const query = reference.queryRange || reference;
      const scope = query.file.getScopeRangeAt?.(query.start.offset);
      const existing = scope?.local.getMember(newName);
      if (existing && !targets.has(existing) && !existing.placeholder)
        throw new Error(
          `The name ${newName} would be captured by another local symbol.`,
        );
    }
    if (!reference.isRenameable) {
      if (reference.rename?.kind === 'none')
        throw new Error(
          'A reference has no safe source edit; rename would be incomplete.',
        );
      continue;
    }
    if (reference.origin?.expansion && !universe)
      throw new Error(
        'Renaming macro-expanded bindings requires all expansion references.',
      );
    const peers = universe || reference.file.refs || [];
    const conflict = peers.some((other) => {
      if (
        other.file !== reference.file ||
        other.start.offset !== reference.start.offset ||
        other.end.offset !== reference.end.offset ||
        targets.has(other.item)
      )
        return false;
      // Expanding an ordinary shorthand explicitly preserves its other role.
      const shorthandPair =
        !reference.origin?.expansion &&
        ((reference.role === 'shorthand-value' &&
          other.role === 'shorthand-property') ||
          (reference.role === 'shorthand-property' &&
            other.role === 'shorthand-value'));
      return !shorthandPair;
    });
    if (conflict)
      throw new Error(
        reference.origin?.expansion
          ? 'The macro spelling denotes different symbols in different expansions.'
          : 'The source spelling denotes different symbols; rename would be ambiguous.',
      );
    const key = `${reference.file.path.absolute}:${reference.start.offset}:${reference.end.offset}`;
    const text = reference.toRenamed(newName);
    const prior = edits.get(key);
    if (prior && prior.text !== text)
      throw new Error(
        'Overlapping reference roles require incompatible rename edits.',
      );
    if (text !== reference.text) edits.set(key, { range: reference, text });
  }
  return [...edits.values()];
}
