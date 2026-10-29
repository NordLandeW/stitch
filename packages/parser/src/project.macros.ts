import type { Project } from './project.js';
import type { YypConfig } from '@bscotch/yy';
import type { Code } from './project.code.js';
import { Position, Range, type SourceMapping } from './project.location.js';
import { Signifier } from './signifiers.js';
import { Type } from './types.js';
import {
  collectMacros,
  isMacroWord,
  MacroEnvironment,
  type MacroCollection,
  type PreprocessedDocument,
} from './syntax/macros.js';
import {
  SourceLines,
  type SourceMap,
  type SourceSpan,
} from './syntax/source.js';
import { logger } from './logger.js';

interface MacroSource {
  readonly code: Code;
  readonly collection: MacroCollection;
  readonly lines: SourceLines;
}

/** Macro dependencies and spelling contexts, separate from runtime symbol inference. */
export class ProjectMacros {
  private readonly sources = new Map<string, MacroSource>();
  private readonly definitions = new Map<Code, MacroCollection>();
  private readonly dependencies = new Map<Code, ReadonlySet<string>>();
  private readonly users = new Map<string, Set<Code>>();
  private readonly maps = new Map<Code, SourceMap>();
  private readonly mappedSources = new Map<Code, Set<Code>>();
  private readonly sourceUsers = new Map<Code, Set<Code>>();
  private readonly reparse = new Set<Code>();
  private readonly pending = new Set<Code>();
  private readonly families = new Map<string, Signifier>();
  private environment?: MacroEnvironment;
  private requestedConfiguration?: string;

  constructor(readonly project: Project) {}

  get configuration(): string {
    return this.lineage(this.requestedConfiguration).at(-1)!;
  }

  private lineage(requested: string | undefined): string[] {
    const root = this.project.yyp?.configs;
    if (!root) return ['Default'];
    const selected = requested || root.children?.[0]?.name || root.name;
    const frames: { node: YypConfig; parents: string[] }[] = [
      { node: root, parents: [] },
    ];
    while (frames.length) {
      const { node, parents } = frames.pop()!;
      const path = [...parents, node.name];
      if (node.name === selected) return path;
      for (const child of node.children || [])
        frames.push({ node: child, parents: path });
    }
    throw new Error(`Unknown GameMaker configuration: ${selected}`);
  }

  configure(configuration?: string) {
    this.lineage(configuration);
    if (configuration === this.requestedConfiguration) return;
    this.requestedConfiguration = configuration;
    this.configurationTreeChanged();
  }

  configurationTreeChanged() {
    if (
      this.requestedConfiguration &&
      !this.project.configs.includes(this.requestedConfiguration)
    ) {
      logger.warn(
        `GameMaker configuration ${this.requestedConfiguration} was removed; using the project's default selection.`,
      );
      this.requestedConfiguration = undefined;
    }
    this.environment = undefined;
    for (const [name, files] of this.users) {
      if (this.families.has(name))
        for (const code of files) this.invalidate(code);
    }
    for (const code of this.definitions.keys()) this.invalidate(code);
  }

  private invalidate(code: Code) {
    this.pending.add(code);
    this.reparse.add(code);
  }

  collect(code: Code, text: string) {
    const uri = code.path.absolute;
    const old = this.sources.get(uri);
    const collected = collectMacros({ uri, text });
    const collection =
      old?.collection.key === collected.key
        ? { ...collected, definitions: old.collection.definitions }
        : collected;
    this.sources.set(uri, { code, collection, lines: new SourceLines(text) });
    this.invalidate(code);
    if (collection.key) this.definitions.set(code, collection);
    else this.definitions.delete(code);
    if (
      old?.collection.key !== collection.key &&
      (old?.collection.key || collection.key)
    ) {
      const changed = new Set([
        ...(old?.collection.definitions.map((item) => item.name) || []),
        ...collection.definitions.map((item) => item.name),
      ]);
      this.definitionsChanged(changed);
    }
  }

  private definitionsChanged(changed: ReadonlySet<string>) {
    this.environment = undefined;
    for (const name of changed)
      for (const user of this.users.get(name) || []) this.invalidate(user);
    // Surviving declarations also need new selection and duplicate diagnostics,
    // including when removal happens through YY/Code retirement rather than YYP.
    for (const [owner, definitions] of this.definitions) {
      if (definitions.definitions.some((item) => changed.has(item.name)))
        this.invalidate(owner);
    }
  }

  private selected(): MacroEnvironment {
    if (this.environment) return this.environment;
    const environment = new MacroEnvironment(
      [...this.definitions.values()],
      this.lineage(this.requestedConfiguration),
    );
    const allNames = new Set<string>();
    for (const collection of this.definitions.values()) {
      for (const definition of collection.definitions) {
        allNames.add(definition.name);
        if (!this.families.has(definition.name)) {
          const symbol = new Signifier(
            this.project.self,
            definition.name,
            new Type('Any'),
          );
          symbol.macro = true;
          symbol.global = true;
          symbol.writable = false;
          this.families.set(definition.name, symbol);
        }
      }
    }
    for (const [name, symbol] of this.families) {
      symbol.unsetDef();
      if (!allNames.has(name)) this.families.delete(name);
    }
    this.environment = environment;
    // Definitions are physical; their owner is the declaration file, not a caller.
    for (const [name, definition] of environment.definitions) {
      const symbol = this.families.get(name)!;
      symbol.definedAt(this.physicalRange(definition.source));
      symbol.declaredAt(this.physicalRange(definition.directive));
      symbol.describe(`#macro ${name}${definition.body}`);
    }
    return environment;
  }

  hasName(name: string): boolean {
    this.selected();
    return this.families.has(name);
  }

  hasIdentifier(name: string): boolean {
    return !!this.users.get(name)?.size;
  }

  hasUnexpandedCodeUse(name: string): boolean {
    if (this.selected().definitions.has(name)) return false;
    for (const code of this.users.get(name) || []) {
      // The collection's code tokens exclude directives. Inactive template-body
      // references are already registered, unlike ordinary uses in another config.
      const source = this.sources.get(code.path.absolute);
      if (
        source?.collection.lexed.tokens.some(
          (token) => isMacroWord(token) && token.image === name,
        )
      )
        return true;
    }
    return false;
  }

  activeSymbols(): Signifier[] {
    return [...this.selected().definitions.keys()].map(
      (name) => this.families.get(name)!,
    );
  }

  declarationsIn(code: Code) {
    const definitions = this.definitions.get(code)?.definitions || [];
    if (!definitions.length) return [];
    this.selected();
    return definitions.map((definition) => ({
      item: this.families.get(definition.name)!,
      configuration: definition.configuration,
      range: this.physicalRange(definition.directive),
      selectionRange: this.physicalRange(definition.source),
    }));
  }

  preprocess(code: Code): PreprocessedDocument {
    const source = this.sources.get(code.path.absolute)!;
    const environment = this.selected();
    const result = environment.expand(source.collection);
    const names = new Set(result.dependencies);
    for (const definition of source.collection.definitions) {
      for (const token of environment.tokensFor(definition).tokens) {
        if (isMacroWord(token)) names.add(token.image);
      }
    }
    const old = this.dependencies.get(code) || new Set<string>();
    for (const name of old) {
      if (names.has(name)) continue;
      const users = this.users.get(name)!;
      users.delete(code);
      if (!users.size) this.users.delete(name);
    }
    for (const name of names) {
      if (old.has(name)) continue;
      let users = this.users.get(name);
      if (!users) this.users.set(name, (users = new Set()));
      users.add(code);
    }
    this.dependencies.set(code, names);
    for (const owner of this.mappedSources.get(code) || []) {
      const users = this.sourceUsers.get(owner)!;
      users.delete(code);
      if (!users.size) this.sourceUsers.delete(owner);
    }
    this.maps.delete(code);
    this.mappedSources.delete(code);
    if (result.sourceMap) {
      this.maps.set(code, result.sourceMap);
      const owners = new Set<Code>([code]);
      for (const segment of result.sourceMap.segments) {
        const owner = this.sources.get(segment.origin.spelling.uri)?.code;
        if (owner) owners.add(owner);
      }
      this.mappedSources.set(code, owners);
      for (const owner of owners) {
        let users = this.sourceUsers.get(owner);
        if (!users) this.sourceUsers.set(owner, (users = new Set()));
        users.add(code);
      }
    }
    this.reparse.delete(code);
    return result;
  }

  mapping(map: SourceMap): SourceMapping {
    // Retain the exact physical-text snapshots used by this analysis. Old refs
    // can then be withdrawn safely after a source edit or resource retirement.
    const snapshots = new Map<string, MacroSource>();
    for (const uri of new Set([
      map.document.uri,
      ...map.segments.map((item) => item.origin.spelling.uri),
    ])) {
      const source = this.sources.get(uri);
      if (source) snapshots.set(uri, source);
    }
    return {
      project: (range, invocation) => {
        const origin = map.origin(range.start.offset, range.end.offset);
        const span =
          invocation || !origin.editable
            ? origin.expansion || origin.spelling
            : origin.spelling;
        return this.physicalRange(span, snapshots);
      },
      editable: (range) =>
        map.origin(range.start.offset, range.end.offset).editable,
    };
  }

  physicalRange(span: SourceSpan, sources = this.sources): Range {
    const source = sources.get(span.uri);
    if (!source)
      throw new Error(`No physical source for macro range: ${span.uri}`);
    const start = source.lines.position(span.start);
    const end = source.lines.position(span.end);
    return Range.physical(
      new Position(source.code, start.offset, start.line, start.column),
      new Position(source.code, end.offset, end.line, end.column),
    );
  }

  contextsAt(code: Code, offset: number): { code: Code; offset: number }[] {
    const users = this.sourceUsers.get(code);
    if (!users?.size) return [{ code, offset }];
    const contexts: { code: Code; offset: number; expanded: boolean }[] = [];
    const uri = code.path.absolute;
    if (!this.maps.has(code)) contexts.push({ code, offset, expanded: false });
    for (const user of users) {
      const mapping = this.maps.get(user)!;
      for (const generated of mapping.generatedOffsets(uri, offset)) {
        contexts.push({
          code: user,
          offset: generated,
          expanded: !!mapping.origin(generated).expansion,
        });
      }
    }
    const inDefinition = this.sources
      .get(uri)
      ?.collection.definitions.some(
        (item) =>
          item.directive.start <= offset && offset <= item.directive.end,
      );
    if (inDefinition && contexts.some((item) => item.expanded))
      return contexts.filter((item) => item.expanded);
    return contexts.length ? contexts : [{ code, offset }];
  }

  registerSymbols(code: Code, expanded: PreprocessedDocument) {
    const source = this.sources.get(code.path.absolute)!;
    const environment = this.selected();
    for (const definition of source.collection.definitions) {
      const symbol = this.families.get(definition.name)!;
      const location = this.physicalRange(definition.source);
      if (environment.definitions.get(definition.name) === definition) {
        symbol
          .definedAt(location)
          .declaredAt(this.physicalRange(definition.directive));
      }
      symbol.addRef(location, true);
      for (const token of environment.tokensFor(definition).tokens) {
        if (!isMacroWord(token)) continue;
        const referenced = this.families.get(token.image);
        if (!referenced) continue;
        const origin = definition.bodyMap.origin(
          token.startOffset,
          token.endOffset,
        );
        if (origin.editable)
          referenced.addRef(this.physicalRange(origin.spelling));
      }
    }
    // Nested macro spellings were registered once above, rather than once per use.
    for (const reference of expanded.references) {
      if (reference.origin.expansion) continue;
      this.families
        .get(reference.name)
        ?.addRef(this.physicalRange(reference.origin.spelling));
    }
  }

  preparePending(): Code[] {
    for (const code of [...this.reparse]) code.parseCollected();
    return [...this.pending];
  }

  complete(codes: Iterable<Code>) {
    for (const code of codes) this.pending.delete(code);
  }

  /** Synchronous publication: no other buffer can interleave between these passes. */
  flush() {
    const codes = this.preparePending();
    for (const code of codes) code.updateGlobals();
    for (const code of codes) code.updateAllSymbols();
    if (codes.length > 1)
      for (const code of codes) {
        code.updateGlobals();
        code.updateAllSymbols();
      }
    this.complete(codes);
    for (const code of codes) code.updateDiagnostics();
  }

  forget(code: Code) {
    const uri = code.path.absolute;
    if (this.sources.get(uri)?.code !== code) return;
    const previous = this.definitions.get(code);
    this.definitions.delete(code);
    this.sources.delete(uri);
    this.pending.delete(code);
    this.reparse.delete(code);
    for (const name of this.dependencies.get(code) || []) {
      const users = this.users.get(name)!;
      users.delete(code);
      if (!users.size) this.users.delete(name);
    }
    this.dependencies.delete(code);
    for (const source of this.mappedSources.get(code) || []) {
      const users = this.sourceUsers.get(source)!;
      users.delete(code);
      if (!users.size) this.sourceUsers.delete(source);
    }
    this.mappedSources.delete(code);
    this.maps.delete(code);
    if (previous) {
      this.definitionsChanged(
        new Set(previous.definitions.map((item) => item.name)),
      );
    }
  }
}
