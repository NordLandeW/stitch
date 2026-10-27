import type { JsdocSummary } from '../jsdoc.js';
import {
  Diagnostic,
  type DiagnosticCollections,
} from '../project.diagnostics.js';
import {
  FunctionArgRange,
  Position,
  Range,
  Reference,
  Scope,
  StructNewMemberRange,
} from '../project.location.js';
import {
  Type,
  TypeStore,
  type FunctionType,
  type StructType,
  type WithableType,
} from '../types.js';
import { Signifier } from '../signifiers.js';
import type {
  CodeSemanticView,
  MaterializationHost,
  SourceOrigin,
  SourceSpan,
  SymbolContribution,
  UnitEvaluation,
} from './model.js';
import { value } from './values.js';

type SourceLocationHost = Pick<MaterializationHost, 'source'>;
const sourceRangeFactories = new WeakMap<
  SourceLocationHost,
  ReturnType<typeof createSourceRanges>
>();
function createSourceRanges(host: SourceLocationHost) {
  const lineStarts = new Map<string, { text: string; starts: number[] }>();
  function position(uri: string, offset: number): Position {
    const document = host.source(uri);
    if (!document)
      throw new Error(
        `Source document is unavailable while materializing ${uri}`,
      );
    offset = Math.max(0, Math.min(offset, document.text.length));
    const cached = lineStarts.get(uri);
    let starts = cached?.text === document.text ? cached.starts : undefined;
    if (!starts) {
      starts = [0];
      for (let index = 0; index < document.text.length; index++)
        if (document.text[index] === '\n') starts.push(index + 1);
      lineStarts.set(uri, { text: document.text, starts });
    }
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return new Position(
      document.file,
      offset,
      low + 1,
      offset - starts[low] + 1,
    );
  }
  function span(source: SourceSpan): Range {
    return new Range(
      position(source.uri, source.start),
      position(source.uri, source.end),
    );
  }
  return (origin: SourceOrigin, anchor = false): Range =>
    span(anchor && origin.expansion ? origin.expansion : origin.spelling);
}
export function materializeSourceRange(
  origin: SourceOrigin,
  host: SourceLocationHost,
  anchor = false,
): Range {
  let factory = sourceRangeFactories.get(host);
  if (!factory) {
    factory = createSourceRanges(host);
    sourceRangeFactories.set(host, factory);
  }
  return factory(origin, anchor);
}

/** Build public query objects without registering refs or publishing diagnostics. */
export function materializeUnit(
  result: UnitEvaluation,
  host: MaterializationHost,
): CodeSemanticView {
  const range = (origin: SourceOrigin, anchor = false) =>
    materializeSourceRange(origin, host, anchor);
  function currentType(store: TypeStore): TypeStore {
    const current = new TypeStore();
    current.type = store.type.map((type) => host.value(type));
    return current;
  }
  const refs = result.references.map((reference) => {
    const location = range(reference.origin);
    const ref = new Reference(
      host.symbol(reference.symbol),
      location.start,
      location.end,
    );
    ref.ownerUnitId = result.unitId;
    ref.origin = reference.origin;
    const definition = host.definition?.(reference.symbol)?.spelling;
    const spelling = reference.origin.spelling;
    ref.isDef =
      !ref.item.resourceDefinition &&
      reference.isDefinition &&
      (!host.definition ||
        (!!definition &&
          definition.uri === spelling.uri &&
          definition.start === spelling.start &&
          definition.end === spelling.end));
    ref.role =
      ref.item.resourceDefinition && reference.role === 'declaration'
        ? 'write'
        : reference.role;
    ref.rename = ref.item.resourceDefinition
      ? { kind: 'none' }
      : reference.rename;
    ref.evaluatedType = currentType(reference.type);
    if (reference.origin.expansion)
      ref.queryRange = range(reference.origin, true);
    return ref;
  });
  // At a shorthand token the value role is the conventional point-query target.
  refs.sort(
    (a, b) =>
      (a.queryRange || a).start.offset - (b.queryRange || b).start.offset ||
      (a.role === 'shorthand-value'
        ? -1
        : b.role === 'shorthand-value'
          ? 1
          : 0),
  );
  const scopes = result.scopes.map((scope) => {
    const location = range(scope.origin, true);
    const current = new Scope(
      location.start,
      host.type(scope.local) as StructType,
      host.type(scope.self) as WithableType,
    );
    current.end = location.end;
    current.isDotAccessor = scope.dot;
    current.dotReceivers = scope.receivers?.type.map((type) =>
      host.value(type),
    );
    if (scope.memberTypes) {
      const memberTypes = new Map<Signifier, TypeStore>();
      for (const [key, type] of scope.memberTypes) {
        if (!host.hasSymbol(key)) continue;
        const symbol = host.symbol(key);
        memberTypes.set(
          symbol,
          value(memberTypes.get(symbol), currentType(type)),
        );
      }
      current.memberTypes = memberTypes;
    }
    return current;
  });
  // Existing Code chooses the first containing scope: more precise scopes win.
  scopes.sort(
    (a, b) =>
      Number(b.isDotAccessor) - Number(a.isDotAccessor) ||
      a.end.offset - a.start.offset - (b.end.offset - b.start.offset) ||
      a.start.offset - b.start.offset,
  );
  const functionArgRanges: FunctionArgRange[] = [];
  const functionCalls: FunctionArgRange[][] = [];
  for (const call of result.calls) {
    const type = host.value(call.type) as FunctionType;
    const arguments_ = call.arguments.map((argument, index) => {
      const location = range(argument.origin, true);
      const current = new FunctionArgRange(
        type,
        index,
        location.start,
        location.end,
      );
      current.hasExpression = argument.hasExpression;
      functionArgRanges.push(current);
      return current;
    });
    functionCalls.push(arguments_);
  }
  const structNewMemberRanges = result.structRanges.map((entry) => {
    const location = range(entry.origin, true);
    return new StructNewMemberRange(
      host.type(entry.type) as StructType,
      location.start,
      location.end,
    );
  });
  const diagnostics: Partial<DiagnosticCollections> = {};
  for (const diagnostic of result.diagnostics) {
    (diagnostics[diagnostic.collection] ||= []).push(
      new Diagnostic(
        diagnostic.message,
        range(diagnostic.origin, true),
        diagnostic.severity,
      ),
    );
  }
  function mapDoc<T>(input: T): T {
    if (!input || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(mapDoc) as T;
    const source = input as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source))
      if (key !== 'start' && key !== 'end') copy[key] = mapDoc(entry);
    const start = source.start as { offset: number } | undefined;
    const end = source.end as { offset: number } | undefined;
    if (start && end) {
      const location = range(
        result.bound.syntax.input.origin(start.offset, end.offset),
        true,
      );
      copy.start = {
        offset: location.start.offset,
        line: location.start.line,
        column: location.start.column,
      };
      copy.end = {
        offset: location.end.offset,
        line: location.end.line,
        column: location.end.column,
      };
    } else {
      if ('start' in source) copy.start = source.start;
      if ('end' in source) copy.end = source.end;
    }
    return copy as T;
  }
  const jsdocs = result.bound.syntax.jsdocs.map(
    (doc): JsdocSummary => mapDoc(doc),
  );
  for (const doc of jsdocs)
    for (const diagnostic of doc.diagnostics) {
      (diagnostics.JSDOC ||= []).push(
        new Diagnostic(diagnostic.message, diagnostic, 'warning'),
      );
    }
  return {
    refs,
    scopes,
    jsdocs,
    functionArgRanges,
    functionCalls,
    structNewMemberRanges,
    callsSuper: result.callsSuper,
    diagnostics,
  };
}

function mappedStore(
  source: TypeStore | undefined,
  host: MaterializationHost,
): TypeStore | undefined {
  return source && value(...source.type.map((type) => host.value(type)));
}
function canonicalMember(
  source: Signifier,
  host: MaterializationHost,
): Signifier | undefined {
  // Borrowed type shapes may still contain a member from the unit currently
  // being replaced or retired. Only a surviving symbol owner can publish it.
  if (source.semanticKey)
    return host.hasSymbol(source.semanticKey)
      ? host.symbol(source.semanticKey)
      : undefined;
  // Native generic parameters and annotation-only members may be anonymous.
  const member = new Signifier(host.value(source.parent), source.name);
  member.replaceMetadata(source, mappedStore(source.type, host)!);
  member.replaceDefinition(source.def, source.declaration);
  return member;
}

/** Replace all owned fields, using only this generation's complete contribution set. */
export function installTypeContributions(
  sources: readonly Type[],
  target: Type,
  host: MaterializationHost,
): void {
  if (!sources.length) {
    target.replaceOwnMembers([]);
    target.setBaseView(undefined);
    target.items = undefined;
    target.local = undefined;
    target.self = undefined;
    target.statics = undefined;
    target.returns = undefined;
    target.name = undefined;
    target.description = undefined;
    target.isConstructor = false;
    target.functionSource = undefined;
    target.methodSource = undefined;
    return;
  }
  const source =
    sources.find(
      (entry) => entry.kind === 'Function' || entry.name || entry.signifier,
    ) || sources[0];
  if (target.kind !== source.kind) target.kind = source.kind;
  target.semanticKey = source.semanticKey || target.semanticKey;
  target.name = source.name;
  target.description = source.description;
  target.isConstructor = sources.some((entry) => entry.isConstructor);
  target.isGeneric = source.isGeneric;
  target.isReadonly = source.isReadonly;
  target.callKind = source.callKind;
  target.functionSource = source.functionSource;
  target.methodSource =
    source.methodSource &&
    (host.value(source.methodSource) as FunctionType | undefined);
  target.literalValue = source.literalValue;
  target.nullPointer = source.nullPointer;
  target.local =
    source.local && (host.value(source.local) as StructType | undefined);
  target.self =
    source.self && (host.value(source.self) as WithableType | undefined);
  target.statics =
    source.statics && (host.value(source.statics) as StructType | undefined);
  const base = sources.find((entry) => entry.extends)?.extends;
  target.setBaseView(base && host.value(base));
  const signifier = source.signifier;
  target._signifier = signifier ? canonicalMember(signifier, host) : undefined;
  const items = sources.flatMap((entry) => entry.items?.type || []);
  const returns = sources.flatMap((entry) => entry.returns?.type || []);
  target.items = sources.some((entry) => !!entry.items)
    ? value(...items.map((entry) => host.value(entry)))
    : undefined;
  target.returns = sources.some((entry) => !!entry.returns)
    ? value(...returns.map((entry) => host.value(entry)))
    : undefined;
  const members = new Map<string, Signifier>();
  for (const candidate of sources)
    for (const member of candidate.listMembers(true)) {
      if (!members.has(member.name)) {
        const current = canonicalMember(member, host);
        if (current) members.set(member.name, current);
      }
    }
  target.replaceOwnMembers(members.values());
}

/** Copy metadata once, then merge values from all surviving storage contributions. */
export function installSymbolContributions(
  sources: readonly SymbolContribution[],
  target: Signifier,
  host: MaterializationHost,
): void {
  if (!sources.length) {
    target.resourceDefinition = undefined;
    target.replaceDefinition(undefined);
    target.setType([]);
    return;
  }
  const intrinsic = sources.filter(
    (source) => source.intrinsic || !!source.item.native,
  );
  const effective = intrinsic.length ? intrinsic : sources;
  const ordered = [...effective].sort(
    (a, b) =>
      Number(!!b.declaration) - Number(!!a.declaration) ||
      Number(b.item.definitive) - Number(a.item.definitive) ||
      a.unitId.localeCompare(b.unitId) ||
      (a.origin?.spelling.start || 0) - (b.origin?.spelling.start || 0),
  );
  const source = ordered[0];
  target.semanticKey = source.key;
  const resourceDefinition = sources.find(
    (entry) => entry.item.resourceDefinition?.unitId === entry.unitId,
  )?.item.resourceDefinition;
  target.replaceMetadata(
    source.item,
    value(
      ...effective
        .flatMap((entry) => entry.item.type.type)
        .map((type) => host.value(type)),
    ),
  );
  // Copied GML metadata cannot perpetuate a removed resource declaration.
  target.resourceDefinition = resourceDefinition;
  if (resourceDefinition) {
    target.replaceDefinition({});
    return;
  }
  const definition =
    source.origin && (source.declaration || source.item.def)
      ? materializeSourceRange(source.origin, host)
      : source.item.def;
  const declaration = source.declaration
    ? materializeSourceRange(source.declaration.declaration, host)
    : source.item.declaration;
  target.replaceDefinition(definition, declaration);
}
