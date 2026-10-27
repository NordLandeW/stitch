import { pathy } from '@bscotch/pathy';
import { stitchConfigSchema } from '@bscotch/stitch-config';
import {
  YyObjectPropertyVarType,
  yyObjectSchema,
  type YyObject,
  type YypResource,
} from '@bscotch/yy';
import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Asset } from '../project.asset.js';
import { Code } from '../project.code.js';
import type { Diagnostic } from '../project.diagnostics.js';
import { planReferenceRename, type Reference } from '../project.location.js';
import { Native } from '../project.native.js';
import { Project, type ProjectOptions } from '../project.js';
import { Signifier } from '../signifiers.js';
import { Type, type TypeStore } from '../types.js';
import { LanguageProfile } from './version.js';

let fixtureId = 0;
type Sources = Readonly<Record<string, string>>;
interface FixtureOptions {
  readonly resourceOrder?: readonly string[];
  readonly fileOrder?: readonly string[];
  readonly configuration?: string;
}

function diagnosticSummary(diagnostic: Diagnostic) {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    start: diagnostic.location.start.offset,
    end: diagnostic.location.end.offset,
  };
}

/** Real model constructors, but no Project.from/YYP loading or filesystem writes. */
class MemoryProject extends Project {
  readonly testCodes = new Map<string, Code>();
  readonly nativeTypeNames = new Set<string>();
  readonly publications: {
    readonly filePath: string;
    readonly diagnostics: ReturnType<typeof diagnosticSummary>[];
  }[] = [];

  constructor(
    configuration = 'Default',
    documentText?: ProjectOptions['documentText'],
  ) {
    // These paths are identities only: this fixture never creates the directory.
    super(
      pathy(
        join(
          tmpdir(),
          `stitch-language-service-${process.pid}-${++fixtureId}`,
          'memory.yyp',
        ),
      ),
      { settings: { analysisConfiguration: configuration }, documentText },
    );
    this.self = new Type('Struct').named('global');
    this.symbol = new Signifier(this.self, 'global', this.self);
    this.symbol.global = true;
    this.symbol.writable = false;
    this.symbol.def = {};
    this.yyp = {
      MetaData: { IDEVersion: '2024.11.0.0' },
      resources: [],
      configs: {
        name: 'Default',
        children: [
          { name: 'Parent', children: [{ name: 'Child', children: [] }] },
        ],
      },
    } as unknown as Project['yyp'];
    this.config = stitchConfigSchema.parse({ runtimeVersion: '2024.11.0.0' });
    this.onDiagnostics(({ filePath, diagnostics }) => {
      this.publications.push({
        filePath,
        diagnostics: diagnostics.map(diagnosticSummary),
      });
    });
  }

  async prepareBundledNative() {
    this.native = await Native.from(
      [Native.fallbackGmlSpecPath],
      this.self,
      this.types,
    );
    this.languageProfile = new LanguageProfile({
      runtimeVersion: this.config.runtimeVersion,
      ideVersion: this.ideVersion,
      specSources: this.native.getSpecSources(),
    });
    for (const name of this.types.keys()) this.nativeTypeNames.add(name);
    this.analysis.captureNative();
  }

  addTestResource(name: string): MemoryScript {
    const resource = new MemoryScript(this, name);
    this.assets.set(name.toLowerCase(), resource);
    this.yyp.resources.push(resource.resource);
    return resource;
  }

  addTestCode(name: string, text?: string): Code {
    const asset = this.getAssetByName(name) || this.addTestResource(name);
    const code = new Code(asset, asset.dir.join(`${name}.gml`));
    asset.gmlFiles.set(code.path.absolute.toLowerCase(), code);
    this.testCodes.set(name, code);
    if (typeof text === 'string') code.content = text;
    return code;
  }

  testCode(name: string): Code {
    const code = this.testCodes.get(name);
    expect(code, `registered code ${name}`).not.to.equal(undefined);
    return code!;
  }

  async retireTestResource(name: string): Promise<Code> {
    const code = this.testCode(name);
    // Model retirement is the real service API; Code.remove would delete a file.
    this.analysis.retire(code);
    code.asset.gmlFiles.delete(code.path.absolute.toLowerCase());
    this.assets.delete(name.toLowerCase());
    this.yyp.resources = this.yyp.resources.filter(
      (resource) => resource.id.name !== name,
    );
    this.testCodes.delete(name);
    await this.analysis.analyze();
    return code;
  }

  async selectTestConfiguration(name: string) {
    await this.setAnalysisConfiguration(name);
  }

  publishedFor(code: Code) {
    const publication = this.publications
      .filter((item) => item.filePath === code.path.absolute)
      .at(-1);
    expect(
      publication,
      `published diagnostics for ${code.asset.name}`,
    ).not.to.equal(undefined);
    return publication!.diagnostics;
  }
}

class MemoryScript extends Asset<'scripts'> {
  constructor(project: MemoryProject, name: string) {
    const resource = {
      id: { name, path: `scripts/${name}/${name}.yy` },
    } as YypResource;
    super(project, resource, project.dir.join(resource.id.path));
    this.yy = { name, resourceType: 'GMScript' } as Asset<'scripts'>['yy'];
  }
}

async function createProject(
  sources: Sources,
  options: FixtureOptions = {},
): Promise<MemoryProject> {
  const project = new MemoryProject(options.configuration);
  await project.prepareBundledNative();
  for (const name of options.resourceOrder || Object.keys(sources))
    project.addTestResource(name);
  for (const name of options.fileOrder || Object.keys(sources)) {
    expect(name in sources, `source supplied for ${name}`).to.equal(true);
    project.addTestCode(name, sources[name]!);
  }
  // All resources, declarations and texts exist before the first cold transaction.
  await project.analysis.analyze();
  expect(project.analysis.generation).to.be.greaterThan(0);
  assertAvailable(project);
  return project;
}

function kinds(store: TypeStore | undefined): string[] {
  return [...new Set(store?.type.map((type) => type.kind) || [])].sort();
}

function definition(code: Code, name: string): Reference {
  const reference = code.refs.find(
    (item) => item.isDef && item.item.name === name,
  );
  expect(reference, `definition of ${name} in ${code.asset.name}`).not.to.equal(
    undefined,
  );
  return reference!;
}

function expectValue(code: Code, name: string, kind: string) {
  expect(
    kinds(definition(code, name).item.type),
    `${code.asset.name}.${name}`,
  ).to.deep.equal([kind]);
}

function callable(project: MemoryProject, name: string) {
  const symbol = project.self.getMember(name);
  expect(symbol?.def, `global definition of ${name}`).not.to.equal(undefined);
  const type = symbol?.getTypeByKind('Function');
  expect(type, `function type of ${name}`).not.to.equal(undefined);
  return type!;
}

function missing(code: Code, name: string) {
  const diagnostics = code.getDiagnostics();
  return [
    ...diagnostics.UNDECLARED_GLOBAL_REFERENCE,
    ...diagnostics.UNDECLARED_VARIABLE_REFERENCE,
  ].filter((diagnostic) => diagnostic.message.includes(name));
}

function assertAvailable(project: MemoryProject) {
  for (const code of project.testCodes.values()) {
    expect(['complete', 'degraded']).to.include(code.analysisState.status);
    expect(code.analysisState.semanticVersion).to.be.greaterThan(0);
    expect(code.analysisState.projectVersion).to.be.at.most(
      project.analysis.generation,
    );
    expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
  }
}

function symbolSummary(symbol: Signifier) {
  const fn = symbol.getTypeByKind('Function');
  return {
    name: symbol.name,
    defined: !!symbol.def,
    macro: !!symbol.macro,
    type: symbol.type.toFeatherString(),
    refs: symbol.refs.size,
    parameters: fn?.listParameters().map(
      (parameter) =>
        parameter && {
          name: parameter.name,
          type: parameter.type.toFeatherString(),
          optional: !!parameter.optional,
        },
    ),
    returns: fn?.returns?.toFeatherString(),
  };
}

function sorted<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    (JSON.stringify(left) ?? '').localeCompare(JSON.stringify(right) ?? ''),
  );
}

/** Compare public semantics, not per-project path IDs, generations or queue order. */
function snapshot(project: MemoryProject) {
  return {
    files: [...project.testCodes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, code]) => ({
        name,
        status: code.analysisState.status,
        refs: sorted(
          code.refs.map((reference) => ({
            name: reference.item.name,
            isDef: reference.isDef,
            role: reference.role,
            file: reference.start.file.asset.name,
            start: reference.start.offset,
            end: reference.end.offset,
            type: reference.item.type.toFeatherString(),
            evaluated: reference.evaluatedType?.toFeatherString(),
            definitionFile: reference.item.def?.file?.asset.name,
          })),
        ),
        diagnostics: Object.fromEntries(
          Object.entries(code.getDiagnostics())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([collection, diagnostics]) => [
              collection,
              sorted(diagnostics.map(diagnosticSummary)),
            ]),
        ),
      })),
    globals: sorted(
      project.self
        .listMembers(true)
        .filter((symbol) => !symbol.native)
        .map(symbolSummary),
    ),
    namedTypes: [...project.types]
      .filter(([name]) => !project.nativeTypeNames.has(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => ({
        name,
        kind: type.kind,
        type: type.toFeatherString(),
        members: sorted(
          type
            .listMembers(true)
            .map((member) => ({
              name: member.name,
              type: member.type.toFeatherString(),
            })),
        ),
      })),
  };
}

function currentSources(project: MemoryProject): Record<string, string> {
  return Object.fromEntries(
    [...project.testCodes].map(([name, code]) => [name, code.content]),
  );
}

function counters(project: MemoryProject) {
  return { ...project.analysis.metrics };
}
function delta(project: MemoryProject, before: ReturnType<typeof counters>) {
  const now = counters(project);
  return {
    parsed: now.parsed - before.parsed,
    bound: now.bound - before.bound,
    evaluated: now.evaluated - before.evaluated,
    published: now.published - before.published,
  };
}

const chain: Sources = {
  A: 'function audit_chain_a() { return audit_chain_b(); } var result = audit_chain_a();',
  B: 'function audit_chain_b() { return audit_chain_c(); }',
  C: 'function audit_chain_c() { return audit_chain_d(); }',
  D: 'function audit_chain_d() { return 1; }',
};

function expectChain(project: MemoryProject, kind: string) {
  expectValue(project.testCode('A'), 'result', kind);
  for (const name of [
    'audit_chain_a',
    'audit_chain_b',
    'audit_chain_c',
    'audit_chain_d',
  ]) {
    expect(
      kinds(callable(project, name).returns),
      `${name} return`,
    ).to.deep.equal([kind]);
  }
  assertAvailable(project);
}

describe('ProjectAnalysis through real Project and Code models', function () {
  it('converges A → B → C → D forward returns independently of resource and file registration order', async function () {
    const forward = await createProject(chain);
    expectChain(forward, 'Real');
    const expected = snapshot(forward);
    const names = Object.keys(chain);
    for (const options of [
      { resourceOrder: [...names].reverse() },
      { fileOrder: [...names].reverse() },
      { resourceOrder: [...names].reverse(), fileOrder: [...names].reverse() },
    ]) {
      const reordered = await createProject(chain, options);
      expectChain(reordered, 'Real');
      expect(snapshot(reordered)).to.deep.equal(expected);
    }
  });

  it('refreshes unchanged consumers after provider return edits and matches the final cold project', async function () {
    const project = await createProject(chain);
    const consumer = project.testCode('A');
    const consumerText = consumer.content;
    const syntaxVersion = consumer.analysisState.syntaxVersion;
    let semanticVersion = consumer.analysisState.semanticVersion;
    for (const [source, kind] of [
      ['function audit_chain_d() { return "changed"; }', 'String'],
      [chain.D!, 'Real'],
    ] as const) {
      const generation = project.analysis.generation;
      await project.testCode('D').reload(source);
      expect(project.analysis.generation).to.be.greaterThan(generation);
      expectChain(project, kind);
      expect(consumer.content).to.equal(consumerText);
      expect(consumer.analysisState.syntaxVersion).to.equal(syntaxVersion);
      expect(consumer.analysisState.semanticVersion).to.be.greaterThan(
        semanticVersion,
      );
      semanticVersion = consumer.analysisState.semanticVersion;
      const cold = await createProject(currentSources(project), {
        fileOrder: ['D', 'C', 'B', 'A'],
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    }
  });

  it('invalidates negative function lookups on add and model deletion, preserving cold/incremental types and diagnostics', async function () {
    const project = await createProject({
      Consumer: 'var result = audit_added_later();',
    });
    const consumer = project.testCode('Consumer');
    expect(missing(consumer, 'audit_added_later')).not.to.have.lengthOf(0);
    const missingState = snapshot(project);
    project.addTestCode(
      'Provider',
      'function audit_added_later() { return 7; }',
    );
    await project.analysis.analyze();
    expect(missing(consumer, 'audit_added_later')).to.deep.equal([]);
    expectValue(consumer, 'result', 'Real');
    const provider = project.testCode('Provider');
    const read = consumer.refs.find(
      (reference) => reference.item.name === 'audit_added_later',
    )!;
    expect(read.item).to.equal(project.self.getMember('audit_added_later'));
    expect(read.item.def?.file).to.equal(provider);
    expect(read.item.refs.size).to.equal(2);
    const coldPresent = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldPresent));

    const symbol = read.item;
    const oldReferences = [...symbol.refs];
    const retired = await project.retireTestResource('Provider');
    expect(retired.analysisState.status).to.equal('retired');
    expect(retired.refs).to.deep.equal([]);
    expect(symbol.def).to.equal(undefined);
    for (const oldReference of oldReferences) {
      expect(symbol.refs.has(oldReference)).to.equal(false);
      expect(project.analysis.references).not.to.include(oldReference);
    }
    // Canonical storage may survive deletion because this name is still used.
    // Retire obsolete Reference objects, not the current consumer's real use.
    const currentUses = consumer.refs.filter(
      (reference) =>
        reference.item.name === 'audit_added_later' && !reference.isDef,
    );
    expect(currentUses).to.have.lengthOf(1);
    expect(currentUses[0]).not.to.equal(read);
    for (const current of currentUses) {
      expect(current.start.file).to.equal(consumer);
      expect(current.item.def).to.equal(undefined);
      expect(current.item.refs.has(current)).to.equal(true);
      expect(project.analysis.references).to.include(current);
    }
    for (const current of symbol.refs) {
      expect(currentUses).to.include(current);
      expect(current.ownerUnitId).to.equal(consumer.path.absolute);
      expect(current.start.file).to.equal(consumer);
      expect(current.isDef).to.equal(false);
    }
    expect(
      project.analysis.references.some(
        (reference) => reference.ownerUnitId === provider.path.absolute,
      ),
    ).to.equal(false);
    expect(project.types.has('Function.audit_added_later')).to.equal(false);
    expect(missing(consumer, 'audit_added_later')).not.to.have.lengthOf(0);
    expect(kinds(definition(consumer, 'result').item.type)).not.to.deep.equal([
      'Real',
    ]);
    expect(snapshot(project)).to.deep.equal(missingState);
    const coldMissing = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldMissing));
  });

  it('replaces parameter names, annotation types and optional slots without retaining the old signature', async function () {
    const original =
      '/// @param {Real} value\nfunction audit_parameters(value) { return value; }';
    const changed = [
      '/// @param {String} renamed',
      '/// @param {Real} [extra]',
      'function audit_parameters(renamed, extra = 3) { return renamed; }',
    ].join('\n');
    const project = await createProject({
      Provider: original,
      Consumer: 'var result = audit_parameters(1);',
    });
    expectValue(project.testCode('Consumer'), 'result', 'Real');
    await project.testCode('Provider').reload(changed);
    const fn = callable(project, 'audit_parameters');
    expect(
      fn.listParameters().map((parameter) => parameter?.name),
    ).to.deep.equal(['renamed', 'extra']);
    expect(fn.getParameter('value')).to.equal(undefined);
    expect(kinds(fn.getParameter('renamed')!.type)).to.deep.equal(['String']);
    expect(fn.getParameter('extra')!.optional).to.equal(true);
    expectValue(project.testCode('Consumer'), 'result', 'String');
    const coldChanged = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldChanged));
    await project.testCode('Provider').reload(original);
    expect(
      callable(project, 'audit_parameters')
        .listParameters()
        .map((parameter) => parameter?.name),
    ).to.deep.equal(['value']);
    expect(
      callable(project, 'audit_parameters').getParameter('extra'),
    ).to.equal(undefined);
    const coldOriginal = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldOriginal));
  });

  it('retires constructor names and instance shapes across rename, repair and deletion', async function () {
    const project = await createProject({
      Provider: 'function AuditBefore() constructor { value = 1; }',
      Consumer: 'var instance = new AuditBefore(); var field = instance.value;',
    });
    expect(project.types.has('Function.AuditBefore')).to.equal(true);
    expect(project.types.has('Struct.AuditBefore')).to.equal(true);
    expectValue(project.testCode('Consumer'), 'field', 'Real');
    await project
      .testCode('Provider')
      .reload('function AuditAfter() constructor { value = 1; }');
    expect(project.types.has('Function.AuditBefore')).to.equal(false);
    expect(project.types.has('Struct.AuditBefore')).to.equal(false);
    expect(project.self.getMember('AuditBefore')?.def).to.equal(undefined);
    expect(project.types.has('Function.AuditAfter')).to.equal(true);
    expect(project.types.has('Struct.AuditAfter')).to.equal(true);
    expect(
      missing(project.testCode('Consumer'), 'AuditBefore'),
    ).not.to.have.lengthOf(0);
    const coldBroken = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldBroken));

    await project
      .testCode('Consumer')
      .reload('var instance = new AuditAfter(); var field = instance.value;');
    expectValue(project.testCode('Consumer'), 'field', 'Real');
    expect(callable(project, 'AuditAfter').isConstructor).to.equal(true);
    const coldRepaired = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldRepaired));
    await project.retireTestResource('Provider');
    for (const name of [
      'Function.AuditBefore',
      'Struct.AuditBefore',
      'Function.AuditAfter',
      'Struct.AuditAfter',
    ]) {
      expect(project.types.has(name), `retired named type ${name}`).to.equal(
        false,
      );
    }
    expect(
      missing(project.testCode('Consumer'), 'AuditAfter'),
    ).not.to.have.lengthOf(0);
    const coldDeleted = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldDeleted));
  });

  it('replaces references on repeated edits instead of accumulating old uses or declarations', async function () {
    const once = 'var result = audit_stable();';
    const twice = `${once} var other = audit_stable();`;
    const project = await createProject({
      Provider: 'function audit_stable() { return 1; }',
      Consumer: once,
    });
    const original = snapshot(project);
    const symbol = project.self.getMember('audit_stable')!;
    for (const calls of [2, 1, 2, 1, 2, 1]) {
      const consumer = project.testCode('Consumer');
      await consumer.reload(calls === 1 ? once : twice);
      expect(project.self.getMember('audit_stable')).to.equal(symbol);
      expect(symbol.refs.size).to.equal(calls + 1);
      const all = project.analysis.references.filter(
        (reference) => reference.item === symbol,
      );
      expect(all).to.have.lengthOf(calls + 1);
      expect(
        new Set(
          all.map(
            (reference) =>
              `${reference.ownerUnitId}:${reference.start.offset}:${reference.isDef}`,
          ),
        ).size,
      ).to.equal(all.length);
      expect(
        consumer.refs.filter((reference) => reference.item === symbol),
      ).to.have.lengthOf(calls);
      expect(
        consumer.refs.some((reference) => reference.item.name === 'other'),
      ).to.equal(calls === 2);
      expectValue(consumer, 'result', 'Real');
    }
    expect(snapshot(project)).to.deep.equal(original);
  });

  it('publishes a local lexical diagnostic, retains later declarations and clears it after repair', async function () {
    const valid = 'var good = 1; var after = 2;';
    const invalid = 'var good = 1; § var after = 2;';
    const project = await createProject({ Source: valid });
    const original = snapshot(project);
    const code = project.testCode('Source');
    const initialStatus = code.analysisState.status;
    await code.reload(invalid);
    expect(code.analysisState.status).to.equal('degraded');
    expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
    const syntax = code.getDiagnostics().SYNTAX_ERROR;
    expect(syntax).to.have.lengthOf(1);
    expect(syntax[0].location.start.offset).to.equal(invalid.indexOf('§'));
    expect(syntax[0].location.end.offset).to.equal(invalid.indexOf('§'));
    expect(syntax[0].severity).to.equal('error');
    expectValue(code, 'good', 'Real');
    expectValue(code, 'after', 'Real');
    expect(project.publishedFor(code)).to.deep.include(
      diagnosticSummary(syntax[0]),
    );
    await code.reload(valid);
    expect(code.analysisState.status).to.equal(initialStatus);
    expect(code.getDiagnostics().SYNTAX_ERROR).to.deep.equal([]);
    expect(project.publishedFor(code)).to.deep.equal([]);
    expect(snapshot(project)).to.deep.equal(original);
  });

  it('updates cross-file macro additions, edits, selected configuration and deletion through the same project service', async function () {
    const project = await createProject({
      Consumer: 'var value = AUDIT_GLOBAL_VALUE;',
    });
    const consumer = project.testCode('Consumer');
    expect(missing(consumer, 'AUDIT_GLOBAL_VALUE')).not.to.have.lengthOf(0);
    project.addTestCode('Macros', '#macro AUDIT_GLOBAL_VALUE 1\n');
    await project.analysis.analyze();
    expectValue(consumer, 'value', 'Real');
    expect(missing(consumer, 'AUDIT_GLOBAL_VALUE')).to.deep.equal([]);
    const macro = consumer.refs.find(
      (reference) => reference.item.name === 'AUDIT_GLOBAL_VALUE',
    )!;
    expect(macro.item.macro).to.equal(true);
    expect(macro.start.file).to.equal(consumer);
    expect(macro.text).to.equal('AUDIT_GLOBAL_VALUE');
    expect(
      [...macro.item.refs].some(
        (reference) =>
          reference.isDef &&
          reference.start.file === project.testCode('Macros'),
      ),
    ).to.equal(true);
    const directive = macro.item.declaration!;
    expect(directive.file).to.equal(project.testCode('Macros'));
    expect(
      directive.file.getTextAt(directive.start.offset, directive.end.offset),
    ).to.equal('#macro AUDIT_GLOBAL_VALUE 1');

    const configurations = [
      '#macro AUDIT_GLOBAL_VALUE "base"',
      '#macro Parent:AUDIT_GLOBAL_VALUE 42',
      '#macro Child:AUDIT_GLOBAL_VALUE "child"',
    ].join('\n');
    await project.testCode('Macros').reload(configurations);
    expectValue(consumer, 'value', 'String');
    await project.selectTestConfiguration('Parent');
    expect(project.analysisConfigurationLineage).to.deep.equal([
      'Default',
      'Parent',
    ]);
    expectValue(consumer, 'value', 'Real');
    await project.selectTestConfiguration('Child');
    expect(project.analysisConfigurationLineage).to.deep.equal([
      'Default',
      'Parent',
      'Child',
    ]);
    expectValue(consumer, 'value', 'String');
    const coldChild = await createProject(currentSources(project), {
      configuration: 'Child',
    });
    expect(snapshot(project)).to.deep.equal(snapshot(coldChild));
    const retired = await project.retireTestResource('Macros');
    expect(retired.analysisState.status).to.equal('retired');
    expect(missing(consumer, 'AUDIT_GLOBAL_VALUE')).not.to.have.lengthOf(0);
    expect(
      consumer.refs.some(
        (reference) =>
          reference.item.name === 'AUDIT_GLOBAL_VALUE' && reference.item.macro,
      ),
    ).to.equal(false);
    const coldDeleted = await createProject(currentSources(project), {
      configuration: 'Child',
    });
    expect(snapshot(project)).to.deep.equal(snapshot(coldDeleted));
    const replacement = project.addTestCode('Macros', configurations);
    await project.analysis.analyze();
    expectValue(consumer, 'value', 'String');
    expect(replacement).not.to.equal(retired);
    expect(snapshot(project)).to.deep.equal(snapshot(coldChild));
  });

  it('does not bind an inactive configuration macro as a runtime variable', async function () {
    const sources = {
      Definitions: '#macro Child:AUDIT_CONFIG_ONLY 42',
      Consumer: 'var result = AUDIT_CONFIG_ONLY;',
    };
    const project = await createProject(sources);
    const consumer = project.testCode('Consumer');
    const unresolved = () => {
      expect(missing(consumer, 'AUDIT_CONFIG_ONLY')).not.to.have.lengthOf(0);
      const reference = consumer.refs.find(
        (ref) => ref.text === 'AUDIT_CONFIG_ONLY',
      )!;
      expect(reference.item.macro).to.equal(false);
      expect(reference.item.def).to.equal(undefined);
    };
    unresolved();
    await project.selectTestConfiguration('Child');
    expect(missing(consumer, 'AUDIT_CONFIG_ONLY')).to.have.lengthOf(0);
    expectValue(consumer, 'result', 'Real');
    expect(
      consumer.refs.find((ref) => ref.text === 'AUDIT_CONFIG_ONLY')!.item.macro,
    ).to.equal(true);
    await project.selectTestConfiguration('Default');
    unresolved();
    const cold = await createProject(sources);
    expect(snapshot(project)).to.deep.equal(snapshot(cold));
  });

  it('promotes a surviving global write immediately when the earlier definition is removed', async function () {
    const project = await createProject({
      First: 'global.audit_remaining = 1;',
      Second: 'global.audit_remaining = "later";',
    });
    const second = project.testCode('Second');
    const original = second.refs.find(
      (reference) => reference.item.name === 'audit_remaining',
    )!;
    expect(original.isDef).to.equal(false);
    await project.testCode('First').reload('');
    const promoted = second.refs.find(
      (reference) => reference.item.name === 'audit_remaining',
    )!;
    expect(promoted.item).to.equal(original.item);
    expect(promoted.isDef).to.equal(true);
    expect(promoted.item.def?.file).to.equal(second);
    expect(promoted.item.type.toFeatherString()).to.equal('String');
    const cold = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(cold));
  });

  it('renames only the final qualified annotation name without value-namespace capture', async function () {
    const project = await createProject({
      Definition: 'function Struct() constructor { field=1; }',
      Consumer:
        'function Probe(){\nvar Renamed=0;\n/// @type {Struct.Struct}\nvar instance;\n}',
    });
    const consumer = project.testCode('Consumer');
    const annotation = consumer.refs.find(
      (reference) => reference.role === 'type',
    )!;
    expect(annotation.text).to.equal('Struct.Struct');
    expect(annotation.item).to.equal(project.self.getMember('Struct'));
    expect(annotation.toRenamed('Renamed')).to.equal('Struct.Renamed');
    expect(
      planReferenceRename([annotation], 'Renamed').map((edit) => edit.text),
    ).to.deep.equal(['Struct.Renamed']);
    // Ordinary GML uses still must reject capture by that same local variable.
    await consumer.reload(
      'function Probe(){ var Renamed=0; return new Struct(); }',
    );
    const ordinary = consumer.refs.filter(
      (reference) => reference.item.name === 'Struct',
    );
    expect(() => planReferenceRename(ordinary, 'Renamed')).to.throw('captured');
  });

  it('does no additional inference work for an independent chain when another chain changes', async function () {
    const left = {
      LeftUser:
        'function audit_left_user() { return audit_left_provider(); } var left_result = audit_left_user();',
      LeftProvider: 'function audit_left_provider() { return 1; }',
    };
    const project = await createProject({
      ...left,
      RightUser:
        'function audit_right_user() { return audit_right_provider(); } var right_result = audit_right_user();',
      RightProvider: 'function audit_right_provider() { return 2; }',
    });
    const isolated = await createProject(left);
    const versions = ['RightUser', 'RightProvider'].map((name) => ({
      name,
      state: project.testCode(name).analysisState,
    }));
    const before = counters(project);
    const isolatedBefore = counters(isolated);
    const changed = 'function audit_left_provider() { return "changed"; }';
    await project.testCode('LeftProvider').reload(changed);
    await isolated.testCode('LeftProvider').reload(changed);
    expectValue(project.testCode('LeftUser'), 'left_result', 'String');
    expectValue(project.testCode('RightUser'), 'right_result', 'Real');
    for (const { name, state } of versions) {
      expect(project.testCode(name).analysisState.semanticVersion).to.equal(
        state.semanticVersion,
      );
      expect(project.testCode(name).analysisState.syntaxVersion).to.equal(
        state.syntaxVersion,
      );
    }
    const work = delta(project, before);
    const minimal = delta(isolated, isolatedBefore);
    expect(work.parsed).to.equal(1);
    expect(work.bound).to.equal(1);
    expect(work.evaluated).to.be.greaterThan(0);
    expect(work.parsed).to.equal(minimal.parsed);
    expect(work.bound).to.equal(minimal.bound);
    expect(work.evaluated).to.equal(minimal.evaluated);
  });

  it('refreshes definition-file UNUSED publication on call addition/removal without reevaluating the unchanged body', async function () {
    const uncalled = 'var unrelated = 2;';
    const project = await createProject({
      Provider: 'function audit_usage_target() { return 1; }',
      Consumer: uncalled,
    });
    const provider = project.testCode('Provider');
    const consumer = project.testCode('Consumer');
    const unused = () =>
      provider
        .getDiagnostics()
        .UNUSED.filter((diagnostic) =>
          diagnostic.message.includes('audit_usage_target'),
        );
    expect(unused()).to.have.lengthOf(1);
    expect(
      project
        .publishedFor(provider)
        .some((diagnostic) =>
          diagnostic.message.includes('audit_usage_target'),
        ),
    ).to.equal(true);
    const semanticVersion = provider.analysisState.semanticVersion;
    const syntaxVersion = provider.analysisState.syntaxVersion;
    for (const [text, expectedUnused] of [
      ['var result = audit_usage_target();', false],
      [uncalled, true],
    ] as const) {
      const before = counters(project);
      const publications = project.publications.filter(
        (item) => item.filePath === provider.path.absolute,
      ).length;
      await consumer.reload(text);
      expect(unused()).to.have.lengthOf(expectedUnused ? 1 : 0);
      expect(
        project
          .publishedFor(provider)
          .some((diagnostic) =>
            diagnostic.message.includes('audit_usage_target'),
          ),
      ).to.equal(expectedUnused);
      expect(
        project.publications.filter(
          (item) => item.filePath === provider.path.absolute,
        ).length,
      ).to.be.greaterThan(publications);
      expect(provider.analysisState.semanticVersion).to.equal(semanticVersion);
      expect(provider.analysisState.syntaxVersion).to.equal(syntaxVersion);
      expect(
        kinds(callable(project, 'audit_usage_target').returns),
      ).to.deep.equal(['Real']);
      expect(delta(project, before).evaluated).to.equal(1);
    }
  });

  it('does not resurrect a unit retired synchronously by the first diagnostics publication', async function () {
    const project = new MemoryProject();
    await project.prepareBundledNative();
    project.addTestResource('A');
    project.addTestResource('B');
    const a = project.addTestCode(
      'A',
      'function audit_kept() { return 1; } var result = audit_kept();',
    );
    const b = project.addTestCode(
      'B',
      'function audit_retired_during_publish() { return 2; }',
    );
    let retirementCalls = 0;
    let wasRegisteredAtPublication = false;
    const unsubscribe = project.onDiagnostics(({ code }) => {
      if (code !== a || retirementCalls !== 0) return;
      retirementCalls++;
      wasRegisteredAtPublication =
        project.analysis.document(b.path.absolute) === b;
      // This public callback changes the revision before the originating
      // analyze() resolves. Its old transaction must never write B back.
      project.analysis.retire(b);
    });
    try {
      await project.analysis.analyze();
    } finally {
      unsubscribe();
    }
    expect(retirementCalls).to.equal(1);
    expect(wasRegisteredAtPublication).to.equal(true);
    expect(project.analysis.document(b.path.absolute)).to.equal(undefined);
    expect(project.self.getMember('audit_retired_during_publish')).to.equal(
      undefined,
    );
    expect(project.types.has('Function.audit_retired_during_publish')).to.equal(
      false,
    );
    expect(b.analysisState.status).to.equal('retired');
    expect(b.refs).to.deep.equal([]);
    expect(
      project.analysis.references.some(
        (reference) => reference.ownerUnitId === b.path.absolute,
      ),
    ).to.equal(false);
    expect(project.analysis.document(a.path.absolute)).to.equal(a);
    expect(a.getDiagnostics().ANALYSIS).to.deep.equal([]);
    expectValue(a, 'result', 'Real');
    expect(kinds(callable(project, 'audit_kept').returns)).to.deep.equal([
      'Real',
    ]);
  });

  it('refreshes duplicate-macro diagnostics and definitions when same-length unused headers leave masked syntax unchanged', async function () {
    const duplicate = '#macro AA 2\n';
    const repaired = '#macro BB 2\n';
    const project = await createProject({ A: '#macro AA 1\n', B: duplicate });
    const b = project.testCode('B');
    const masked = b.syntaxText;
    const duplicates = () =>
      b
        .getDiagnostics()
        .SYNTAX_ERROR.filter((diagnostic) =>
          /duplicate macro AA/i.test(diagnostic.message),
        );
    expect(duplicates()).to.have.lengthOf(1);
    expect(duplicates()[0].location.start.offset).to.equal(
      duplicate.indexOf('AA'),
    );
    expect(duplicates()[0].location.end.offset).to.equal(
      duplicate.indexOf('AA') + 1,
    );
    expect(project.testCode('A').preprocessed!.references).to.deep.equal([]);
    expect(b.preprocessed!.references).to.deep.equal([]);
    const initial = snapshot(project);

    await b.reload(repaired);
    expect(b.content.length).to.equal(duplicate.length);
    expect(b.syntaxText).to.equal(masked);
    expect(b.getDiagnostics().SYNTAX_ERROR).to.deep.equal([]);
    expect(b.preprocessed!.references).to.deep.equal([]);
    expect(definition(b, 'BB').text).to.equal('BB');
    expect(definition(b, 'BB').item.macro).to.equal(true);
    expect(b.refs.some((reference) => reference.item.name === 'AA')).to.equal(
      false,
    );
    const coldRepaired = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldRepaired));

    await b.reload(duplicate);
    expect(b.syntaxText).to.equal(masked);
    expect(duplicates()).to.have.lengthOf(1);
    expect(b.preprocessed!.references).to.deep.equal([]);
    expect(project.self.getMember('BB')).to.equal(undefined);
    expect(b.refs.some((reference) => reference.item.name === 'BB')).to.equal(
      false,
    );
    expect(snapshot(project)).to.deep.equal(initial);
    const coldDuplicate = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldDuplicate));
  });

  it('delivers all pending retirement tombstones when the first tombstone callback invalidates another unit', async function () {
    const project = await createProject({
      A: 'var kept = 1;',
      B: 'var b = audit_missing_in_b;',
      C: 'var c = audit_missing_in_c;',
    });
    const a = project.testCode('A');
    const b = project.testCode('B');
    const c = project.testCode('C');
    expect(project.publishedFor(b).length).to.be.greaterThan(0);
    expect(project.publishedFor(c).length).to.be.greaterThan(0);
    const firstRetirementEvent = project.publications.length;
    let invalidations = 0;
    const unsubscribe = project.onDiagnostics(({ filePath, diagnostics }) => {
      // Deletion is an event for the physical URI, not necessarily a Code.
      if (filePath !== b.path.absolute || diagnostics.length || invalidations)
        return;
      invalidations++;
      project.analysis.invalidate(a);
    });
    try {
      project.analysis.retire(b);
      project.analysis.retire(c);
      await project.analysis.analyze();
    } finally {
      unsubscribe();
    }
    expect(invalidations).to.equal(1);
    const events = project.publications.slice(firstRetirementEvent);
    for (const retired of [b, c]) {
      expect(
        events.some(
          (event) =>
            event.filePath === retired.path.absolute &&
            event.diagnostics.length === 0,
        ),
        `tombstone for ${retired.asset.name}`,
      ).to.equal(true);
      expect(project.publishedFor(retired)).to.deep.equal([]);
      expect(project.analysis.document(retired.path.absolute)).to.equal(
        undefined,
      );
      expect(retired.analysisState.status).to.equal('retired');
      expect(retired.refs).to.deep.equal([]);
    }
    expect(project.analysis.document(a.path.absolute)).to.equal(a);
    expect(a.getDiagnostics().ANALYSIS).to.deep.equal([]);
    expectValue(a, 'kept', 'Real');
  });

  it('refreshes an unedited macro declaration when the lexically winning duplicate is retired and restored', async function () {
    const sourceA = '#macro AA 1\n';
    const project = await createProject({ A: sourceA, B: '#macro AA 2\n' });
    const b = project.testCode('B');
    const content = b.content;
    const contentVersion = b.analysisState.contentVersion;
    const masked = b.syntaxText;
    const duplicates = () =>
      b
        .getDiagnostics()
        .SYNTAX_ERROR.filter((diagnostic) =>
          /duplicate macro AA/i.test(diagnostic.message),
        );
    expect(duplicates()).to.have.lengthOf(1);
    expect(b.preprocessed!.references).to.deep.equal([]);
    const initial = snapshot(project);

    await project.retireTestResource('A');
    expect(b.content).to.equal(content);
    expect(b.analysisState.contentVersion).to.equal(contentVersion);
    expect(b.syntaxText).to.equal(masked);
    expect(duplicates()).to.deep.equal([]);
    expect(
      project
        .publishedFor(b)
        .some((diagnostic) => /duplicate macro AA/i.test(diagnostic.message)),
    ).to.equal(false);
    expect(definition(b, 'AA').item.def?.file).to.equal(b);
    const coldOnlyB = await createProject(currentSources(project));
    expect(snapshot(project)).to.deep.equal(snapshot(coldOnlyB));

    // A is registered after B now; source URI ordering still selects A.
    const replacement = project.addTestCode('A', sourceA);
    await project.analysis.analyze();
    expect(b.content).to.equal(content);
    expect(b.analysisState.contentVersion).to.equal(contentVersion);
    expect(b.syntaxText).to.equal(masked);
    expect(duplicates()).to.have.lengthOf(1);
    expect(
      project
        .publishedFor(b)
        .some((diagnostic) => /duplicate macro AA/i.test(diagnostic.message)),
    ).to.equal(true);
    expect(project.self.getMember('AA')!.def?.file).to.equal(replacement);
    expect(snapshot(project)).to.deep.equal(initial);
  });

  it('waits for a newer queued resource barrier instead of completing after only the older barrier', async function () {
    function gate() {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = () => resolve();
      });
      return { promise, open };
    }
    class ObservedProject extends MemoryProject {
      onBarrierWait?: (barrier: Promise<void>) => void;
      private readonly observed = new WeakMap<Promise<void>, Promise<void>>();

      actualBarrier() {
        return super.resourcesReady;
      }

      override get resourcesReady(): Promise<void> {
        const actual = super.resourcesReady;
        let observed = this.observed.get(actual);
        if (!observed) {
          // A stable, transparent thenable view observes an actual await,
          // not just a getter read or a guessed number of promise turns.
          // The identity mapping is one-to-one with the real barriers.
          observed = new Proxy(actual, {
            get: (target, key) => {
              if (key === 'then')
                return (...args: Parameters<Promise<void>['then']>) => {
                  this.onBarrierWait?.(actual);
                  return target.then(...args);
                };
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          this.observed.set(actual, observed);
        }
        return observed;
      }
    }

    const project = new ObservedProject();
    await project.prepareBundledNative();
    const a = project.addTestCode('A', 'var value = 1;');
    await project.analysis.analyze();
    const before = counters(project);
    const generation = project.analysis.generation;
    const committed = a.analysisState;
    const b0Started = gate();
    const releaseB0 = gate();
    const b1Started = gate();
    const releaseB1 = gate();
    const waitingB0 = gate();
    const waitingB1 = gate();
    const operationB0 = project.withResourceUpdate(async () => {
      b0Started.open();
      await releaseB0.promise;
      a.content = 'var value = 2;';
    });
    await b0Started.promise;
    const barrierB0 = project.actualBarrier();
    project.onBarrierWait = (barrier) => {
      if (barrier === barrierB0) waitingB0.open();
    };
    let completed = false;
    const analyzing = project.analysis.analyze().then(() => {
      completed = true;
    });
    await waitingB0.promise;
    const operationB1 = project.withResourceUpdate(async () => {
      b1Started.open();
      await releaseB1.promise;
      a.content = 'var value = "final";';
    });
    const barrierB1 = project.actualBarrier();
    project.onBarrierWait = (barrier) => {
      if (barrier === barrierB1) waitingB1.open();
    };
    try {
      expect(barrierB1).not.to.equal(barrierB0);
      releaseB0.open();
      await b1Started.promise;
      const checkpoint = await Promise.race([
        waitingB1.promise.then(() => 'waiting-for-B1'),
        analyzing.then(() => 'completed-before-B1'),
      ]);
      expect(checkpoint).to.equal('waiting-for-B1');
      expect(project.resourcesPending).to.equal(true);
      expect(completed).to.equal(false);
      expect(project.analysis.generation).to.be.greaterThan(generation);
      expect(a.analysisState.projectVersion).to.equal(committed.projectVersion);
      expect(a.analysisState.semanticVersion).to.equal(
        committed.semanticVersion,
      );
      expect(project.analysis.isCurrent).to.equal(false);
      expect(counters(project)).to.deep.equal(before);
    } finally {
      project.onBarrierWait = undefined;
      releaseB0.open();
      releaseB1.open();
      await Promise.all([operationB0, operationB1, analyzing]);
    }
    expect(completed).to.equal(true);
    expect(project.resourcesPending).to.equal(false);
    expectValue(a, 'value', 'String');
    expect(a.analysisState.projectVersion).to.equal(
      project.analysis.generation,
    );
    expect(a.getDiagnostics().ANALYSIS).to.deep.equal([]);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const result = await settled(promise);
  expect(result.ok, 'operation must reject').to.equal(false);
  if (result.ok) throw new Error('Expected a rejected operation');
  return result.error;
}

/** Replace only this instance's property, restoring its exact original descriptor. */
function patchInstance(
  target: object,
  key: PropertyKey,
  value: unknown,
): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  };
}

async function withDiskRead<T>(
  code: Code,
  read: () => Promise<string>,
  action: () => Promise<T>,
): Promise<T> {
  const restore = patchInstance(code.path, 'read', read);
  try {
    return await action();
  } finally {
    restore();
  }
}

/** Same transparent await probe as the resource-order regression above. */
class HostBoundaryProject extends MemoryProject {
  onBarrierWait?: (barrier: Promise<void>) => void;
  private readonly observedBarriers = new WeakMap<
    Promise<void>,
    Promise<void>
  >();

  actualBarrier() {
    return super.resourcesReady;
  }

  override get resourcesReady(): Promise<void> {
    const actual = super.resourcesReady;
    let observed = this.observedBarriers.get(actual);
    if (!observed) {
      observed = new Proxy(actual, {
        get: (target, key) => {
          if (key === 'then')
            return (...args: Parameters<Promise<void>['then']>) => {
              this.onBarrierWait?.(actual);
              return target.then(...args);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      this.observedBarriers.set(actual, observed);
    }
    return observed;
  }
}

describe('ProjectAnalysis editor host and transaction boundaries', function () {
  for (const entryPoint of ['readContent', 'analyze'] as const)
    for (const text of ['var value = "unsaved";', '']) {
      it(`uses ${text ? 'unsaved' : 'empty'} documentText before a new Code's first ${entryPoint}`, async function () {
        const buffers = new Map<string, string>();
        const project = new MemoryProject('Default', (uri) => buffers.get(uri));
        await project.prepareBundledNative();
        // Deliberately do not seed Code.content: the editor owns the very first text.
        const code = project.addTestCode('Open');
        buffers.set(code.path.absolute, text);
        let diskReads = 0;
        await withDiskRead(
          code,
          async () => {
            diskReads++;
            throw new Error(
              'An open document must not read its stale disk counterpart',
            );
          },
          async () => {
            if (entryPoint === 'readContent')
              await code.readContent(undefined, true);
            await project.analysis.analyze();
            expect(code.content).to.equal(text);
            expect(code.syntaxText).to.equal(text);
            expect(diskReads).to.equal(0);
            assertAvailable(project);
            if (text) expectValue(code, 'value', 'String');
            else expect(code.refs).to.deep.equal([]);
            expect(project.publishedFor(code)).to.deep.equal([]);
            const cold = await createProject({ Open: text });
            expect(snapshot(project)).to.deep.equal(snapshot(cold));
          },
        );
      });
    }

  for (const sameText of [true, false]) {
    it(`does not let a delayed disk read overwrite ${sameText ? 'an equal-text newly opened' : 'a newer'} buffer`, async function () {
      const project = await createProject({ A: 'var value = 1;' });
      const code = project.testCode('A');
      const versionBeforeOpen = code.analysisState.contentVersion;
      const started = deferred();
      const disk = deferred<string>();
      let diskReads = 0;
      await withDiskRead(
        code,
        () => {
          diskReads++;
          started.resolve(undefined);
          return disk.promise;
        },
        async () => {
          const reading = settled(code.readContent(undefined, true));
          const ownedText = sameText ? code.content : 'var value = "owned";';
          try {
            expect(
              await Promise.race([
                started.promise.then(() => 'disk-read-started'),
                reading.then(() => 'read-finished-without-disk'),
              ]),
            ).to.equal('disk-read-started');
            await code.readContent(ownedText);
            expect(code.analysisState.contentVersion).to.equal(
              versionBeforeOpen + (sameText ? 0 : 1),
            );
            await project.analysis.analyze();
            expectValue(code, 'value', sameText ? 'Real' : 'String');
            const owned = snapshot(project);
            const state = code.analysisState;
            const generation = project.analysis.generation;
            const publications = project.publications.length;
            disk.resolve('var stale_disk_only = unresolved_disk_value;');
            expect((await reading).ok).to.equal(true);
            expect(code.content).to.equal(ownedText);
            expect(code.analysisState).to.deep.equal(state);
            expect(project.analysis.generation).to.equal(generation);
            expect(snapshot(project)).to.deep.equal(owned);
            // The buffer ownership also survives completion of the obsolete disk request.
            await code.readContent();
            await project.analysis.analyze();
            expect(diskReads).to.equal(1);
            expect(project.publications.length).to.equal(publications);
            expect(project.self.getMember('stale_disk_only')).to.equal(
              undefined,
            );
            assertAvailable(project);
          } finally {
            disk.resolve('var stale_disk_only = unresolved_disk_value;');
            await reading;
          }
        },
      );
    });
  }

  it('rechecks documentText when an editor opens the document during a disk read without a push update', async function () {
    const buffers = new Map<string, string>();
    const project = new MemoryProject('Default', (uri) => buffers.get(uri));
    await project.prepareBundledNative();
    const code = project.addTestCode('A', 'var value = 1;');
    await project.analysis.analyze();
    const started = deferred();
    const disk = deferred<string>();
    let diskReads = 0;
    await withDiskRead(
      code,
      () => {
        diskReads++;
        started.resolve(undefined);
        return disk.promise;
      },
      async () => {
        const reading = settled(code.readContent());
        try {
          expect(
            await Promise.race([
              started.promise.then(() => 'disk-read-started'),
              reading.then(() => 'read-finished-without-disk'),
            ]),
          ).to.equal('disk-read-started');
          buffers.set(code.path.absolute, 'var value = "late host buffer";');
          // No setBufferContent/readContent(text)/analyze call delivers this buffer yet.
          disk.resolve('var disk_only = 0;');
          expect((await reading).ok).to.equal(true);
          expect(code.content).to.equal(buffers.get(code.path.absolute));
          await project.analysis.analyze();
          expectValue(code, 'value', 'String');
          expect(project.self.getMember('disk_only')).to.equal(undefined);
          expect(diskReads).to.equal(1);
          assertAvailable(project);
        } finally {
          disk.resolve('var disk_only = 0;');
          await reading;
        }
      },
    );
  });

  it('does not revive a replaced Code when its older reload finishes reading disk', async function () {
    const original = 'function audit_host_owner() { return 1; }';
    const replacementText =
      'function audit_host_owner() { return "replacement"; }';
    const project = await createProject({
      A: original,
      Consumer: 'var result = audit_host_owner();',
    });
    const old = project.testCode('A');
    const consumer = project.testCode('Consumer');
    const oldReferences = old.refs;
    const started = deferred();
    const disk = deferred<string>();
    await withDiskRead(
      old,
      () => {
        started.resolve(undefined);
        return disk.promise;
      },
      async () => {
        const reloading = settled(old.reload());
        try {
          expect(
            await Promise.race([
              started.promise.then(() => 'disk-read-started'),
              reloading.then(() => 'reload-finished-without-disk'),
            ]),
          ).to.equal('disk-read-started');
          const replacement = project.addTestCode('A', replacementText);
          await project.analysis.analyze();
          expect(replacement).not.to.equal(old);
          expect(project.analysis.document(old.path.absolute)).to.equal(
            replacement,
          );
          expectValue(consumer, 'result', 'String');
          expect(old.analysisState.status).to.equal('retired');
          expect(old.refs).to.deep.equal([]);
          const current = snapshot(project);
          const generation = project.analysis.generation;
          const publications = project.publications.length;
          disk.resolve('function audit_stale_disk_owner() { return false; }');
          expect((await reloading).ok).to.equal(true);
          expect(old.content).to.equal(original);
          expect(replacement.content).to.equal(replacementText);
          expect(project.testCode('A')).to.equal(replacement);
          expect(old.asset.getGmlFile(old.path)).to.equal(replacement);
          expect(project.analysis.document(old.path.absolute)).to.equal(
            replacement,
          );
          expect(old.analysisState.status).to.equal('retired');
          expect(project.analysis.generation).to.equal(generation);
          expect(project.publications.length).to.equal(publications);
          expect(snapshot(project)).to.deep.equal(current);
          for (const reference of oldReferences) {
            expect(project.analysis.references).not.to.include(reference);
            expect(reference.item.refs.has(reference)).to.equal(false);
          }
          expect(
            project.analysis.references.some(
              (reference) => reference.start.file === old,
            ),
          ).to.equal(false);
          expect(project.self.getMember('audit_stale_disk_owner')).to.equal(
            undefined,
          );
          expect(project.types.has('Function.audit_stale_disk_owner')).to.equal(
            false,
          );
          expect(
            project.self.getMember('audit_host_owner')?.def?.file,
          ).to.equal(replacement);
          const retiredReload = await rejection(
            old.reload('var must_not_revive = 1;'),
          );
          expect(retiredReload).to.be.instanceOf(Error);
          expect((retiredReload as Error).message).to.match(/retired/i);
          expect(project.analysis.document(old.path.absolute)).to.equal(
            replacement,
          );
          expect(snapshot(project)).to.deep.equal(
            snapshot(await createProject(currentSources(project))),
          );
          assertAvailable(project);
        } finally {
          disk.resolve('function audit_stale_disk_owner() { return false; }');
          await reloading;
        }
      },
    );
  });

  it('retires an in-flight disk reload on Project.dispose without later publication or registration', async function () {
    const project = await createProject({ A: 'var value = 1;' });
    const code = project.testCode('A');
    const originalContent = code.content;
    const started = deferred();
    const disk = deferred<string>();
    let latePublishAttempts = 0;
    let lateEvents = 0;
    const publish = code.publishDiagnostics;
    const restorePublish = patchInstance(code, 'publishDiagnostics', () => {
      if (project.isDisposed) latePublishAttempts++;
      return publish.call(code);
    });
    let unsubscribe = () => {};
    try {
      await withDiskRead(
        code,
        () => {
          started.resolve(undefined);
          return disk.promise;
        },
        async () => {
          const reloading = settled(code.reload());
          try {
            expect(
              await Promise.race([
                started.promise.then(() => 'disk-read-started'),
                reloading.then(() => 'reload-finished-without-disk'),
              ]),
            ).to.equal('disk-read-started');
            project.dispose();
            const generation = project.analysis.generation;
            const afterDispose = counters(project);
            // Also observe the closed emitter after dispose removed its previous subscribers.
            unsubscribe = project.onDiagnostics(() => {
              lateEvents++;
            });
            disk.resolve('var disposed_disk_only = 2;');
            expect((await reloading).ok).to.equal(true);
            await code.readContent('var disposed_buffer_only = 3;');
            code.setBufferContent('var also_disposed = 4;');
            expect(project.isDisposed).to.equal(true);
            expect(code.content).to.equal(originalContent);
            expect(code.analysisState.status).to.equal('retired');
            expect(code.refs).to.deep.equal([]);
            expect(project.analysis.document(code.path.absolute)).to.equal(
              undefined,
            );
            expect(project.analysis.references).to.deep.equal([]);
            expect(project.analysis.isCurrent).to.equal(false);
            expect(project.analysis.generation).to.equal(generation);
            expect(counters(project)).to.deep.equal(afterDispose);
            expect(latePublishAttempts).to.equal(0);
            expect(lateEvents).to.equal(0);
            project.dispose();
            expect(project.analysis.generation).to.equal(generation);
          } finally {
            disk.resolve('var disposed_disk_only = 2;');
            await reloading;
          }
        },
      );
    } finally {
      unsubscribe();
      restorePublish();
    }
  });

  it('disposes analysis suspended on a real resource barrier without publishing after the barrier opens', async function () {
    const project = new HostBoundaryProject();
    await project.prepareBundledNative();
    const code = project.addTestCode('A', 'var value = 1;');
    await project.analysis.analyze();
    const started = deferred();
    const release = deferred();
    const waiting = deferred();
    let latePublishAttempts = 0;
    let lateEvents = 0;
    const publish = code.publishDiagnostics;
    const restorePublish = patchInstance(code, 'publishDiagnostics', () => {
      if (project.isDisposed) latePublishAttempts++;
      return publish.call(code);
    });
    const operation = settled(
      project.withResourceUpdate(async () => {
        started.resolve(undefined);
        await release.promise;
      }),
    );
    let unsubscribe = () => {};
    let analyzing: ReturnType<typeof settled<void>> | undefined;
    try {
      await started.promise;
      const barrier = project.actualBarrier();
      project.onBarrierWait = (current) => {
        if (current === barrier) waiting.resolve(undefined);
      };
      analyzing = settled(project.analysis.analyze());
      expect(
        await Promise.race([
          waiting.promise.then(() => 'analysis-waits-for-barrier'),
          analyzing.then(() => 'analysis-finished-before-barrier'),
        ]),
      ).to.equal('analysis-waits-for-barrier');
      expect(project.resourcesPending).to.equal(true);
      project.dispose();
      const generation = project.analysis.generation;
      const afterDispose = counters(project);
      unsubscribe = project.onDiagnostics(() => {
        lateEvents++;
      });
      release.resolve(undefined);
      expect((await operation).ok).to.equal(true);
      const result = await analyzing;
      expect(result.ok).to.equal(false);
      if (result.ok)
        throw new Error('Disposed pending analysis must not succeed');
      expect(result.error).to.be.instanceOf(Error);
      expect((result.error as Error).message).to.match(/disposed/i);
      expect(project.resourcesPending).to.equal(false);
      expect(project.analysis.document(code.path.absolute)).to.equal(undefined);
      expect(project.analysis.references).to.deep.equal([]);
      expect(code.analysisState.status).to.equal('retired');
      expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
      expect(project.analysis.generation).to.equal(generation);
      expect(counters(project)).to.deep.equal(afterDispose);
      expect(latePublishAttempts).to.equal(0);
      expect(lateEvents).to.equal(0);
      let newActionRan = false;
      const closed = await rejection(
        project.withResourceUpdate(async () => {
          newActionRan = true;
        }),
      );
      expect(closed).to.be.instanceOf(Error);
      expect((closed as Error).message).to.match(/disposed/i);
      expect(newActionRan).to.equal(false);
    } finally {
      project.onBarrierWait = undefined;
      release.resolve(undefined);
      await operation;
      if (analyzing) await analyzing;
      unsubscribe();
      restorePublish();
    }
  });

  it('discards a prepared syntax candidate after synchronous input invalidation and commits only its replacement', async function () {
    const initial =
      'function audit_candidate_value() { return 1; } var result = audit_candidate_value();';
    const abandoned =
      'function audit_abandoned_candidate() { return "stale"; } var transient = audit_abandoned_candidate(); §';
    const finalText =
      'function audit_candidate_value() { return "final"; } var result = audit_candidate_value();';
    const project = await createProject({ A: initial });
    const code = project.testCode('A');
    const oldState = code.analysisState;
    const oldCst = code.cst;
    const oldProcessed = code.preprocessed;
    const oldSourceMap = code.sourceMap;
    const oldReferences = code.refs;
    const oldScopes = [...code.scopes];
    const oldDiagnostics = Object.fromEntries(
      Object.entries(code.getDiagnostics()).map(([name, diagnostics]) => [
        name,
        diagnostics.map(diagnosticSummary),
      ]),
    );
    const prepared: string[] = [];
    const committed: string[] = [];
    const published: {
      text: string;
      syntax: string;
      errors: number;
      returns: string[];
    }[] = [];
    let invalidations = 0;
    const assertOldCommittedView = () => {
      expect(code.cst).to.equal(oldCst);
      expect(code.preprocessed).to.equal(oldProcessed);
      expect(code.sourceMap).to.equal(oldSourceMap);
      expect(code.syntaxText).to.equal(initial);
      expect(code.analysisState.syntaxVersion).to.equal(oldState.syntaxVersion);
      expect(code.analysisState.semanticVersion).to.equal(
        oldState.semanticVersion,
      );
      expect(code.analysisState.projectVersion).to.equal(
        oldState.projectVersion,
      );
      expect(code.refs).to.have.lengthOf(oldReferences.length);
      code.refs.forEach((reference, index) => {
        expect(reference).to.equal(oldReferences[index]);
      });
      expect(code.scopes).to.have.lengthOf(oldScopes.length);
      code.scopes.forEach((scope, index) => {
        expect(scope).to.equal(oldScopes[index]);
      });
      expect(
        Object.fromEntries(
          Object.entries(code.getDiagnostics()).map(([name, diagnostics]) => [
            name,
            diagnostics.map(diagnosticSummary),
          ]),
        ),
      ).to.deep.equal(oldDiagnostics);
      expectValue(code, 'result', 'Real');
      expect(
        kinds(callable(project, 'audit_candidate_value').returns),
      ).to.deep.equal(['Real']);
    };
    const prepare = code.prepareSyntax;
    const replace = code.replaceSyntaxView;
    const restorePrepare = patchInstance(
      code,
      'prepareSyntax',
      (...args: Parameters<Code['prepareSyntax']>) => {
        const candidate = prepare.apply(code, args);
        prepared.push(candidate.processed.text);
        assertOldCommittedView();
        if (candidate.processed.text === abandoned) {
          expect(candidate.diagnostics.length).to.be.greaterThan(0);
          expect(invalidations).to.equal(0);
          const generation = project.analysis.generation;
          code.setBufferContent(finalText);
          invalidations++;
          expect(project.analysis.generation).to.be.greaterThan(generation);
          assertOldCommittedView();
        } else {
          expect(candidate.processed.text).to.equal(finalText);
          expect(invalidations).to.equal(1);
        }
        return candidate;
      },
    );
    const restoreReplace = patchInstance(
      code,
      'replaceSyntaxView',
      (view: Parameters<Code['replaceSyntaxView']>[0]) => {
        replace.call(code, view);
        committed.push(view.processed.text);
      },
    );
    const unsubscribe = project.onDiagnostics(({ code: emitting }) => {
      if (emitting !== code) return;
      published.push({
        text: code.content,
        syntax: code.syntaxText,
        errors: code.getDiagnostics().SYNTAX_ERROR.length,
        returns: kinds(
          project.self
            .getMember('audit_candidate_value')
            ?.getTypeByKind('Function')?.returns,
        ),
      });
    });
    try {
      await code.reload(abandoned);
    } finally {
      unsubscribe();
      restoreReplace();
      restorePrepare();
    }
    expect(invalidations).to.equal(1);
    expect(prepared).to.deep.equal([abandoned, finalText]);
    expect(committed).to.deep.equal([finalText]);
    expect(published).to.deep.equal([
      { text: finalText, syntax: finalText, errors: 0, returns: ['String'] },
    ]);
    expect(code.cst).not.to.equal(oldCst);
    expect(code.content).to.equal(finalText);
    expect(code.syntaxText).to.equal(finalText);
    expect(code.analysisState.syntaxVersion).to.equal(
      oldState.syntaxVersion + 1,
    );
    expect(code.analysisState.semanticVersion).to.equal(
      oldState.semanticVersion + 1,
    );
    expect(project.self.getMember('audit_abandoned_candidate')).to.equal(
      undefined,
    );
    expect(project.types.has('Function.audit_abandoned_candidate')).to.equal(
      false,
    );
    expectValue(code, 'result', 'String');
    assertAvailable(project);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject({ A: finalText })),
    );
  });

  it('reports a failed resource barrier as ANALYSIS and recovers through a new real barrier', async function () {
    const project = await createProject({ A: 'var value = 1;' });
    const code = project.testCode('A');
    const failure = new Error('injected owned resource barrier failure');
    const failedOperation = await rejection(
      project.withResourceUpdate(async () => {
        throw failure;
      }),
    );
    expect(failedOperation).to.equal(failure);
    expect(project.resourcesPending).to.equal(false);
    expect(await rejection(project.analysis.analyze())).to.equal(failure);
    expect(project.analysis.error).to.equal(failure);
    expect(project.analysis.isCurrent).to.equal(false);
    expect(code.analysisState.status).to.equal('failed');
    expect(code.refs).to.deep.equal([]);
    const diagnostics = code.getDiagnostics().ANALYSIS;
    expect(diagnostics).to.have.lengthOf(1);
    expect(diagnostics[0].message).to.include(failure.message);
    expect(project.publishedFor(code)).to.deep.include(
      diagnosticSummary(diagnostics[0]),
    );
    const publications = project.publications.length;
    expect(await rejection(project.analysis.analyze())).to.equal(failure);
    expect(project.publications.length).to.equal(publications);

    await project.withResourceUpdate(async () => {
      code.setBufferContent('var value = "recovered";');
    });
    expect(project.resourcesPending).to.equal(false);
    expect(project.analysis.error).to.equal(undefined);
    expect(project.analysis.isCurrent).to.equal(true);
    expectValue(code, 'value', 'String');
    expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
    expect(project.publishedFor(code)).to.deep.equal([]);
    assertAvailable(project);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('publishes an explicit internal ANALYSIS failure without installing its syntax candidate and can recover', async function () {
    const project = await createProject({ A: 'var value = 1;' });
    const code = project.testCode('A');
    const oldCst = code.cst;
    const oldSyntaxVersion = code.analysisState.syntaxVersion;
    const failure = new Error('injected failure after real syntax preparation');
    const prepare = code.prepareSyntax;
    let preparations = 0;
    const restore = patchInstance(
      code,
      'prepareSyntax',
      (...args: Parameters<Code['prepareSyntax']>) => {
        prepare.apply(code, args);
        preparations++;
        throw failure;
      },
    );
    try {
      expect(
        await rejection(code.reload('var value = "uncommitted";')),
      ).to.equal(failure);
      expect(preparations).to.equal(1);
      expect(code.cst).to.equal(oldCst);
      expect(code.analysisState.syntaxVersion).to.equal(oldSyntaxVersion);
      expect(code.analysisState.status).to.equal('failed');
      expect(code.refs).to.deep.equal([]);
      expect(project.analysis.error).to.equal(failure);
      expect(project.analysis.isCurrent).to.equal(false);
      const diagnostics = code.getDiagnostics().ANALYSIS;
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0].message).to.include(failure.message);
      expect(project.publishedFor(code)).to.deep.include(
        diagnosticSummary(diagnostics[0]),
      );
    } finally {
      restore();
    }
    await code.reload('var value = "recovered";');
    expectValue(code, 'value', 'String');
    expect(project.analysis.error).to.equal(undefined);
    expect(project.analysis.isCurrent).to.equal(true);
    expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
    expect(project.publishedFor(code)).to.deep.equal([]);
    assertAvailable(project);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });
});

interface ObjectDefinitionFixture {
  readonly parent?: string;
  readonly properties?: readonly {
    name: string;
    varType: YyObjectPropertyVarType;
    multiselect?: boolean;
  }[];
  readonly create: string;
}
class MemoryObject extends Asset<'objects'> {
  constructor(
    project: MemoryProject,
    name: string,
    input: ObjectDefinitionFixture,
  ) {
    const resource = {
      id: { name, path: `objects/${name}/${name}.yy` },
    } as YypResource;
    super(project, resource, project.dir.join(resource.id.path));
    this.yy = yyObjectSchema.parse({
      name,
      parentObjectId: input.parent
        ? {
            name: input.parent,
            path: `objects/${input.parent}/${input.parent}.yy`,
          }
        : null,
      properties: (input.properties || []).map((property) => ({
        ...property,
        value: 'not statically evaluated',
        rangeMin: 0,
        rangeMax: 10,
      })),
      eventList: [{ eventType: 0, eventNum: 0 }],
    });
  }
}
async function objectDefinitionsProject(
  inputs: Record<string, ObjectDefinitionFixture>,
): Promise<MemoryProject> {
  const project = new MemoryProject();
  await project.prepareBundledNative();
  for (const [name, input] of Object.entries(inputs)) {
    const asset = new MemoryObject(project, name, input);
    project.assets.set(name.toLowerCase(), asset);
    project.yyp.resources.push(asset.resource);
    const code = new Code(asset, asset.dir.join('Create_0.gml'));
    asset.gmlFiles.set(code.path.absolute.toLowerCase(), code);
    project.testCodes.set(name, code);
    code.content = input.create;
  }
  for (const asset of project.assets.values()) asset.refreshParent();
  await project.analysis.analyze();
  assertAvailable(project);
  return project;
}

describe('Object Variable Definitions in the project analysis view', function () {
  it('inherits editor fields before an overriding Create without inheriting parent Create writes or locking later flow types', async function () {
    const inputs = {
      Parent: {
        properties: [
          { name: 'initial_speed', varType: YyObjectPropertyVarType.Real },
          { name: 'initial_label', varType: YyObjectPropertyVarType.String },
          { name: 'enabled_hint', varType: YyObjectPropertyVarType.Boolean },
          { name: 'count_hint', varType: YyObjectPropertyVarType.Integer },
          { name: 'colour_hint', varType: YyObjectPropertyVarType.Colour },
          {
            name: 'expression_hint',
            varType: YyObjectPropertyVarType.Expression,
          },
          { name: 'asset_hint', varType: YyObjectPropertyVarType.Asset },
          { name: 'choice_hint', varType: YyObjectPropertyVarType.List },
          {
            name: 'choices_hint',
            varType: YyObjectPropertyVarType.List,
            multiselect: true,
          },
        ],
        create: 'from_parent_create = 1;',
      },
      Child: {
        parent: 'Parent',
        create:
          'var before = initial_speed; initial_speed = "changed"; var after = initial_speed; var label = initial_label; var enabled = enabled_hint; var count = count_hint; var colour = colour_hint; var expression = expression_hint; var asset = asset_hint; var choice = choice_hint; var choices = choices_hint; var absent = from_parent_create;',
      },
    };
    const project = await objectDefinitionsProject(inputs);
    try {
      const code = project.testCode('Child');
      expectValue(code, 'before', 'Real');
      expectValue(code, 'after', 'String');
      expectValue(code, 'label', 'String');
      expectValue(code, 'enabled', 'Bool');
      expectValue(code, 'count', 'Real');
      expectValue(code, 'colour', 'Real');
      for (const name of ['expression', 'asset', 'choice'])
        expectValue(code, name, 'Unknown');
      expectValue(code, 'choices', 'Array');
      expect(
        kinds(definition(code, 'choices').item.getTypeByKind('Array')?.items),
      ).to.deep.equal(['Unknown']);
      expect(missing(code, 'initial_speed')).to.deep.equal([]);
      expect(missing(code, 'from_parent_create')).not.to.have.length(0);
      const references = code.refs.filter(
        (ref) => ref.item.name === 'initial_speed',
      );
      expect(references).to.have.length(3);
      const symbol = references[0].item;
      expect(symbol.native).to.equal(undefined);
      expect(symbol.resourceDefinition?.uri).to.equal(
        project.getAssetByName('Parent')!.yyPath.absolute,
      );
      expect(symbol.def?.file).to.equal(undefined);
      expect(symbol.isRenameable).to.equal(false);
      expect(
        references.every((ref) => !ref.isDef && !ref.isRenameable),
      ).to.equal(true);
      expect(() =>
        planReferenceRename(
          symbol.refs,
          'renamed_speed',
          project.analysis.references,
        ),
      ).to.throw();
      expect(code.content).to.equal(inputs.Child.create);
    } finally {
      project.dispose();
    }
  });

  it('retires YY ownership after definition removal while retaining an ordinary GML field and cold-equivalent renameability', async function () {
    const initial = {
      Parent: {
        properties: [
          { name: 'editable_field', varType: YyObjectPropertyVarType.Real },
        ],
        create: '',
      },
      Child: {
        parent: 'Parent',
        create: 'editable_field = "changed"; var result = editable_field;',
      },
    };
    const project = await objectDefinitionsProject(initial);
    let cold: MemoryProject | undefined;
    try {
      const code = project.testCode('Child');
      const field = () =>
        code.refs.find((ref) => ref.item.name === 'editable_field')!.item;
      expect(field().resourceDefinition).not.to.equal(undefined);
      expect(field().isRenameable).to.equal(false);
      const parent = project.getAssetByName('Parent')!;
      await project.withResourceUpdate(async () => {
        (parent.yy as YyObject).properties = [];
      });
      expectValue(code, 'result', 'String');
      expect(field().resourceDefinition).to.equal(undefined);
      expect(field().isRenameable).to.equal(true);
      expect(field().def?.file).to.equal(code);
      const plan = planReferenceRename(
        field().refs,
        'renamed_field',
        project.analysis.references,
      );
      expect(
        plan.map((edit) =>
          edit.range.file.content.slice(
            edit.range.start.offset,
            edit.range.end.offset + 1,
          ),
        ),
      ).to.deep.equal(['editable_field', 'editable_field']);
      cold = await objectDefinitionsProject({
        ...initial,
        Parent: { ...initial.Parent, properties: [] },
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('updates inherited YY provenance on a parent switch and withdraws fields with no surviving code definition', async function () {
    const shared = {
      name: 'shared_field',
      varType: YyObjectPropertyVarType.Real,
    };
    const inputs = {
      ParentA: {
        properties: [
          shared,
          { name: 'only_a', varType: YyObjectPropertyVarType.String },
        ],
        create: '',
      },
      ParentB: { properties: [shared], create: '' },
      Child: {
        parent: 'ParentA',
        create: 'var shared = shared_field; var obsolete = only_a;',
      },
    };
    const project = await objectDefinitionsProject(inputs);
    let cold: MemoryProject | undefined;
    try {
      const code = project.testCode('Child');
      const reference = (name: string) =>
        code.refs.find((ref) => ref.item.name === name)!;
      expect(reference('shared_field').item.resourceDefinition?.uri).to.equal(
        project.getAssetByName('ParentA')!.yyPath.absolute,
      );
      expectValue(code, 'obsolete', 'String');
      const child = project.getAssetByName('Child')!;
      await project.withResourceUpdate(async () => {
        (child.yy as YyObject).parentObjectId = {
          name: 'ParentB',
          path: 'objects/ParentB/ParentB.yy',
        };
        child.refreshParent();
      });
      expectValue(code, 'shared', 'Real');
      expect(reference('shared_field').item.resourceDefinition?.uri).to.equal(
        project.getAssetByName('ParentB')!.yyPath.absolute,
      );
      expect(reference('shared_field').item.isRenameable).to.equal(false);
      expect(reference('only_a').item.resourceDefinition).to.equal(undefined);
      expect(reference('only_a').item.def).to.equal(undefined);
      expect(missing(code, 'only_a')).not.to.have.length(0);
      cold = await objectDefinitionsProject({
        ...inputs,
        Child: { ...inputs.Child, parent: 'ParentB' },
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });
});
