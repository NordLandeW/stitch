import { createHash } from 'node:crypto';
import {
  Type,
  TypeStore,
  type FunctionType,
  type StructType,
  type WithableType,
} from '../types.js';
import { Signifier } from '../signifiers.js';
import {
  getTypes,
  normalizeType,
  replaceGenerics,
  updateGenericsMap,
} from '../types.checks.js';
import { typeFromParsedJsdocs } from '../types.feather.js';
import type { JsdocSummary } from '../jsdoc.js';
import {
  AnalysisCancelled,
  globalKey,
  globalOwner,
  memberKey,
  nativeGlobalKey,
  nativeGlobalOwner,
  type Argument,
  type BindingScope,
  type BoundFunction,
  type BoundUnit,
  type Declaration,
  type Expression,
  type FunctionExpression,
  type Name,
  type ReferenceRole,
  type RenameRecipe,
  type SemanticCall,
  type SemanticDependency,
  type SemanticDiagnostic,
  type SemanticEnvironment,
  type SemanticReference,
  type SemanticScope,
  type SourceOrigin,
  type Statement,
  type SymbolContribution,
  type SymbolView,
  type SyntaxNode,
  type UnitEvaluation,
  type VariableDeclaration,
} from './model.js';
import {
  copyFlow,
  flowKey,
  initialFlow,
  mergeFlow,
  normal,
  type Completion,
  type FlowState,
} from './flow.js';
import {
  constantTruth,
  dynamic,
  fingerprint,
  fingerprints,
  foldBitwiseNot,
  foldNumeric,
  join,
  knownConstant,
  nullishPaths,
  nullishResult,
  pending,
  primitive,
  unknown,
  value,
  valueFrom,
  withoutUndefined,
  type Value,
} from './values.js';

interface Frame {
  scope: BindingScope;
  function?: BoundFunction;
  self?: Type;
  other?: Type;
}
interface LocatedValue {
  type: Value;
  symbols: SymbolView[];
}
interface PreparedAccess {
  readonly target: Value;
  readonly key?: string;
  readonly keyNode: SyntaxNode;
  readonly rename: RenameRecipe;
}
interface CapturedTarget {
  readonly value: Value;
  readonly symbols: readonly SymbolView[];
  write(current: Value, state: FlowState): Value;
}
type ConstantFact =
  | { kind: 'known'; value: string | number | boolean }
  | { kind: 'unknown' | 'invalid' };
interface MethodAnalysis {
  readonly type: FunctionType;
  active: boolean;
  complete: boolean;
  diagnostics?: readonly SemanticDiagnostic[];
  effects?: {
    readonly self: Type;
    readonly symbols: readonly SymbolContribution[];
    readonly itemsWritten: boolean;
  };
}

/** Evaluate one bound unit into a detached contribution; no published graph mutation. */
export function evaluateUnit(
  bound: BoundUnit,
  environment: SemanticEnvironment,
): UnitEvaluation {
  let previous: UnitEvaluation | undefined;
  let previousKey: string | undefined;
  const seen = new Set<string>();
  const callableKeys = new Set(
    [...bound.functions.values()].map((fn) => fn.typeKey),
  );
  for (;;) {
    if (environment.cancelled()) throw new AnalysisCancelled();
    const result = new Evaluator(
      bound,
      {
        lookup: (request) => environment.lookup(request),
        type: (key) =>
          callableKeys.has(key)
            ? previous?.types.get(key) || environment.type(key)
            : environment.type(key),
        observe: () => {},
        cancelled: () => environment.cancelled(),
      },
      undefined,
      previous?.types,
    ).run();
    const key = JSON.stringify([
      result.summary,
      fingerprints(
        [...callableKeys].map((typeKey) => result.types.get(typeKey)!),
      ),
    ]);
    const recursive = result.dependencies.some(
      (dependency) =>
        dependency.kind === 'type' &&
        dependency.facet === 'returns' &&
        callableKeys.has(dependency.owner),
    );
    if (key === previousKey || !recursive) {
      result.dependencies.forEach((dependency) =>
        environment.observe(dependency),
      );
      return result;
    }
    if (seen.has(key)) {
      result.dependencies.forEach((dependency) =>
        environment.observe(dependency),
      );
      return {
        ...result,
        status: 'degraded',
        diagnostics: [
          ...result.diagnostics,
          {
            collection: 'INVALID_OPERATION',
            severity: 'info',
            origin: bound.syntax.root.origin,
            message: 'Recursive type inference did not reach a stable result.',
          },
        ],
      };
    }
    seen.add(key);
    previous = result;
    previousKey = key;
  }
}

/** Declaration-only callable/shape skeletons for project-wide forward lookup. */
export function createDeclarationSummary(
  bound: BoundUnit,
): Pick<UnitEvaluation, 'symbols' | 'types' | 'namedTypes'> {
  const declarations = new Evaluator(bound, {
    lookup: () => undefined,
    type: () => undefined,
    observe: () => {},
    cancelled: () => false,
  });
  return {
    symbols: declarations.symbols,
    types: declarations.types,
    namedTypes: declarations.namedTypes,
  };
}

class Evaluator {
  readonly symbols = new Map<string, SymbolContribution>();
  readonly types = new Map<string, Type>();
  readonly namedTypes = new Map<string, string>();
  readonly references = new Map<string, SemanticReference>();
  readonly scopes = new Map<string, SemanticScope>();
  readonly calls = new Map<string, SemanticCall>();
  readonly structRanges: { origin: SourceOrigin; type: string }[] = [];
  readonly diagnostics: SemanticDiagnostic[] = [];
  readonly dependencies = new Map<string, SemanticDependency>();
  readonly annotated = new Set<string>();
  readonly functionStatus = new Map<string, 'running' | 'done'>();
  readonly functionByKey = new Map<string, BoundFunction>();
  readonly functionByType = new Map<string, BoundFunction>();
  readonly constructorBySelf = new Map<string, BoundFunction>();
  readonly declarationsByKey = new Map<string, Declaration>();
  readonly nativeDeclarations = new Map<string, SymbolView>();
  readonly externalKeys = new WeakMap<Signifier, string>();
  readonly expressionValues = new Map<string, Value>();
  readonly symbolAliases = new Map<string, string>();
  readonly dynamicSelf = new Map<string, Type>();
  readonly knownTypes = new Map<string, Type>();
  readonly writtenTypes = new Set<string>();
  readonly reboundSelf = new Map<string, Type>();
  readonly extensionViews = new Map<string, FunctionType[]>();
  readonly extensionImplementations = new Map<string, string>();
  readonly recursiveAllocations = new Set<string>();
  callsSuper = false;
  degraded = false;

  constructor(
    readonly bound: BoundUnit,
    readonly environment: SemanticEnvironment,
    readonly methodAnalyses = new Map<string, MethodAnalysis>(),
    readonly priorTypes?: ReadonlyMap<string, Type>,
  ) {
    this.diagnostics.push(...bound.diagnostics);
    for (const declaration of bound.declarations)
      if (!this.declarationsByKey.has(declaration.key))
        this.declarationsByKey.set(declaration.key, declaration);
    for (const scope of bound.scopes.values()) {
      this.ensureType(scope.localOwner);
      this.ensureType(scope.selfOwner);
      if (scope.staticOwner) this.ensureType(scope.staticOwner);
    }
    for (const fn of bound.functions.values()) {
      if (
        fn.declaration?.role === 'function' ||
        fn.declaration?.role === 'legacy-script' ||
        fn.declaration?.role === 'extension-function'
      )
        this.functionByKey.set(fn.key, fn);
      this.functionByType.set(fn.typeKey, fn);
      if (fn.node.constructor) this.constructorBySelf.set(fn.selfOwner, fn);
      const type = this.ensureType(fn.typeKey, 'Function') as FunctionType;
      type.name = fn.declaration?.name || fn.node.name?.text;
      type.callKind =
        fn.declaration?.role === 'legacy-script' ||
        fn.declaration?.role === 'extension-function'
          ? 'legacy'
          : 'user';
      type.isConstructor = fn.node.constructor;
      type.local = this.ensureType(fn.localOwner) as StructType;
      type.statics = this.ensureType(fn.staticOwner) as StructType;
      type.self = this.ensureType(fn.selfOwner) as WithableType;
      if (type.isConstructor) type.self.name = type.name;
      type.returns = pending();
      if (fn.declaration?.extensionModule) {
        // One implementation may be exported through different native signatures.
        // Its implicit arguments see all possible entry contracts; public views
        // below retain their own arity and parameter types.
        for (const declaration of bound.declarations) {
          if (
            !(
              declaration.key === fn.key ||
              declaration.extensionTarget === fn.typeKey
            ) ||
            !declaration.extensionSignature
          )
            continue;
          const signature = this.environment.type(
            declaration.extensionSignature,
          );
          if (signature?.kind !== 'Function') continue;
          for (const parameter of signature.listParameters()) {
            if (!parameter) continue;
            const previous = type.getParameter(parameter.idx!);
            type.addParameter(parameter.idx!, parameter.name, {
              type: value(previous?.type, parameter.type).type,
              optional: previous?.optional || parameter.optional,
            });
          }
        }
      }
      type.functionSource = {
        bound,
        functionId: fn.node.id,
        fingerprint: createHash('sha256')
          .update(bound.syntax.input.text.slice(fn.node.start, fn.node.end + 1))
          .digest('hex'),
      };
      if (fn.declaration?.exported && type.name) {
        this.namedTypes.set(`Function.${type.name}`, fn.typeKey);
        if (type.isConstructor)
          this.namedTypes.set(`Struct.${type.name}`, fn.selfOwner);
      }
    }
    if (bound.context.selfOwner) {
      const self = this.types.get(bound.context.selfOwner)!;
      self.setBaseView(this.environment.type(bound.context.selfOwner)?.extends);
    }
    for (const declaration of bound.declarations)
      this.installDeclaration(declaration);
    for (const fn of bound.functions.values()) {
      const type = this.types.get(fn.typeKey)!;
      const symbol = this.symbols.get(fn.key);
      if (symbol) {
        if (
          !symbol.intrinsic &&
          (fn.declaration?.role === 'function' ||
            fn.declaration?.role === 'legacy-script' ||
            fn.declaration?.role === 'extension-function')
        )
          symbol.item.setType(type);
        type.signifier = symbol.item;
        if (type.isConstructor && type.self) type.self.signifier = symbol.item;
      }
    }
    for (const declaration of bound.declarations) {
      if (!declaration.extensionModule) continue;
      const implementationKey =
        declaration.extensionTarget || `function:${declaration.key}`;
      const implementation = this.types.get(implementationKey) as
        | FunctionType
        | undefined;
      const symbol = this.symbols.get(declaration.key);
      if (!implementation || !symbol) continue;
      const signature = declaration.extensionSignature
        ? this.environment.type(declaration.extensionSignature)
        : undefined;
      let type = implementation;
      if (signature?.kind === 'Function') {
        const viewKey = `extension-view:${declaration.key}`;
        type = this.ensureType(viewKey, 'Function') as FunctionType;
        type.name = declaration.name;
        type.callKind = 'native';
        type.local = this.ensureType(`${viewKey}:locals`) as StructType;
        type.self = implementation.self;
        type.statics = implementation.statics;
        type.functionSource = implementation.functionSource;
        type.returns = pending();
        type.signifier = symbol.item;
        for (const parameter of signature.listParameters())
          if (parameter)
            type.addParameter(parameter.idx!, parameter.name, {
              type: parameter.type.type,
              optional: parameter.optional,
            });
        let views = this.extensionViews.get(implementationKey);
        if (!views) this.extensionViews.set(implementationKey, (views = []));
        views.push(type);
        this.extensionImplementations.set(viewKey, implementationKey);
      }
      symbol.item.setType(type);
      this.namedTypes.set(`Function.${declaration.name}`, type.semanticKey!);
    }
    for (const [name, key] of this.namedTypes)
      this.knownTypes.set(name, this.types.get(key)!);
    for (const docs of bound.syntax.jsdocs) {
      for (const range of docs.typeRanges) {
        const imported = this.readType(range.content, 'annotation');
        if (imported) this.knownTypes.set(range.content, imported);
      }
    }
    for (const contribution of this.symbols.values()) {
      const declaration = contribution.declaration;
      if (!declaration?.docs) continue;
      const documented = this.annotation(declaration.docs);
      if (
        documented.length &&
        declaration.docs.kind !== 'self' &&
        declaration.role !== 'function' &&
        declaration.role !== 'legacy-script' &&
        declaration.role !== 'extension-function'
      ) {
        contribution.item.setType(documented);
        this.annotated.add(contribution.key);
      }
      contribution.item.description = declaration.docs.description;
      contribution.item.deprecated = !!declaration.docs.deprecated;
      contribution.item.mixin = !!declaration.docs.mixin;
    }
  }

  run(): UnitEvaluation {
    this.checkCancellation();
    const rootScope = this.bound.scopes.get(`${this.bound.unitId}:root`)!;
    const root: Frame = {
      scope: rootScope,
      self: this.types.get(rootScope.selfOwner),
    };
    if (
      this.bound.context.kind !== 'script' ||
      this.bound.context.language.scriptSemantics !== 'legacy-callable'
    )
      this.execute(this.bound.syntax.root, initialFlow(), root);
    for (const fn of this.bound.functions.values()) this.evaluateFunction(fn);
    for (const [id, reference] of this.references) {
      const symbol = this.resolveAlias(reference.symbol);
      if (symbol !== reference.symbol)
        this.references.set(id, {
          ...reference,
          symbol,
          isDefinition: false,
          role: reference.role === 'declaration' ? 'write' : reference.role,
        });
    }
    for (const [id, scope] of this.scopes) {
      if (!scope.memberTypes) continue;
      const memberTypes = new Map<string, TypeStore>();
      for (const [key, current] of scope.memberTypes) {
        const symbol = this.resolveAlias(key);
        memberTypes.set(symbol, value(memberTypes.get(symbol), current));
      }
      this.scopes.set(id, { ...scope, memberTypes });
    }
    const exported = [...this.symbols.values()].filter(
      (symbol) => symbol.exported,
    );
    const summaryTypes = [
      ...exported.map((symbol) => symbol.item.type),
      ...[...this.namedTypes.values()].map((key) => this.types.get(key)!),
      ...[...this.writtenTypes].map((key) => this.types.get(key)!),
    ];
    const summaries = fingerprints(summaryTypes);
    const summaryOf = new Map(
      summaryTypes.map((type, index) => [type, summaries[index]]),
    );
    const summary = JSON.stringify([
      exported
        .map((symbol) => [
          symbol.key,
          symbol.item.readable,
          symbol.item.writable,
          symbol.item.static,
          symbol.item.override,
          symbol.bare,
          symbol.item.resourceDefinition && [
            symbol.item.resourceDefinition.unitId,
            symbol.item.resourceDefinition.uri,
            symbol.item.resourceDefinition.name,
          ],
          summaryOf.get(symbol.item.type)!,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [...this.namedTypes]
        .map(([name, key]) => [name, summaryOf.get(this.types.get(key)!)!])
        .sort((a, b) => a[0].localeCompare(b[0])),
      this.callsSuper,
      [...this.writtenTypes]
        .sort()
        .map((key) => [key, summaryOf.get(this.types.get(key)!)!]),
    ]);
    return {
      unitId: this.bound.unitId,
      bound: this.bound,
      status: this.degraded ? 'degraded' : 'complete',
      symbols: this.symbols,
      types: this.types,
      namedTypes: this.namedTypes,
      references: [...this.references.values()],
      scopes: [...this.scopes.values()],
      calls: [...this.calls.values()],
      structRanges: this.structRanges,
      callsSuper: this.callsSuper,
      diagnostics: this.uniqueDiagnostics(),
      dependencies: [...this.dependencies.values()],
      summary,
    };
  }

  checkCancellation() {
    if (this.environment.cancelled()) throw new AnalysisCancelled();
  }
  observe(dependency: SemanticDependency) {
    const key = JSON.stringify(dependency);
    if (!this.dependencies.has(key)) {
      this.dependencies.set(key, dependency);
      this.environment.observe(dependency);
    }
  }
  diagnostic(
    origin: SourceOrigin,
    message: string,
    collection: SemanticDiagnostic['collection'] = 'INVALID_OPERATION',
    severity: SemanticDiagnostic['severity'] = 'warning',
  ) {
    this.diagnostics.push({ origin, message, collection, severity });
  }
  uniqueDiagnostics() {
    const seen = new Set<string>();
    return this.diagnostics.filter((diagnostic) => {
      const key = JSON.stringify([
        diagnostic.collection,
        diagnostic.message,
        diagnostic.origin.spelling,
        diagnostic.origin.expansion,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  ensureType(key: string, kind: Type['kind'] = 'Struct'): Type {
    let type = this.types.get(key);
    if (!type) {
      type = new Type(kind);
      type.semanticKey = key;
      this.types.set(key, type);
    }
    return type;
  }
  keyOfType(type: Type): string {
    return type.semanticKey || `${type.kind}.${type.name || ''}`;
  }
  keyOf(item: Signifier): string {
    return (
      item.semanticKey ||
      this.externalKeys.get(item) ||
      (item.native && !item.instance
        ? nativeGlobalKey(item.name)
        : item.global
          ? globalKey(item.name)
          : memberKey(this.keyOfType(item.parent), item.name))
    );
  }
  readType(
    key: string,
    facet: SemanticDependency['facet'] = 'members',
  ): Type | undefined {
    const own =
      this.types.get(key) ||
      (this.namedTypes.has(key)
        ? this.types.get(this.namedTypes.get(key)!)
        : undefined);
    if (own) return own;
    const imported = this.environment.type(key);
    this.observe({ kind: imported ? 'type' : 'missing', owner: key, facet });
    return imported;
  }
  importedLookup(
    namespace: 'global' | 'member' | 'static' | 'native',
    owner: string,
    name: string,
  ): SymbolView | undefined {
    const candidate = this.environment.lookup({ namespace, owner, name });
    const found =
      candidate && (candidate.item.def || candidate.item.native)
        ? candidate
        : undefined;
    this.observe({
      kind: found ? 'lookup' : 'missing',
      owner,
      name,
      target: found?.key,
    });
    if (found) this.externalKeys.set(found.item, found.key);
    return found;
  }
  installDeclaration(declaration: Declaration): SymbolView {
    // `var` declarations cannot reuse built-in names. Parameters and static
    // declarations have different compiler rules; catch/doc names are not var
    // declarations. Keep a local recovery symbol without mutating the native.
    if (
      declaration.role === 'local' &&
      'name' in declaration.node &&
      this.importedLookup('native', nativeGlobalOwner, declaration.name)
    ) {
      this.diagnostic(
        declaration.origin,
        `Cannot redeclare built-in symbol \`${declaration.name}\`.`,
        'INVALID_OPERATION',
        'error',
      );
    }
    const assignment = declaration.node as Partial<
      Extract<Expression, { kind: 'assign' }>
    >;
    const bareWrite =
      declaration.role === 'field' &&
      assignment.kind === 'assign' &&
      assignment.target?.kind === 'name';
    if (
      (declaration.owner === globalOwner && !declaration.explicitGlobal) ||
      bareWrite
    ) {
      const native = this.importedLookup(
        'native',
        nativeGlobalOwner,
        declaration.name,
      );
      if (
        native &&
        (!bareWrite || !native.item.instance) &&
        declaration.role !== 'function' &&
        !(
          declaration.extensionModule &&
          native.item.native === declaration.extensionModule
        )
      ) {
        this.nativeDeclarations.set(declaration.id, native);
        if (declaration.role !== 'global' && !bareWrite) {
          this.diagnostic(
            declaration.origin,
            `Cannot redeclare built-in symbol \`${declaration.name}\`.`,
            'INVALID_OPERATION',
            'error',
          );
          this.namedTypes.delete(`Function.${declaration.name}`);
          this.namedTypes.delete(`Struct.${declaration.name}`);
        }
        return native;
      }
    }
    const existing = this.symbols.get(declaration.key);
    if (existing) {
      if (declaration.bare && !existing.bare) {
        const alias = { ...existing, bare: true };
        this.symbols.set(declaration.key, alias);
        return alias;
      }
      return existing;
    }
    const container = this.ensureType(
      declaration.owner,
      declaration.role === 'enum-member' ? 'Enum' : 'Struct',
    );
    const item = new Signifier(container, declaration.name);
    let imported =
      declaration.owner === globalOwner
        ? this.importedLookup('global', globalOwner, declaration.name)
        : undefined;
    if (declaration.role === 'field') {
      const resource = this.importedLookup(
        'member',
        declaration.owner,
        declaration.name,
      );
      if (resource?.item.resourceDefinition) imported = resource;
    }
    if (!imported && declaration.role === 'field' && container.extends) {
      const member = this.nativeMember(container.extends, declaration.name);
      if (member?.native)
        imported = { key: this.keyOf(member), item: member, intrinsic: true };
    }
    if (
      imported &&
      (imported.intrinsic || imported.item.native) &&
      !(
        declaration.extensionModule &&
        imported.item.native === declaration.extensionModule
      )
    ) {
      item.semanticKey = declaration.key;
      item.replaceMetadata(imported.item, value(imported.item.type));
      item.replaceDefinition(imported.item.def, imported.item.declaration);
      this.annotated.add(declaration.key);
      const contribution: SymbolContribution = {
        key: declaration.key,
        item,
        owner: declaration.owner,
        unitId: this.bound.unitId,
        exported: false,
        bare: imported.bare,
        intrinsic: true,
      };
      this.symbols.set(declaration.key, contribution);
      container.setOwnMember(item);
      if ((declaration.node as { kind?: string }).kind !== 'assign')
        this.diagnostic(
          declaration.origin,
          `Cannot redeclare built-in symbol \`${declaration.name}\`.`,
          'INVALID_OPERATION',
          'error',
        );
      this.namedTypes.delete(`Function.${declaration.name}`);
      this.namedTypes.delete(`Struct.${declaration.name}`);
      return contribution;
    }
    if (imported?.item.resourceDefinition)
      item.replaceMetadata(imported.item, value(imported.item.type));
    item.semanticKey = declaration.key;
    if (declaration.extensionModule) item.native = declaration.extensionModule;
    item.hidden = !!declaration.hidden;
    item.def = {};
    item.local =
      declaration.role === 'local' || declaration.role === 'parameter';
    item.parameter = declaration.role === 'parameter';
    item.idx = declaration.parameterIndex;
    item.optional = !!declaration.optional;
    item.global = declaration.owner === globalOwner;
    item.static = declaration.role === 'static';
    item.instance = ['field', 'static'].includes(declaration.role);
    item.enum = declaration.role === 'enum';
    item.enumMember = declaration.role === 'enum-member';
    item.writable =
      !item.enum && !item.enumMember && !declaration.extensionModule;
    item.definitive =
      this.bound.context.definitiveSelf ||
      this.bound.scopes.get(declaration.scope)?.functionId !== undefined;
    const contribution: SymbolContribution = {
      key: declaration.key,
      item,
      origin: declaration.origin,
      declaration,
      bare: declaration.bare,
      owner: declaration.owner,
      unitId: this.bound.unitId,
      exported: declaration.exported,
    };
    this.symbols.set(declaration.key, contribution);
    container.setOwnMember(item);
    if (declaration.role === 'static') {
      const scope = this.bound.scopes.get(declaration.scope);
      if (scope) this.ensureType(scope.localOwner).setOwnMember(item);
    }
    if (declaration.role === 'enum') {
      const enumKey = `enum:${declaration.key}`;
      const type = this.ensureType(enumKey, 'Enum');
      type.name = declaration.name;
      type.signifier = item;
      item.setType(type);
      this.namedTypes.set(`Enum.${declaration.name}`, enumKey);
    } else if (item.enumMember) {
      const type = this.ensureType(
        `enum-member:${declaration.key}`,
        'EnumMember',
      );
      type.name = declaration.name;
      type.signifier = item;
      item.setType(type);
    }
    return contribution;
  }
  annotation(docs: JsdocSummary): Type[] {
    return typeFromParsedJsdocs(docs, this.knownTypes, false);
  }
  frameFor(node: SyntaxNode, fallback: Frame): Frame {
    const scopeKey = this.bound.nodeScopes.get(node.id);
    const scope = scopeKey && this.bound.scopes.get(scopeKey);
    return scope && scope.key !== fallback.scope.key
      ? {
          ...fallback,
          scope,
          self:
            scope.selfOwner === fallback.scope.selfOwner
              ? fallback.self
              : this.dynamicSelf.get(scope.selfOwner) ||
                this.types.get(scope.selfOwner),
        }
      : fallback;
  }
  scope(node: SyntaxNode, frame: Frame) {
    const selfKey = this.keyOfType(
      frame.self || this.ensureType(frame.scope.selfOwner),
    );
    this.scopes.set(`${node.id}:false:${selfKey}`, {
      origin: node.origin,
      local: frame.scope.localOwner,
      self: selfKey,
      dot: false,
    });
  }
  dotScope(
    node: Extract<Expression, { kind: 'member' }>,
    frame: Frame,
    alternatives: readonly Type[],
    state: FlowState,
  ) {
    const origin = this.bound.syntax.input.origin(node.dot.end, node.end);
    // Query ranges include the caret after a token; reference spans do not.
    const scopeOrigin = origin.expansion
      ? {
          ...origin,
          expansion: { ...origin.expansion, end: origin.expansion.end + 1 },
        }
      : {
          ...origin,
          spelling: { ...origin.spelling, end: origin.spelling.end + 1 },
        };
    const id = `${node.id}:dot`;
    const previous = this.scopes.get(id);
    const receivers = value(previous?.receivers, ...alternatives);
    const memberTypes = new Map(previous?.memberTypes);
    for (const receiver of alternatives) {
      const type = this.types.get(this.keyOfType(receiver)) || receiver;
      const visited = new Set<Type>();
      for (
        let cursor: Type | undefined = type;
        cursor && !visited.has(cursor);
        cursor = cursor.extends
      ) {
        visited.add(cursor);
        this.observe({
          kind: 'type',
          owner: this.keyOfType(cursor),
          facet: 'members',
        });
      }
      const names = new Set<string>();
      for (const member of type.listMembers()) {
        if (names.has(member.name) || (!member.def && !member.native)) continue;
        names.add(member.name);
        const key = this.keyOf(member);
        const current = state.values.get(key) || value(member.type);
        memberTypes.set(key, value(memberTypes.get(key), current));
      }
    }
    const single = receivers.type.length === 1 && receivers.type[0];
    const self =
      single &&
      ['Struct', 'Enum', 'Id.Instance', 'Asset.GMObject'].includes(single.kind)
        ? single
        : this.ensureType(`completion:${node.id}`);
    this.scopes.set(id, {
      origin: scopeOrigin,
      local: frame.scope.localOwner,
      self: this.keyOfType(self),
      dot: true,
      receivers,
      memberTypes,
    });
  }
  record(
    node: SyntaxNode,
    symbol: SymbolView,
    current: Value,
    role: ReferenceRole = 'read',
    isDefinition = false,
    rename: RenameRecipe = { kind: 'identifier' },
  ) {
    if (
      !symbol.item.readable &&
      ['read', 'read-write', 'shorthand-value'].includes(role)
    ) {
      const uncertain =
        !!symbol.item.native &&
        this.bound.context.language.nativeDegraded !== false;
      if (uncertain) this.degraded = true;
      this.diagnostic(
        node.origin,
        uncertain
          ? `The fallback or unspecified native schema marks \`${symbol.item.name}\` as unreadable; this target's availability is unverified.`
          : `Cannot read symbol \`${symbol.item.name}\`: the selected specification marks it as unreadable.`,
        'INVALID_OPERATION',
        uncertain ? 'info' : 'error',
      );
    }
    if (symbol.item.resourceDefinition) {
      isDefinition = false;
      if (role === 'declaration') role = 'write';
      rename = { kind: 'none' };
    }
    const id = `${node.id}:${symbol.key}:${role}`;
    const previous = this.references.get(id);
    this.references.set(id, {
      unitId: this.bound.unitId,
      symbol: symbol.key,
      origin: node.origin,
      role,
      isDefinition,
      type: previous ? join(previous.type, current) : value(current),
      rename:
        node.origin.editable && symbol.origin?.editable !== false
          ? rename
          : { kind: 'none' },
    });
    if (!isDefinition)
      this.observe({ kind: 'usage', owner: symbol.key, target: symbol.key });
  }
  local(name: string, frame: Frame): SymbolView | undefined {
    let scope: BindingScope | undefined = frame.scope;
    while (scope) {
      const key = scope.declarations.get(name);
      if (key) return this.symbols.get(key);
      const parent: BindingScope | undefined = scope.parent
        ? this.bound.scopes.get(scope.parent)
        : undefined;
      if (parent?.functionId !== frame.scope.functionId) break;
      scope = parent;
    }
    return;
  }
  lookupName(name: string, frame: Frame): SymbolView | undefined {
    const local = this.local(name, frame);
    if (local) return local;
    // Native bare names are not aliases of global.name or self.name. A legal
    // same-name function owns user storage without replacing the built-in call.
    const native = this.importedLookup('native', nativeGlobalOwner, name);
    if (native && !native.item.instance) return native;
    const self = frame.self || this.types.get(frame.scope.selfOwner);
    if (self && frame.scope.selfOwner !== globalOwner) {
      const found = this.lookupMember(self, name);
      if (found) return found;
    }
    if (native && frame.scope.selfOwner !== globalOwner) return native;
    const own = this.symbols.get(globalKey(name));
    if (own?.item.def && (own.bare || frame.scope.selfOwner === globalOwner))
      return own;
    const imported = this.importedLookup('global', globalOwner, name);
    if (
      imported &&
      (imported.bare !== false || frame.scope.selfOwner === globalOwner) &&
      (!imported.item.instance || frame.scope.selfOwner !== globalOwner)
    )
      return imported;
    return;
  }
  needsInstanceView(type: Type): boolean {
    if (
      type.kind !== 'Id.Instance' ||
      type.name ||
      type.literalValue !== undefined
    )
      return false;
    let storage = type;
    const seen = new Set<Type>();
    while (
      storage.kind === 'Id.Instance' &&
      storage.extends &&
      !seen.has(storage)
    ) {
      seen.add(storage);
      storage = storage.extends;
    }
    return !type.extends || type.isReadonly || storage.isReadonly;
  }
  /** A runtime handle owns writable storage; the shared specification remains
   * an immutable base. The wrapper retains its non-callable instance kind. */
  instanceView(source: Type, key: string): Type {
    let view = this.types.get(key);
    if (!view) {
      view = source.deriveDetached();
      view.semanticKey = key;
      view.isReadonly = false;
      view.replaceOwnMembers([]);
      const storage = this.ensureType(`${key}:storage`);
      storage.setBaseView(source);
      view.setBaseView(storage);
      this.types.set(key, view);
    }
    return view;
  }
  inputInstanceViews(current: Value, identity: string): Value {
    return valueFrom(
      current.type.map((type) =>
        this.needsInstanceView(type)
          ? this.instanceView(
              type,
              `instance-input:${this.bound.unitId}:${identity}:${this.keyOfType(type)}`,
            )
          : type,
      ),
    );
  }
  callInstanceViews(current: Value, node: SyntaxNode): Value {
    return valueFrom(
      current.type.map((type) =>
        this.needsInstanceView(type)
          ? this.instanceView(
              type,
              `instance:${this.bound.unitId}:${node.id}:${this.keyOfType(type)}`,
            )
          : type,
      ),
    );
  }
  storageType(type: Type): Type {
    const seen = new Set<Type>();
    while (
      ['Id.Instance', 'Asset.GMObject'].includes(type.kind) &&
      type.extends &&
      !seen.has(type)
    ) {
      seen.add(type);
      type = type.extends;
    }
    return type;
  }
  /** Declaration skeletons may provisionally contain names from the native
   * instance base. They never replace that base's runtime member identity. */
  nativeMember(type: Type, name: string): Signifier | undefined {
    const seen = new Set<Type>();
    let found: Signifier | undefined;
    for (
      let cursor: Type | undefined = type;
      cursor && !seen.has(cursor);
      cursor = cursor.extends
    ) {
      seen.add(cursor);
      const member = cursor.getMember(name, true);
      if (member?.native) found = member;
    }
    return found;
  }
  lookupMember(
    type: Type,
    name: string,
    statics = false,
  ): SymbolView | undefined {
    const constructor =
      type.semanticKey && this.constructorBySelf.get(type.semanticKey);
    if (constructor) this.evaluateFunction(constructor);
    type = this.storageType(type);
    const owner = this.keyOfType(type);
    const visited = new Set<Type>();
    const roots = [
      type,
      owner === globalOwner ? undefined : this.environment.type(owner),
    ].filter((entry): entry is Type => !!entry);
    for (const root of roots)
      for (
        let cursor: Type | undefined = root;
        cursor && !visited.has(cursor);
        cursor = cursor.extends
      ) {
        visited.add(cursor);
        this.observe({
          kind: 'type',
          owner: this.keyOfType(cursor),
          name,
          facet: 'base',
        });
      }
    const native = roots
      .map((root) => this.nativeMember(root, name))
      .find((member) => !!member);
    if (native) {
      const key = this.keyOf(native);
      this.observe({ kind: 'lookup', owner, name, target: key });
      return { key, item: native, intrinsic: true };
    }
    const candidate =
      this.types.get(owner)?.getMember(name) || type.getMember(name);
    this.observe({
      kind: 'type',
      owner,
      name,
      facet: statics ? 'static' : 'members',
    });
    if (candidate && (candidate.def || candidate.native)) {
      const key = this.keyOf(candidate);
      return (
        this.symbols.get(key) ||
        this.importedLookup(statics ? 'static' : 'member', owner, name) || {
          key,
          item: candidate,
        }
      );
    }
    return this.importedLookup(statics ? 'static' : 'member', owner, name);
  }
  symbolType(symbol: SymbolView, state: FlowState): Value {
    const fn = this.functionByKey.get(symbol.key);
    if (fn && this.functionStatus.get(fn.node.id) !== 'running')
      this.evaluateFunction(fn);
    const stored = state.values.get(symbol.key) || value(symbol.item.type);
    const current = valueFrom(
      stored.type.map(
        (type) =>
          (type.semanticKey && this.types.get(type.semanticKey)) || type,
      ),
    );
    if (symbol.constant !== undefined || symbol.nullPointer !== undefined)
      return valueFrom(
        current.type.map((type) => {
          const copy = type.deriveDetached();
          copy.literalValue = symbol.constant;
          copy.nullPointer = symbol.nullPointer;
          return copy;
        }),
      );
    return this.inputInstanceViews(current, `symbol:${symbol.key}`);
  }
  unresolved(name: Name, frame: Frame): SymbolView {
    const self = this.storageType(
      frame.self || this.ensureType(frame.scope.selfOwner),
    );
    const owner = this.keyOfType(self);
    const key =
      owner === globalOwner
        ? globalKey(name.text)
        : memberKey(owner, name.text);
    let symbol = this.symbols.get(key);
    if (!symbol) {
      const shape = this.types.get(owner) || this.copyShape(self);
      const item = new Signifier(shape, name.text, Type.Any);
      item.semanticKey = key;
      item.placeholder = true;
      symbol = { key, item, owner, unitId: this.bound.unitId, exported: false };
      this.symbols.set(key, symbol);
      shape.setOwnMember(item);
    }
    const auto = this.bound.context.autoDeclareGlobalsPrefixes?.some((prefix) =>
      name.text.startsWith(prefix),
    );
    const dynamicCaller =
      this.bound.context.dynamicSelf &&
      owner !== globalOwner &&
      (owner === this.bound.context.selfOwner ||
        owner.endsWith(':caller-self'));
    if (!auto && !dynamicCaller)
      this.diagnostic(
        name.origin,
        owner === globalOwner
          ? `${name.text} looks like a global but is not declared anywhere.`
          : `Undeclared symbol \`${name.text}\``,
        owner === globalOwner
          ? 'UNDECLARED_GLOBAL_REFERENCE'
          : 'UNDECLARED_VARIABLE_REFERENCE',
      );
    return symbol;
  }

  evaluateFunction(fn: BoundFunction): Type<'Function'> {
    const type = this.types.get(fn.typeKey)! as FunctionType;
    if (this.functionStatus.has(fn.node.id)) return type;
    this.functionStatus.set(fn.node.id, 'running');
    this.checkCancellation();
    const scope = this.bound.scopes.get(fn.scope)!;
    const frame: Frame = {
      scope,
      function: fn,
      self:
        this.reboundSelf.get(fn.node.id) ||
        this.dynamicSelf.get(fn.selfOwner) ||
        type.self,
    };
    const docs = fn.node.docs || fn.declaration?.docs;
    const documented = docs
      ? this.annotation(docs).find((entry) => entry.kind === 'Function')
      : undefined;
    if (docs?.self && !this.reboundSelf.has(fn.node.id)) {
      const self = this.knownTypes.get(docs.self.content);
      if (self)
        frame.self =
          (self.kind === 'Function' ? self.self : self) || frame.self;
    }
    if (frame.self) {
      frame.self = this.inputInstanceViews(
        value(frame.self),
        `receiver:${scope.key}`,
      ).type[0];
      type.self = frame.self as WithableType;
    }
    const state = initialFlow();
    this.scope(fn.node.body, frame);
    for (let index = 0; index < fn.node.parameters.length; index++) {
      const parameter = fn.node.parameters[index];
      const declaration = this.bound.declarationSites.get(parameter.name.id)!;
      const symbol = this.symbols.get(declaration.key)!;
      const annotation = documented?.getParameter(parameter.name.text);
      let current = annotation?.isTyped
        ? value(annotation.type)
        : parameter.value
          ? this.expression(parameter.value, state, frame)
          : unknown();
      if (annotation) {
        symbol.item.description = annotation.description;
        this.annotated.add(symbol.key);
      }
      symbol.item.setType(current);
      symbol.item.optional = !!parameter.value || !!annotation?.optional;
      state.values.set(symbol.key, current);
      this.record(parameter.name, symbol, current, 'declaration', true);
      const documentedName = docs?.params?.find(
        (entry) => entry.name?.content === parameter.name.text,
      )?.name;
      if (documentedName)
        this.record(
          {
            ...parameter.name,
            id: `${parameter.name.id}:doc`,
            origin: this.bound.syntax.input.origin(
              documentedName.start.offset,
              documentedName.end.offset,
            ),
          },
          symbol,
          current,
        );
    }
    if (documented) {
      for (const parameter of documented.listParameters()) {
        if (!parameter || type.getParameter(parameter.name)) continue;
        const copy = new Signifier(type.local!, parameter.name);
        copy.parameter = true;
        copy.local = true;
        copy.idx = parameter.idx;
        copy.optional = parameter.optional;
        copy.type = value(parameter.type);
        copy.description = parameter.description;
        type.local!.setOwnMember(copy);
      }
    }
    if (fn.node.base) {
      const parent = this.lookupName(fn.node.base.name.text, frame);
      if (parent) {
        const parentType = this.symbolType(parent, state).type.find(
          (entry) => entry.kind === 'Function',
        ) as FunctionType | undefined;
        this.record(fn.node.base.name, parent, value(parent.item.type));
        this.observe({
          kind: 'type',
          owner: parent.key,
          facet: 'base',
          target: parent.key,
        });
        if (
          parentType?.isConstructor &&
          parentType.self &&
          parentType !== type &&
          !this.hasBase(parentType.self, type.self!)
        ) {
          type.self!.setBaseView(parentType.self);
          type.statics!.setBaseView(parentType.statics);
        } else if (parentType && !parentType.isConstructor)
          this.diagnostic(
            fn.node.base.name.origin,
            'A parent constructor must be a constructor function.',
            'INVALID_OPERATION',
            'error',
          );
        if (parentType)
          this.call(
            parentType,
            parent,
            fn.node.base.arguments,
            fn.node.base.name,
            state,
            frame,
            'base-constructor',
          );
        else
          fn.node.base.arguments.forEach((arg) => {
            if (arg.value) this.expression(arg.value, state, frame);
          });
      } else {
        this.record(
          fn.node.base.name,
          this.unresolved(fn.node.base.name, frame),
          unknown(),
        );
        fn.node.base.arguments.forEach((arg) => {
          if (arg.value) this.expression(arg.value, state, frame);
        });
      }
    }
    // Function statics exist before the body, including lexically conditional ones.
    for (const declaration of this.bound.declarations) {
      if (
        declaration.role !== 'static' ||
        this.bound.scopes.get(declaration.scope)?.functionId !== fn.node.id
      )
        continue;
      const initializer = (declaration.node as VariableDeclaration).value;
      const current = initializer
        ? this.expression(initializer, state, frame)
        : primitive('Undefined');
      const symbol = this.symbols.get(declaration.key)!;
      const initialized = this.annotated.has(symbol.key)
        ? value(symbol.item.type)
        : current;
      symbol.item.setType(initialized);
      state.values.set(symbol.key, initialized);
    }
    const completions = this.execute(fn.node.body, state, frame);
    const returns: Value[] = [];
    for (const completion of completions) {
      if (!completion.state.reachable) continue;
      if (completion.kind === 'return')
        returns.push(completion.value || primitive('Undefined'));
      else if (completion.kind === 'normal' || completion.kind === 'exit')
        returns.push(primitive('Undefined'));
    }
    type.setReturnType(
      documented?.returns?.hasTypes
        ? documented.returns
        : returns.length
          ? join(...returns)
          : primitive('Never'),
    );
    if (type.isConstructor && type.self) {
      // Own instance fields shadow constructor statics; inherited statics retain identity.
      for (const member of type.statics?.listMembers(true) || [])
        if (!type.self.getMember(member.name, true))
          type.self.setOwnMember(member);
    }
    for (const view of this.extensionViews.get(fn.typeKey) || [])
      view.setReturnType(value(type.returns));
    this.functionStatus.set(fn.node.id, 'done');
    return type;
  }
  /** A recursive call refers to this pass's allocation, not a deeper copy of
   * the previous pass. Only proven local feedback roots are rebound; unrelated
   * equal-key objects and external inputs retain their own graphs. */
  recursiveReturn(prior: Value): Value {
    return valueFrom(
      prior.type.map((type) => {
        const key = type.semanticKey;
        if (!key || this.priorTypes?.get(key) !== type) return type;
        let current = this.types.get(key);
        if (
          !current &&
          (key.startsWith('array:') || key.startsWith('allocation:'))
        ) {
          // The allocation expression can occur after its recursive arguments.
          // Reserve its identity now; its normal evaluator fills the contents.
          current = type.deriveDetached();
          current.semanticKey = key;
          current.items = pending();
          this.types.set(key, current);
          if (key.startsWith('allocation:')) this.recursiveAllocations.add(key);
        }
        return current || type;
      }),
    );
  }

  hasBase(type: Type, searched: Type): boolean {
    const seen = new Set<Type>();
    for (
      let current: Type | undefined = type;
      current && !seen.has(current);
      current = current.extends
    ) {
      if (current === searched) return true;
      seen.add(current);
    }
    return false;
  }

  expression(node: Expression, state: FlowState, frame: Frame): Value {
    const current = this.evaluateExpression(node, state, frame);
    this.expressionValues.set(node.id, current);
    return current;
  }

  evaluateExpression(node: Expression, state: FlowState, frame: Frame): Value {
    this.checkCancellation();
    frame = this.frameFor(node, frame);
    switch (node.kind) {
      case 'literal': {
        const type = new Type(node.type);
        type.literalValue = node.value;
        type.nullPointer = node.nullPointer;
        return value(type);
      }
      case 'name': {
        if (['self', 'other', 'global'].includes(node.name.text))
          return value(
            node.name.text === 'global'
              ? this.ensureType(globalOwner)
              : node.name.text === 'other'
                ? frame.other || this.ensureType(globalOwner)
                : frame.self || this.ensureType(frame.scope.selfOwner),
          );
        if (node.name.text === 'noone' || node.name.text === 'all') {
          // These reserved scope values need distinct facts through aliases:
          // native schemas otherwise describe both simply as Id.Instance.
          // https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Instance_Keywords.htm
          const candidate = this.importedLookup(
            'native',
            nativeGlobalOwner,
            node.name.text,
          );
          const symbol = candidate?.item.native ? candidate : undefined;
          const nativeType = symbol?.item.getTypeByKind('Id.Instance');
          const type = this.ensureType(
            `keyword:${node.name.text}`,
            'Id.Instance',
          );
          type.literalValue = node.name.text === 'noone' ? -4 : -3;
          type.name = nativeType?.name;
          type.setBaseView(nativeType?.extends);
          if (symbol) this.record(node.name, symbol, value(type));
          return value(type);
        }
        if (node.name.text === 'argument_count') return primitive('Real');
        if (/^argument(?:\d+)?$/.test(node.name.text) && frame.function) {
          const index = /^argument(\d+)$/.exec(node.name.text);
          const fn = this.types.get(frame.function.typeKey)!;
          if (index)
            return value(fn.getParameter(Number(index[1]))?.type || unknown());
          const array = this.ensureType(
            `${frame.function.typeKey}:arguments`,
            'Array',
          );
          array.items = unknown();
          return value(array);
        }
        const symbol =
          this.lookupName(node.name.text, frame) ||
          this.unresolved(node.name, frame);
        const current = this.symbolType(symbol, state);
        this.record(node.name, symbol, current);
        return current;
      }
      case 'function': {
        const fn = this.bound.functions.get(node.id);
        return fn ? value(this.types.get(fn.typeKey)) : unknown();
      }
      case 'struct': {
        const owner = `struct:${node.id}`;
        const type = this.ensureType(owner) as StructType;
        this.structRanges.push({ origin: node.origin, type: owner });
        for (const entry of node.entries) {
          const declaration = this.bound.declarationSites.get(entry.name.id)!;
          const property = this.symbols.get(declaration.key)!;
          if (entry.shorthand) {
            const source =
              this.lookupName(entry.name.text, frame) ||
              this.unresolved(entry.name, frame);
            const current = this.symbolType(source, state);
            this.write(
              property,
              current,
              state,
              entry.name,
              frame,
              true,
              'shorthand-property',
              { kind: 'shorthand-property', value: entry.name.text },
            );
            this.record(entry.name, source, current, 'shorthand-value', false, {
              kind: 'shorthand-value',
              property: entry.name.text,
            });
          } else {
            const current = entry.value
              ? this.expression(entry.value, state, frame)
              : primitive('Undefined');
            const spelling = this.bound.syntax.input.text.slice(
              entry.name.start,
              entry.name.end + 1,
            );
            const rename: RenameRecipe = /^["']/.test(spelling)
              ? { kind: 'string-key', quote: spelling[0] }
              : { kind: 'identifier', property: true };
            this.write(
              property,
              current,
              state,
              entry.name,
              frame,
              true,
              'write',
              rename,
            );
          }
        }
        return value(type);
      }
      case 'array': {
        const type = this.ensureType(`array:${node.id}`, 'Array');
        type.items = join(
          ...node.values.map((entry) => this.expression(entry, state, frame)),
        );
        return value(type);
      }
      case 'template':
        node.values.forEach((entry) => this.expression(entry, state, frame));
        return primitive('String');
      case 'member':
      case 'index':
        return this.access(node, state, frame, false).type;
      case 'call': {
        const target = this.expression(node.target, state, frame);
        const results: Value[] = [];
        const callables = target.type.filter(
          (type): type is FunctionType => type.kind === 'Function',
        );
        if (!callables.length) {
          node.arguments.forEach((argument) => {
            if (argument.value) this.expression(argument.value, state, frame);
          });
          if (state.reachable && !dynamic(target))
            this.diagnostic(
              node.origin,
              'This value is not callable.',
              'INVALID_OPERATION',
              'error',
            );
          return unknown();
        }
        const callee =
          node.target.kind === 'name'
            ? this.lookupName(node.target.name.text, frame)
            : undefined;
        for (const fn of callables)
          results.push(
            this.call(
              fn,
              callee,
              node.arguments,
              node,
              state,
              frame,
              node.usesNew ? 'new' : 'call',
            ),
          );
        return join(...results);
      }
      case 'assign': {
        if (node.operator === '??=') {
          const target = this.captureTarget(node.target, state, frame);
          return this.coalesce(target.value, node.value, state, frame, target);
        }
        let current = this.expression(node.value, state, frame);
        if (node.operator !== '=') {
          const previous = this.readTarget(node.target, state, frame);
          current = this.binary(
            node.operator.slice(0, -1),
            previous,
            current,
            node.origin,
          );
        }
        return this.assignTarget(
          node.target,
          current,
          state,
          frame,
          node.operator === '=' ? 'write' : 'read-write',
        );
      }
      case 'binary': {
        const left = this.expression(node.left, state, frame);
        if (node.operator === '??')
          return this.coalesce(left, node.right, state, frame);
        const rightState = copyFlow(state);
        const logical = ['&&', 'and', '||', 'or'].includes(node.operator);
        const requiresTrue = ['&&', 'and'].includes(node.operator);
        if (logical) this.narrow(node.left, rightState, requiresTrue, frame);
        const right = this.expression(node.right, rightState, frame);
        if (logical) {
          const skipped = copyFlow(state);
          this.narrow(node.left, skipped, !requiresTrue, frame);
          const merged = mergeFlow([skipped, rightState]);
          state.values.clear();
          merged.values.forEach((entry, key) => state.values.set(key, entry));
          state.reachable = merged.reachable;
        } else {
          state.values.clear();
          rightState.values.forEach((entry, key) =>
            state.values.set(key, entry),
          );
        }
        const evaluated = this.binary(node.operator, left, right, node.origin);
        if (!node.uncertainGrouping) return evaluated;
        let alternatives = evaluated;
        if (node.right.kind === 'binary' && !node.right.grouped) {
          const middle =
            this.expressionValues.get(node.right.left.id) || unknown();
          const last =
            this.expressionValues.get(node.right.right.id) || unknown();
          alternatives = join(
            alternatives,
            this.binary(
              node.right.operator,
              this.binary(node.operator, left, middle),
              last,
            ),
          );
        }
        return value(
          ...alternatives.type.map((type) => {
            const copy = type.deriveDetached();
            copy.literalValue = undefined;
            return copy;
          }),
        );
      }
      case 'conditional': {
        this.expression(node.condition, state, frame);
        const yes = copyFlow(state),
          no = copyFlow(state);
        this.narrow(node.condition, yes, true, frame);
        this.narrow(node.condition, no, false, frame);
        const current = join(
          this.expression(node.yes, yes, frame),
          this.expression(node.no, no, frame),
        );
        const merged = mergeFlow([yes, no]);
        state.values.clear();
        merged.values.forEach((entry, key) => state.values.set(key, entry));
        return current;
      }
      case 'unary': {
        const operand = this.expression(node.operand, state, frame);
        if (['++', '--'].includes(node.operator))
          return this.assignTarget(
            node.operand,
            primitive('Real'),
            state,
            frame,
            'read-write',
          );
        if (['!', 'not'].includes(node.operator)) return primitive('Bool');
        if (node.operator === 'delete') return primitive('Undefined');
        const constant = knownConstant(operand);
        const result = new Type('Real');
        if (typeof constant === 'number')
          result.literalValue =
            node.operator === '-'
              ? -constant
              : node.operator === '+'
                ? constant
                : node.operator === '~'
                  ? foldBitwiseNot(constant)
                  : undefined;
        return value(result);
      }
      case 'unknown':
        node.children.forEach((entry) => this.expression(entry, state, frame));
        this.degraded = true;
        return unknown();
    }
  }

  binary(
    operator: string,
    left: Value,
    right: Value,
    origin?: SourceOrigin,
  ): Value {
    if (operator === '??') return nullishResult(left, right);
    if (
      [
        '=',
        '==',
        '!=',
        '<>',
        '<',
        '<=',
        '>',
        '>=',
        '&&',
        '||',
        '^^',
        'and',
        'or',
        'xor',
      ].includes(operator)
    )
      return primitive('Bool');
    if (
      operator === '+' &&
      (left.type.some((type) => type.kind === 'String') ||
        right.type.some((type) => type.kind === 'String'))
    ) {
      const leftString = left.type.some((type) => type.kind === 'String');
      const rightString = right.type.some((type) => type.kind === 'String');
      const leftOther = left.type.some(
        (type) =>
          !['String', 'Any', 'Unknown', 'Mixed', 'ArgumentIdentity'].includes(
            type.kind,
          ),
      );
      const rightOther = right.type.some(
        (type) =>
          !['String', 'Any', 'Unknown', 'Mixed', 'ArgumentIdentity'].includes(
            type.kind,
          ),
      );
      const alternatives: Type[] = [];
      if ((leftString || dynamic(left)) && (rightString || dynamic(right))) {
        const string = new Type('String');
        const a = knownConstant(left),
          b = knownConstant(right);
        if (typeof a === 'string' && typeof b === 'string')
          string.literalValue = a + b;
        alternatives.push(string);
      }
      if (leftOther && rightOther) alternatives.push(new Type('Real'));
      if (origin && ((leftString && rightOther) || (rightString && leftOther)))
        this.diagnostic(
          origin,
          'String concatenation requires a String on both sides of +.',
          'INVALID_OPERATION',
          alternatives.length ? 'warning' : 'error',
        );
      return alternatives.length ? value(...alternatives) : unknown();
    }
    const result = new Type('Real');
    const a = knownConstant(left),
      b = knownConstant(right);
    if (typeof a === 'number' && typeof b === 'number')
      result.literalValue = foldNumeric(operator, a, b);
    return value(result);
  }

  /** Compile-time eligibility is separate from a value inferred at runtime.
   * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Variables/Constants.htm
   * A spec's Pure flag alone does not certify compiler constant evaluation.
   */
  enumConstant(node: Expression, frame: Frame, before: number): ConstantFact {
    const unknown: ConstantFact = { kind: 'unknown' },
      invalid: ConstantFact = { kind: 'invalid' };
    const known = (
      current: string | number | boolean | undefined,
    ): ConstantFact =>
      current === undefined ? unknown : { kind: 'known', value: current };
    if (node.kind === 'literal')
      return ['Real', 'String', 'Bool'].includes(node.type)
        ? known(node.value)
        : invalid;
    if (node.kind === 'name' || node.kind === 'member') {
      const candidates =
        node.kind === 'name'
          ? [this.lookupName(node.name.text, frame)]
          : (this.expressionValues.get(node.target.id)?.type || []).map(
              (type) => this.lookupMember(type, node.name.text),
            );
      if (!candidates.length || candidates.some((candidate) => !candidate))
        return unknown;
      if (
        candidates.some(
          (candidate) =>
            candidate!.item.enumMember &&
            candidate!.origin?.spelling.uri === node.origin.spelling.uri &&
            candidate!.origin.spelling.start >= before,
        )
      )
        return invalid;
      if (
        candidates.some(
          (candidate) =>
            !candidate!.item.enumMember &&
            !candidate!.item.native &&
            candidate!.constant === undefined,
        )
      )
        return invalid;
      // Native schemas distinguish constants imperfectly. Do not treat an
      // immutable runtime variable as a proven constant merely due to its flag.
      if (
        candidates.some(
          (candidate) =>
            !candidate!.item.enumMember && candidate!.constant === undefined,
        )
      )
        return unknown;
      return known(
        knownConstant(this.expressionValues.get(node.id) || pending()),
      );
    }
    if (node.kind === 'unary') {
      if (!['+', '-', '~', '!', 'not'].includes(node.operator)) return invalid;
      const operand = this.enumConstant(node.operand, frame, before);
      if (operand.kind !== 'known') return operand;
      if (node.operator === '!' || node.operator === 'not')
        return typeof operand.value === 'boolean'
          ? known(!operand.value)
          : typeof operand.value === 'number'
            ? known(!(operand.value > 0.5))
            : unknown;
      if (typeof operand.value !== 'number') return invalid;
      return known(
        node.operator === '-'
          ? -operand.value
          : node.operator === '+'
            ? operand.value
            : foldBitwiseNot(operand.value),
      );
    }
    if (node.kind === 'binary') {
      const left = this.enumConstant(node.left, frame, before),
        right = this.enumConstant(node.right, frame, before);
      if (left.kind === 'invalid' || right.kind === 'invalid') return invalid;
      if (
        left.kind !== 'known' ||
        right.kind !== 'known' ||
        node.uncertainGrouping
      )
        return unknown;
      if (typeof left.value === 'number' && typeof right.value === 'number')
        return known(foldNumeric(node.operator, left.value, right.value));
      if (
        node.operator === '+' &&
        typeof left.value === 'string' &&
        typeof right.value === 'string'
      )
        return known(left.value + right.value);
      return unknown;
    }
    if (node.kind === 'conditional') {
      const condition = this.enumConstant(node.condition, frame, before),
        yes = this.enumConstant(node.yes, frame, before),
        no = this.enumConstant(node.no, frame, before);
      if ([condition, yes, no].some((fact) => fact.kind === 'invalid'))
        return invalid;
      if (condition.kind !== 'known') return unknown;
      const truth =
        typeof condition.value === 'boolean'
          ? condition.value
          : typeof condition.value === 'number'
            ? condition.value > 0.5
            : undefined;
      return truth === undefined ? unknown : truth ? yes : no;
    }
    if (node.kind === 'call' && !node.usesNew) {
      const target =
        node.target.kind === 'name'
          ? this.lookupName(node.target.name.text, frame)
          : undefined;
      if (!target) return unknown;
      if (!target.item.native) return invalid;
      const arguments_ = node.arguments
        .filter((argument) => argument.value)
        .map((argument) => this.enumConstant(argument.value!, frame, before));
      if (arguments_.some((argument) => argument.kind === 'invalid'))
        return invalid;
      if (arguments_.some((argument) => argument.kind !== 'known'))
        return unknown;
      // Only these documented elementary operations are folded here. Other
      // native calls remain unknown, not falsely rejected as non-constant.
      // Number_Functions/{abs,floor,ceil}.htm in the official monthly manual.
      if (
        arguments_.length === 1 &&
        arguments_[0].kind === 'known' &&
        typeof arguments_[0].value === 'number'
      ) {
        const input = arguments_[0].value;
        const operation = (
          { abs: Math.abs, floor: Math.floor, ceil: Math.ceil } as Record<
            string,
            ((value: number) => number) | undefined
          >
        )[target.item.name];
        if (operation && Number.isFinite(input)) return known(operation(input));
      }
      return unknown;
    }
    return invalid;
  }

  callable(type: FunctionType): FunctionType {
    if (type.methodSource) return this.evaluateMethod(type);
    const implementation = this.extensionImplementations.get(
      type.semanticKey || '',
    );
    if (implementation) {
      const fn = this.functionByType.get(implementation);
      if (fn) this.evaluateFunction(fn);
      return type;
    }
    const fn = type.semanticKey && this.functionByType.get(type.semanticKey);
    return fn ? this.evaluateFunction(fn) : type;
  }

  /** method creates a new bound value, retaining the original function and statics.
   * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Variable_Functions/method.htm
   */
  bindMethod(source: FunctionType, self: Type): FunctionType {
    source = source.methodSource || source;
    const key = `method:${this.keyOfType(source)}:${this.keyOfType(self)}`;
    const existing = this.methodAnalyses.get(key);
    if (existing) return this.evaluateMethod(existing.type);
    const method = source.deriveDetached() as FunctionType;
    method.semanticKey = key;
    method.self = self as WithableType;
    method.methodSource = source;
    method.returns = source.functionSource
      ? pending()
      : source.returns && value(source.returns);
    this.types.set(key, method);
    this.methodAnalyses.set(key, {
      type: method,
      active: false,
      complete: false,
    });
    return this.evaluateMethod(method);
  }

  evaluateMethod(method: FunctionType): FunctionType {
    const source = method.methodSource;
    const self = method.self;
    if (!source || !self) return method;
    const key =
      method.semanticKey ||
      `method:${this.keyOfType(source)}:${this.keyOfType(self)}`;
    let record = this.methodAnalyses.get(key);
    if (!record) {
      const copy = method.deriveDetached() as FunctionType;
      copy.semanticKey = key;
      record = { type: copy, active: false, complete: false };
      this.methodAnalyses.set(key, record);
      this.types.set(key, copy);
    }
    this.observe({
      kind: 'type',
      owner: this.keyOfType(source),
      facet: 'returns',
    });
    this.observe({
      kind: 'type',
      owner: this.keyOfType(self),
      facet: 'members',
    });
    if (record.active || record.complete) return record.type;
    const provenance = source.functionSource;
    const fn = provenance?.bound.functions.get(provenance.functionId);
    if (!provenance || !fn) {
      record.complete = true;
      return record.type;
    }
    // Evaluate just this callable and its nested declarations. Other files and
    // the source function's published storage are read-only environment inputs.
    const functions = new Map(
      [...provenance.bound.functions].filter(([, candidate]) => {
        for (
          let scope: BindingScope | undefined = provenance.bound.scopes.get(
            candidate.scope,
          );
          scope;
          scope = scope.parent
            ? provenance.bound.scopes.get(scope.parent)
            : undefined
        )
          if (scope.key === fn.scope) return true;
        return false;
      }),
    );
    const declarations = provenance.bound.declarations.filter(
      (declaration) =>
        declaration === fn.declaration ||
        functions.has(
          provenance.bound.scopes.get(declaration.scope)?.functionId || '',
        ),
    );
    const selected = new Set(declarations.map((declaration) => declaration.id));
    const bound: BoundUnit = {
      ...provenance.bound,
      functions,
      declarations,
      diagnostics: [],
      declarationSites: new Map(
        [...provenance.bound.declarationSites].filter(([, declaration]) =>
          selected.has(declaration.id),
        ),
      ),
    };
    const previous = record.type;
    const environment: SemanticEnvironment = {
      lookup: (request) => {
        const own = this.symbols.get(memberKey(request.owner, request.name));
        if (own?.item.def || own?.item.native) {
          const callable = this.functionByKey.get(own.key);
          if (
            callable &&
            this.functionStatus.get(callable.node.id) !== 'running'
          )
            this.evaluateFunction(callable);
          return own;
        }
        const member = this.types.get(request.owner)?.getMember(request.name);
        return member && (member.def || member.native)
          ? { key: this.keyOf(member), item: member }
          : this.environment.lookup(request);
      },
      type: (typeKey) =>
        typeKey === fn.typeKey
          ? previous
          : this.types.get(typeKey) ||
            this.types.get(this.namedTypes.get(typeKey) || '') ||
            this.environment.type(typeKey),
      observe: (dependency) => this.observe(dependency),
      cancelled: () => this.environment.cancelled(),
    };
    const seen = new Set<string>();
    let priorTypes: ReadonlyMap<string, Type> | undefined;
    record.active = true;
    try {
      for (;;) {
        this.checkCancellation();
        const child = new Evaluator(
          bound,
          environment,
          this.methodAnalyses,
          priorTypes,
        );
        const target = self.deriveDetached();
        target.semanticKey = this.keyOfType(self);
        for (const member of self.listMembers(true)) {
          const owned = child.symbols.get(this.keyOf(member));
          if (owned) {
            owned.item.replaceMetadata(member, value(member.type));
            owned.item.replaceDefinition(member.def, member.declaration);
            target.setOwnMember(owned.item);
          }
        }
        child.types.set(target.semanticKey, target);
        child.dynamicSelf.set(fn.selfOwner, target);
        child.reboundSelf.set(fn.node.id, target);
        const result = child.evaluateFunction(fn);
        priorTypes = child.types;
        record.diagnostics = child
          .uniqueDiagnostics()
          .filter((diagnostic) => diagnostic.severity === 'error');
        this.degraded ||= child.degraded;
        child.dependencies.forEach((dependency) => this.observe(dependency));
        const before = fingerprint(previous.returns || pending());
        previous.returns = value(result.returns || pending());
        const after = fingerprint(previous.returns);
        record.effects = {
          self: child.types.get(target.semanticKey) || target,
          symbols: [...child.symbols.values()].filter(
            (symbol) => symbol.owner === target.semanticKey && symbol.exported,
          ),
          itemsWritten: child.writtenTypes.has(target.semanticKey),
        };
        if (before === after) break;
        if (seen.has(after)) {
          this.degraded = true;
          break;
        }
        seen.add(after);
        const recursive = [...child.dependencies.values()].some(
          (dependency) =>
            dependency.kind === 'type' &&
            dependency.facet === 'returns' &&
            dependency.owner === fn.typeKey,
        );
        if (!recursive) break;
      }
      record.complete = true;
      return previous;
    } finally {
      record.active = false;
    }
  }

  applyMethodEffects(method: FunctionType, state: FlowState): void {
    if (!state.reachable || !method.semanticKey) return;
    const effects = this.methodAnalyses.get(method.semanticKey)?.effects;
    if (!effects || !effects.self.semanticKey) return;
    const ownerKey = effects.self.semanticKey;
    const owner = this.types.get(ownerKey) || this.copyShape(effects.self);
    for (const source of effects.symbols) {
      if (!source.item.writable || source.item.native) continue;
      let contribution = this.symbols.get(source.key);
      if (!contribution) {
        const item = new Signifier(owner, source.item.name);
        item.semanticKey = source.key;
        item.replaceMetadata(source.item, value(source.item.type));
        item.replaceDefinition(source.item.def, source.item.declaration);
        contribution = {
          ...source,
          item,
          unitId: this.bound.unitId,
          origin: source.origin && { ...source.origin, editable: false },
        };
        this.symbols.set(source.key, contribution);
      } else
        contribution.item.setType(
          join(contribution.item.type, source.item.type),
        );
      owner.setOwnMember(contribution.item);
      state.values.set(source.key, value(source.item.type));
    }
    if (effects.itemsWritten)
      owner.items = join(
        owner.items || pending(),
        effects.self.items || pending(),
      );
    if (effects.symbols.length || effects.itemsWritten)
      this.writtenTypes.add(ownerKey);
  }

  call(
    fn: FunctionType,
    symbol: SymbolView | undefined,
    arguments_: readonly Argument[],
    node: SyntaxNode,
    state: FlowState,
    frame: Frame,
    kind: SemanticCall['kind'],
  ): Value {
    fn = this.callable(fn);
    const generics = new Map<string, TypeStore>();
    const argumentValues: Value[] = [];
    const callName = symbol?.item.native
      ? symbol.item.name
      : fn.signifier?.native
        ? fn.signifier.name
        : undefined;
    arguments_.forEach((argument, index) => {
      const current = argument.value
        ? this.expression(argument.value, state, frame)
        : primitive('Undefined');
      argumentValues.push(current);
      const expected = fn.getParameter(index);
      if (expected)
        updateGenericsMap(expected.type, current, this.knownTypes, generics);
    });
    if (fn.methodSource) {
      this.applyMethodEffects(fn, state);
      for (const diagnostic of this.methodAnalyses.get(fn.semanticKey || '')
        ?.diagnostics || [])
        this.diagnostics.push({
          ...diagnostic,
          origin: node.origin,
          message: `Bound method: ${diagnostic.message}`,
        });
    }
    this.calls.set(node.id, {
      origin: node.origin,
      type: fn,
      arguments: arguments_.map((argument, index) => ({
        origin: argument.origin,
        hasExpression: !!argument.value,
        type: argumentValues[index],
      })),
      kind,
    });
    this.observe({
      kind: 'type',
      owner: symbol?.key || this.keyOfType(fn),
      facet: 'signature',
    });
    this.observe({
      kind: 'type',
      owner: symbol?.key || this.keyOfType(fn),
      facet: 'returns',
    });
    if (state.reachable && callName === 'event_inherited')
      this.callsSuper = true;
    if (callName === 'static_get') {
      const accepted = fn.getParameter(0)?.type.type || [];
      const allowsFunction =
        !accepted.length ||
        accepted.some((type) =>
          ['Function', 'Asset.GMScript', 'Any', 'Unknown', 'Mixed'].includes(
            type.kind,
          ),
        );
      const statics =
        argumentValues[0]?.type
          .map((type) => {
            if (type.kind === 'Function') {
              if (!allowsFunction) return;
              const source =
                (type as FunctionType).methodSource || (type as FunctionType);
              return this.callable(source).statics;
            }
            return (
              type.statics ||
              (type.kind === 'Struct'
                ? type.signifier?.getTypeByKind('Function')?.statics
                : undefined)
            );
          })
          .filter((type): type is StructType => !!type) || [];
      for (const type of statics)
        this.observe({
          kind: 'type',
          owner: this.keyOfType(type),
          facet: 'static',
        });
      if (statics.length) return value(...statics);
      if (
        !allowsFunction &&
        argumentValues[0]?.type.some((type) => type.kind === 'Function')
      )
        return unknown();
    }
    if (callName === 'method' && argumentValues[1]) {
      const targets =
        argumentValues[0]?.type.flatMap((type) =>
          type.kind === 'Undefined'
            ? frame.self
              ? [frame.self]
              : []
            : ['Struct', 'Id.Instance'].includes(type.kind)
              ? [this.storageType(type)]
              : [],
        ) || [];
      const methods = argumentValues[1].type.filter(
        (type): type is FunctionType => type.kind === 'Function',
      );
      return targets.length && methods.length
        ? value(
            ...methods.flatMap((source) =>
              targets.map((target) => this.bindMethod(source, target)),
            ),
          )
        : unknown();
    }
    if (state.reachable && symbol?.item.mixin && fn.self) {
      const self = frame.self;
      this.observe({
        kind: 'type',
        owner: this.keyOfType(fn.self),
        facet: 'members',
      });
      if (self && this.types.get(this.keyOfType(self)) === self) {
        for (const member of fn.self.listMembers())
          if (!self.getMember(member.name)?.native) self.setOwnMember(member);
        this.writtenTypes.add(this.keyOfType(self));
      }
    }
    if (kind === 'new')
      return fn.isConstructor && fn.self ? value(fn.self) : unknown();
    let returns = fn.returns || pending();
    if (
      !returns.hasTypes &&
      symbol &&
      this.functionStatus.get(
        this.functionByKey.get(symbol.key)?.node.id || '',
      ) === 'running'
    ) {
      const key = this.functionByKey.get(symbol.key)!.typeKey;
      const prior = this.environment.type(key)?.returns;
      this.observe({ kind: 'type', owner: key, facet: 'returns' });
      if (prior) returns = this.recursiveReturn(prior);
    }
    if (!returns.hasTypes) return pending();
    const normalized = normalizeType(
      replaceGenerics(returns, this.knownTypes, generics),
      this.knownTypes,
    );
    // Native specifications use ArgumentIdentity for dependent results. Keep
    // resolved alternatives; an unbound leaf carries no concrete type fact.
    const resolved = valueFrom(
      normalized.type.map((type) =>
        type.kind === 'ArgumentIdentity' ? new Type('Unknown') : type,
      ),
    );
    const instance = this.nativeInstanceResult(
      callName,
      argumentValues,
      resolved,
    );
    if (instance) return this.callInstanceViews(instance, node);
    // These native calls allocate fresh mutable containers. Their shared
    // specification return type is a contract, not storage owned by every call.
    // https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Data_Structures/DS_Maps/ds_map_create.htm
    // https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Variable_Functions/array_create.htm
    if (
      callName === 'array_create' ||
      /^ds_(map|list|grid|queue|stack|priority)_create$/.test(callName || '')
    ) {
      return value(
        ...resolved.type.map((type) => {
          if (type.kind !== 'Array' && !type.kind.startsWith('Id.Ds'))
            return type;
          const key = `allocation:${this.bound.unitId}:${node.id}:${type.kind}`;
          let owned = this.types.get(key);
          if (!owned || this.recursiveAllocations.delete(key)) {
            owned ||= type.deriveDetached();
            owned.semanticKey = key;
            owned.items =
              callName === 'array_create'
                ? value(argumentValues[1] || primitive('Real'))
                : undefined;
            this.types.set(key, owned);
          }
          return owned;
        }),
      );
    }
    return this.callInstanceViews(resolved, node);
  }

  /** Create has completed before these calls return. Keep the selected resource
   * instance view separate from the immutable generic native return contract. */
  nativeInstanceResult(
    name: string | undefined,
    arguments_: readonly Value[],
    fallback: Value,
  ): Value | undefined {
    const objectIndex =
      name === 'instance_create_layer' || name === 'instance_create_depth'
        ? 3
        : name === 'instance_create'
          ? 2
          : undefined;
    if (objectIndex === undefined) return undefined;
    const objects = arguments_[objectIndex];
    if (!objects?.hasTypes) return fallback;
    const instances: Type[] = [];
    let unknownObject = false;
    for (const object of objects.type) {
      const instance =
        object.kind === 'Asset.GMObject' && object.name
          ? this.readType(`Id.Instance.${object.name}`, 'members')
          : undefined;
      if (instance?.kind !== 'Id.Instance' || instance.name !== object.name) {
        unknownObject = true;
        continue;
      }
      instances.push(instance);
      this.observe({
        kind: 'type',
        owner: this.keyOfType(object),
        facet: 'members',
      });
      const seen = new Set<Type>();
      for (
        let current: Type | undefined = instance;
        current && !seen.has(current);
        current = current.extends
      ) {
        seen.add(current);
        this.observe({
          kind: 'type',
          owner: this.keyOfType(current),
          facet: 'members',
        });
      }
    }
    return valueFrom(unknownObject ? [...instances, fallback] : instances);
  }

  readTarget(target: Expression, state: FlowState, frame: Frame): Value {
    return this.expression(target, state, frame);
  }

  /** Analyze both source branches, but apply runtime effects only on feasible paths. */
  coalesce(
    previous: Value,
    right: Expression,
    state: FlowState,
    frame: Frame,
    target?: CapturedTarget,
  ): Value {
    const paths = nullishPaths(previous);
    const skipped = copyFlow(state),
      executed = copyFlow(state);
    skipped.reachable &&= paths.maySkip;
    executed.reachable &&= paths.mayRun;
    if (target)
      for (const symbol of target.symbols) {
        skipped.values.set(
          symbol.key,
          nullishPaths(this.symbolType(symbol, state)).present,
        );
      }
    const replacement = this.expression(right, executed, frame);
    if (target && executed.reachable) target.write(replacement, executed);
    const merged = mergeFlow([skipped, executed]);
    state.values.clear();
    merged.values.forEach((entry, key) => state.values.set(key, entry));
    state.reachable = merged.reachable;
    return nullishResult(previous, replacement);
  }

  /** Capture receiver and indices before RHS effects; write never re-evaluates them. */
  captureTarget(
    target: Expression,
    state: FlowState,
    frame: Frame,
  ): CapturedTarget {
    if (target.kind === 'member' || target.kind === 'index') {
      const prepared = this.prepareAccess(target, state, frame);
      const located = this.accessPrepared(
        target,
        prepared,
        state,
        frame,
        false,
      );
      return {
        value: located.type,
        symbols: located.symbols,
        write: (current, branch) => {
          this.accessPrepared(target, prepared, branch, frame, true, current);
          return current;
        },
      };
    }
    const previous = this.readTarget(target, state, frame);
    const symbol =
      target.kind === 'name'
        ? this.lookupName(target.name.text, frame)
        : undefined;
    return {
      value: previous,
      symbols: symbol ? [symbol] : [],
      write: (current, branch) =>
        this.assignTarget(target, current, branch, frame, 'read-write'),
    };
  }
  resolveAlias(key: string): string {
    const seen = new Set<string>();
    while (this.symbolAliases.has(key) && !seen.has(key)) {
      seen.add(key);
      key = this.symbolAliases.get(key)!;
    }
    return key;
  }
  redirectSymbol(from: string, to: string): void {
    if (from === to) return;
    const old = this.symbols.get(from);
    if (old) {
      const owner = this.types.get(old.owner);
      if (owner)
        owner.replaceOwnMembers(
          owner.listMembers(true).filter((member) => member !== old.item),
        );
      this.symbols.delete(from);
    }
    this.symbolAliases.set(from, to);
  }

  assignTarget(
    target: Expression,
    current: Value,
    state: FlowState,
    frame: Frame,
    role: ReferenceRole = 'write',
  ): Value {
    if (target.kind === 'name') {
      const declaration = this.bound.declarationSites.get(target.name.id);
      let symbol = declaration
        ? this.nativeDeclarations.get(declaration.id) ||
          this.symbols.get(this.resolveAlias(declaration.key))
        : this.lookupName(target.name.text, frame);
      if (!symbol)
        symbol =
          this.lookupName(target.name.text, frame) ||
          this.unresolved(target.name, frame);
      if (
        declaration?.role === 'field' &&
        frame.self &&
        !this.nativeDeclarations.has(declaration.id)
      ) {
        const storage = this.storageType(frame.self);
        const actualOwner = this.keyOfType(storage);
        if (actualOwner !== declaration.owner) {
          let actual = this.lookupMember(frame.self, target.name.text);
          if (!actual) {
            const owner =
              this.types.get(actualOwner) || this.copyShape(storage);
            const item = new Signifier(owner, target.name.text);
            item.semanticKey = memberKey(actualOwner, target.name.text);
            item.instance = true;
            actual = { key: item.semanticKey, item, bare: declaration.bare };
          }
          actual = this.ownWrite(actual, target.name, frame) || actual;
          this.redirectSymbol(declaration.key, actual.key);
          symbol = actual;
        }
        if (
          storage.extends &&
          current.type.every((type) => type.kind !== 'Function')
        ) {
          const inherited = this.lookupMember(
            storage.extends,
            target.name.text,
          );
          if (
            inherited?.item.def &&
            !inherited.item.static &&
            !inherited.item.getTypeByKind('Function')
          ) {
            this.redirectSymbol(declaration.key, inherited.key);
            symbol = inherited;
          }
        }
      }
      return this.write(
        symbol,
        current,
        state,
        target.name,
        frame,
        !!declaration &&
          this.symbols.get(symbol.key)?.declaration?.origin ===
            declaration.origin,
        role,
      );
    }
    if (target.kind === 'member' || target.kind === 'index') {
      const located = this.access(target, state, frame, true, current);
      for (const symbol of located.symbols)
        this.write(
          symbol,
          current,
          state,
          target.kind === 'member' ? target.name : target,
          frame,
          !symbol.item.def,
          role,
          target.kind === 'index' && target.accessor === 'struct'
            ? { kind: 'none' }
            : { kind: 'identifier' },
        );
      return current;
    }
    this.expression(target, state, frame);
    this.diagnostic(
      target.origin,
      'The target of an assignment must be a variable or container member.',
      'INVALID_OPERATION',
      'error',
    );
    return current;
  }
  /** Every real write owns a candidate site, even when another unit already
   * supplied the member. Borrowed definition locations are never owned facts. */
  ownWrite(
    symbol: SymbolView,
    node: SyntaxNode,
    frame: Frame,
  ): SymbolContribution | undefined {
    let owned = this.symbols.get(symbol.key);
    if (owned) return owned;
    if (symbol.intrinsic || symbol.item.native) return;
    const ownerKey = this.keyOfType(symbol.item.parent);
    const owner =
      this.types.get(ownerKey) || this.copyShape(symbol.item.parent);
    const item = new Signifier(owner, symbol.item.name);
    item.semanticKey = symbol.key;
    item.replaceMetadata(symbol.item, pending());
    item.replaceDefinition({});
    item.definitive = this.bound.context.definitiveSelf || !!frame.function;
    owned = {
      key: symbol.key,
      item,
      owner: ownerKey,
      unitId: this.bound.unitId,
      exported: true,
      bare: symbol.bare,
      origin: node.origin,
    };
    this.symbols.set(symbol.key, owned);
    owner.setOwnMember(item);
    return owned;
  }
  write(
    symbol: SymbolView,
    current: Value,
    state: FlowState,
    node: SyntaxNode,
    frame: Frame,
    definition = false,
    role: ReferenceRole = 'write',
    rename: RenameRecipe = { kind: 'identifier' },
  ): Value {
    if (!symbol.item.writable)
      this.diagnostic(
        node.origin,
        `Cannot assign to read-only symbol \`${symbol.item.name}\`.`,
        'INVALID_OPERATION',
        'error',
      );
    let constrained = current;
    if (
      this.annotated.has(symbol.key) ||
      symbol.intrinsic ||
      symbol.item.native
    ) {
      const contract = value(symbol.item.type);
      const instanceAssignment =
        contract.hasTypes &&
        contract.type.every(
          (type) =>
            type.kind === 'Id.Instance' &&
            !type.name &&
            type.literalValue === undefined,
        ) &&
        current.hasTypes &&
        current.type.every((type) => type.kind === 'Id.Instance');
      // A generic instance annotation constrains the kind, not the identity of
      // the assigned value. Preserve a proven alias rather than its schema slot.
      constrained = instanceAssignment
        ? current
        : this.inputInstanceViews(contract, `assignment:${node.id}`);
    }
    let owned = this.symbols.get(symbol.key);
    if (state.reachable && symbol.item.writable) {
      state.values.set(symbol.key, constrained);
      owned = this.ownWrite(symbol, node, frame);
      if (owned && !this.annotated.has(symbol.key))
        owned.item.setType(join(owned.item.type, current));
    }
    const candidate = owned?.origin?.spelling;
    definition =
      (definition ||
        (!!candidate &&
          candidate.uri === node.origin.spelling.uri &&
          candidate.start === node.origin.spelling.start &&
          candidate.end === node.origin.spelling.end)) &&
      !symbol.intrinsic &&
      !symbol.item.native;
    this.record(
      node,
      symbol,
      constrained,
      definition
        ? role === 'shorthand-property'
          ? role
          : 'declaration'
        : role,
      definition,
      rename,
    );
    return constrained;
  }

  access(
    node: Extract<Expression, { kind: 'member' | 'index' }>,
    state: FlowState,
    frame: Frame,
    write: boolean,
    assigned?: Value,
  ): LocatedValue {
    return this.accessPrepared(
      node,
      this.prepareAccess(node, state, frame),
      state,
      frame,
      write,
      assigned,
    );
  }

  prepareAccess(
    node: Extract<Expression, { kind: 'member' | 'index' }>,
    state: FlowState,
    frame: Frame,
  ): PreparedAccess {
    const target = this.expression(node.target, state, frame);
    let key: string | undefined;
    let keyNode: SyntaxNode = node;
    let rename: RenameRecipe = { kind: 'identifier' };
    if (node.kind === 'member') {
      key = node.name.text;
      keyNode = node.name;
      rename = { kind: 'identifier', property: true };
    } else {
      const indices = node.indices.map((index) =>
        this.expression(index, state, frame),
      );
      if (node.accessor === 'struct') {
        const constant = indices[0] && knownConstant(indices[0]);
        if (typeof constant === 'string') {
          key = constant;
          keyNode = node.indices[0];
          rename =
            node.indices[0].kind === 'literal'
              ? { kind: 'string-key', quote: '"' }
              : { kind: 'none' };
        }
      }
    }
    return { target, key, keyNode, rename };
  }

  accessPrepared(
    node: Extract<Expression, { kind: 'member' | 'index' }>,
    prepared: PreparedAccess,
    state: FlowState,
    frame: Frame,
    write: boolean,
    assigned?: Value,
  ): LocatedValue {
    const { target, key, keyNode, rename } = prepared;
    const result: Value[] = [];
    const symbols: SymbolView[] = [];
    const receivers: Type[] = [];
    let accessible = false;
    for (let type of target.type) {
      if (type.kind === 'Function') {
        const fn =
          type.semanticKey && this.functionByType.get(type.semanticKey);
        if (fn) type = this.evaluateFunction(fn);
        type =
          type.statics || this.ensureType(`${this.keyOfType(type)}:statics`);
      }
      const unidentifiedInstance = this.needsInstanceView(type);
      type = this.storageType(type);
      receivers.push(type);
      if (
        ![
          'Struct',
          'Enum',
          'Id.Instance',
          'Asset.GMObject',
          'Array',
          'Id.DsMap',
          'Id.DsList',
          'Id.DsGrid',
        ].includes(type.kind)
      )
        continue;
      accessible = true;
      if (node.kind === 'member') {
        if (!node.name.text) {
          // Keep the receiver's completion namespace without inventing a
          // member named "", a reference at offset zero, or a semantic error.
          this.observe({
            kind: 'type',
            owner: this.keyOfType(type),
            facet: 'members',
          });
          result.push(unknown());
          continue;
        }
      }
      if (
        key !== undefined &&
        ['Struct', 'Enum', 'Id.Instance', 'Asset.GMObject'].includes(type.kind)
      ) {
        let member = this.lookupMember(type, key);
        if (!member && type.semanticKey === globalOwner) {
          const candidate =
            this.symbols.get(globalKey(key)) ||
            this.importedLookup('global', globalOwner, key);
          if (candidate?.item.def || candidate?.item.native) member = candidate;
        }
        if (!member && unidentifiedInstance) {
          // A schema without a value/binding identity cannot own flow slots.
          // Keep custom members unknown rather than inventing a must-alias heap.
          result.push(unknown());
          continue;
        }
        if (
          !member &&
          write &&
          state.reachable &&
          type.kind !== 'Enum' &&
          !type.isReadonly
        ) {
          const owner = this.keyOfType(type);
          const owned =
            this.types.get(owner) === type ? type : this.copyShape(type);
          const item = new Signifier(owned, key);
          item.semanticKey = memberKey(owner, key);
          item.global = owner === globalOwner;
          item.instance = owner !== globalOwner;
          item.def = {};
          item.definitive =
            this.bound.context.definitiveSelf || !!frame.function;
          const contribution: SymbolContribution = {
            key: item.semanticKey,
            item,
            origin: keyNode.origin,
            owner,
            unitId: this.bound.unitId,
            bare: owner === globalOwner ? false : undefined,
            exported: !owner.startsWith('struct:' + this.bound.unitId),
          };
          this.symbols.set(contribution.key, contribution);
          owned.setOwnMember(item);
          member = contribution;
        }
        if (member) {
          const current = this.symbolType(member, state);
          result.push(current);
          if (write && assigned) {
            const definition =
              member.origin?.spelling.uri === keyNode.origin.spelling.uri &&
              member.origin.spelling.start === keyNode.origin.spelling.start;
            this.write(
              member,
              assigned,
              state,
              keyNode,
              frame,
              definition,
              'write',
              rename,
            );
          } else {
            symbols.push(member);
            this.record(keyNode, member, current, 'read', false, rename);
          }
        } else {
          if (!write) {
            this.diagnostic(
              keyNode.origin,
              type.kind === 'Enum'
                ? `Undefined enum member \`${key}\`.`
                : `Undeclared symbol \`${key}\``,
              type.kind === 'Enum'
                ? 'INVALID_OPERATION'
                : 'UNDECLARED_VARIABLE_REFERENCE',
            );
            const owner = this.keyOfType(type);
            const missingKey =
              owner === globalOwner ? globalKey(key) : memberKey(owner, key);
            let missing = this.symbols.get(missingKey);
            if (!missing) {
              const shape =
                type.kind === 'Enum'
                  ? type
                  : this.types.get(owner) || this.copyShape(type);
              const item = new Signifier(shape, key, Type.Any);
              item.semanticKey = missingKey;
              item.placeholder = true;
              missing = {
                key: missingKey,
                item,
                owner,
                unitId: this.bound.unitId,
                exported: false,
              };
              this.symbols.set(missingKey, missing);
              if (type.kind !== 'Enum') shape.setOwnMember(item);
            }
            this.record(keyNode, missing, unknown(), 'read', false, rename);
          } else if (type.kind === 'Enum' || type.isReadonly)
            this.diagnostic(
              keyNode.origin,
              'Cannot add variables to this type.',
              'INVALID_OPERATION',
              'error',
            );
          this.observe({
            kind: 'type',
            owner: this.keyOfType(type),
            facet: 'items',
          });
          result.push(type.items || unknown());
        }
      } else {
        this.observe({
          kind: 'type',
          owner: this.keyOfType(type),
          facet: 'items',
        });
        if (write && assigned && !type.isReadonly && state.reachable) {
          const owned =
            this.types.get(this.keyOfType(type)) === type
              ? type
              : this.copyShape(type);
          owned.items = join(owned.items || pending(), assigned);
          this.writtenTypes.add(this.keyOfType(owned));
          result.push(assigned);
        } else result.push(type.items || unknown());
      }
    }
    if (node.kind === 'member') {
      // One boundary retains the complete receiver union. Even an unresolved
      // receiver stays inside this namespace instead of exposing lexical names.
      this.dotScope(
        node,
        frame,
        receivers.length ? receivers : [Type.Any],
        state,
      );
    }
    if (!accessible && !dynamic(target))
      this.diagnostic(
        node.origin,
        node.kind === 'member'
          ? 'Type does not allow dot accessors.'
          : 'Type does not allow this indexed accessor.',
      );
    return { type: result.length ? join(...result) : unknown(), symbols };
  }
  copyShape(type: Type): Type {
    const key = this.keyOfType(type);
    const existing = this.types.get(key);
    if (existing) return existing;
    const copy = new Type(type.kind);
    copy.semanticKey = key;
    copy.name = type.name;
    copy.setBaseView(type.extends);
    copy.items = type.items && value(type.items);
    copy.self = type.self;
    copy.local = type.local;
    copy.statics = type.statics;
    copy.returns = type.returns;
    copy.isConstructor = type.isConstructor;
    for (const member of type.listMembers(true)) copy.setOwnMember(member);
    this.types.set(key, copy);
    return copy;
  }

  narrow(
    condition: Expression,
    state: FlowState,
    truthy: boolean,
    frame: Frame,
  ): void {
    const evaluated = this.expressionValues.get(condition.id);
    const known = evaluated && constantTruth(evaluated);
    if (known !== undefined && known !== truthy) state.reachable = false;
    if (
      condition.kind === 'binary' &&
      ['&&', 'and', '||', 'or'].includes(condition.operator)
    ) {
      const conjunction = ['&&', 'and'].includes(condition.operator);
      if (truthy === conjunction) {
        this.narrow(condition.left, state, truthy, frame);
        this.narrow(condition.right, state, truthy, frame);
      } else {
        const skipped = copyFlow(state),
          evaluatedRight = copyFlow(state);
        this.narrow(condition.left, skipped, truthy, frame);
        this.narrow(condition.left, evaluatedRight, !truthy, frame);
        this.narrow(condition.right, evaluatedRight, truthy, frame);
        const merged = mergeFlow([skipped, evaluatedRight]);
        state.values.clear();
        merged.values.forEach((value, key) => state.values.set(key, value));
        state.reachable = merged.reachable;
      }
      return;
    }
    let name: Name | undefined;
    let kind: Type['kind'] | undefined;
    let keep = truthy;
    if (condition.kind === 'unary' && ['!', 'not'].includes(condition.operator))
      return this.narrow(condition.operand, state, !truthy, frame);
    if (
      condition.kind === 'call' &&
      condition.target.kind === 'name' &&
      condition.arguments[0]?.value?.kind === 'name'
    ) {
      const guard = this.lookupName(condition.target.name.text, frame);
      if (!guard?.item.native) return;
      // A named script function can be callable without being a method. The
      // common Function kind alone does not prove the negative branch empty.
      if (condition.target.name.text === 'is_method' && !truthy) return;
      name = condition.arguments[0].value.name;
      kind = (
        {
          is_undefined: 'Undefined',
          is_real: 'Real',
          is_string: 'String',
          is_bool: 'Bool',
          is_struct: 'Struct',
          is_array: 'Array',
          is_callable: 'Function',
          is_method: 'Function',
        } as Record<string, Type['kind']>
      )[condition.target.name.text];
    } else if (
      condition.kind === 'binary' &&
      ['=', '==', '!=', '<>'].includes(condition.operator)
    ) {
      const target =
        condition.left.kind === 'name' && condition.right.kind === 'literal'
          ? condition.left
          : condition.right.kind === 'name' && condition.left.kind === 'literal'
            ? condition.right
            : undefined;
      const literal =
        condition.left.kind === 'literal'
          ? condition.left
          : condition.right.kind === 'literal'
            ? condition.right
            : undefined;
      if (target && literal?.type === 'Undefined') {
        name = target.name;
        kind = 'Undefined';
        keep = ['!=', '<>'].includes(condition.operator) ? !truthy : truthy;
      }
    }
    if (!name || !kind) return;
    const symbol = this.lookupName(name.text, frame);
    if (!symbol) return;
    const previous = this.symbolType(symbol, state);
    if (dynamic(previous)) {
      if (keep) {
        const type = new Type(kind);
        if (kind === 'Function') {
          type.addParameter(0, '...', { type: Type.Any, optional: true });
          type.returns = unknown();
        }
        state.values.set(symbol.key, value(type));
      }
      return;
    }
    const narrowed = valueFrom(
      previous.type.filter((type) => (type.kind === kind) === keep),
    );
    state.values.set(symbol.key, narrowed);
    if (!narrowed.hasTypes) state.reachable = false;
  }

  execute(node: Statement, state: FlowState, frame: Frame): Completion[] {
    this.checkCancellation();
    frame = this.frameFor(node, frame);
    this.scope(node, frame);
    switch (node.kind) {
      case 'block': {
        let completions = normal(state);
        for (const child of node.statements) {
          const live = completions.filter(
            (completion) => completion.kind === 'normal',
          );
          const abrupt = completions.filter(
            (completion) => completion.kind !== 'normal',
          );
          if (!live.length) {
            const unreachable = copyFlow(state);
            unreachable.reachable = false;
            this.execute(child, unreachable, frame);
            continue;
          }
          completions = [
            ...abrupt,
            ...this.execute(
              child,
              mergeFlow(live.map((completion) => completion.state)),
              frame,
            ),
          ];
        }
        return completions;
      }
      case 'declarations': {
        for (const declaration of node.declarations) {
          const bound = this.bound.declarationSites.get(declaration.name.id);
          if (!bound) continue;
          const native = this.nativeDeclarations.get(bound.id);
          const symbol = native || this.symbols.get(bound.key)!;
          if (native && !declaration.value) {
            this.record(
              declaration.name,
              native,
              value(native.item.type),
              'declaration',
            );
            continue;
          }
          const current =
            node.storage === 'static' && state.values.has(symbol.key)
              ? state.values.get(symbol.key)!
              : declaration.value
                ? this.expression(declaration.value, state, frame)
                : primitive('Undefined');
          this.write(symbol, current, state, declaration.name, frame, true);
        }
        return normal(state);
      }
      case 'function': {
        const fn = this.bound.functions.get(node.expression.id);
        if (fn) {
          const type = this.types.get(fn.typeKey)!;
          const symbol = this.symbols.get(fn.key);
          if (symbol && node.expression.name)
            this.record(
              node.expression.name,
              symbol,
              value(type),
              'declaration',
              true,
            );
        }
        return normal(state);
      }
      case 'expression':
        this.expression(node.expression, state, frame);
        return normal(state);
      case 'enum': {
        let next: number | undefined = 0;
        const root = this.symbols.get(globalKey(node.name.text));
        if (root)
          this.record(
            node.name,
            root,
            value(root.item.type),
            'declaration',
            true,
          );
        for (const member of node.members) {
          const declaration = this.bound.declarationSites.get(member.name.id)!;
          const symbol = this.symbols.get(declaration.key)!;
          if (member.value) this.expression(member.value, state, frame);
          const constant: ConstantFact = member.value
            ? this.enumConstant(member.value, frame, member.start)
            : next === undefined
              ? { kind: 'unknown' }
              : { kind: 'known', value: next };
          if (
            constant.kind === 'invalid' ||
            (constant.kind === 'known' &&
              (typeof constant.value !== 'number' ||
                !Number.isInteger(constant.value)))
          ) {
            this.diagnostic(
              member.origin,
              'An enum value must be a constant integer expression; user variables and user functions are not compile-time constants.',
              'INVALID_OPERATION',
              'error',
            );
            next = undefined;
          } else if (constant.kind === 'unknown') {
            this.degraded = true;
            next = undefined;
            this.diagnostic(
              member.origin,
              'The enum value cannot be verified as a compile-time integer with the available native and target information.',
              'INVALID_OPERATION',
              'info',
            );
          } else if (constant.kind === 'known') {
            const integer = constant.value as number;
            next = Number.isSafeInteger(integer) ? integer + 1 : undefined;
            const type = symbol.item.type.type[0];
            type.literalValue = integer;
          }
          this.record(
            member.name,
            symbol,
            value(symbol.item.type),
            'declaration',
            true,
          );
        }
        return normal(state);
      }
      case 'if': {
        this.expression(node.condition, state, frame);
        const yes = copyFlow(state),
          no = copyFlow(state);
        this.narrow(node.condition, yes, true, frame);
        this.narrow(node.condition, no, false, frame);
        return [
          ...this.execute(node.yes, yes, frame),
          ...(node.no ? this.execute(node.no, no, frame) : normal(no)),
        ];
      }
      case 'return':
        return [
          {
            kind: 'return',
            state,
            value: node.value
              ? this.expression(node.value, state, frame)
              : primitive('Undefined'),
          },
        ];
      case 'throw':
        return [
          {
            kind: 'throw',
            state,
            value: node.value
              ? this.expression(node.value, state, frame)
              : unknown(),
          },
        ];
      case 'exit':
      case 'break':
      case 'continue':
        return [{ kind: node.kind, state }];
      case 'with': {
        // Evaluate the target once. with is a loop over its selected instances
        // or struct; break/continue belong here, while return/throw/exit escape.
        // https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Language_Features/with.htm
        const target = this.expression(node.expression, state, frame);
        const counts = target.type.map(
          (type): 'zero' | 'one' | 'many' | 'never' => {
            if (type.kind === 'Never') return 'never';
            if (type.literalValue === -4) return 'zero';
            if (type.literalValue === -3) return 'many';
            if (
              type.literalValue === -1 ||
              type.literalValue === -2 ||
              ['Struct', 'Id.Instance'].includes(type.kind)
            )
              return 'one';
            return 'many';
          },
        );
        const maySkip =
          !counts.length ||
          counts.some((count) => count === 'zero' || count === 'many');
        const mayRepeat = !counts.length || counts.includes('many');
        const canRun =
          !counts.length ||
          counts.some((count) => count === 'one' || count === 'many');
        const annotated =
          node.docs?.self && this.knownTypes.get(node.docs.self.content);
        const legacy = knownConstant(target);
        const receiver = target.type.find(
          (type) =>
            type.literalValue !== -4 &&
            (type.literalValue !== -3 || !!type.extends) &&
            ['Struct', 'Id.Instance', 'Asset.GMObject'].includes(type.kind),
        );
        const selectedSelf =
          annotated ||
          receiver ||
          (legacy === -1
            ? frame.self
            : legacy === -2
              ? frame.other
              : undefined) ||
          this.ensureType(`with:${node.id}`);
        const innerScope =
          this.bound.scopes.get(`${node.id}:with`) || frame.scope;
        const self = this.inputInstanceViews(
          value(selectedSelf),
          `receiver:${innerScope.key}`,
        ).type[0];
        const inner: Frame = {
          ...frame,
          scope: innerScope,
          self,
          other: frame.self,
        };
        this.dynamicSelf.set(innerScope.selfOwner, self);
        const entry = copyFlow(state);
        const results: Completion[] = maySkip ? normal(copyFlow(entry)) : [];
        if (!canRun) {
          const unreachable = copyFlow(entry);
          unreachable.reachable = false;
          this.execute(node.body, unreachable, inner);
          return results;
        }
        let head = copyFlow(entry);
        const seen = new Set<string>();
        for (;;) {
          const key = flowKey(head);
          if (seen.has(key)) break;
          seen.add(key);
          const body = this.execute(node.body, copyFlow(head), inner);
          results.push(
            ...body
              .filter(
                (completion) =>
                  !['normal', 'continue'].includes(completion.kind),
              )
              .map((completion) =>
                completion.kind === 'break'
                  ? { ...completion, kind: 'normal' as const }
                  : completion,
              ),
          );
          const back = body
            .filter((completion) =>
              ['normal', 'continue'].includes(completion.kind),
            )
            .map((completion) => completion.state);
          if (!back.length) break;
          const advanced = mergeFlow(back);
          results.push(...normal(copyFlow(advanced)));
          if (!mayRepeat) break;
          const next = mergeFlow([entry, head, advanced]);
          if (flowKey(next) === key) break;
          head = next;
        }
        return results;
      }
      case 'switch': {
        const selector = knownConstant(
          this.expression(node.expression, state, frame),
        );
        const unmatched = copyFlow(state);
        const entries = new Map<(typeof node.cases)[number], FlowState>();
        let default_: (typeof node.cases)[number] | undefined;
        for (const entry of node.cases) {
          if (!entry.test) {
            default_ ||= entry;
            const recovery = copyFlow(state);
            recovery.reachable = false;
            entries.set(entry, recovery);
            continue;
          }
          // GML case labels are fixed values. Analyze recovery expressions for
          // references without letting invalid label effects enter runtime flow.
          const labelState = copyFlow(state);
          labelState.reachable = false;
          const test = knownConstant(
            this.expression(entry.test, labelState, frame),
          );
          const selected = copyFlow(unmatched);
          if (selector !== undefined && test !== undefined) {
            selected.reachable &&= selector === test;
            if (selector === test) unmatched.reachable = false;
          }
          entries.set(entry, selected);
        }
        if (default_) entries.set(default_, copyFlow(unmatched));
        const results: Completion[] = [];
        let fallthrough: FlowState[] = [];
        for (const entry of node.cases) {
          const current = this.execute(
            entry.body,
            mergeFlow([entries.get(entry)!, ...fallthrough]),
            frame,
          );
          fallthrough = current
            .filter((completion) => completion.kind === 'normal')
            .map((completion) => completion.state);
          results.push(
            ...current
              .filter((completion) => completion.kind !== 'normal')
              .map((completion) =>
                completion.kind === 'break'
                  ? { ...completion, kind: 'normal' as const }
                  : completion,
              ),
          );
        }
        if (!default_) fallthrough.push(unmatched);
        if (fallthrough.length) results.push(...normal(mergeFlow(fallthrough)));
        return results;
      }
      case 'try': {
        let results = this.execute(node.body, copyFlow(state), frame);
        if (node.catchBody) {
          const incoming = mergeFlow([
            state,
            ...results
              .filter((completion) => completion.kind === 'throw')
              .map((completion) => completion.state),
          ]);
          const scope =
            this.bound.scopes.get(`${node.id}:catch`) || frame.scope;
          if (node.catchName) {
            const declaration = this.bound.declarationSites.get(
              node.catchName.id,
            );
            const symbol = declaration && this.symbols.get(declaration.key);
            if (symbol)
              this.write(
                symbol,
                value(this.readType('Struct.Exception') || Type.Any),
                incoming,
                node.catchName,
                { ...frame, scope },
                true,
              );
          }
          results = [
            ...results.filter((completion) => completion.kind !== 'throw'),
            ...this.execute(node.catchBody, incoming, { ...frame, scope }),
          ];
        }
        if (node.finallyBody)
          results = results.flatMap((completion) =>
            this.execute(
              node.finallyBody!,
              copyFlow(completion.state),
              frame,
            ).map((final) =>
              final.kind === 'normal'
                ? { ...completion, state: final.state }
                : final,
            ),
          );
        return results;
      }
      case 'loop': {
        if (node.initializer) {
          const initialized = this.execute(node.initializer, state, frame);
          state = mergeFlow(
            initialized
              .filter((completion) => completion.kind === 'normal')
              .map((completion) => completion.state),
          );
        }
        const repeated =
          node.loop === 'repeat' && node.condition
            ? knownConstant(this.expression(node.condition, state, frame))
            : undefined;
        const count =
          typeof repeated === 'number' && Number.isSafeInteger(repeated)
            ? repeated
            : undefined;
        const entry = copyFlow(state);
        const results: Completion[] = [];
        if (node.loop === 'repeat' && (count === undefined || count <= 0))
          results.push(...normal(copyFlow(entry)));
        let head = copyFlow(entry);
        const seen = new Set<string>();
        for (;;) {
          const key = flowKey(head);
          if (seen.has(key)) break;
          seen.add(key);
          const current = copyFlow(head);
          if (node.loop === 'repeat' && count !== undefined && count <= 0) {
            current.reachable = false;
            this.execute(node.body, current, frame);
            break;
          }
          if (node.loop === 'while' || node.loop === 'for') {
            const truth = node.condition
              ? constantTruth(this.expression(node.condition, current, frame))
              : true;
            if (truth !== true) {
              const exit = copyFlow(current);
              if (node.condition)
                this.narrow(node.condition, exit, false, frame);
              results.push(...normal(exit));
            }
            if (truth === false) {
              current.reachable = false;
              this.execute(node.body, current, frame);
              break;
            }
            if (node.condition)
              this.narrow(node.condition, current, true, frame);
          }
          const body = this.execute(node.body, current, frame);
          results.push(
            ...body
              .filter(
                (completion) =>
                  !['normal', 'continue'].includes(completion.kind),
              )
              .map((completion) =>
                completion.kind === 'break'
                  ? { ...completion, kind: 'normal' as const }
                  : completion,
              ),
          );
          const back = body
            .filter((completion) =>
              ['normal', 'continue'].includes(completion.kind),
            )
            .map((completion) => completion.state);
          if (!back.length) break;
          const advanced = mergeFlow(back);
          // A do-until tests only paths that reach its latch. Return/throw paths
          // cannot manufacture an exit, and the initial body cannot be skipped.
          // https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Language_Features/do___until.htm
          if (node.loop === 'do-until') {
            const truth = node.condition
              ? constantTruth(this.expression(node.condition, advanced, frame))
              : undefined;
            if (truth !== false) {
              const exit = copyFlow(advanced);
              if (node.condition)
                this.narrow(node.condition, exit, true, frame);
              results.push(...normal(exit));
            }
            if (truth === true) break;
            if (node.condition)
              this.narrow(node.condition, advanced, false, frame);
          } else if (node.loop === 'repeat') {
            results.push(...normal(copyFlow(advanced)));
            if (count === 1) break;
          }
          if (node.update) this.expression(node.update, advanced, frame);
          const next = mergeFlow([entry, head, advanced]);
          if (flowKey(next) === key) break;
          head = next;
        }
        return results;
      }
      case 'doc': {
        const declaration = this.bound.declarationSites.get(`${node.id}:name`);
        const symbol =
          declaration &&
          (this.nativeDeclarations.get(declaration.id) ||
            this.symbols.get(declaration.key));
        if (symbol && declaration)
          this.record(
            {
              ...node,
              id: `${node.id}:declared-name`,
              origin: declaration.origin,
            },
            symbol,
            value(symbol.item.type),
            'declaration',
            !symbol.item.native,
          );
        for (const range of node.docs.typeRanges) {
          const type = this.knownTypes.get(range.content);
          if (type?.signifier) {
            const origin = this.bound.syntax.input.origin(
              range.start.offset,
              range.end.offset,
            );
            const source = {
              ...node,
              id: `${node.id}:${range.start.offset}`,
              origin,
            };
            this.record(
              source,
              { key: this.keyOf(type.signifier), item: type.signifier },
              value(type),
              'type',
            );
          }
        }
        return normal(state);
      }
      default:
        return normal(state);
    }
  }
}
