import { Signifier } from '../signifiers.js';
import {
  Type,
  type FunctionType,
  type StructType,
  type WithableType,
} from '../types.js';
import {
  globalOwner,
  memberKey,
  type BindingScope,
  type BoundFunction,
  type BoundUnit,
  type FunctionImplementation,
  type SymbolContribution,
} from './model.js';
import { valueFrom, type Value } from './values.js';

/** Select one executable body without evaluating unrelated project functions. */
export function selectCallable(
  provenance: FunctionImplementation | undefined,
): { bound: BoundUnit; fn: BoundFunction } | undefined {
  const fn = provenance?.bound.functions.get(provenance.functionId);
  if (!provenance || !fn) return;
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
  return {
    fn,
    bound: {
      ...provenance.bound,
      functions,
      declarations,
      diagnostics: [],
      declarationSites: new Map(
        [...provenance.bound.declarationSites].filter(([, declaration]) =>
          selected.has(declaration.id),
        ),
      ),
    },
  };
}

/** A structural input may carry a callback several members/items below its root. */
export function hasContextualCallable(values: readonly Value[]): boolean {
  const pending = values.flatMap((value) => value.type);
  const seen = new Set<Type>();
  for (let index = 0; index < pending.length; index++) {
    const type = pending[index];
    if (seen.has(type)) continue;
    seen.add(type);
    if (type.kind === 'Function') {
      if (
        type.usesOther ||
        type.callsLocalCallable ||
        type.methodSource?.usesOther ||
        type.methodSource?.callsLocalCallable
      )
        return true;
      continue;
    }
    pending.push(...(type.items?.type || []));
    for (const member of type.listMembers(true))
      pending.push(...member.type.type);
  }
  return false;
}

/** Runtime input aliases keep their identity when a call-local result graph is published. */
export function inputAliases(
  values: readonly Value[],
  followMethods = true,
): Set<string> {
  const keys = new Set<string>();
  const pending = values.flatMap((value) => value.type);
  const seen = new Set<Type>();
  for (let index = 0; index < pending.length; index++) {
    const type = pending[index];
    if (seen.has(type)) continue;
    seen.add(type);
    if (type.semanticKey) keys.add(type.semanticKey);
    // The global namespace and callable signatures are not runtime object graphs.
    if (type.semanticKey === globalOwner) continue;
    if (type.kind === 'Function') {
      if (followMethods && type.self) pending.push(type.self);
      continue;
    }
    pending.push(...(type.items?.type || []));
    for (const member of type.listMembers(true))
      pending.push(...member.type.type);
  }
  return keys;
}

/** A repeated allocation context denotes a recursive edge. Keep its existing
 * suffix so the identity is finite while nonrecursive callers stay distinct. */
export function allocationContextKey(
  namespace: string,
  source: string,
): string {
  const prefix = `${namespace}/`;
  // A method embeds its receiver's identity after its own callable identity.
  // Only the leading import path is recursive context, never that embedded self.
  const method = source.startsWith('method:')
    ? 0
    : source.indexOf('/method:') >= 0
      ? source.indexOf('/method:') + 1
      : source.length;
  const repeated = source.slice(0, method).lastIndexOf(`/${prefix}`);
  return repeated >= 0
    ? source.slice(repeated + 1)
    : source.startsWith(prefix)
      ? source
      : `${prefix}${source}`;
}

/** Imports an invocation result's complete allocation graph, preserving cycles,
 * source locations and borrowed aliases. Content versions never enter its keys. */
export class InvocationGraph {
  readonly types = new Map<string, Type>();
  readonly symbols = new Map<string, SymbolContribution>();
  private readonly copies = new Map<Type, Type>();
  private readonly queue: { source: Type; target: Type }[] = [];
  private readonly canonical = new Set<string>();
  private readonly locals = new Set<string>();

  constructor(
    readonly namespace: string,
    readonly unitId: string,
    readonly bound: BoundUnit,
    readonly root: BoundFunction,
    readonly inputs: ReadonlySet<string>,
    readonly sourceTypes: ReadonlyMap<string, Type>,
    readonly sourceSymbols: ReadonlyMap<string, SymbolContribution>,
    readonly external: (key: string) => Type | undefined,
    readonly allocationSource?: string,
    readonly allocationOwner?: (type: Type) => boolean,
    readonly sourceValues?: ReadonlyMap<string, Value>,
  ) {
    this.canonical.add(globalOwner);
    this.canonical.add(root.typeKey);
    for (const fn of bound.functions.values()) {
      this.canonical.add(fn.staticOwner);
      if (fn.node.constructor && fn.declaration?.role === 'function')
        this.canonical.add(fn.selfOwner);
    }
    for (const fn of bound.functions.values()) {
      this.locals.add(fn.localOwner);
      this.locals.add(`${fn.typeKey}:arguments`);
      if (fn !== root) this.locals.add(fn.typeKey);
    }
    for (const declaration of bound.declarations) {
      if (
        declaration.owner !== root.selfOwner &&
        !this.canonical.has(declaration.owner)
      )
        this.locals.add(declaration.owner);
    }
  }

  private owned(type: Type): boolean {
    const key = type.semanticKey;
    if (!key || this.inputs.has(key) || this.canonical.has(key)) return false;
    if (this.allocationOwner) return this.allocationOwner(type);
    return (
      this.sourceTypes.has(key) &&
      !(
        type.name &&
        !this.locals.has(key) &&
        !/^(?:allocation|method|invocation):/.test(key)
      ) &&
      (this.locals.has(key) ||
        /^(?:struct|array|allocation|instance|instance-input|annotation|anonymous|method|invocation|narrow):/.test(
          key,
        ))
    );
  }

  /** A constructed root is already installed; nested self aliases point to it. */
  seed(source: Type, target: Type): void {
    this.copies.set(source, target);
    this.types.set(target.semanticKey!, target);
  }

  type(source: Type): Type {
    const prior = this.copies.get(source);
    if (prior) return prior;
    const key = source.semanticKey;
    // A previous summary can point back to storage already installed in this
    // import. Close that edge on the current graph instead of its older view.
    const feedback = key && this.types.get(key);
    if (feedback) return feedback;
    if (!this.owned(source)) return key ? this.external(key) || source : source;
    const targetKey = allocationContextKey(this.namespace, key!);
    const existing = this.types.get(targetKey);
    if (existing) {
      this.copies.set(source, existing);
      return existing;
    }
    const target = source.deriveDetached();
    target.semanticKey = targetKey;
    target.allocationSource = this.allocationSource || source.allocationSource;
    target.replaceOwnMembers([]);
    this.copies.set(source, target);
    this.types.set(target.semanticKey, target);
    this.queue.push({ source, target });
    return target;
  }

  value(source: Value): Value {
    const result = valueFrom(source.type.map((type) => this.type(type)));
    this.drain();
    return result;
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length; index++) {
      const { source, target } = this.queue[index];
      const store = (input: Value | undefined) =>
        input && valueFrom(input.type.map((type) => this.type(type)));
      target.items = store(source.items);
      target.returns = store(source.returns);
      target.local = source.local && (this.type(source.local) as StructType);
      target.self = source.self && (this.type(source.self) as WithableType);
      target.statics =
        source.statics && (this.type(source.statics) as StructType);
      target.methodSource =
        source.methodSource && (this.type(source.methodSource) as FunctionType);
      target.setBaseView(source.extends && this.type(source.extends));
      for (const original of source.listMembers(true)) {
        // Inherited constructor statics remain owned by the original function.
        if (
          original.parent.semanticKey &&
          original.parent.semanticKey !== source.semanticKey
        ) {
          target.setOwnMember(original);
          continue;
        }
        const item = new Signifier(target, original.name);
        item.semanticKey = memberKey(target.semanticKey!, original.name);
        const current =
          original.semanticKey && this.sourceValues?.get(original.semanticKey);
        item.replaceMetadata(original, store(current || original.type)!);
        item.replaceDefinition(original.def, original.declaration);
        target.setOwnMember(item);
        const contribution = original.semanticKey
          ? this.sourceSymbols.get(original.semanticKey)
          : undefined;
        this.symbols.set(item.semanticKey, {
          ...(contribution || {}),
          key: item.semanticKey,
          item,
          canonicalKey:
            contribution?.canonicalKey ||
            contribution?.key ||
            original.canonicalKey ||
            original.semanticKey,
          owner: target.semanticKey!,
          unitId: this.unitId,
          exported: true,
          origin: contribution?.origin,
        });
      }
    }
    this.queue.length = 0;
  }
}
