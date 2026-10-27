import type { Code } from '../project.code.js';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
import {
  installSymbolContributions,
  installTypeContributions,
} from '../analysis/materialization.js';
import {
  globalKey,
  globalOwner,
  memberKey,
  nativeGlobalOwner,
  type MaterializationHost,
  type SymbolContribution,
  type UnitEvaluation,
} from '../analysis/model.js';

export type Contribution = Pick<
  UnitEvaluation,
  'symbols' | 'types' | 'namedTypes'
>;
type Index<T> = Map<string, Map<string, T>>;

/** Every fact has an owning unit. Replacement always removes that unit first. */
export class ContributionIndex {
  readonly units = new Map<string, Contribution>();
  readonly symbols: Index<SymbolContribution> = new Map();
  readonly types: Index<Type> = new Map();
  readonly names: Index<string> = new Map();

  replace(unit: string, part?: Contribution): void {
    const previous = this.units.get(unit);
    const update = <T>(
      index: Index<T>,
      before: ReadonlyMap<string, T> | undefined,
      after: ReadonlyMap<string, T> | undefined,
    ) => {
      for (const key of before?.keys() || []) {
        const sources = index.get(key)!;
        sources.delete(unit);
        if (!sources.size) index.delete(key);
      }
      for (const [key, source] of after || []) {
        let sources = index.get(key);
        if (!sources) index.set(key, (sources = new Map()));
        sources.set(unit, source);
      }
    };
    update(this.symbols, previous?.symbols, part?.symbols);
    update(this.types, previous?.types, part?.types);
    update(this.names, previous?.namedTypes, part?.namedTypes);
    if (part) this.units.set(unit, part);
    else this.units.delete(unit);
  }

  sources<T>(
    index: Index<T>,
    key: string,
    excluded?: string,
    replacement?: ReadonlyMap<string, T>,
  ): T[] {
    const result = [...(index.get(key) || [])]
      .filter(([unit]) => unit !== excluded)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, source]) => source);
    const own = replacement?.get(key);
    if (own) result.push(own);
    return result;
  }
}

/** Lazily merged detached graph. It never reads old public members as inputs. */
export class ContributionGraph implements MaterializationHost {
  readonly symbols = new Map<string, Signifier>();
  readonly types = new Map<string, Type>();
  private readonly completeSymbols = new Set<string>();
  private readonly completeTypes = new Set<string>();
  private readonly anonymous = new WeakMap<Type, Type>();

  constructor(
    readonly index: ContributionIndex,
    readonly source: (uri: string) => { file: Code; text: string } | undefined,
    readonly excluded?: string,
    readonly replacement?: Contribution,
  ) {}

  symbolSources(key: string): SymbolContribution[] {
    return this.index.sources(
      this.index.symbols,
      key,
      this.excluded,
      this.replacement?.symbols,
    );
  }
  hasSymbol(key: string): boolean {
    return this.symbolSources(key).length > 0;
  }
  typeSources(key: string): Type[] {
    return this.index.sources(
      this.index.types,
      key,
      this.excluded,
      this.replacement?.types,
    );
  }
  namedType(key: string): string | undefined {
    return this.index.sources(
      this.index.names,
      key,
      this.excluded,
      this.replacement?.namedTypes,
    )[0];
  }
  private allocateType(key: string, source?: Type): Type {
    let type = this.types.get(key);
    if (!type) {
      type = new Type(
        source?.kind || this.typeSources(key)[0]?.kind || 'Struct',
      );
      type.semanticKey = key;
      this.types.set(key, type);
    }
    return type;
  }
  type(key: string): Type {
    const actual = this.namedType(key) || key;
    const type = this.allocateType(actual);
    if (!this.completeTypes.has(actual)) {
      this.completeTypes.add(actual);
      installTypeContributions(this.typeSources(actual), type, this);
    }
    return type;
  }
  symbol(key: string): Signifier {
    let item = this.symbols.get(key);
    const sources = this.symbolSources(key);
    if (!item) {
      const source = sources[0];
      if (!source) throw new Error(`Missing semantic symbol ${key}`);
      item = new Signifier(this.allocateType(source.owner), source.item.name);
      item.semanticKey = key;
      this.symbols.set(key, item);
    }
    if (!this.completeSymbols.has(key)) {
      this.completeSymbols.add(key);
      installSymbolContributions(sources, item, this);
    }
    return item;
  }
  definition(
    key: string,
  ): import('../analysis/model.js').SourceOrigin | undefined {
    const definition = this.symbol(key).def;
    return definition?.file
      ? {
          spelling: {
            uri: definition.file.path.absolute,
            start: definition.start.offset,
            end: definition.end.offset,
          },
          editable: true,
        }
      : undefined;
  }
  value(source: Type): Type {
    // Enum copies are values of one declaration, including detached copies
    // whose type key was dropped. Resolve through the current declaration so
    // old consumers cannot perpetuate a previous generation's numeric value.
    if (source.kind === 'Enum' || source.kind === 'EnumMember') {
      const declaration = source.signifier?.semanticKey;
      for (const contribution of declaration
        ? this.symbolSources(declaration)
        : []) {
        for (const current of contribution.item.type.type) {
          if (
            current.kind === source.kind &&
            current.semanticKey &&
            this.typeSources(current.semanticKey).length
          )
            return this.type(current.semanticKey);
        }
      }
    }
    if (source.semanticKey && this.typeSources(source.semanticKey).length)
      return this.type(source.semanticKey);
    let target = this.anonymous.get(source);
    if (target) return target;
    target = new Type(source.kind);
    this.anonymous.set(source, target);
    installTypeContributions([source], target, this);
    return target;
  }
  lookup(
    owner: string,
    name: string,
    seen = new Set<string>(),
  ): SymbolContribution | undefined {
    if (seen.has(owner)) return;
    seen.add(owner);
    // Macro symbols describe physical directives and invocation anchors. Their
    // selected bodies are already expanded before binding; an unexpanded name
    // must resolve as ordinary GML, including when its configuration is inactive.
    const candidates =
      owner === globalOwner
        ? [globalKey(name), memberKey(owner, name)]
        : [memberKey(owner, name)];
    for (const key of candidates) {
      const defined = this.symbolSources(key).filter(
        (source) => source.item.def || source.item.native,
      );
      if (defined.length)
        return {
          ...defined[0],
          item: this.symbol(key),
          bare: defined.some((source) => source.bare !== false),
        };
    }
    // Global names are indexed directly. A miss must not materialize every
    // unrelated native function and project symbol merely to return undefined.
    if (owner === globalOwner || owner === nativeGlobalOwner) return;
    for (const source of this.typeSources(owner)) {
      const own = source
        .listMembers(true)
        .find((item) => item.name === name && (item.def || item.native));
      if (own?.semanticKey && this.symbolSources(own.semanticKey).length) {
        const contribution = this.symbolSources(own.semanticKey)[0];
        return { ...contribution, item: this.symbol(own.semanticKey) };
      }
      const base = source.extends?.semanticKey;
      if (base) {
        const found = this.lookup(base, name, seen);
        if (found) return found;
      }
    }
    return;
  }

  /** Fully prepare and validate before the host changes any public handle. */
  complete(): this {
    for (const key of this.index.types.keys()) this.type(key);
    for (const key of this.index.symbols.keys()) this.symbol(key);
    return this;
  }
}

/** Capture native/resource inputs separately from source-owned contributions. */
export function collectInputContribution(
  unitId: string,
  roots: ReadonlyMap<string, Type>,
  namedTypes: ReadonlyMap<string, Type> = new Map(),
): Contribution {
  const types = new Map<string, Type>();
  const symbols = new Map<string, SymbolContribution>();
  const names = new Map<string, string>();
  const assignedRoots = new Set<Type>();
  for (const [key, type] of roots) {
    if (assignedRoots.has(type)) continue;
    assignedRoots.add(type);
    type.semanticKey = key;
  }
  const visited = new Set<Type>();
  const queue = [...roots].map(([key, type]) => ({ key, type }));
  for (let index = 0; index < queue.length; index++) {
    const { key, type } = queue[index];
    if (visited.has(type)) continue;
    visited.add(type);
    type.semanticKey ||= key;
    // Root declarations win over symbolic base-edge placeholders of the same key.
    if (types.has(type.semanticKey)) continue;
    types.set(type.semanticKey, type);
    const add = (child: Type | undefined, suffix: string) => {
      if (child)
        queue.push({
          key: child.semanticKey || `${type.semanticKey}/${suffix}`,
          type: child,
        });
    };
    add(type.extends, 'base');
    add(type.local, 'locals');
    add(type.self, 'self');
    add(type.statics, 'statics');
    for (const [offset, child] of (type.items?.type || []).entries())
      add(child, `items/${offset}`);
    for (const [offset, child] of (type.returns?.type || []).entries())
      add(child, `returns/${offset}`);
    for (const member of type.listMembers(true)) {
      const owner = member.parent.semanticKey || type.semanticKey;
      member.semanticKey ||=
        owner === globalOwner
          ? globalKey(member.name)
          : memberKey(owner, member.name);
      symbols.set(member.semanticKey, {
        key: member.semanticKey,
        item: member,
        owner,
        unitId,
        exported: true,
        bare: true,
        intrinsic: !member.resourceDefinition,
      });
      for (const [offset, child] of member.type.type.entries())
        add(child, `member:${member.name}/value:${offset}`);
    }
  }
  for (const [name, type] of namedTypes)
    if (type.semanticKey) names.set(name, type.semanticKey);
  return { symbols, types, namedTypes: names };
}
