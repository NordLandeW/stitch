import { createHash } from 'node:crypto';
import { YyObjectPropertyVarType, type YyObject } from '@bscotch/yy';
import { bindUnit } from '../analysis/binding.js';
import { checkUnit } from '../analysis/checking.js';
import {
  createDeclarationSummary,
  evaluateUnit,
} from '../analysis/evaluation.js';
import {
  installSymbolContributions,
  installTypeContributions,
  materializeSourceRange,
  materializeUnit,
} from '../analysis/materialization.js';
import { normalizeSyntax } from '../analysis/syntax.js';
import {
  AnalysisCancelled,
  globalOwner,
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
import { LanguageProfile } from './version.js';

interface UnitState {
  readonly code: Code;
  collection?: MacroCollection;
  preprocessKey?: string;
  syntax?: CodeSyntaxView;
  bound?: BoundUnit;
  declarations?: Contribution;
  evaluation?: UnitEvaluation;
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
function keys(part: Contribution | undefined): Set<string> {
  const result = new Set<string>();
  if (!part) return result;
  for (const symbol of part.symbols.values()) {
    result.add(symbol.key);
    result.add(`${symbol.owner}/lookup:${symbol.item.name}`);
  }
  for (const key of part.types.keys()) result.add(key);
  for (const key of part.namedTypes.keys()) result.add(key);
  return result;
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
  private readonly externalReferences = new Map<string, Reference[]>();
  private readonly pendingPublications = new Map<
    string,
    { code: Code; retired: boolean; semanticVersion: number }
  >();
  private macroEnvironment?: MacroEnvironment;

  constructor(readonly project: Project) {}

  private disposed = false;
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.generation++;
    for (const [uri, state] of this.units) {
      this.removeRefs(uri);
      state.code.retireAnalysis();
      this.dependencies.remove(uri);
    }
    for (const code of this.retired) code.retireAnalysis();
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
    return this.externalReferences.get(uri) || [];
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
      [globalOwner, this.project.native?.globalSelf || this.project.self],
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
      for (const [name, source] of asset.extensionSymbols || []) {
        const symbol = new Signifier(global, name);
        symbol.replaceMetadata(source, source.type);
        symbol.replaceDefinition(source.def);
        symbol.semanticKey = `global:${name}`;
        global.setOwnMember(symbol);
      }
      for (const [name, type] of asset.extensionTypes || []) {
        type.semanticKey = `${key}:extension:${name}`;
        roots.set(type.semanticKey, type);
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
    const inputKey = digest([
      profile.key,
      lineage,
      this.project.options?.settings,
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
    const index = new ContributionIndex();
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
            kind: code.isScript
              ? 'script'
              : code.isObjectEvent
                ? 'object-event'
                : 'other',
            eventName: code.name,
            selfOwner: code.isObjectEvent
              ? ProjectAnalysis.selfKey(code.asset.name)
              : undefined,
            definitiveSelf: code.isCreateEvent,
            language: profile,
            autoDeclareGlobalsPrefixes:
              this.project.options?.settings?.autoDeclareGlobalsPrefixes,
          });
          this.metrics.bound++;
          state.declarations = createDeclarationSummary(state.bound);
          state.preprocessKey = preprocessKey;
        }
        state.evaluation = undefined;
      }
      index.replace(uri, state.evaluation || state.declarations);
      yield;
    }
    const queue = new Set(changed);
    for (const [uri, state] of states) if (!state.evaluation) queue.add(uri);
    const dependencyIndex = new DependencyIndex();
    for (const [uri, state] of states)
      if (state.evaluation)
        dependencyIndex.replace(uri, state.evaluation.dependencies);
    for (const uri of changed) {
      const old = this.units.get(uri);
      const changeKeys = new Set([
        ...keys(old?.evaluation || old?.declarations),
        ...keys(states.get(uri)?.declarations),
      ]);
      for (const user of this.dependencies.affected(changeKeys))
        queue.add(user);
    }
    const evaluated = new Set<string>();
    const seenStates = new Map<string, Set<string>>();
    while (queue.size) {
      if (cancelled()) throw new AnalysisCancelled();
      const uri = queue.values().next().value!;
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
        observe: () => {},
        cancelled,
      };
      const previous = state.evaluation;
      const result = evaluateUnit(state.bound, environment);
      state.evaluation = {
        ...result,
        diagnostics: [...result.diagnostics, ...checkUnit(state.bound, result)],
      };
      this.metrics.evaluated++;
      evaluated.add(uri);
      dependencyIndex.replace(uri, result.dependencies);
      const before = index.units.get(uri);
      index.replace(uri, state.evaluation);
      if (
        state.code.isCreateEvent &&
        previous?.callsSuper !== result.callsSuper
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
          for (const user of dependencyIndex.affected(changedBases))
            queue.add(user);
          queue.add(uri);
        }
      }
      if (!previous || previous.summary !== result.summary) {
        const changeKeys = new Set([
          ...keys(before),
          ...keys(state.evaluation),
        ]);
        for (const user of dependencyIndex.affected(changeKeys))
          if (user !== uri) queue.add(user);
        // Recursive SCCs can oscillate in an unsupported abstraction. Report an
        // explicit failure instead of accepting an arbitrary fixed pass count.
        let seen = seenStates.get(uri);
        if (!seen) seenStates.set(uri, (seen = new Set()));
        if (seen.has(result.summary))
          throw new Error(
            `Type inference did not converge for ${state.code.name}`,
          );
        seen.add(result.summary);
      }
      yield;
    }
    if (cancelled()) throw new AnalysisCancelled();
    const staged = new ContributionGraph(index, this.source).complete();
    // Preflight source positions and graph closure on detached objects.
    for (const state of states.values())
      if (state.evaluation && evaluated.has(state.code.path.absolute))
        materializeUnit(state.evaluation, staged);
    const publication = this.commit(staged, states, evaluated);
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

  private commit(
    staged: ContributionGraph,
    states: Map<string, UnitState>,
    evaluated: Set<string>,
  ): { published: Code[]; retired: Code[] } {
    const index = staged.index;
    const previousUses = new Map<Signifier, number>();
    const previousDefinitions = new Map<string, string | undefined>();
    const definitionKey = (symbol: Signifier) =>
      symbol.def?.file
        ? `${symbol.def.file.path.absolute}:${symbol.def.start.offset}:${symbol.def.end.offset}`
        : undefined;
    for (const [key, symbol] of this.publicSymbols) {
      previousDefinitions.set(key, definitionKey(symbol));
      if (!symbol.native && symbol.global && symbol.getTypeByKind('Function'))
        previousUses.set(
          symbol,
          [...symbol.refs].filter((ref) => !ref.isDef).length,
        );
    }
    this.publicTypes.set(globalOwner, this.project.self);
    let replacedHandles = false;
    for (const [key, source] of staged.types) {
      const previous = this.publicTypes.get(key);
      if (!previous || previous.kind !== source.kind) {
        // A stable storage key may acquire a different value kind after a
        // schema/resource edit. Type's kind contract remains immutable.
        const type = new Type(source.kind);
        type.semanticKey = key;
        this.publicTypes.set(key, type);
        replacedHandles ||= !!previous;
      }
    }
    const replacedSymbols: Signifier[] = [];
    for (const [key, source] of staged.symbols) {
      const owner = this.publicTypes.get(staged.symbolSources(key)[0].owner)!;
      const previous = this.publicSymbols.get(key);
      if (
        !previous ||
        previous.parent !== owner ||
        previous.name !== source.name
      ) {
        const item = new Signifier(owner, source.name);
        item.semanticKey = key;
        this.publicSymbols.set(key, item);
        if (previous) {
          replacedSymbols.push(previous);
          replacedHandles = true;
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
        if (source.semanticKey && this.publicTypes.has(source.semanticKey))
          return this.publicTypes.get(source.semanticKey)!;
        let type = anonymous.get(source);
        if (!type) {
          type = new Type(source.kind);
          anonymous.set(source, type);
          installTypeContributions([source], type, host);
        }
        return type;
      },
    };
    // No await, callback or diagnostic publication until every live view agrees.
    for (const [key, target] of this.publicTypes)
      installTypeContributions(
        staged.types.has(key) ? [staged.types.get(key)!] : [],
        target,
        host,
      );
    for (const [key, target] of this.publicSymbols) {
      const sources = staged.symbolSources(key);
      installSymbolContributions(
        sources.map((source) => ({ ...source, item: staged.symbol(key) })),
        target,
        host,
      );
    }
    for (const code of this.retired) {
      this.removeRefs(code.path.absolute);
      code.retireAnalysis();
    }
    const retired = [...this.retired];
    this.retired.clear();
    const published: Code[] = [];
    const changedDefinitions = new Set<string>();
    for (const [key, symbol] of this.publicSymbols)
      if (definitionKey(symbol) !== previousDefinitions.get(key))
        changedDefinitions.add(key);
    for (const [uri, state] of states) {
      const definitionChanged = state.evaluation?.references.some((ref) =>
        changedDefinitions.has(ref.symbol),
      );
      if (
        !state.evaluation ||
        (!evaluated.has(uri) && !definitionChanged && !replacedHandles)
      )
        continue;
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
      for (const ref of refs) ref.item.refs.add(ref);
      this.refsByUnit.set(uri, refs);
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
    this.externalReferences.clear();
    for (const refs of this.refsByUnit.values())
      for (const ref of refs) {
        if (ref.origin?.spelling.uri === ref.ownerUnitId) continue;
        const uri = ref.origin?.spelling.uri;
        if (!uri) continue;
        let list = this.externalReferences.get(uri);
        if (!list) this.externalReferences.set(uri, (list = []));
        list.push(ref);
      }
    this.generation++;
    for (const [symbol, before] of previousUses) {
      const after = [...symbol.refs].filter((ref) => !ref.isDef).length;
      const code = symbol.def?.file;
      if (
        before !== after &&
        code &&
        this.units.get(code.path.absolute)?.code === code &&
        !published.includes(code)
      )
        published.push(code);
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

  private removeRefs(uri: string): void {
    for (const ref of this.refsByUnit.get(uri) || []) ref.item.refs.delete(ref);
    this.refsByUnit.delete(uri);
  }
}
