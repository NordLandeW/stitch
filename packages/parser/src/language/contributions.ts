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
  implementationKey,
  memberKey,
  nativeGlobalOwner,
  type FunctionImplementation,
  type MaterializationHost,
  type SymbolContribution,
  type UnitEvaluation,
} from '../analysis/model.js';

export type Contribution = Pick<
  UnitEvaluation,
  'symbols' | 'types' | 'namedTypes'
> &
  Partial<Pick<UnitEvaluation, 'implementations'>>;
type Index<T> = Map<string, Map<string, T>>;
// Keyed nodes have stable handles; anonymous nodes are inline value graphs.
// Their direct lookup edges also record missing keys, so adding an owner can
// replace an earlier detached value without leaving stale anonymous edges.
type PublicationNode = string | Type;
const typeNode = (key: string) => `type:${key}`;
const symbolNode = (key: string) => `symbol:${key}`;
const nameNode = (key: string) => `name:${key}`;

/** Every fact has an owning unit. Installed contributions are immutable versions:
 * replace them with new versions rather than mutating their maps or payloads. */
export class ContributionIndex {
  readonly units: Map<string, Contribution>;
  readonly symbols: Index<SymbolContribution>;
  readonly types: Index<Type>;
  readonly names: Index<string>;
  private writeOwner: object = {};
  private readonly sourceOwners: WeakMap<object, object>;
  private readonly orderedSources: WeakMap<
    object,
    readonly (readonly [string, unknown])[]
  >;

  constructor(
    parent?: ContributionIndex,
    retainUnit?: (unit: string) => boolean,
  ) {
    this.units = new Map();
    this.symbols = new Map(parent?.symbols);
    this.types = new Map(parent?.types);
    this.names = new Map(parent?.names);
    this.sourceOwners = parent?.sourceOwners || new WeakMap();
    this.orderedSources = parent?.orderedSources || new WeakMap();
    if (parent) {
      // Neither branch owns a shared source map after forking. Rotating the
      // parent's token also isolates later writes to ancestors and siblings.
      parent.writeOwner = {};
      const retired: string[] = [];
      for (const [unit, part] of parent.units) {
        this.units.set(unit, part);
        if (retainUnit && !retainUnit(unit)) retired.push(unit);
      }
      // Keep each old version until replace has withdrawn all of its facts.
      for (const unit of retired) this.replace(unit);
    }
  }

  /** Copies O(N) outer entries; source maps and their ordering caches stay shared
   * until replace changes them. Optional retirement is selected during the unit
   * copy pass and touches only the excluded units' contribution keys. */
  fork(retainUnit?: (unit: string) => boolean): ContributionIndex {
    return new ContributionIndex(this, retainUnit);
  }

  replace(unit: string, part?: Contribution): void {
    const previous = this.units.get(unit);
    if (previous === part) return;
    const update = <T>(
      index: Index<T>,
      before: ReadonlyMap<string, T> | undefined,
      after: ReadonlyMap<string, T> | undefined,
    ) => {
      if (before === after) return;
      const write = (key: string, present: boolean, source?: T) => {
        let sources = index.get(key);
        if (present && sources?.has(unit) && sources.get(unit) === source)
          return;
        if (!present && !sources?.has(unit)) return;
        if (!sources || this.sourceOwners.get(sources) !== this.writeOwner) {
          sources = new Map(sources);
          this.sourceOwners.set(sources, this.writeOwner);
          index.set(key, sources);
        }
        this.orderedSources.delete(sources);
        if (present) sources.set(unit, source!);
        else {
          sources.delete(unit);
          if (!sources.size) index.delete(key);
        }
      };
      for (const key of before?.keys() || [])
        if (!after?.has(key)) write(key, false);
      for (const [key, source] of after || []) write(key, true, source);
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
    const result: T[] = [];
    const sources = index.get(key);
    if (sources) {
      let ordered = this.orderedSources.get(sources) as
        | readonly (readonly [string, T])[]
        | undefined;
      if (!ordered) {
        ordered = [...sources].sort(([left], [right]) =>
          left.localeCompare(right),
        );
        this.orderedSources.set(sources, ordered);
      }
      for (const [unit, source] of ordered)
        if (unit !== excluded) result.push(source);
    }
    const own = replacement?.get(key);
    if (own) result.push(own);
    return result;
  }
}

/** Lazily merged detached graph over one fixed index/overlay snapshot. A new
 * graph is created after each index replacement; no old public view is input. */
export class ContributionGraph implements MaterializationHost {
  private symbolHandles = new Map<string, Signifier>();
  private typeHandles = new Map<string, Type>();
  get symbols(): Map<string, Signifier> {
    return this.symbolHandles;
  }
  get types(): Map<string, Type> {
    return this.typeHandles;
  }
  private completeSymbols = new Set<string>();
  private completeTypes = new Set<string>();
  private anonymous = new WeakMap<Type, Type>();
  private preparedAnonymous = new WeakSet<Type>();
  private readonly symbolSourceCache = new Map<string, SymbolContribution[]>();
  private readonly typeSourceCache = new Map<string, Type[]>();
  private readonly namedTypeCache = new Map<string, string | undefined>();
  readonly updatedTypes = new Set<string>();
  readonly updatedSymbols = new Set<string>();
  publicationReused = false;
  private trackingPublication = false;
  private publicationNode?: PublicationNode;
  private publicationReads = new Map<PublicationNode, Set<PublicationNode>>();
  private publicationReaders = new Map<PublicationNode, Set<PublicationNode>>();
  private publicationGarbage = new Set<Type>();

  /** Prepared anonymous values retain alias identity while their lookup edges
   * stay valid. Public copies can share that identity without sharing objects. */
  isPreparedValue(source: Type): boolean {
    return this.preparedAnonymous.has(source);
  }

  private observePublication(node: PublicationNode): void {
    const parent = this.publicationNode;
    if (parent === undefined) return;
    const inputs = this.publicationReads.get(parent)!;
    if (inputs.has(node)) return;
    inputs.add(node);
    let readers = this.publicationReaders.get(node);
    if (!readers) this.publicationReaders.set(node, (readers = new Set()));
    readers.add(parent);
  }

  private forgetPublication(node: PublicationNode): void {
    for (const input of this.publicationReads.get(node) || []) {
      if (typeof input !== 'string') this.publicationGarbage.add(input);
      const readers = this.publicationReaders.get(input)!;
      readers.delete(node);
      if (!readers.size) this.publicationReaders.delete(input);
    }
    this.publicationReads.delete(node);
  }

  private capturePublication(node: PublicationNode, install: () => void): void {
    if (!this.trackingPublication) {
      install();
      return;
    }
    const parent = this.publicationNode;
    // Queries can prepare detached values after complete(), outside any keyed
    // root. Reconsider those values at the next publication boundary too.
    if (parent === undefined && typeof node !== 'string')
      this.publicationGarbage.add(node);
    this.forgetPublication(node);
    this.publicationReads.set(node, new Set());
    this.publicationNode = node;
    try {
      install();
    } finally {
      this.publicationNode = parent;
    }
  }

  private retainPublicationReads(): void {
    // Only removed edges or detached query roots can make a previously live
    // anonymous graph unreachable. Trial-delete their descendant region, then
    // retain paths entering it from outside. This also collects isolated cycles
    // without scanning every unchanged keyed root on each keystroke.
    const candidates = new Set<Type>();
    const visited = new Set<Type>();
    const queue = [...this.publicationGarbage];
    for (const node of queue) {
      if (visited.has(node)) continue;
      visited.add(node);
      let rooted = false;
      for (const parent of this.publicationReaders.get(node) || [])
        if (typeof parent === 'string') {
          rooted = true;
          break;
        }
      if (rooted) continue;
      candidates.add(node);
      for (const child of this.publicationReads.get(node) || [])
        if (typeof child !== 'string') queue.push(child);
    }
    const live = new Set<Type>();
    const retained: Type[] = [];
    for (const node of candidates)
      for (const parent of this.publicationReaders.get(node) || [])
        if (typeof parent === 'string' || !candidates.has(parent)) {
          retained.push(node);
          break;
        }
    for (const node of retained) {
      if (live.has(node)) continue;
      live.add(node);
      for (const child of this.publicationReads.get(node) || [])
        if (typeof child !== 'string' && candidates.has(child))
          retained.push(child);
    }
    for (const node of candidates)
      if (!live.has(node)) {
        this.forgetPublication(node);
        // A value hidden by a keyed owner must not return from an unobserved
        // cache entry after that owner retires.
        this.anonymous.delete(node);
      }
    this.publicationGarbage.clear();
  }

  constructor(
    readonly index: ContributionIndex,
    readonly source: (uri: string) => { file: Code; text: string } | undefined,
    readonly excluded?: string,
    readonly replacement?: Contribution,
  ) {}

  /** Consume an exclusively owned publication buffer, then copy its updates
   * into public handles. Analysis overlays always own independent graphs. */
  static prepare(
    index: ContributionIndex,
    source: ContributionGraph['source'],
    previous?: ContributionGraph,
    changedSources: ReadonlySet<string> = new Set(),
  ): ContributionGraph {
    const graph = new ContributionGraph(index, source);
    graph.trackingPublication = true;
    if (previous) graph.reusePublication(previous, changedSources);
    return graph.complete();
  }

  private reusePublication(
    previous: ContributionGraph,
    changedSources: ReadonlySet<string>,
  ): void {
    if (
      previous.excluded ||
      previous.replacement ||
      !previous.trackingPublication
    )
      return;
    // Incomplete owner domains and changes to union/handle identity use a full
    // remap. Ordinary allocation/member additions and removals retain handles.
    if (previous.types.size !== previous.index.types.size) return;
    for (const [key, sources] of this.index.types) {
      const before = previous.types.get(key);
      if (!before) continue;
      for (const source of sources.values()) {
        if (source.kind !== before.kind) return;
        if (
          (source.kind === 'Enum' || source.kind === 'EnumMember') &&
          source.signifier?.semanticKey !== before.signifier?.semanticKey
        )
          return;
      }
    }
    for (const [key, sources] of this.index.symbols) {
      const before = previous.symbols.get(key);
      for (const source of sources.values()) {
        if (!this.index.types.has(source.owner)) return;
        if (
          before &&
          (source.owner !== before.parent.semanticKey ||
            source.item.name !== before.name)
        )
          return;
      }
    }
    const types = new Set<string>(),
      symbols = new Set<string>();
    const changed = (part: Contribution | undefined) => {
      for (const key of part?.types.keys() || []) types.add(key);
      for (const key of part?.symbols.keys() || []) symbols.add(key);
    };
    for (const unit of new Set([
      ...previous.index.units.keys(),
      ...this.index.units.keys(),
    ])) {
      const before = previous.index.units.get(unit),
        after = this.index.units.get(unit);
      if (before !== after) {
        changed(before);
        changed(after);
      }
    }
    // Enum values resolve through the current declaration, even when an old
    // consumer still contributes the previous type key. Retargeting that
    // declaration changes value identity and requires remapping its readers.
    const enumTargets = (graph: ContributionGraph, key: string) => {
      const result: (string | undefined)[] = [undefined, undefined];
      for (const source of graph.symbolSources(key))
        for (const type of source.item.type.type) {
          const slot =
            type.kind === 'Enum' ? 0 : type.kind === 'EnumMember' ? 1 : -1;
          if (
            slot >= 0 &&
            result[slot] === undefined &&
            type.semanticKey &&
            graph.index.types.has(type.semanticKey)
          )
            result[slot] = type.semanticKey;
        }
      return result;
    };
    for (const key of symbols)
      if (previous.symbols.has(key) && this.index.symbols.has(key)) {
        const before = enumTargets(previous, key),
          after = enumTargets(this, key);
        if (before.some((target, slot) => target !== after[slot])) return;
      }
    const domains = new Set<PublicationNode>();
    const domain = (
      before: ReadonlyMap<string, unknown>,
      after: ReadonlyMap<string, unknown>,
      prepared: ReadonlyMap<string, unknown>,
      node: (key: string) => string,
    ): boolean => {
      if (before.size !== prepared.size) return false;
      for (const key of before.keys()) {
        // Named redirection and detached queries can produce a different key
        // set with the same size. Such buffers require a fresh full remap.
        if (!prepared.has(key)) return false;
        if (!after.has(key)) domains.add(node(key));
      }
      for (const key of after.keys())
        if (!before.has(key)) domains.add(node(key));
      return true;
    };
    if (
      !domain(previous.index.types, this.index.types, previous.types, typeNode)
    )
      return;
    if (
      !domain(
        previous.index.symbols,
        this.index.symbols,
        previous.symbols,
        symbolNode,
      )
    )
      return;
    for (const name of new Set([
      ...previous.index.names.keys(),
      ...this.index.names.keys(),
    ]))
      if (previous.namedType(name) !== this.namedType(name))
        domains.add(nameNode(name));
    if (domains.size) {
      const readers = previous.publicationReaders;
      const queue = [...domains];
      for (const input of queue)
        for (const parent of readers.get(input) || []) {
          if (typeof parent === 'string') {
            if (parent.startsWith('type:')) types.add(parent.slice(5));
            else if (parent.startsWith('symbol:')) symbols.add(parent.slice(7));
          } else if (!domains.has(parent)) {
            // Inline cycles propagate to every keyed owner. Stable keyed
            // children update through their handles and stop propagation.
            domains.add(parent);
            queue.push(parent);
          }
        }
    }
    for (const [key, sources] of this.index.symbols)
      for (const source of sources.values()) {
        const uri = source.origin?.spelling.uri;
        const declaration = source.declaration?.declaration.spelling.uri;
        if (
          (uri && changedSources.has(uri)) ||
          (declaration && changedSources.has(declaration))
        )
          symbols.add(key);
      }
    this.anonymous = previous.anonymous;
    this.preparedAnonymous = previous.preparedAnonymous;
    for (const node of domains)
      if (typeof node !== 'string') this.anonymous.delete(node);
    // The buffer is exclusively consumed. Retain both directions rather than
    // reconstructing every unchanged lookup edge for each small domain edit.
    this.publicationReads = previous.publicationReads;
    this.publicationReaders = previous.publicationReaders;
    this.publicationGarbage = previous.publicationGarbage;
    // The same exclusive transfer also preserves handle order and completion
    // state without copying every unchanged map/set entry. Input/source caches
    // remain private to this new graph and its index version.
    this.typeHandles = previous.typeHandles;
    this.symbolHandles = previous.symbolHandles;
    this.completeTypes = previous.completeTypes;
    this.completeSymbols = previous.completeSymbols;
    for (const key of types) this.completeTypes.delete(key);
    for (const key of symbols) this.completeSymbols.delete(key);
    for (const node of domains) {
      if (typeof node !== 'string') continue;
      if (node.startsWith('type:') && !this.index.types.has(node.slice(5))) {
        this.types.delete(node.slice(5));
        this.completeTypes.delete(node.slice(5));
        this.forgetPublication(node);
      } else if (
        node.startsWith('symbol:') &&
        !this.index.symbols.has(node.slice(7))
      ) {
        this.symbols.delete(node.slice(7));
        this.completeSymbols.delete(node.slice(7));
        this.forgetPublication(node);
      }
    }
    this.publicationReused = true;
  }

  symbolSources(key: string): SymbolContribution[] {
    if (this.trackingPublication) this.observePublication(symbolNode(key));
    let sources = this.symbolSourceCache.get(key);
    if (!sources) {
      sources = this.index.sources(
        this.index.symbols,
        key,
        this.excluded,
        this.replacement?.symbols,
      );
      this.symbolSourceCache.set(key, sources);
    }
    return sources;
  }
  hasSymbol(key: string): boolean {
    return this.symbolSources(key).length > 0;
  }
  typeSources(key: string): Type[] {
    if (this.trackingPublication) this.observePublication(typeNode(key));
    let sources = this.typeSourceCache.get(key);
    if (!sources) {
      sources = this.index.sources(
        this.index.types,
        key,
        this.excluded,
        this.replacement?.types,
      );
      this.typeSourceCache.set(key, sources);
    }
    return sources;
  }
  namedType(key: string): string | undefined {
    if (this.trackingPublication) this.observePublication(nameNode(key));
    if (!this.namedTypeCache.has(key)) {
      this.namedTypeCache.set(
        key,
        this.index.sources(
          this.index.names,
          key,
          this.excluded,
          this.replacement?.namedTypes,
        )[0],
      );
    }
    return this.namedTypeCache.get(key);
  }
  implementation(
    unitId: string,
    functionId: string,
  ): FunctionImplementation | undefined {
    const source =
      unitId === this.excluded
        ? this.replacement
        : this.index.units.get(unitId);
    return source?.implementations?.get(implementationKey(unitId, functionId));
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
    if (this.trackingPublication) this.observePublication(typeNode(actual));
    const type = this.allocateType(actual);
    if (!this.completeTypes.has(actual)) {
      this.completeTypes.add(actual);
      if (this.trackingPublication) this.updatedTypes.add(actual);
      this.capturePublication(typeNode(actual), () =>
        installTypeContributions(this.typeSources(actual), type, this),
      );
    }
    return type;
  }
  symbol(key: string): Signifier {
    if (this.trackingPublication) this.observePublication(symbolNode(key));
    let item = this.symbols.get(key);
    if (item && this.completeSymbols.has(key)) return item;
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
      if (this.trackingPublication) this.updatedSymbols.add(key);
      const target = item;
      this.capturePublication(symbolNode(key), () =>
        installSymbolContributions(sources, target, this),
      );
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
    if (this.trackingPublication) this.observePublication(source);
    let target = this.anonymous.get(source);
    if (target) return target;
    target = new Type(source.kind);
    this.anonymous.set(source, target);
    if (this.trackingPublication) this.preparedAnonymous.add(target);
    const current = target;
    this.capturePublication(source, () =>
      installTypeContributions([source], current, this),
    );
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
    for (const key of this.index.types.keys())
      if (!this.completeTypes.has(key)) this.type(key);
    for (const key of this.index.symbols.keys())
      if (!this.completeSymbols.has(key)) this.symbol(key);
    if (this.trackingPublication) this.retainPublicationReads();
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
