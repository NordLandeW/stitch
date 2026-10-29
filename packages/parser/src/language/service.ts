import { createHash } from 'node:crypto';
import { YyObjectPropertyVarType, type YyObject } from '@bscotch/yy';
import { bindUnit } from '../analysis/binding.js';
import { checkUnit } from '../analysis/checking.js';
import {
  createDeclarationSummary,
  evaluateUnit,
} from '../analysis/evaluation.js';
import {
  copyPreparedSymbol,
  installTypeContributions,
  materializeSourceRange,
  materializeUnit,
} from '../analysis/materialization.js';
import { normalizeSyntax } from '../analysis/syntax.js';
import {
  AnalysisCancelled,
  globalOwner,
  nativeGlobalOwner,
  type BoundUnit,
  type CodeSemanticView,
  type MaterializationHost,
  type SemanticEnvironment,
  type UnitEvaluation,
} from '../analysis/model.js';
import { logger } from '../logger.js';
import type { Code, CodeSyntaxView } from '../project.code.js';
import type { Project } from '../project.js';
import { Reference } from '../project.location.js';
import { Signifier } from '../signifiers.js';
import { Type } from '../types.js';
import {
  collectMacros,
  MacroEnvironment,
  type MacroCollection,
} from '../syntax/macros.js';
import {
  ContributionGraph,
  ContributionIndex,
  collectInputContribution,
  type Contribution,
} from './contributions.js';
import { DependencyIndex } from './dependencies.js';
import { orderColdSources } from './ordering.js';
import { LanguageProfile } from './version.js';
import { WorklistHistory } from './worklist.js';
import { ValueFeedbackIndex } from './value-feedback.js';

interface UnitState {
  readonly code: Code;
  collection?: MacroCollection;
  preprocessKey?: string;
  syntax?: CodeSyntaxView;
  bound?: BoundUnit;
  declarations?: Contribution;
  evaluation?: UnitEvaluation;
  worklistState?: string;
}
const services = new WeakMap<Project, ProjectAnalysis>();
export function getProjectAnalysis(project: Project): ProjectAnalysis {
  let service = services.get(project);
  if (!service) {
    service = new ProjectAnalysis(project);
    services.set(project, service);
  }
  return service;
}
function digest(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input) ?? 'null')
    .digest('hex');
}
const contributionKeys = new WeakMap<Contribution, Set<string>>();
function keys(part: Contribution | undefined): Set<string> {
  if (part) {
    const cached = contributionKeys.get(part);
    if (cached) return cached;
  }
  const result = new Set<string>();
  if (!part) return result;
  contributionKeys.set(part, result);
  for (const symbol of part.symbols.values()) {
    result.add(symbol.key);
    result.add(`${symbol.owner}/lookup:${symbol.item.name}`);
  }
  for (const key of part.types.keys()) result.add(key);
  for (const key of part.namedTypes.keys()) result.add(key);
  for (const key of part.implementations?.keys() || []) result.add(key);
  return result;
}
function contributionChanges(
  previous: UnitEvaluation | undefined,
  result: UnitEvaluation,
  before?: Contribution,
) {
  const all = new Set([...keys(previous || before), ...keys(result)]);
  const changed = new Set<string>();
  if (!previous) for (const key of all) changed.add(key);
  else {
    for (const key of new Set([
      ...previous.semanticSummaries.keys(),
      ...result.semanticSummaries.keys(),
    ]))
      if (
        previous.semanticSummaries.get(key) !==
        result.semanticSummaries.get(key)
      )
        changed.add(key);
    // A retired identity can remain in a consumer even when the surviving
    // exported shape has not changed.
    const surviving = keys(result);
    for (const key of keys(previous)) if (!surviving.has(key)) changed.add(key);
  }
  return { all, changed };
}

const emptyView: CodeSemanticView = {
  refs: [],
  scopes: [],
  jsdocs: [],
  functionArgRanges: [],
  functionCalls: [],
  structNewMemberRanges: [],
  callsSuper: false,
  diagnostics: {},
};

/** Project-owned analysis transaction, dependency worklist and publication boundary. */
export class ProjectAnalysis {
  generation = 0;
  readonly metrics = { parsed: 0, bound: 0, evaluated: 0, published: 0 };
  private revision = 0;
  private committedRevision = -1;
  private readonly units = new Map<string, UnitState>();
  private readonly dirty = new Set<string>();
  private readonly retired = new Set<Code>();
  private readonly dependencies = new DependencyIndex();
  private native?: Contribution;
  private nativeIdentity?: object;
  private publicationBuffer?: ContributionGraph;
  private readonly publicationValues = new WeakMap<Type, Type>();
  private inputKey = '';
  private running?: Promise<void>;
  private lastError: unknown;
  get error(): unknown {
    return this.lastError;
  }
  get isCurrent(): boolean {
    return (
      !this.disposed &&
      this.committedRevision === this.revision &&
      !this.lastError
    );
  }
  private readonly publicTypes = new Map<string, Type>();
  private readonly publicSymbols = new Map<string, Signifier>();
  private readonly refsByUnit = new Map<string, readonly Reference[]>();
  private readonly externalReferences = new Map<
    string,
    { units: Map<string, readonly Reference[]>; view?: readonly Reference[] }
  >();
  private readonly pendingPublications = new Map<
    string,
    { code: Code; retired: boolean; semanticVersion: number }
  >();
  private macroEnvironment?: MacroEnvironment;

  private readonly globalStorageType = new Type('Struct').named('global');

  constructor(readonly project: Project) {
    this.globalStorageType.semanticKey = globalOwner;
  }

  /** User global storage, including declarations whose bare name is native.
   * The stable handle is empty until the first committed analysis. */
  get globalStorage(): Type {
    return this.globalStorageType;
  }

  private disposed = false;
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publicationBuffer = undefined;
    this.revision++;
    this.generation++;
    for (const [uri, state] of this.units) {
      this.removeRefs(uri);
      state.code.retireAnalysis();
      this.dependencies.remove(uri);
    }
    for (const code of this.retired) {
      this.removeRefs(code.path.absolute);
      code.retireAnalysis();
    }
    this.units.clear();
    this.dirty.clear();
    this.retired.clear();
    this.pendingPublications.clear();
    this.externalReferences.clear();
    this.publicSymbols.clear();
    this.publicTypes.clear();
    this.native = undefined;
    this.nativeIdentity = undefined;
    this.macroEnvironment = undefined;
  }

  private synchronizeBuffers(): void {
    const read = this.project.options?.documentText;
    if (!read) return;
    for (const [uri, state] of this.units) {
      const text = read(uri);
      if (typeof text === 'string') state.code.setBufferContent(text);
    }
  }

  register(code: Code): void {
    if (this.disposed) throw new Error('Project analysis has been disposed');
    const uri = code.path.absolute;
    if (this.units.get(uri)?.code === code) return;
    const previous = this.units.get(uri);
    if (previous) this.retire(previous.code);
    this.units.set(uri, { code });
    this.invalidate(code);
  }
  invalidate(code?: Code): void {
    if (
      this.disposed ||
      (code && this.units.get(code.path.absolute)?.code !== code)
    )
      return;
    if (code) this.dirty.add(code.path.absolute);
    else for (const uri of this.units.keys()) this.dirty.add(uri);
    this.revision++;
    this.generation++;
    this.lastError = undefined;
  }
  retire(code: Code): void {
    const uri = code.path.absolute;
    if (this.units.get(uri)?.code !== code) return;
    const state = this.units.get(uri)!;
    for (const unit of this.dependencies.affected(
      keys(state.evaluation || state.declarations),
    ))
      this.dirty.add(unit);
    this.units.delete(uri);
    this.dependencies.remove(uri);
    this.dirty.delete(uri);
    this.retired.add(code);
    this.revision++;
    this.generation++;
    this.lastError = undefined;
  }
  get references(): readonly Reference[] {
    return [...this.refsByUnit.values()].flat();
  }
  spellingReferences(uri: string): readonly Reference[] {
    const group = this.externalReferences.get(uri);
    return group ? (group.view ||= [...group.units.values()].flat()) : [];
  }
  document(uri: string): Code | undefined {
    return this.units.get(uri)?.code;
  }
  private source = (uri: string) => {
    const code = this.units.get(uri)?.code;
    return code && { file: code, text: code.content };
  };

  private profile(): LanguageProfile {
    return (
      this.project.languageProfile ||
      new LanguageProfile({
        runtimeVersion: this.project.config?.runtimeVersion,
        ideVersion: this.project.yyp?.MetaData?.IDEVersion,
        specSources: this.project.native?.getSpecSources?.(),
      })
    );
  }
  private nativeInput(): Contribution {
    const identity = this.project.native || this.project.self;
    if (this.native && this.nativeIdentity === identity) return this.native;
    this.nativeIdentity = identity;
    const nativeTypes = this.project.native?.types || this.project.types;
    const roots = new Map<string, Type>([
      [nativeGlobalOwner, this.project.native?.globalSelf || this.project.self],
    ]);
    for (const [name, type] of nativeTypes || [])
      roots.set(`native:${name}`, type);
    if (this.project.native?.objectInstanceBase)
      roots.set('native:object', this.project.native.objectInstanceBase);
    const input = collectInputContribution('$native', roots, nativeTypes);
    for (const symbol of input.symbols.values()) {
      const number = this.project.native?.getEnumMemberValue?.(symbol.item);
      if (number !== undefined)
        for (const type of symbol.item.type.type) type.literalValue = number;
    }
    const index = new ContributionIndex();
    index.replace('$native', input);
    const graph = new ContributionGraph(index, this.source).complete();
    this.native = {
      symbols: new Map(
        [...input.symbols].map(([key, symbol]) => [
          key,
          { ...symbol, item: graph.symbol(key) },
        ]),
      ),
      types: new Map(graph.types),
      namedTypes: new Map(input.namedTypes),
    };
    return this.native;
  }

  /** Call after loading native schemas, before resources/source add user members. */
  captureNative(): void {
    this.nativeIdentity = undefined;
    this.native = undefined;
    this.nativeInput();
    this.invalidate();
  }

  private resourceInput(states: ReadonlyMap<string, UnitState>): Contribution {
    const roots = new Map<string, Type>();
    const names = new Map<string, Type>();
    const global = new Type('Struct');
    global.semanticKey = globalOwner;
    roots.set(globalOwner, global);
    for (const audio of this.project.yyp?.AudioGroups || []) {
      const type = new Type('Asset.GMAudioGroup').named(audio.name);
      const symbol = new Signifier(global, audio.name, type);
      symbol.global = true;
      symbol.asset = true;
      symbol.writable = false;
      symbol.replaceDefinition({});
      global.setOwnMember(symbol);
    }
    for (const asset of this.project.assets?.values() || []) {
      const key = `resource:${asset.assetKind}:${asset.name}`;
      const implemented = new Set(
        [...asset.gmlFiles.values()]
          .filter((code) => code.sourceContext.kind === 'extension')
          .flatMap((code) =>
            (code.sourceContext.extensionFunctions || [])
              .filter((binding) =>
                code.extensionDefinitions.has(binding.sourceName),
              )
              .map((binding) => binding.name),
          ),
      );
      for (const [name, source] of asset.extensionSymbols || []) {
        if (implemented.has(name)) continue;
        const symbol = new Signifier(global, name);
        symbol.replaceMetadata(source, source.type);
        symbol.replaceDefinition(source.def);
        symbol.semanticKey = `global:${name}`;
        global.setOwnMember(symbol);
      }
      for (const [name, type] of asset.extensionTypes || []) {
        type.semanticKey = `${key}:extension:${name}`;
        roots.set(type.semanticKey, type);
        if (!implemented.has(name.replace(/^Function\./, '')))
          names.set(name, type);
      }
      asset.assetType.semanticKey = `${key}:asset`;
      this.publicTypes.set(asset.assetType.semanticKey, asset.assetType);
      const assetType = new Type(asset.assetType.kind).named(asset.name);
      assetType.semanticKey = asset.assetType.semanticKey;
      roots.set(assetType.semanticKey, assetType);
      if (!asset.isScript && asset.assetKind !== 'extensions') {
        const symbol = new Signifier(global, asset.name, assetType);
        symbol.replaceMetadata(asset.signifier, symbol.type);
        symbol.setType(assetType);
        symbol.replaceDefinition({});
        symbol.semanticKey = `global:${asset.name}`;
        assetType.signifier = symbol;
        global.setOwnMember(symbol);
        this.publicSymbols.set(symbol.semanticKey, asset.signifier);
        names.set(asset.typeName, assetType);
      }
      if (asset.variables) {
        const owner = ProjectAnalysis.selfKey(asset.name);
        asset.variables.semanticKey = owner;
        this.publicTypes.set(owner, asset.variables);
        const self = new Type('Struct');
        self.semanticKey = owner;
        const create = [...asset.gmlFiles.values()].find(
          (code) => code.isCreateEvent,
        );
        const inherits =
          !!asset.parent &&
          (!create ||
            !!states.get(create.path.absolute)?.evaluation?.callsSuper);
        const parent = inherits ? new Type('Struct') : asset.nativeVariables;
        if (parent && inherits)
          parent.semanticKey = ProjectAnalysis.selfKey(asset.parent!.name);
        self.setBaseView(parent);
        // Editor-defined variables initialize before Create and are inherited
        // even when an overriding Create does not call event_inherited().
        // Keep this seed separate from the conditional parent-Create base.
        const lineage = [asset];
        const seen = new Set(lineage);
        for (
          let ancestor = asset.parent;
          ancestor && !seen.has(ancestor);
          ancestor = ancestor.parent
        ) {
          lineage.push(ancestor);
          seen.add(ancestor);
        }
        for (const source of lineage.reverse()) {
          for (const property of (source.yy as YyObject | undefined)
            ?.properties || []) {
            let type: Type;
            switch (property.varType) {
              case YyObjectPropertyVarType.Real:
              case YyObjectPropertyVarType.Integer:
              case YyObjectPropertyVarType.Colour:
                type = new Type('Real');
                break;
              case YyObjectPropertyVarType.String:
                type = new Type('String');
                break;
              case YyObjectPropertyVarType.Boolean:
                type = new Type('Bool');
                break;
              case YyObjectPropertyVarType.List:
                type = property.multiselect
                  ? new Type('Array').addItemType(new Type('Unknown'))
                  : new Type('Unknown');
                break;
              default:
                type = new Type('Unknown');
            }
            const member = new Signifier(self, property.name, type);
            member.instance = true;
            member.replaceDefinition({});
            member.resourceDefinition = Object.freeze({
              kind: 'object-variable',
              unitId: '$resources',
              uri: source.yyPath.absolute,
              name: property.name,
            });
            self.setOwnMember(member);
          }
        }
        roots.set(owner, self);
        assetType.setBaseView(self);
        if (asset.instanceType) {
          asset.instanceType.semanticKey = `${key}:instance`;
          this.publicTypes.set(
            asset.instanceType.semanticKey,
            asset.instanceType,
          );
          const instance = new Type('Id.Instance').named(asset.name);
          instance.semanticKey = asset.instanceType.semanticKey;
          instance.setBaseView(self);
          if (assetType.signifier) instance.signifier = assetType.signifier;
          roots.set(instance.semanticKey, instance);
          names.set(asset.instanceTypeName, instance);
          const id = new Signifier(self, 'id', instance);
          id.native = 'Base';
          id.instance = true;
          id.writable = false;
          id.override = true;
          self.setOwnMember(id);
        }
      }
    }
    for (const asset of this.project.assets?.values() || []) {
      for (const code of asset.gmlFiles.values()) {
        const source = code.sourceContext;
        if (!source.selfOwner || source.kind === 'object-event') continue;
        const self = new Type('Struct');
        self.semanticKey = source.selfOwner;
        if (source.objectName) {
          const object = this.project.getAssetByName(source.objectName);
          if (object?.isObject) {
            const base = new Type('Struct');
            base.semanticKey = ProjectAnalysis.selfKey(object.name);
            self.setBaseView(base);
          } else self.setBaseView(this.project.native?.objectInstanceBase);
        } else self.setBaseView(this.project.native?.objectInstanceBase);
        roots.set(source.selfOwner, self);
      }
    }
    return collectInputContribution('$resources', roots, names);
  }
  static selfKey(name: string): string {
    return `object:${name}:self`;
  }

  private macroInput(
    environment: MacroEnvironment,
    collections: readonly MacroCollection[],
  ): Contribution {
    const root = new Type('Struct');
    root.semanticKey = globalOwner;
    const locations = { source: this.source };
    const symbols = new Map<
      string,
      import('../analysis/model.js').SymbolContribution
    >();
    for (const collection of collections)
      for (const definition of collection.definitions) {
        const key = `macro:${definition.name}`;
        const active = environment.definitions.get(definition.name);
        if (symbols.has(key) && definition !== active) continue;
        const item = new Signifier(root, definition.name);
        item.semanticKey = key;
        item.global = true;
        item.macro = true;
        item.writable = false;
        item.description = definition.body.trim();
        item.replaceDefinition(
          {},
          materializeSourceRange(
            { spelling: definition.directive, editable: true },
            locations,
          ),
        );
        symbols.set(key, {
          key,
          item,
          owner: globalOwner,
          unitId: '$macros',
          exported: true,
          bare: true,
          origin: { spelling: definition.source, editable: true },
        });
        if (active) root.setOwnMember(item);
      }
    return {
      symbols,
      types: new Map([[globalOwner, root]]),
      namedTypes: new Map(),
    };
  }

  async analyze(): Promise<void> {
    do {
      if (this.disposed) throw new Error('Project analysis has been disposed');
      this.synchronizeBuffers();
      if (this.lastError && this.committedRevision === this.revision)
        throw this.lastError;
      this.running ||= Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.running = undefined;
        });
      await this.running;
    } while (
      !this.isCurrent ||
      this.pendingPublications.size ||
      this.project.resourcesPending
    );
  }
  private async drain(): Promise<void> {
    while (
      !this.disposed &&
      (this.committedRevision !== this.revision ||
        this.pendingPublications.size)
    ) {
      if (this.committedRevision === this.revision) {
        this.publishPending(this.revision);
        continue;
      }
      let revision = this.revision;
      try {
        for (;;) {
          const barrier = this.project.resourcesReady;
          try {
            await barrier;
          } catch (error) {
            if (barrier !== this.project.resourcesReady) continue;
            throw error;
          }
          if (
            barrier === this.project.resourcesReady &&
            !this.project.resourcesPending
          )
            break;
        }
        if (this.disposed) return;
        this.synchronizeBuffers();
        revision = this.revision;
        let slice = performance.now();
        for (const _ of this.transaction(revision)) {
          if (performance.now() - slice >= 8) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            slice = performance.now();
          }
          if (revision !== this.revision) throw new AnalysisCancelled();
        }
      } catch (error) {
        if (error instanceof AnalysisCancelled) continue;
        if (!this.disposed) this.fail(error, this.revision);
        throw error;
      }
    }
  }
  /** Compatibility for synchronous library consumers; editor work uses analyze(). */
  analyzeSync(): void {
    if (this.disposed) throw new Error('Project analysis has been disposed');
    this.synchronizeBuffers();
    if (this.lastError && this.committedRevision === this.revision)
      throw this.lastError;
    if (this.project.resourcesPending)
      throw new Error(
        'Resource reconciliation is in progress; await analyze()',
      );
    while (
      this.committedRevision !== this.revision ||
      this.pendingPublications.size
    ) {
      const revision = this.revision;
      if (this.committedRevision === revision) {
        this.publishPending(revision);
        continue;
      }
      try {
        for (const _ of this.transaction(revision)) {
          /* synchronously drain */
        }
      } catch (error) {
        if (error instanceof AnalysisCancelled) continue;
        this.fail(error, revision);
        throw error;
      }
    }
  }
  private fail(error: unknown, revision: number): void {
    this.lastError = error;
    this.generation++;
    logger.error(
      'Language service transaction failed',
      {
        project: this.project.yypPath?.absolute,
        revision,
        generation: this.generation,
        stage: 'analysis',
        documents: [...this.dirty],
      },
      error,
    );
    for (const code of this.retired) {
      this.removeRefs(code.path.absolute);
      code.retireAnalysis();
      this.pendingPublications.set(code.path.absolute, {
        code,
        retired: true,
        semanticVersion: code.analysisState.semanticVersion,
      });
    }
    this.retired.clear();
    for (const state of this.units.values()) {
      if (!this.dirty.has(state.code.path.absolute)) continue;
      this.removeRefs(state.code.path.absolute);
      state.code.replaceSemanticView(emptyView);
      state.code.markAnalysisFailed(error, this.generation);
      this.pendingPublications.set(state.code.path.absolute, {
        code: state.code,
        retired: false,
        semanticVersion: state.code.analysisState.semanticVersion,
      });
    }
    this.committedRevision = revision;
    this.publishPending(revision);
  }

  private *transaction(revision: number): Generator<void> {
    const cancelled = () => revision !== this.revision;
    const profile = this.profile();
    const lineage = this.project.analysisConfigurationLineage || ['Default'];
    const legacyOtherBehaviour = this.project.legacyOtherBehaviour;
    const inputKey = digest([
      profile.key,
      lineage,
      this.project.options?.settings,
      legacyOtherBehaviour,
    ]);
    const configurationChanged = inputKey !== this.inputKey;
    const states = new Map(
      [...this.units].map(([uri, state]) => [uri, { ...state }]),
    );
    const changed = new Set(this.dirty);
    if (configurationChanged) for (const uri of states.keys()) changed.add(uri);
    for (const [uri, state] of states) {
      if (state.collection?.document.text !== state.code.content) {
        state.collection = collectMacros({ uri, text: state.code.content });
        changed.add(uri);
      }
    }
    const collections = [...states.values()].map((state) => state.collection!);
    const macros = new MacroEnvironment(collections, lineage);
    const oldMacros = this.macroEnvironment;
    const changedMacros = new Set<string>();
    for (const name of new Set([
      ...(oldMacros?.definitions.keys() || []),
      ...macros.definitions.keys(),
    ])) {
      const description = (environment: MacroEnvironment | undefined) => {
        const definition = environment?.definitions.get(name);
        return (
          definition && [
            definition.body,
            definition.source,
            definition.bodyMap.segments,
          ]
        );
      };
      if (digest(description(oldMacros)) !== digest(description(macros)))
        changedMacros.add(name);
    }
    const index =
      this.publicationBuffer?.index.fork(
        (unit) =>
          states.has(unit) ||
          unit === '$native' ||
          unit === '$resources' ||
          unit === '$macros',
      ) ?? new ContributionIndex();
    index.replace('$native', this.nativeInput());
    let resources = this.resourceInput(states);
    index.replace('$resources', resources);
    index.replace('$macros', this.macroInput(macros, collections));
    for (const [uri, state] of states) {
      const code = state.code;
      if (
        [
          ...(state.syntax?.processed.dependencies || []),
          ...(state.collection?.definitions.map(
            (definition) => definition.name,
          ) || []),
        ].some((name) => changedMacros.has(name))
      )
        changed.add(uri);
      if (changed.has(uri) || !state.bound) {
        const processed = macros.expand(
          { uri, text: code.content },
          { cancelled },
        );
        const preprocessKey = digest([
          processed.text,
          processed.sourceMap.segments,
          profile.key,
          code.sourceContext,
          legacyOtherBehaviour,
        ]);
        const reusable =
          preprocessKey === state.preprocessKey
            ? state.syntax?.parsed
            : undefined;
        state.syntax = code.prepareSyntax(processed, reusable);
        if (!reusable) this.metrics.parsed++;
        if (
          preprocessKey !== state.preprocessKey ||
          !state.bound ||
          configurationChanged
        ) {
          const syntax = normalizeSyntax({
            unitId: uri,
            text: processed.text,
            cst: state.syntax.parsed.cst,
            origin: (start, end) => processed.sourceMap.origin(start, end),
          });
          state.bound = bindUnit(syntax, {
            unitId: uri,
            assetId: code.asset.name,
            assetName: code.asset.name,
            kind: code.sourceContext.kind,
            extensionFunctions: code.sourceContext.extensionFunctions,
            eventName: code.name,
            selfOwner: code.sourceContext.selfOwner,
            dynamicSelf: ['timeline', 'extension'].includes(
              code.sourceContext.kind,
            ),
            definitiveSelf:
              code.isCreateEvent ||
              code.sourceContext.kind === 'instance-creation',
            language: profile,
            legacyOtherBehaviour,
            autoDeclareGlobalsPrefixes:
              this.project.options?.settings?.autoDeclareGlobalsPrefixes,
          });
          this.metrics.bound++;
          state.declarations = createDeclarationSummary(state.bound);
          state.preprocessKey = preprocessKey;
        }
        state.evaluation = undefined;
        state.worklistState = undefined;
      }
      index.replace(uri, state.evaluation || state.declarations);
      yield;
    }
    const queue = new Set(changed);
    for (const [uri, state] of states) if (!state.evaluation) queue.add(uri);
    if (this.committedRevision < 0) {
      // Prefer possible named providers only in the initial script/extension
      // queue. Cycles and every later dependency retry keep ordinary scheduling.
      const preferred: string[] = [];
      const remaining: string[] = [];
      for (const uri of queue) {
        const kind = states.get(uri)?.bound?.context.kind;
        (kind === 'script' || kind === 'extension'
          ? preferred
          : remaining
        ).push(uri);
      }
      const ordered = orderColdSources(preferred, states, index, cancelled);
      queue.clear();
      for (const uri of [...ordered, ...remaining]) queue.add(uri);
    }
    const dependencyIndex = this.dependencies.clone();
    for (const [uri, state] of states)
      if (!state.evaluation) dependencyIndex.remove(uri);
    // Source positions can change without changing any exported semantics.
    // Evaluate changed inputs first; enqueue their users only after comparing
    // the new result with the previously committed semantic summary.
    const evaluated = new Set<string>();
    // Discover initial value ports before withdrawing partially discovered
    // components. Otherwise a growing cycle can re-run its older members once
    // for every newly evaluated provider. This set is fixed by transaction
    // inputs and advances with History's per-unit evaluated flags.
    const initialPending = new Set(
      [...states]
        .filter(
          ([, state]) => !state.evaluation && state.bound && state.declarations,
        )
        .map(([uri]) => uri),
    );
    const history = new WorklistHistory();
    const feedback = new ValueFeedbackIndex();
    const unitOrder = new Map<string, number>();
    for (const [uri, state] of states) {
      unitOrder.set(uri, unitOrder.size);
      // Dirty inputs have already reverted to declarations. Their last known
      // value ports still locate the feedback that must be withdrawn together.
      feedback.replace(
        uri,
        state.evaluation || this.units.get(uri)?.evaluation,
      );
      if (state.worklistState) history.setUnitState(uri, state.worklistState);
      else
        state.worklistState = history.setUnit(
          uri,
          state.evaluation,
          keys(state.evaluation || state.declarations),
          feedback.effects(uri),
        );
    }
    history.setResourceBases(
      [...resources.types].map(
        ([key, type]) => [key, type.extends?.semanticKey] as const,
      ),
    );
    const deferred = new Set<string>();
    let active: ReadonlySet<string> | undefined;
    const baselines = new Map<
      string,
      {
        previous?: UnitEvaluation;
        declarations?: Contribution;
        pending: boolean;
      }
    >();
    const comparisonStates = new Map<string, string>();
    let baselineBases: Map<string, string | undefined> | undefined;
    let schedulingChanged = false;
    const defer = (uri: string) => {
      if (!deferred.has(uri)) {
        deferred.add(uri);
        schedulingChanged = true;
      }
    };
    const solve = (members: ReadonlySet<string>) => {
      const pending = [...queue].filter((uri) => members.has(uri));
      const remaining = [...members].filter((uri) => !queue.has(uri));
      remaining.sort(
        (left, right) => unitOrder.get(left)! - unitOrder.get(right)!,
      );
      if (!baselineBases) {
        baselineBases = new Map(
          [...resources.types].map(([key, type]) => [
            key,
            type.extends?.semanticKey,
          ]),
        );
        comparisonStates.set(
          '$resource-bases',
          digest([...baselineBases].sort()),
        );
      }
      for (const uri of members) {
        if (baselines.has(uri)) continue;
        const state = states.get(uri)!;
        const committed = this.units.get(uri);
        const pending = !state.evaluation;
        baselines.set(uri, {
          previous: state.evaluation || committed?.evaluation,
          declarations: state.declarations,
          pending,
        });
        comparisonStates.set(
          uri,
          digest([
            pending,
            state.evaluation
              ? state.worklistState
              : committed?.worklistState || state.worklistState,
          ]),
        );
      }
      // Outside consumers cannot observe internal withdrawal/intermediate facts.
      // Preserve existing work now; notify net changes only after convergence.
      for (const uri of queue) if (!members.has(uri)) defer(uri);
      queue.clear();
      for (const uri of [...pending, ...remaining]) {
        const state = states.get(uri)!;
        state.evaluation = undefined;
        state.worklistState = history.setUnit(
          uri,
          undefined,
          keys(state.declarations),
          feedback.effects(uri),
        );
        index.replace(uri, state.declarations);
        dependencyIndex.remove(uri);
        deferred.delete(uri);
        queue.add(uri);
      }
      active = members;
      schedulingChanged = true;
    };
    const finishComponent = () => {
      const changedKeys = new Set<string>();
      const retryKeys = new Set<string>();
      for (const [uri, baseline] of baselines) {
        const result = states.get(uri)?.evaluation;
        if (!result) throw new Error(`Missing feedback evaluation for ${uri}`);
        const changes = contributionChanges(
          baseline.previous,
          result,
          baseline.declarations,
        );
        for (const key of changes.changed) changedKeys.add(key);
        if (baseline.pending) for (const key of changes.all) retryKeys.add(key);
      }
      for (const [key, type] of resources.types)
        if (baselineBases!.get(key) !== type.extends?.semanticKey)
          changedKeys.add(key);
      const users = dependencyIndex.affected(changedKeys);
      for (const user of dependencyIndex.affected(retryKeys))
        if (evaluated.has(user)) users.add(user);
      // Component membership and comparison baselines are sets in History.
      // Exit order must not depend on which member populated those sets first.
      for (const user of [...users].sort()) if (!active!.has(user)) defer(user);
      active = undefined;
      baselines.clear();
      comparisonStates.clear();
      baselineBases = undefined;
      schedulingChanged = true;
    };
    while (queue.size || deferred.size || active) {
      if (cancelled()) throw new AnalysisCancelled();
      if (!queue.size) {
        if (active) finishComponent();
        if (!deferred.size) break;
        for (const uri of deferred) queue.add(uri);
        deferred.clear();
        schedulingChanged = true;
      }
      if (!active && !initialPending.size) {
        const members = feedback.component(queue.values().next().value!);
        if (members) solve(members);
      }
      if (schedulingChanged) {
        history.setSchedulingState(active, deferred, comparisonStates);
        schedulingChanged = false;
      }
      const uri = queue.values().next().value!;
      if (history.repeats(queue))
        throw new Error(
          `Type inference did not converge for ${states.get(uri)?.code.name || uri}`,
        );
      queue.delete(uri);
      const state = states.get(uri);
      if (!state?.bound || !state.declarations) continue;
      const graph = new ContributionGraph(
        index,
        this.source,
        uri,
        state.declarations,
      );
      const environment: SemanticEnvironment = {
        lookup: (request) => graph.lookup(request.owner, request.name),
        type: (key) =>
          graph.namedType(key) || graph.typeSources(key).length
            ? graph.type(key)
            : undefined,
        implementation: (unitId, functionId) =>
          graph.implementation(unitId, functionId),
        observe: () => {},
        cancelled,
      };
      const firstEvaluation = !state.evaluation;
      const previous = state.evaluation || this.units.get(uri)?.evaluation;
      const result = evaluateUnit(state.bound, environment);
      state.evaluation = {
        ...result,
        diagnostics: [...result.diagnostics, ...checkUnit(state.bound, result)],
      };
      this.metrics.evaluated++;
      evaluated.add(uri);
      history.markEvaluated(uri);
      feedback.replace(uri, result);
      dependencyIndex.replace(uri, result.dependencies);
      state.worklistState = history.setUnit(uri, result, keys(result));
      const before = index.units.get(uri);
      index.replace(uri, state.evaluation);
      if (
        state.code.isCreateEvent &&
        (firstEvaluation || previous?.callsSuper !== result.callsSuper)
      ) {
        const next = this.resourceInput(states);
        const changedBases = new Set<string>();
        for (const [key, type] of next.types) {
          if (
            resources.types.get(key)?.extends?.semanticKey !==
            type.extends?.semanticKey
          )
            changedBases.add(key);
        }
        if (changedBases.size) {
          resources = next;
          index.replace('$resources', resources);
          history.setResourceBases(
            [...resources.types].map(
              ([key, type]) => [key, type.extends?.semanticKey] as const,
            ),
          );
          for (const user of [...dependencyIndex.affected(changedBases)].sort())
            if (!active || active.has(user)) queue.add(user);
          queue.add(uri);
        }
      }
      const changes = contributionChanges(previous, result, before);
      for (const user of [...dependencyIndex.affected(changes.changed)].sort())
        if (user !== uri && (!active || active.has(user))) queue.add(user);
      if (firstEvaluation) {
        // A consumer may have observed declaration-only input. Inside a solve,
        // retry internal users now and outside users against the final result.
        for (const user of [...dependencyIndex.affected(changes.all)].sort())
          if (
            user !== uri &&
            evaluated.has(user) &&
            (!active || active.has(user))
          )
            queue.add(user);
      }
      if (initialPending.delete(uri) && !initialPending.size) {
        // Early ordinary evaluations may already have drained their own queue
        // entries. Revisit discovered feedback even if their outputs looked
        // unchanged because another member still supported a retired fact.
        for (const candidate of [...evaluated].sort())
          if (feedback.component(candidate)) queue.add(candidate);
      }
      const members = initialPending.size ? undefined : feedback.component(uri);
      if (members && !active) solve(members);
      else if (
        active &&
        members &&
        [...members].some((member) => !active!.has(member))
      )
        solve(new Set([...active, ...members]));
      if (active)
        for (const pending of [...queue])
          if (!active.has(pending)) {
            queue.delete(pending);
            defer(pending);
          }
      yield;
    }
    if (cancelled()) throw new AnalysisCancelled();
    const previousBuffer = this.publicationBuffer;
    // Preparation consumes private handles. A failed/cancelled publication must
    // not leave a partly refreshed buffer eligible for another generation.
    this.publicationBuffer = undefined;
    const staged = ContributionGraph.prepare(
      index,
      this.source,
      previousBuffer,
      changed,
    );
    const publish = this.publicationUnits(staged, states, evaluated);
    // Preflight the evaluation views that commit will replace, including
    // definition-only consumers, before changing public handles or references.
    for (const uri of publish)
      materializeUnit(states.get(uri)!.evaluation!, staged);
    if (cancelled()) throw new AnalysisCancelled();
    const publication = this.commit(staged, states, publish);
    this.publicationBuffer = staged;
    this.inputKey = inputKey;
    this.macroEnvironment = macros;
    for (const [uri, state] of states) {
      this.units.set(uri, state);
      if (state.evaluation)
        this.dependencies.replace(uri, state.evaluation.dependencies);
    }
    this.dirty.clear();
    this.committedRevision = revision;
    for (const code of publication.retired)
      this.pendingPublications.set(code.path.absolute, {
        code,
        retired: true,
        semanticVersion: code.analysisState.semanticVersion,
      });
    for (const code of publication.published)
      this.pendingPublications.set(code.path.absolute, {
        code,
        retired: false,
        semanticVersion: code.analysisState.semanticVersion,
      });
    this.publishPending(revision);
  }

  private publicationUnits(
    staged: ContributionGraph,
    states: ReadonlyMap<string, UnitState>,
    evaluated: ReadonlySet<string>,
  ): Set<string> {
    let all = !staged.publicationReused;
    for (const key of staged.updatedTypes) {
      const previous = this.publicTypes.get(key);
      if (previous && previous.kind !== staged.types.get(key)!.kind) all = true;
    }
    for (const key of staged.updatedSymbols) {
      const previous = this.publicSymbols.get(key);
      if (!previous) continue;
      const source = staged.symbols.get(key)!;
      const ownerKey = source.parent.semanticKey!;
      if (
        previous.name !== source.name ||
        (previous.parent !== this.publicTypes.get(ownerKey) &&
          !(
            previous.asset &&
            previous.parent === this.project.self &&
            ownerKey === globalOwner
          ))
      )
        all = true;
    }
    const affected = new Set(evaluated);
    if (!all) {
      const candidates = new Set(staged.updatedSymbols);
      // Resource input may have registered a public handle before preparation.
      // Keep the exact absent-domain check until those ingress writes are tracked.
      for (const key of this.publicSymbols.keys())
        if (!staged.symbols.has(key)) candidates.add(key);
      const definitionKey = (symbol: Signifier | undefined) =>
        symbol?.def?.file
          ? `${symbol.def.file.path.absolute}:${symbol.def.start.offset}:${symbol.def.end.offset}`
          : undefined;
      const changed = new Set<string>();
      const owners = new Set<string>();
      for (const key of candidates) {
        const previous = this.publicSymbols.get(key);
        if (definitionKey(previous) === definitionKey(staged.symbols.get(key)))
          continue;
        changed.add(key);
        for (const ref of previous?.refs || [])
          if (ref.ownerUnitId) owners.add(ref.ownerUnitId);
      }
      // Public refs also contain macro-query occurrences. Verify the original
      // evaluation relation on this bounded owner set to preserve publication scope.
      for (const uri of owners)
        if (
          states
            .get(uri)
            ?.evaluation?.references.some((ref) => changed.has(ref.symbol))
        )
          affected.add(uri);
    }
    return new Set(
      [...states]
        .filter(
          ([uri, state]) => state.evaluation && (all || affected.has(uri)),
        )
        .map(([uri]) => uri),
    );
  }

  private commit(
    staged: ContributionGraph,
    states: Map<string, UnitState>,
    publish: ReadonlySet<string>,
  ): { published: Code[]; retired: Code[] } {
    const index = staged.index;
    const previousUses = new Map<Signifier, number>();
    const useCount = (symbol: Signifier) => {
      let count = 0;
      for (const ref of symbol.refs) if (!ref.isDef) count++;
      return count;
    };
    const rememberUses = (symbol: Signifier | undefined) => {
      if (
        symbol &&
        !previousUses.has(symbol) &&
        !symbol.native &&
        symbol.global &&
        symbol.getTypeByKind('Function')
      )
        previousUses.set(symbol, useCount(symbol));
    };
    const rememberRemoved = (uri: string) => {
      for (const ref of this.refsByUnit.get(uri) || []) rememberUses(ref.item);
    };
    for (const code of this.retired) rememberRemoved(code.path.absolute);
    for (const uri of publish) {
      rememberRemoved(uri);
      const state = states.get(uri)!;
      for (const ref of state.evaluation!.references)
        rememberUses(this.publicSymbols.get(ref.symbol));
      for (const macro of state.collection?.definitions || [])
        rememberUses(this.publicSymbols.get(`macro:${macro.name}`));
      const processed = state.syntax?.processed || state.code.preprocessed;
      for (const macro of processed?.references || [])
        rememberUses(this.publicSymbols.get(`macro:${macro.name}`));
    }
    this.publicTypes.set(globalOwner, this.globalStorage);
    for (const key of staged.updatedTypes) {
      const source = staged.types.get(key)!;
      const previous = this.publicTypes.get(key);
      if (!previous || previous.kind !== source.kind) {
        // A stable storage key may acquire a different value kind after a
        // schema/resource edit. Type's kind contract remains immutable.
        const type = new Type(source.kind);
        type.semanticKey = key;
        this.publicTypes.set(key, type);
      }
    }
    const replacedSymbols: Signifier[] = [];
    for (const key of staged.updatedSymbols) {
      const source = staged.symbols.get(key)!;
      const owner = this.publicTypes.get(source.parent.semanticKey!)!;
      const previous = this.publicSymbols.get(key);
      if (
        !previous ||
        (previous.parent !== owner &&
          // Resource Signifiers are stable public handles allocated by Asset
          // against project.self before the storage graph is materialized.
          !(
            previous.asset &&
            previous.parent === this.project.self &&
            owner.semanticKey === globalOwner
          )) ||
        previous.name !== source.name
      ) {
        const item = new Signifier(owner, source.name);
        item.semanticKey = key;
        this.publicSymbols.set(key, item);
        if (previous) {
          replacedSymbols.push(previous);
        }
      }
    }
    const anonymous = new WeakMap<Type, Type>();
    const host: MaterializationHost = {
      source: this.source,
      hasSymbol: (key) => staged.hasSymbol(key),
      type: (key) => this.publicTypes.get(staged.namedType(key) || key)!,
      symbol: (key) => this.publicSymbols.get(key)!,
      definition: (key) => staged.definition(key),
      value: (source) => {
        if (source.semanticKey && staged.types.has(source.semanticKey))
          return this.publicTypes.get(source.semanticKey)!;
        const values = staged.isPreparedValue(source)
          ? this.publicationValues
          : anonymous;
        let type = values.get(source);
        if (!type) {
          type = new Type(source.kind);
          values.set(source, type);
          installTypeContributions([source], type, host);
        }
        return type;
      },
    };
    // No await, callback or diagnostic publication until every live view agrees.
    for (const [key, target] of this.publicTypes)
      if (staged.updatedTypes.has(key) || !staged.types.has(key))
        installTypeContributions(
          staged.types.has(key) ? [staged.types.get(key)!] : [],
          target,
          host,
        );
    for (const [key, target] of this.publicSymbols)
      if (staged.updatedSymbols.has(key) || !staged.symbols.has(key))
        copyPreparedSymbol(staged.symbols.get(key), target, host);
    // Public project.self is the bare-name presentation view. It is not an
    // analysis input or the storage receiver returned by the global keyword.
    const globals = this.publicTypes.get(globalOwner);
    const native = this.publicTypes.get(nativeGlobalOwner);
    const presented = new Map(
      (globals?.listMembers(true) || []).map((symbol) => [symbol.name, symbol]),
    );
    for (const symbol of native?.listMembers(true) || [])
      presented.set(symbol.name, symbol);
    this.project.self.semanticKey = 'presentation:global';
    this.project.self.replaceOwnMembers(presented.values());
    this.project.self.setBaseView(undefined);
    if (globals) this.project.symbol?.setType(globals);
    for (const code of this.retired) {
      this.removeRefs(code.path.absolute);
      code.retireAnalysis();
    }
    const retired = [...this.retired];
    this.retired.clear();
    const published: Code[] = [];
    for (const uri of publish) {
      const state = states.get(uri)!;
      if (!state.evaluation) continue;
      this.removeRefs(uri);
      const previous = this.units.get(uri);
      if (state.syntax && state.syntax !== previous?.syntax)
        state.code.replaceSyntaxView(state.syntax);
      const view = materializeUnit(state.evaluation, host);
      const macroRefs: Reference[] = [];
      const addMacro = (
        name: string,
        origin: import('../syntax/source.js').SourceOrigin,
        isDef: boolean,
      ) => {
        const location = materializeSourceRange(origin, host);
        const ref = new Reference(
          host.symbol(`macro:${name}`),
          location.start,
          location.end,
        );
        ref.ownerUnitId = uri;
        ref.origin = origin;
        ref.isDef = isDef;
        ref.role = isDef ? 'declaration' : 'read';
        ref.rename = { kind: 'identifier' };
        if (origin.expansion)
          ref.queryRange = materializeSourceRange(origin, host, true);
        macroRefs.push(ref);
      };
      for (const definition of state.collection?.definitions || [])
        addMacro(
          definition.name,
          { spelling: definition.source, editable: true },
          true,
        );
      for (const reference of state.code.preprocessed?.references || [])
        addMacro(reference.name, reference.origin, false);
      const refs = [...macroRefs, ...view.refs];
      this.registerRefs(uri, refs);
      state.code.replaceSemanticView({ ...view, refs });
      state.code.markAnalyzed(
        this.generation + 1,
        state.evaluation.status === 'degraded' || state.code.hasSyntaxErrors
          ? 'degraded'
          : 'complete',
      );
      published.push(state.code);
    }
    for (const symbol of replacedSymbols) {
      symbol.replaceDefinition(undefined);
      symbol.setType([]);
    }
    this.project.types.clear();
    for (const [name] of index.names) {
      const key = staged.namedType(name);
      if (key) this.project.types.set(name, host.type(key));
    }
    for (const key of [...this.publicSymbols.keys()])
      if (!index.symbols.has(key)) this.publicSymbols.delete(key);
    for (const key of [...this.publicTypes.keys()])
      if (!index.types.has(key)) this.publicTypes.delete(key);
    this.generation++;
    const usagePublications = new Map<Signifier, Code>();
    for (const [symbol, before] of previousUses) {
      const after = useCount(symbol);
      const code = symbol.def?.file;
      if (
        before !== after &&
        code &&
        this.units.get(code.path.absolute)?.code === code &&
        !published.includes(code)
      )
        usagePublications.set(symbol, code);
    }
    // Retained handles keep their original Map order. Preserve diagnostic-only
    // callback order too; a zero/single target needs no public-domain traversal.
    const usageOrder =
      usagePublications.size > 1
        ? this.publicSymbols.values()
        : usagePublications.keys();
    for (const symbol of usageOrder) {
      const code = usagePublications.get(symbol);
      if (code && !published.includes(code)) published.push(code);
    }
    for (const code of published) code.computeUnusedSymbolDiagnostics();
    return { published, retired };
  }
  private publishPending(revision: number): void {
    for (const [uri, publication] of this.pendingPublications) {
      if (revision !== this.revision) break;
      this.pendingPublications.delete(uri);
      const current = this.units.get(uri)?.code;
      if (publication.retired) {
        if (!current) this.project.emitDiagnostics(uri, []);
      } else if (
        current === publication.code &&
        current.analysisState.semanticVersion === publication.semanticVersion
      ) {
        current.publishDiagnostics();
        this.metrics.published++;
      }
    }
  }

  private registerRefs(uri: string, refs: readonly Reference[]): void {
    const spelled = new Map<string, Reference[]>();
    for (const ref of refs) {
      ref.item.refs.add(ref);
      const spelling = ref.origin?.spelling.uri;
      if (!spelling || spelling === ref.ownerUnitId) continue;
      let list = spelled.get(spelling);
      if (!list) spelled.set(spelling, (list = []));
      list.push(ref);
    }
    this.refsByUnit.set(uri, refs);
    for (const [spelling, list] of spelled) {
      let group = this.externalReferences.get(spelling);
      if (!group)
        this.externalReferences.set(spelling, (group = { units: new Map() }));
      group.units.set(uri, list);
      group.view = undefined;
    }
  }

  private removeRefs(uri: string): void {
    for (const ref of this.refsByUnit.get(uri) || []) {
      ref.item.refs.delete(ref);
      const spelling = ref.origin?.spelling.uri;
      if (!spelling || spelling === ref.ownerUnitId) continue;
      const group = this.externalReferences.get(spelling);
      if (!group?.units.delete(uri)) continue;
      if (!group.units.size) this.externalReferences.delete(spelling);
      else group.view = undefined;
    }
    this.refsByUnit.delete(uri);
  }
}
