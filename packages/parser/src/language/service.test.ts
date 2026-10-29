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
import { ContributionGraph, ContributionIndex } from './contributions.js';
import { globalOwner, type UnitEvaluation } from '../analysis/model.js';
import { value } from '../analysis/values.js';

let fixtureId = 0;
type Sources = Readonly<Record<string, string>>;
interface FixtureOptions {
  readonly resourceOrder?: readonly string[];
  readonly fileOrder?: readonly string[];
  readonly configuration?: string;
  readonly legacyOtherBehaviour?: boolean;
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
      new Type('Struct').named('global'),
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
  if (options.legacyOtherBehaviour !== undefined)
    Object.defineProperty(project, 'legacyOtherBehaviour', {
      value: options.legacyOtherBehaviour,
    });
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
          type.listMembers(true).map((member) => ({
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
  it('evaluates a reverse-registered cold provider chain once per unit and preserves warm edits', async function () {
    const project = await createProject(chain, {
      fileOrder: ['A', 'B', 'C', 'D'],
    });
    const fresh: MemoryProject[] = [];
    try {
      expectChain(project, 'Real');
      // A real dependency chain needs no declaration-only retry when its providers
      // are evaluated first. Count work, not wall time or an internal rank table.
      expect(project.analysis.metrics.evaluated).to.equal(4);
      fresh.push(
        await createProject(chain, { fileOrder: ['D', 'C', 'B', 'A'] }),
      );
      expect(snapshot(project)).to.deep.equal(snapshot(fresh[0]));
      await project
        .testCode('D')
        .reload('function audit_chain_d() { return "text"; }');
      expectChain(project, 'String');
      fresh.push(await createProject(currentSources(project)));
      expect(snapshot(project)).to.deep.equal(snapshot(fresh[1]));
    } finally {
      for (const cold of fresh) cold.dispose();
      project.dispose();
    }
  });

  for (const [name, initializer, seed, changedSeed, initialKind] of [
    [
      'member',
      'global.seed.state',
      'global.seed={state:1};',
      'global.seed={state:"text"};',
      'Real',
    ],
    [
      'allocation',
      'provide()',
      'function provide(){return {field:1};}',
      'function provide(){return "text";}',
      'Struct',
    ],
  ]) {
    it(`retracts caller-owned static values after a ${name} initializer provider changes`, async function () {
      const sources = {
        Caller: 'var result=cached();',
        Other: 'var second=cached();',
        Cache: `function cached(){static cache=${initializer};var caller=other;return cache;}`,
        Seed: seed,
      };
      const project = await createProject(sources, {
        legacyOtherBehaviour: false,
      });
      const fresh: MemoryProject[] = [];
      try {
        expectValue(project.testCode('Caller'), 'result', initialKind);
        expectValue(project.testCode('Other'), 'second', initialKind);
        await project.testCode('Seed').reload(changedSeed);
        // Two independent callers must not re-export each other's retired cache
        // values as writes. The source now initializes only a String.
        expectValue(project.testCode('Caller'), 'result', 'String');
        expectValue(project.testCode('Other'), 'second', 'String');
        expect(
          kinds(callable(project, 'cached').statics!.getMember('cache')!.type),
        ).to.deep.equal(['String']);
        fresh.push(
          await createProject(currentSources(project), {
            legacyOtherBehaviour: false,
          }),
        );
        expect(snapshot(project)).to.deep.equal(snapshot(fresh[0]));
      } finally {
        for (const cold of fresh) cold.dispose();
        project.dispose();
      }
    });
  }

  it('keeps nested initialized-static writes separate from retained flow values', async function () {
    const sources = {
      Caller: 'var result=wrapped();',
      Other: 'var second=cached(false);',
      Cache: `function cached(flag){static cache=global.seed.state;var caller=other;
        if(flag)cache="written";return cache;}
        function wrapped(){var caller=other;cached(false);return cached(true);}`,
      Seed: 'global.seed={state:1};',
    };
    const project = await createProject(sources, {
      legacyOtherBehaviour: false,
    });
    const fresh: MemoryProject[] = [];
    try {
      expectValue(project.testCode('Caller'), 'result', 'String');
      await project.testCode('Seed').reload('global.seed={state:true};');
      expectValue(project.testCode('Caller'), 'result', 'String');
      const retained = callable(project, 'cached').statics!.getMember(
        'cache',
      )!.type;
      expect(kinds(retained)).to.deep.equal(['Bool', 'String']);
      const second = definition(project.testCode('Other'), 'second').item.type;
      expect(kinds(second)).to.deep.equal(['Bool', 'String']);
      fresh.push(
        await createProject(currentSources(project), {
          legacyOtherBehaviour: false,
        }),
      );
      expect(snapshot(project)).to.deep.equal(snapshot(fresh[0]));
    } finally {
      for (const cold of fresh) cold.dispose();
      project.dispose();
    }
  });

  for (const contextual of [false, true]) {
    it(`retracts obsolete shared-container item writes through ${contextual ? 'contextual wrappers' : 'direct statements'}`, async function () {
      const write = (name: string, body: string) =>
        contextual
          ? `function ${name}(){var caller=other;${body}} ${name}();`
          : body;
      const sources = {
        State: 'global.data=ds_map_create();',
        Alpha: write('write_a', 'global.data[?"a"]=supply();'),
        Beta: write('write_b', 'global.data[?"b"]=true;'),
        Source: 'function supply(){return 1;}',
        Read: 'var result=global.data[?"a"];',
      };
      const project = await createProject(sources, {
        legacyOtherBehaviour: false,
      });
      let cold: MemoryProject | undefined;
      try {
        expect(
          kinds(definition(project.testCode('Read'), 'result').item.type),
        ).to.deep.equal(['Bool', 'Real']);
        await project
          .testCode('Source')
          .reload('function supply(){return "new";}');
        cold = await createProject(currentSources(project), {
          legacyOtherBehaviour: false,
        });
        // This map abstraction merges both keys' current writes. The Bool is
        // still valid, while neither writer may re-export the retired Real.
        expect(
          kinds(definition(cold.testCode('Read'), 'result').item.type),
        ).to.deep.equal(['Bool', 'String']);
        expect(
          kinds(definition(project.testCode('Read'), 'result').item.type),
        ).to.deep.equal(['Bool', 'String']);
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold?.dispose();
        project.dispose();
      }
    });
  }

  for (const access of ['items', 'members'] as const) {
    it(`retracts superseded provider values from cyclic ${access} read-back writes`, async function () {
      const sources = {
        State:
          access === 'items'
            ? 'global.data=ds_map_create();'
            : 'global.data={};',
        Alpha:
          access === 'items'
            ? 'global.data[?"source"]=supply();var saved=global.data[?"feedback"];global.data[?"copy"]=saved;'
            : 'global.data.copy=supply();global.data.copy=global.data.feedback;',
        Beta:
          access === 'items'
            ? 'var saved=global.data[?"source"];global.data[?"feedback"]=saved;'
            : 'global.data.feedback=global.data.copy;',
        Source: 'function supply(){return 1;}',
        Read:
          access === 'items'
            ? 'var result=global.data[?"source"];'
            : 'var result=global.data.copy;',
      };
      const project = await createProject(sources, {
        legacyOtherBehaviour: false,
      });
      let cold: MemoryProject | undefined;
      try {
        const observed = () =>
          kinds(definition(project.testCode('Read'), 'result').item.type);
        expect(observed()).to.include('Real');
        await project
          .testCode('Source')
          .reload('function supply(){return "new";}');
        cold = await createProject(currentSources(project), {
          legacyOtherBehaviour: false,
        });
        const expected = kinds(
          definition(cold.testCode('Read'), 'result').item.type,
        );
        expect(expected).to.include('String');
        expect(expected).not.to.include('Real');
        // Rewriting values read from the shared map must not keep a removed
        // provider fact alive solely through the two consumers' feedback cycle.
        expect(observed()).to.deep.equal(expected);
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold?.dispose();
        project.dispose();
      }
    });
  }

  it('retracts superseded return values through mutually recursive providers', async function () {
    const sources = {
      Alpha: 'function CycleA(flag){if(flag)return 1;return CycleB();}',
      Beta: 'function CycleB(){return CycleA(true);}',
      Read: 'var result=CycleA(true);',
    };
    const project = await createProject(sources, {
      legacyOtherBehaviour: false,
    });
    let cold: MemoryProject | undefined;
    try {
      expectValue(project.testCode('Read'), 'result', 'Real');
      await project
        .testCode('Alpha')
        .reload('function CycleA(flag){if(flag)return "new";return CycleB();}');
      cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      expectValue(cold.testCode('Read'), 'result', 'String');
      expectValue(project.testCode('Read'), 'result', 'String');
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('keeps cached allocation aliases independent of container feedback startup order', async function () {
    const sources = {
      State:
        'function init(){static state=undefined;if(state!=undefined)return state;state={};state.map=ds_map_create();state.sprites=ds_map_create();state.grid=ds_grid_create(2,2);sprite(0);return state;}',
      Material:
        'function Mat(key) constructor {field=key;static duplicate=function(key){if(field==key)return self;return getmat(key);};}',
      Factory:
        'function getmat(key){static map=init().map;var material=map[?key];if(material==undefined){material=new Mat(key);map[?key]=material;}return material;}',
      Sprite:
        'function sprite(key){static cache=init().sprites;var material=cache[?key];if(material==undefined){material=getmat(key);cache[?key]=material;}return material;}',
      Writer:
        'function fill(){static grid=init().grid;grid[#0,0]=surface();var saved=grid[#0,1];grid[#0,2]=saved;}function surface(){return getmat(0);}',
      Reader:
        'function read(){static grid=init().grid;var item=grid[#0,0];grid[#0,1]=item;return item;}var result=read();',
    };
    const observed = (project: MemoryProject) =>
      sorted(
        definition(project.testCode('Reader'), 'result').item.type.type.map(
          (type) => ({
            kind: type.kind,
            name: type.name,
            key: type.semanticKey?.replaceAll(
              project.dir.absolute,
              '<project>',
            ),
          }),
        ),
      );
    let expected: ReturnType<typeof observed> | undefined;
    for (const fileOrder of [
      Object.keys(sources),
      Object.keys(sources).reverse(),
    ]) {
      const project = await createProject(sources, {
        fileOrder,
        legacyOtherBehaviour: false,
      });
      try {
        const before = observed(project);
        expected ??= before;
        // Equal visible names can conceal distinct mutable aliases. Compare the
        // public storage identities, normalized only for each fixture's root.
        expect(before).to.deep.equal(expected);
        const view = snapshot(project);
        for (const name of ['Writer', 'Reader'])
          project.analysis.invalidate(project.testCode(name));
        await project.analysis.analyze();
        expect(observed(project)).to.deep.equal(before);
        expect(snapshot(project)).to.deep.equal(view);
        assertAvailable(project);
      } finally {
        project.dispose();
      }
    }
  });

  it('preserves independent unknown and boolean seeds while retracting and retiring cyclic inputs', async function () {
    const sources = {
      State: 'global.data=ds_map_create();',
      Alpha:
        'global.data[?"source"]=supply();var saved=global.data[?"feedback"];global.data[?"copy"]=saved;',
      Beta: 'var saved=global.data[?"source"];global.data[?"feedback"]=saved;',
      Source: 'function supply(){return 1;}',
      Extra:
        'function opaque(input){return input;}global.data[?"unknown"]=opaque();global.data[?"boolean"]=false;',
      Read: 'var result=global.data[?"source"];',
    };
    const project = await createProject(sources, {
      legacyOtherBehaviour: false,
    });
    try {
      await project
        .testCode('Source')
        .reload('function supply(){return "new";}');
      const observed = () =>
        kinds(definition(project.testCode('Read'), 'result').item.type);
      expect(observed()).to.include.members(['Any', 'Bool', 'String']);
      expect(observed()).not.to.include('Real');
      await project.retireTestResource('Extra');
      expect(observed()).to.deep.equal(['String']);
      const cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      try {
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold.dispose();
      }
    } finally {
      project.dispose();
    }
  });

  it('discovers and removes feedback edges across distinct containers', async function () {
    const writeOnly = 'global.first[?"source"]=supply();';
    const readBack = `${writeOnly}var saved=global.second[?"feedback"];global.first[?"copy"]=saved;`;
    const project = await createProject(
      {
        State: 'global.first=ds_map_create();global.second=ds_map_create();',
        Alpha: writeOnly,
        Beta: 'var saved=global.first[?"source"];global.second[?"feedback"]=saved;',
        Source: 'function supply(){return 1;}',
        Read: 'var result=global.second[?"feedback"];',
      },
      { legacyOtherBehaviour: false },
    );
    try {
      await project.testCode('Alpha').reload(readBack);
      await project
        .testCode('Source')
        .reload('function supply(){return "new";}');
      expectValue(project.testCode('Read'), 'result', 'String');
      await project.testCode('Alpha').reload(writeOnly);
      await project
        .testCode('Source')
        .reload('function supply(){return false;}');
      expectValue(project.testCode('Read'), 'result', 'Bool');
      const cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      try {
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold.dispose();
      }
    } finally {
      project.dispose();
    }
  });

  // GML methods bind instance/struct self; an outer function's var locals do
  // not become lexical captures. Exercise a returned method with explicit self.
  // https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Overview/Method_Variables.htm
  for (const mode of ['rebound fields', 'returned bound method'] as const) {
    it(`retracts cyclic values propagated through ${mode}`, async function () {
      const project = await createProject(
        {
          State: 'global.data={};',
          Source: 'function supply(){return 1;}',
          Factory:
            mode === 'rebound fields'
              ? 'function apply(){self.copy=supply();self.copy=self.feedback;}'
              : 'function build(){return function(flag){if(flag)return supply();return self.feedback;};}',
          Alpha:
            mode === 'rebound fields'
              ? 'method(global.data,apply)();'
              : 'function write_result(flag){global.data.copy=method(global.data,build())(flag);}',
          Beta: 'global.data.feedback=global.data.copy;',
          Read: 'var result=global.data.copy;',
        },
        { legacyOtherBehaviour: false },
      );
      try {
        expect(
          kinds(definition(project.testCode('Read'), 'result').item.type),
        ).to.include('Real');
        await project
          .testCode('Source')
          .reload('function supply(){return "new";}');
        const cold = await createProject(currentSources(project), {
          legacyOtherBehaviour: false,
        });
        try {
          const expected = kinds(
            definition(cold.testCode('Read'), 'result').item.type,
          );
          expect(expected).to.include('String').and.not.include('Real');
          expect(
            kinds(definition(project.testCode('Read'), 'result').item.type),
          ).to.deep.equal(expected);
          expect(snapshot(project)).to.deep.equal(snapshot(cold));
        } finally {
          cold.dispose();
        }
      } finally {
        project.dispose();
      }
    });
  }

  for (const fileOrder of [
    ['Provider', 'Writer', 'Consumer'],
    ['Provider', 'Consumer', 'Writer'],
    ['Consumer', 'Provider', 'Writer'],
    ['Writer', 'Provider', 'Consumer'],
    ['Consumer', 'Writer', 'Provider'],
    ['Writer', 'Consumer', 'Provider'],
  ]) {
    it(`refreshes exported container aliases in ${fileOrder.join(' -> ')} order`, async function () {
      const sources = {
        Provider:
          'function make_pool(){static state={pool:ds_map_create()};return state;}',
        Writer:
          'function fill_pool(input){static pool=make_pool().pool;pool[?"key"]=input;}',
        Consumer:
          'function use_pool(){static pool=make_pool().pool;return ds_map_exists(pool,"key");}var result=use_pool();',
      };
      const project = await createProject(sources, { fileOrder });
      const consumer = project.testCode('Consumer');
      const assertPool = (expected: string) => {
        const service = project.analysis as unknown as {
          units: ReadonlyMap<string, { evaluation: UnitEvaluation }>;
        };
        const exported = service.units.get(consumer.path.absolute)!.evaluation;
        const symbol = exported.symbols.get(
          'function:global:use_pool:statics/member:pool',
        )!;
        expect(
          symbol.item.type.toFeatherString(),
          fileOrder.join(' -> '),
        ).to.equal(expected);
        expect(
          callable(project, 'use_pool')
            .statics!.getMember('pool')!
            .type.toFeatherString(),
        ).to.equal(expected);
        expectValue(consumer, 'result', 'Bool');
        expect(missing(consumer, 'make_pool')).to.deep.equal([]);
        expect(
          consumer.refs.find((ref) => ref.item.name === 'make_pool')?.item.def
            ?.file?.asset.name,
        ).to.equal('Provider');
      };
      assertPool('Id.DsMap<Any>');
      await project
        .testCode('Writer')
        .reload(
          'function fill_pool(){static pool=make_pool().pool;pool[?"key"]="text";}',
        );
      assertPool('Id.DsMap<String>');
      expect(snapshot(project)).to.deep.equal(
        snapshot(await createProject(currentSources(project))),
      );
      await project.testCode('Writer').reload('');
      assertPool('Id.DsMap');
      expect(snapshot(project)).to.deep.equal(
        snapshot(await createProject(currentSources(project))),
      );
    });
  }

  it('separates explicit global storage from native bare reads, writes, completion and rename', async function () {
    const source =
      'global.fps="user value";var explicit=global.fps;var builtin=fps;fps=30;';
    const project = await createProject({ Scope: source });
    const code = project.testCode('Scope');
    expectValue(code, 'explicit', 'String');
    expectValue(code, 'builtin', 'Real');
    const errors = code.getDiagnostics().INVALID_OPERATION;
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.include('read-only');
    expect(errors[0].location.start.offset).to.equal(source.lastIndexOf('fps'));
    const refs = code.refs.filter((ref) => ref.item.name === 'fps');
    expect(refs).to.have.length(4);
    const user = refs[0].item;
    const builtin = refs[2].item;
    expect(user).not.to.equal(builtin);
    expect(user.native).to.equal(undefined);
    expect(user.isRenameable).to.equal(true);
    expect(builtin.native).to.equal('Base');
    expect(builtin.isRenameable).to.equal(false);
    expect(refs[1].item).to.equal(user);
    expect(refs[3].item).to.equal(builtin);
    expect(user.def?.file).to.equal(code);
    expect(project.analysis.globalStorage.getMember('fps')).to.equal(user);
    expect(project.self.getMember('fps')).to.equal(builtin);
    expect([...user.refs]).to.have.length(2);
    expect(planReferenceRename(user.refs, 'user_fps')).to.have.length(2);
    const dot = code.getCompletionCandidatesAt(
      source.indexOf('global.fps') + 'global.'.length,
    );
    expect(dot.find((item) => item.name === 'fps')?.symbols).to.deep.equal([
      user,
    ]);
    const bare = code.getCompletionCandidatesAt(
      source.indexOf('builtin=fps') + 'builtin='.length,
    );
    expect(bare.find((item) => item.name === 'fps')?.symbols).to.deep.equal([
      builtin,
    ]);
  });

  it('keeps user/native global identities stable across edits, removal and cold load order', async function () {
    const sources = {
      Storage: 'global.fps="user";globalvar ordinary;ordinary=7;',
      Reader:
        'var stored=global.fps;var native_value=fps;var aliased=global.ordinary;var bare_alias=ordinary;',
    };
    const project = await createProject(sources);
    const reader = project.testCode('Reader');
    expectValue(reader, 'stored', 'String');
    expectValue(reader, 'native_value', 'Real');
    expect(kinds(definition(reader, 'aliased').item.type)).to.deep.equal([
      'Real',
      'Undefined',
    ]);
    expect(kinds(definition(reader, 'bare_alias').item.type)).to.deep.equal([
      'Real',
      'Undefined',
    ]);
    expect(
      reader.refs
        .filter((ref) => ref.item.name === 'ordinary')
        .map((ref) => ref.item),
    ).to.deep.equal([
      project.self.getMember('ordinary'),
      project.self.getMember('ordinary'),
    ]);
    const native = reader.refs.find(
      (ref) => ref.text === 'fps' && ref.item.native,
    )!.item;
    const reversed = await createProject(sources, {
      fileOrder: ['Reader', 'Storage'],
      resourceOrder: ['Reader', 'Storage'],
    });
    expect(snapshot(reversed)).to.deep.equal(snapshot(project));
    await project
      .testCode('Storage')
      .parse('global.fps=true;globalvar ordinary;ordinary=7;');
    await project.analysis.analyze();
    expectValue(reader, 'stored', 'Bool');
    expect(
      reader.refs.find((ref) => ref.item.native && ref.text === 'fps')!.item,
    ).to.equal(native);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
    await project.testCode('Storage').parse('globalvar ordinary;ordinary=7;');
    await project.analysis.analyze();
    expect(missing(reader, 'fps')).to.have.length(1);
    expectValue(reader, 'native_value', 'Real');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
    await project.testCode('Storage').parse(sources.Storage);
    await project.analysis.analyze();
    expect(snapshot(project)).to.deep.equal(snapshot(reversed));
  });

  it('permits native-named top-level functions while binding bare calls to the native function', async function () {
    const sources = {
      Declaration:
        'function string_split(_text,_separator){return ds_list_create();}',
      Use: 'var builtin=string_split("a",";");var native_fn=string_split;var indirect=native_fn("a",";");var custom=global.string_split("a",";");',
    };
    const project = await createProject(sources);
    const declaration = definition(
      project.testCode('Declaration'),
      'string_split',
    );
    const code = project.testCode('Use');
    const refs = code.refs.filter((ref) => ref.text === 'string_split');
    expect(refs).to.have.length(3);
    expect(refs[0].item.native).to.equal('Base');
    expect(refs[1].item).to.equal(refs[0].item);
    expect(refs[2].item).to.equal(declaration.item);
    expect(declaration.item.native).to.equal(undefined);
    expect(declaration.item.isRenameable).to.equal(true);
    expectValue(code, 'builtin', 'Array');
    expectValue(code, 'custom', 'Id.DsList');
    expectValue(code, 'indirect', 'Array');
    for (const file of project.testCodes.values())
      expect(file.getDiagnostics().INVALID_OPERATION).to.deep.equal([]);
    expect(
      [...declaration.item.refs].filter((ref) => !ref.isDef),
    ).to.deep.equal([refs[2]]);
    expect(snapshot(project)).to.deep.equal(
      snapshot(
        await createProject(sources, { fileOrder: ['Use', 'Declaration'] }),
      ),
    );
    await project
      .testCode('Declaration')
      .parse('function string_split(_text,_separator){return "changed";}');
    await project.analysis.analyze();
    expectValue(code, 'builtin', 'Array');
    expectValue(code, 'custom', 'String');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
    await project
      .testCode('Declaration')
      .parse('function user_split(_text,_separator){return "changed";}');
    await project.analysis.analyze();
    expect(missing(code, 'string_split')).to.have.length(1);
    expectValue(code, 'builtin', 'Array');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('accepts globalvar native aliases without treating the declaration as an assignment', async function () {
    const project = await createProject({
      Alias:
        'globalvar os_type;var current=os_type;global.os_type="user";os_type=1;',
    });
    const code = project.testCode('Alias');
    expectValue(code, 'current', 'Real');
    const errors = code.getDiagnostics().INVALID_OPERATION;
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.include('read-only');
    expect(errors[0].location.start.offset).to.equal(
      code.content.lastIndexOf('os_type'),
    );
    const native = code.refs.filter(
      (ref) => ref.item.name === 'os_type' && ref.item.native,
    );
    expect(native).to.have.length(3);
    expect(native.every((ref) => !ref.isDef)).to.equal(true);
    await code.parse('globalvar os_type;var current=os_type;');
    await project.analysis.analyze();
    expect(code.getDiagnostics().INVALID_OPERATION).to.deep.equal([]);
  });

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

  it('owns implicit field write sites independently of evaluation order and borrowed definitions', async function () {
    const sources: Sources = {
      State:
        'function shared_state(){initialize_state();static state={};return state;}',
      Alpha:
        'function initialize_state(){with(shared_state()){enabled=false;}}',
      Beta: 'function update_state(next){shared_state().enabled=next;}',
      Read: 'function read_state(){return shared_state().enabled;}',
    };
    const project = await createProject(sources, {
      fileOrder: ['State', 'Alpha', 'Beta', 'Read'],
    });
    const reversed = await createProject(sources, {
      fileOrder: ['State', 'Beta', 'Alpha', 'Read'],
    });
    expect(snapshot(project)).to.deep.equal(snapshot(reversed));
    const field = () =>
      project.testCode('Read').refs.find((ref) => ref.item.name === 'enabled')!
        .item;
    expect(field().def?.file?.asset.name).to.equal('Alpha');
    expect(
      project
        .testCode('Alpha')
        .refs.some((ref) => ref.item.name === 'enabled' && ref.isDef),
    ).to.equal(true);
    await project.testCode('Alpha').reload('function initialize_state(){}');
    expect(field().def?.file?.asset.name).to.equal('Beta');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
    await project.testCode('Alpha').reload(sources.Alpha);
    expect(snapshot(project)).to.deep.equal(snapshot(reversed));
  });

  it('converges when acyclic input progress makes a consumer output reappear', async function () {
    const sources: Sources = {
      A: 'function revisit_a() { return revisit_b() ?? 1; }',
      B: 'function revisit_b() { return (revisit_c() ?? { value: "fallback" }).value; }',
      C: 'function revisit_c() { return { value: undefined }; }',
    };
    // A first sees B's pending return (Real), then B's fallback (String),
    // then C's resolved object makes B return Undefined and A return Real.
    // The dependency graph is a DAG; repeating A's output is normal progress.
    const project = await createProject(sources, {
      fileOrder: ['A', 'B', 'C'],
    });
    expect(kinds(callable(project, 'revisit_a').returns)).to.deep.equal([
      'Real',
    ]);
    expect(kinds(callable(project, 'revisit_b').returns)).to.deep.equal([
      'Undefined',
    ]);
    const cold = await createProject(sources, { fileOrder: ['C', 'B', 'A'] });
    expect(snapshot(project)).to.deep.equal(snapshot(cold));
    await project
      .testCode('C')
      .reload('function revisit_c() { return { value: "changed" }; }');
    expect(kinds(callable(project, 'revisit_a').returns)).to.deep.equal([
      'String',
    ]);
    await project.testCode('C').reload(sources.C);
    expect(kinds(callable(project, 'revisit_a').returns)).to.deep.equal([
      'Real',
    ]);
    expect(snapshot(project)).to.deep.equal(snapshot(cold));
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

  it('completes all with receivers with lexical precedence and partial coverage', async function () {
    for (const alternatives of ['first:second', 'second:first']) {
      const source = `function VisibleGlobal(){} function Probe(flag){
        var shadowed="local";var first={shared:1,onlyFirst:true,shadowed:1};
        var second={shared:"text",onlySecond:1,shadowed:false};
        with(flag?${alternatives}){var inspected=shared;}return 0;}`;
      const project = await createProject({ WithUnion: source });
      const code = project.testCode('WithUnion');
      const cursor = source.indexOf('var inspected');
      const candidates = new Map(
        code
          .getCompletionCandidatesAt(cursor)
          .map((candidate) => [candidate.name, candidate]),
      );
      expect(kinds(candidates.get('shared')!.type)).to.deep.equal([
        'Real',
        'String',
      ]);
      expect(candidates.get('shared')!.symbols).to.have.length(2);
      expect(candidates.get('shared')!.availability).to.deep.equal({
        present: 2,
        total: 2,
      });
      for (const name of ['onlyFirst', 'onlySecond'])
        expect(candidates.get(name)!.availability, name).to.deep.equal({
          present: 1,
          total: 2,
        });
      expect(kinds(candidates.get('shadowed')!.type)).to.deep.equal(['String']);
      expect(
        candidates.get('shadowed')!.symbols.every((symbol) => symbol.local),
      ).to.equal(true);
      expect(candidates.get('shadowed')!.availability).to.deep.equal({
        present: 2,
        total: 2,
      });
      expect(candidates.get('VisibleGlobal')!.availability).to.deep.equal({
        present: 2,
        total: 2,
      });
      expect(
        code
          .getInScopeSymbolsAt(cursor)
          .filter((symbol) => symbol.name === 'shared'),
      ).to.have.length(2);
      expect(
        code
          .getCompletionCandidatesAt(source.indexOf('return 0'))
          .map((candidate) => candidate.name),
      ).not.to.include('onlyFirst');
    }
  });

  it('keeps a concrete receiver in the singular with scope query alongside unknown coverage', async function () {
    const source = 'with(context){var inspected=field;}';
    const project = await createProject({
      Provider:
        'globalvar context;function Context()constructor{field=1;}context=new Context();',
      Consumer: source,
    });
    const code = project.testCode('Consumer');
    const cursor = source.indexOf('var inspected');
    const concrete = project.self.getMember('context')!.getTypeByKind('Struct');
    expect(concrete).not.to.equal(undefined);
    expect(code.getScopeRangeAt(cursor)!.self).to.equal(concrete);
    expect(code.getScopeCandidatesAt(cursor)).to.have.length(2);
    expect(
      code
        .getCompletionCandidatesAt(cursor)
        .find((candidate) => candidate.name === 'field')!.availability,
    ).to.deep.equal({ present: 1, total: 2 });
  });

  it('keeps unknown with coverage while excluding noone from body alternatives', async function () {
    for (const other of ['unknownReceiver', 'noone'])
      for (const alternatives of [`{known:1}:${other}`, `${other}:{known:1}`]) {
        const source = `function Probe(flag,unknownReceiver){var localOnly="local";with(flag?${alternatives}){var inspected=localOnly;}return 0;}`;
        const project = await createProject({ WithOptional: source });
        const code = project.testCode('WithOptional');
        const candidates = new Map(
          code
            .getCompletionCandidatesAt(source.indexOf('var inspected'))
            .map((candidate) => [candidate.name, candidate]),
        );
        const total = other === 'noone' ? 1 : 2;
        expect(
          candidates.get('known')!.availability,
          alternatives,
        ).to.deep.equal({ present: 1, total });
        expect(
          candidates.get('localOnly')!.availability,
          alternatives,
        ).to.deep.equal({ present: total, total });
        expect(kinds(candidates.get('localOnly')!.type)).to.deep.equal([
          'String',
        ]);
      }
  });

  it('refreshes unrelated global completions without semantic reevaluation', async function () {
    const source =
      'global.local=2;var first=global.local;global.local="local";var last=global.local;';
    const project = await createProject({
      Provider: 'global.external=1;global.removed="before";',
      Consumer: source,
    });
    const consumer = project.testCode('Consumer');
    const first = source.indexOf('global.local', 1) + 'global.'.length;
    const last = source.lastIndexOf('global.local') + 'global.'.length;
    const at = (offset: number) =>
      new Map(
        consumer
          .getCompletionCandidatesAt(offset)
          .map((candidate) => [candidate.name, kinds(candidate.type)]),
      );
    expect(at(first).get('local')).to.deep.equal(['Real']);
    expect(at(last).get('local')).to.deep.equal(['String']);
    expect(at(first).get('external')).to.deep.equal(['Real']);
    const before = counters(project);
    await project
      .testCode('Provider')
      .reload('global.external="updated";global.added=true;');
    expect(delta(project, before).evaluated).to.equal(1);
    expect(at(first).get('external')).to.deep.equal(['String']);
    expect(at(first).get('added')).to.deep.equal(['Bool']);
    expect(at(first).has('removed')).to.equal(false);
    expect(at(first).get('local')).to.deep.equal(['Real']);
    expect(at(last).get('local')).to.deep.equal(['String']);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('retains actual global lookup and negative lookup dependencies', async function () {
    const project = await createProject({
      Provider: 'global.external=1;',
      Consumer: 'var actual=global.external;var future=global.future;',
    });
    const consumer = project.testCode('Consumer');
    expectValue(consumer, 'actual', 'Real');
    expect(missing(consumer, 'future').length).to.be.greaterThan(0);
    await project
      .testCode('Provider')
      .reload('global.external="updated";global.future=true;');
    expectValue(consumer, 'actual', 'String');
    expectValue(consumer, 'future', 'Bool');
    expect(missing(consumer, 'future')).to.deep.equal([]);
    await project.testCode('Provider').reload('global.external=1;');
    expectValue(consumer, 'actual', 'Real');
    expect(missing(consumer, 'future').length).to.be.greaterThan(0);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('does not reevaluate semantic dependents when only a provider source position changes', async function () {
    const sources = {
      Provider: 'function audit_position_provider() { return 1; }',
      Consumer:
        'function audit_position_user() { return audit_position_provider(); } var result = audit_position_user();',
      Other: 'function audit_position_other() { return "other"; }',
    };
    const project = await createProject(sources);
    const before = counters(project);
    await project
      .testCode('Provider')
      .reload('// shift source positions\n' + sources.Provider);
    const work = delta(project, before);
    expect(work.parsed).to.equal(1);
    expect(work.bound).to.equal(1);
    expect(work.evaluated).to.equal(1);
    const consumer = project.testCode('Consumer');
    const reference = consumer.refs.find(
      (ref) => ref.item.name === 'audit_position_provider',
    )!;
    const definition = reference.item.def;
    if (!definition?.file)
      throw new Error('The provider must retain a source definition');
    expect(definition.start.line).to.equal(2);
    expectValue(consumer, 'result', 'Real');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('does not reevaluate consumers of unchanged sibling exports when a function body changes', async function () {
    const sources = {
      Provider:
        'function audit_changing() { return 1; } function audit_stable() { return 2; }',
      Consumer: 'var result = audit_stable();',
    };
    const project = await createProject(sources);
    const before = counters(project);
    await project
      .testCode('Provider')
      .reload(sources.Provider.replace('return 1', 'return "changed"'));
    expect(delta(project, before).evaluated).to.equal(1);
    expectValue(project.testCode('Consumer'), 'result', 'Real');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('keeps anonymous annotation storage isolated across declarations and units', async function () {
    const sources = {
      First:
        'function first_shape(){\n/// @type {Struct}\nvar own; own.first=1; return own;} function sibling_shape(){\n/// @type {Struct}\nvar own; own.sibling=true; return own;} function first_array(){\n/// @type {Array}\nvar own; own[0]=1; return own;}',
      Second:
        'function second_shape(){\n/// @type {Struct}\nvar own; own.second="text"; return own;} function second_array(){\n/// @type {Array}\nvar own; own[0]="text"; return own;}',
      Consumer:
        'var first=first_shape(); var second=second_shape(); var sibling=sibling_shape(); var a=first.first; var b=second.second; var c=sibling.sibling; var x=first_array()[0]; var y=second_array()[0];',
    };
    const project = await createProject(sources);
    const consumer = project.testCode('Consumer');
    expectValue(consumer, 'a', 'Real');
    expectValue(consumer, 'b', 'String');
    expectValue(consumer, 'c', 'Bool');
    expectValue(consumer, 'x', 'Real');
    expectValue(consumer, 'y', 'String');
    const first = consumer.refs.find((ref) => ref.item.name === 'first')!.item
      .type.type[0];
    const second = consumer.refs.find((ref) => ref.item.name === 'second')!.item
      .type.type[0];
    const sibling = consumer.refs.find((ref) => ref.item.name === 'sibling')!
      .item.type.type[0];
    expect(first.getMember('second')).to.equal(undefined);
    expect(first.getMember('sibling')).to.equal(undefined);
    expect(second.getMember('first')).to.equal(undefined);
    expect(sibling.getMember('first')).to.equal(undefined);
    await project
      .testCode('First')
      .reload('// location only\n' + sources.First);
    expectValue(consumer, 'x', 'Real');
    expectValue(consumer, 'y', 'String');
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
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

  it('preserves diagnostic-only provider notification order when callers touch functions in reverse order', async function () {
    const project = await createProject({
      First: 'function first_target(){return 1;}',
      Second: 'function second_target(){return 2;}',
      Consumer: 'var result=0;',
    });
    const versions = ['First', 'Second'].map(
      (name) => project.testCode(name).analysisState.semanticVersion,
    );
    try {
      for (const [text, expected] of [
        [
          'var result=second_target()+first_target();',
          ['Consumer', 'First', 'Second'],
        ],
        [
          'var result=second_target()+first_target()+first_target();',
          ['Consumer', 'First'],
        ],
        ['var result=0;', ['Consumer', 'First', 'Second']],
      ] as const) {
        project.publications.length = 0;
        await project.testCode('Consumer').reload(text);
        expect(
          project.publications.map(
            (event) =>
              [...project.testCodes].find(
                ([, code]) => code.path.absolute === event.filePath,
              )?.[0],
          ),
        ).to.deep.equal(expected);
        expect(
          ['First', 'Second'].map(
            (name) => project.testCode(name).analysisState.semanticVersion,
          ),
        ).to.deep.equal(versions);
      }
    } finally {
      project.dispose();
    }
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
    const failedText = 'var value = "uncommitted";';
    const retryEditorAnalysis = async () => {
      await code.readContent(failedText);
      await project.analysis.analyze();
    };
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
      expect(await rejection(code.reload(failedText))).to.equal(failure);
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
      // Passive queries retain the explicit failure. The editor queue's explicit
      // readContent + analyze retry must reject again while the fault persists.
      expect(await rejection(project.analysis.analyze())).to.equal(failure);
      expect(preparations).to.equal(1);
      expect(await rejection(retryEditorAnalysis())).to.equal(failure);
      expect(preparations).to.equal(2);
      expect(code.analysisState.status).to.equal('failed');
      expect(code.refs).to.deep.equal([]);
    } finally {
      restore();
    }
    await retryEditorAnalysis();
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
  for (const order of [
    ['Other', 'Dialogue'],
    ['Dialogue', 'Other'],
  ]) {
    it(`refreshes annotated instance export shapes in ${order.join(' -> ')} order`, async function () {
      const inputs: Record<string, ObjectDefinitionFixture> = {
        Other: { create: 'payload=1;function active(){return payload;}' },
        Dialogue: {
          create:
            '/// @type {Id.Instance.Other}\nconnectedTO=undefined;\n/// @param {Id.Instance.Other} toInst\nfunction init(toInst=undefined){connectedTO=toInst;}\nfunction plan_destroy(){call_later(1,time_source_units_frames,function(){instance_destroy();},false);}',
        },
      };
      const project = await objectDefinitionsProject(
        Object.fromEntries(order.map((name) => [name, inputs[name]])),
      );
      const code = project.testCode('Dialogue');
      const assertShape = (expected: string) => {
        const service = project.analysis as unknown as {
          units: ReadonlyMap<string, { evaluation: UnitEvaluation }>;
        };
        const exported = service.units.get(code.path.absolute)!.evaluation;
        const field = exported.symbols.get(
          'object:Dialogue:self/member:connectedTO',
        )!;
        expect(field.item.type.toFeatherString()).to.equal('Id.Instance.Other');
        expect(
          field.item.type.type[0]!.getMember('payload')!.type.toFeatherString(),
        ).to.equal(expected);
        expect(
          definition(code, 'connectedTO')
            .item.type.type[0]!.getMember('payload')!
            .type.toFeatherString(),
        ).to.equal(expected);
        expect(missing(code, 'connectedTO')).to.deep.equal([]);
        expect(
          code.refs.some(
            (ref) =>
              ref.item.name === 'connectedTO' &&
              !ref.isDef &&
              ref.item.def?.file === code,
          ),
        ).to.equal(true);
      };
      assertShape('Real');
      await project
        .testCode('Other')
        .reload('payload="changed";function active(){return payload;}');
      assertShape('String');
      expect(snapshot(project)).to.deep.equal(
        snapshot(
          await objectDefinitionsProject({
            ...inputs,
            Other: { create: project.testCode('Other').content },
          }),
        ),
      );
    });
  }
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

describe('Missing read placeholders', function () {
  it('keeps incomplete member reads out of declaration shapes and refreshes later real writes', async function () {
    const source = `function Box() constructor { radius=1; }
      function Probe(input) {
        /// @type {Struct.Box}
        var box=input;
        return box.ra;
      }`;
    const project = await createProject({
      provider: source,
      consumer: 'function Consumer(){var box=new Box();return box.radius;}',
    });
    let cold: MemoryProject | undefined;
    try {
      const provider = project.testCode('provider'),
        consumer = project.testCode('consumer');
      const box = () => project.types.get('Struct.Box')!;
      expect(missing(provider, 'ra')).not.to.have.length(0);
      expect(
        provider.refs.some((ref) => ref.item.name === 'ra' && !ref.item.def),
      ).to.equal(true);
      expect(box().getMember('ra')).to.equal(undefined);
      const before = project.analysis.metrics.evaluated;
      await provider.reload(source.replace('box.ra', 'box.razz'));
      expect(project.analysis.metrics.evaluated - before).to.equal(1);
      expect(missing(provider, 'razz')).not.to.have.length(0);
      expect(box().getMember('razz')).to.equal(undefined);
      expect(kinds(callable(project, 'Consumer').returns)).to.deep.equal([
        'Real',
      ]);
      await consumer.reload(
        'function Consumer(){var box=new Box();return box.future;}',
      );
      expect(missing(consumer, 'future')).not.to.have.length(0);
      await provider.reload(
        source.replace(
          'return box.ra;',
          'box.future="text"; return box.future;',
        ),
      );
      expect(box().getMember('future')?.type.kind).to.equal('String');
      expect(missing(consumer, 'future')).to.have.length(0);
      expect(kinds(callable(project, 'Consumer').returns)).to.deep.equal([
        'String',
      ]);
      await provider.reload(source);
      expect(box().getMember('future')).to.equal(undefined);
      expect(missing(consumer, 'future')).not.to.have.length(0);
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('keeps undeclared implicit reads separate from receiver members', async function () {
    const project = await createProject({
      provider:
        'function Box() constructor { radius=1; static inspect=function(){return absent;}; }',
    });
    try {
      const code = project.testCode('provider');
      expect(missing(code, 'absent')).not.to.have.length(0);
      expect(
        code.refs.some((ref) => ref.item.name === 'absent' && !ref.item.def),
      ).to.equal(true);
      expect(project.types.get('Struct.Box')!.getMember('absent')).to.equal(
        undefined,
      );
    } finally {
      project.dispose();
    }
  });
});

describe('Cold-start source scheduling', function () {
  it('orders expanded macro providers and preserves their incremental public results', async function () {
    const sources = {
      Consumer: '#macro COLD_READ cold_macro_provider()\nvar result=COLD_READ;',
      Provider: 'function cold_macro_provider(){return 1;}',
    };
    const project = await createProject(sources);
    try {
      expect(project.analysis.metrics.evaluated).to.equal(2);
      expectValue(project.testCode('Consumer'), 'result', 'Real');
      expect(
        missing(project.testCode('Consumer'), 'cold_macro_provider'),
      ).to.deep.equal([]);
      await project
        .testCode('Provider')
        .reload('function cold_macro_provider(){return "text";}');
      expectValue(project.testCode('Consumer'), 'result', 'String');
      const cold = await createProject(currentSources(project));
      try {
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold.dispose();
      }
    } finally {
      project.dispose();
    }
  });

  it('keeps cyclic providers and their edits semantically equivalent to a fresh cold project', async function () {
    const sources = {
      Left: 'function cold_left(flag){if(flag)return cold_right(false);return 1;} var result=cold_left(true);',
      Right:
        'function cold_right(flag){if(flag)return cold_left(false);return 1;}',
    };
    const project = await createProject(sources);
    try {
      expectValue(project.testCode('Left'), 'result', 'Real');
      await project
        .testCode('Right')
        .reload(
          'function cold_right(flag){if(flag)return cold_left(false);return "text";}',
        );
      const cold = await createProject(currentSources(project));
      try {
        expect(snapshot(project)).to.deep.equal(snapshot(cold));
      } finally {
        cold.dispose();
      }
      assertAvailable(project);
    } finally {
      project.dispose();
    }
  });

  async function fixture(
    providerFirst: boolean,
    kind: 'script' | 'extension' = 'script',
  ): Promise<MemoryProject> {
    const project = new MemoryProject();
    await project.prepareBundledNative();
    const text = 'var result = cold_source_value();';
    const asset = new MemoryObject(project, 'ColdConsumer', { create: text });
    project.assets.set(asset.name.toLowerCase(), asset);
    project.yyp.resources.push(asset.resource);
    project.addTestResource('ColdProvider');
    const consumer = () => {
      const code = new Code(asset, asset.dir.join('Create_0.gml'));
      asset.gmlFiles.set(code.path.absolute.toLowerCase(), code);
      project.testCodes.set('ColdConsumer', code);
      code.content = text;
    };
    const provider = () => {
      const code = project.addTestCode(
        'ColdProvider',
        'function cold_source_value(){return 1;}',
      );
      code.setSourceContext({ kind });
    };
    for (const add of providerFirst
      ? [provider, consumer]
      : [consumer, provider])
      add();
    await project.analysis.analyze();
    assertAvailable(project);
    return project;
  }

  for (const kind of ['script', 'extension'] as const) {
    it(`avoids declaration-only retries when the ${kind} provider registers after its event consumer`, async function () {
      const project = await fixture(false, kind);
      let reversed: MemoryProject | undefined;
      try {
        expectValue(project.testCode('ColdConsumer'), 'result', 'Real');
        const reference = project
          .testCode('ColdConsumer')
          .refs.find((ref) => ref.text === 'cold_source_value')!;
        expect(reference.item.def?.file).to.equal(
          project.testCode('ColdProvider'),
        );
        expect(project.analysis.metrics.evaluated).to.equal(2);
        reversed = await fixture(true, kind);
        expect(reversed.analysis.metrics.evaluated).to.equal(2);
        expect(snapshot(project)).to.deep.equal(snapshot(reversed));
      } finally {
        reversed?.dispose();
        project.dispose();
      }
    });
  }

  it('preserves dirty-first evaluation after the first cold publication', async function () {
    const project = await fixture(false);
    try {
      const before = project.analysis.metrics.evaluated;
      await project
        .testCode('ColdConsumer')
        .readContent('var result = cold_source_value(); var marker = true;');
      await project
        .testCode('ColdProvider')
        .readContent('function cold_source_value(){return "changed";}');
      await project.analysis.analyze();
      expectValue(project.testCode('ColdConsumer'), 'result', 'String');
      expectValue(project.testCode('ColdConsumer'), 'marker', 'Bool');
      // The dirty event runs first, then retries after its dirty provider.
      // Applying cold source priority to this transaction would evaluate twice.
      expect(project.analysis.metrics.evaluated - before).to.equal(3);
    } finally {
      project.dispose();
    }
  });
});

describe('Callable implementation dependencies', function () {
  it('does not reevaluate an unrelated method consumer after a same-shaped sibling body edit', async function () {
    const provider = `function MethodPair() constructor {
      static changing=function(){var internal=1;return 1;};
      static stable=function(){return 2;};
    }`;
    const sources = {
      Provider: provider,
      Consumer:
        '/// @param {Struct.MethodPair} pair\nfunction ReadStable(pair){return pair.stable();}',
    };
    const project = await createProject(sources);
    let cold: MemoryProject | undefined;
    try {
      expect(kinds(callable(project, 'ReadStable').returns)).to.deep.equal([
        'Real',
      ]);
      const before = counters(project);
      await project
        .testCode('Provider')
        .reload(provider.replace('internal=1', 'internal=3'));
      expect(kinds(callable(project, 'ReadStable').returns)).to.deep.equal([
        'Real',
      ]);
      expect(delta(project, before).evaluated).to.equal(1);
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('refreshes an executed body through an unchanged nested carrier without reevaluating the carrier', async function () {
    const provider = 'function ReadContext(){return other.left;}';
    const project = await createProject(
      {
        Provider: provider,
        Carrier: 'global.callbacks={nested:[ReadContext]};',
        Executor: `function RunContext(){var callback=method({},global.callbacks.nested[0]);
        var caller={left:"text",right:1};var result;with(caller){result=callback();}return result;}`,
      },
      { legacyOtherBehaviour: false },
    );
    let cold: MemoryProject | undefined;
    try {
      expect(kinds(callable(project, 'RunContext').returns)).to.deep.equal([
        'String',
      ]);
      const carrier = project.testCode('Carrier');
      const before = counters(project);
      const version = carrier.analysisState.semanticVersion;
      await project
        .testCode('Provider')
        .reload(provider.replace('other.left', 'other.right'));
      expect(kinds(callable(project, 'RunContext').returns)).to.deep.equal([
        'Real',
      ]);
      expect(delta(project, before).evaluated).to.equal(2);
      expect(carrier.analysisState.semanticVersion).to.equal(version);
      cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('tracks nested returned callback implementations and their current bound receivers', async function () {
    const provider = `function MakeCallback(){var owner={left:"text",right:1};
      return method(owner,function(){return left;});}`;
    const project = await createProject({
      Provider: provider,
      Carrier: 'global.callback=MakeCallback();',
      Executor: 'function RunCallback(){return global.callback();}',
    });
    let cold: MemoryProject | undefined;
    try {
      expect(kinds(callable(project, 'RunCallback').returns)).to.deep.equal([
        'String',
      ]);
      await project
        .testCode('Provider')
        .reload(provider.replace('return left', 'return right'));
      expect(kinds(callable(project, 'RunCallback').returns)).to.deep.equal([
        'Real',
      ]);
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('propagates implementation reads made by defaults statics and base constructors', async function () {
    const source = `function Initialize(){return other.left;}
      function WithDefault(input=Initialize()){return input;}
      function WithStatic(){static cached=Initialize();return cached;}
      function BaseContext()constructor{other.mark=other.left;}
      function DerivedContext():BaseContext()constructor{}`;
    const project = await createProject(
      {
        Provider: source,
        Executor: `function RunDefaults(){var callback=method({},WithDefault);var caller={left:"text",right:1};var result;
        with(caller){result=callback();}return result;}
      function RunStatics(){var callback=method({},WithStatic);var caller={left:"text",right:1};var result;
        with(caller){result=callback();}return result;}
      function RunBase(){var caller={left:"text",right:1,mark:false};var result;with(caller){result=new DerivedContext();}return caller.mark;}`,
      },
      { legacyOtherBehaviour: false },
    );
    let cold: MemoryProject | undefined;
    try {
      for (const name of ['RunDefaults', 'RunStatics', 'RunBase'])
        expect(kinds(callable(project, name).returns), name).to.include(
          'String',
        );
      await project
        .testCode('Provider')
        .reload(source.replaceAll('other.left', 'other.right'));
      for (const name of ['RunDefaults', 'RunStatics', 'RunBase']) {
        expect(kinds(callable(project, name).returns), name).to.include('Real');
        expect(kinds(callable(project, name).returns), name).not.to.include(
          'String',
        );
      }
      cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('withdraws deleted callback implementations and recovers after provider restoration', async function () {
    const provider = 'function RetainedCallback(){return other.field;}';
    const project = await createProject(
      {
        Provider: provider,
        Carrier: 'global.callback=RetainedCallback;',
        Executor:
          'function RunRetained(){var callback=method({},global.callback);var caller={field:"text"};var result;with(caller){result=callback();}return result;}',
      },
      { legacyOtherBehaviour: false },
    );
    let cold: MemoryProject | undefined;
    try {
      expect(kinds(callable(project, 'RunRetained').returns)).to.deep.equal([
        'String',
      ]);
      await project.retireTestResource('Provider');
      expect(kinds(callable(project, 'RunRetained').returns)).not.to.include(
        'String',
      );
      expect(
        missing(project.testCode('Carrier'), 'RetainedCallback'),
      ).not.to.have.length(0);
      project.addTestCode('Provider', provider);
      await project.analysis.analyze();
      expect(kinds(callable(project, 'RunRetained').returns)).to.deep.equal([
        'String',
      ]);
      cold = await createProject(currentSources(project), {
        fileOrder: ['Executor', 'Carrier', 'Provider'],
        legacyOtherBehaviour: false,
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('distinguishes same-signature callable origins when a carrier switches targets', async function () {
    const project = await createProject(
      {
        Provider:
          'function LeftContext(){return other.left;} function RightContext(){return other.right;}',
        Carrier: 'global.callback=LeftContext;',
        Executor:
          'function RunSelected(){var callback=method({},global.callback);var caller={left:"text",right:1};var result;with(caller){result=callback();}return result;}',
      },
      { legacyOtherBehaviour: false },
    );
    let cold: MemoryProject | undefined;
    try {
      expect(kinds(callable(project, 'RunSelected').returns)).to.deep.equal([
        'String',
      ]);
      await project.testCode('Carrier').reload('global.callback=RightContext;');
      expect(kinds(callable(project, 'RunSelected').returns)).to.deep.equal([
        'Real',
      ]);
      cold = await createProject(currentSources(project), {
        legacyOtherBehaviour: false,
      });
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });
});

describe('Incremental semantic publication', function () {
  it('retains unchanged source versions while replacing a registered document at the same URI', async function () {
    const project = await createProject({
      Provider:
        'function Candidate(){return 1;} function Obsolete(){return 2;}',
      Consumer: 'var result=Candidate();',
      Stable: 'function Keep(){return true;}',
    });
    const old = project.testCode('Provider');
    const stable = project.testCode('Stable');
    const stableType = callable(project, 'Keep');
    const obsolete = project.self.getMember('Obsolete')!;
    const prepare = ContributionGraph.prepare;
    let checked = false;
    const restore = patchInstance(
      ContributionGraph,
      'prepare',
      (...args: Parameters<typeof prepare>) => {
        const previous = args[2]!.index;
        const oldVersion = previous.units.get(old.path.absolute)!;
        const stableVersion = previous.units.get(stable.path.absolute)!;
        expect(args[0]).not.to.equal(previous);
        expect(args[0].units.get(old.path.absolute)).not.to.equal(oldVersion);
        expect(args[0].units.get(stable.path.absolute)).to.equal(stableVersion);
        const candidate = prepare(...args);
        expect(previous.units.get(old.path.absolute)).to.equal(oldVersion);
        expect(previous.units.get(stable.path.absolute)).to.equal(
          stableVersion,
        );
        checked = true;
        return candidate;
      },
    );
    let cold: MemoryProject | undefined;
    try {
      const replacement = project.addTestCode(
        'Provider',
        'function Candidate(){return "new";}',
      );
      await project.analysis.analyze();
      restore();
      expect(checked).to.equal(true);
      expect(project.analysis.document(old.path.absolute)).to.equal(
        replacement,
      );
      expect(old.analysisState.status).to.equal('retired');
      expectValue(project.testCode('Consumer'), 'result', 'String');
      expect(project.self.getMember('Candidate')!.def?.file).to.equal(
        replacement,
      );
      expect(obsolete.def).to.equal(undefined);
      expect(obsolete.type.hasTypes).to.equal(false);
      expect(callable(project, 'Keep')).to.equal(stableType);
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      restore();
      cold?.dispose();
      project.dispose();
    }
  });

  it('refreshes captured native input after a warm transaction without replacing the native object', async function () {
    const source = 'var result=audit_branch_native;';
    const project = await createProject({ Consumer: source });
    let cold: MemoryProject | undefined;
    const install = (target: MemoryProject, type: Type) => {
      const owner = target.native!.globalSelf;
      const member = new Signifier(owner, 'audit_branch_native', type);
      member.global = true;
      member.writable = false;
      member.def = {};
      owner.setOwnMember(member);
      target.analysis.captureNative();
    };
    try {
      const native = project.native;
      for (const type of [Type.Real, Type.String]) {
        install(project, type);
        await project.analysis.analyze();
        expect(project.native).to.equal(native);
        expectValue(project.testCode('Consumer'), 'result', type.kind);
      }
      cold = new MemoryProject();
      await cold.prepareBundledNative();
      install(cold, Type.String);
      cold.addTestCode('Consumer', source);
      await cold.analysis.analyze();
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      cold?.dispose();
      project.dispose();
    }
  });

  it('withdraws externally spelled references on failure and preserves their owner order through recovery and retirement', async function () {
    const sources = {
      Provider: 'global.audit_macro_value=1;',
      Macros: '#macro AUDIT_PICK global.audit_macro_value\n',
      Consumer: 'var result=AUDIT_PICK;',
      Stable: 'var kept=AUDIT_PICK;',
    };
    const project = await createProject(sources);
    const consumer = project.testCode('Consumer');
    const uri = project.testCode('Macros').path.absolute;
    const external = () => project.analysis.spellingReferences(uri);
    const verify = () =>
      expect(external()).to.deep.equal(
        project.analysis.references.filter(
          (ref) => ref.origin?.spelling.uri === uri && ref.ownerUnitId !== uri,
        ),
      );
    const before = external();
    expect(
      before.some((ref) => ref.ownerUnitId === consumer.path.absolute),
    ).to.equal(true);
    verify();
    const failure = new Error('injected macro reference owner failure');
    const restore = patchInstance(project.analysis, 'resourceInput', () => {
      throw failure;
    });
    let cold: MemoryProject | undefined;
    try {
      expect(
        await rejection(consumer.reload('var changed=AUDIT_PICK;')),
      ).to.equal(failure);
      expect(consumer.refs).to.deep.equal([]);
      expect(
        external().some((ref) => ref.ownerUnitId === consumer.path.absolute),
      ).to.equal(false);
      expect(
        before.some((ref) => ref.ownerUnitId === consumer.path.absolute),
      ).to.equal(true);
      verify();
      restore();
      await consumer.reload('var changed=AUDIT_PICK;');
      verify();
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
      await project.retireTestResource('Consumer');
      verify();
      project.addTestCode('Consumer', sources.Consumer);
      await project.analysis.analyze();
      verify();
    } finally {
      restore();
      cold?.dispose();
      project.dispose();
    }
  });

  it('preflights definition-only consumer views before changing live definitions', async function () {
    const sources = {
      Provider: 'function moved_definition(){return 1;}',
      Consumer: 'var result=moved_definition();',
    };
    const project = await createProject(sources);
    const consumer = project.testCode('Consumer');
    const symbol = project.self.getMember('moved_definition')!;
    const previousDefinition = symbol.def;
    const previousVersion = consumer.analysisState.semanticVersion;
    const failure = new Error('injected definition consumer source failure');
    const prepare = ContributionGraph.prepare;
    const restore = patchInstance(
      ContributionGraph,
      'prepare',
      (...args: Parameters<typeof ContributionGraph.prepare>) => {
        const staged = prepare(...args);
        const source = staged.source;
        patchInstance(staged, 'source', (uri: string) => {
          if (uri === consumer.path.absolute) throw failure;
          return source(uri);
        });
        return staged;
      },
    );
    try {
      expect(
        await rejection(
          project.testCode('Provider').reload('\n' + sources.Provider),
        ),
      ).to.equal(failure);
      expect(symbol.def).to.equal(previousDefinition);
      expect(consumer.analysisState.semanticVersion).to.equal(previousVersion);
      restore();
      await project.testCode('Provider').reload('\n' + sources.Provider);
      const moved = symbol.def;
      const queried = consumer.refs.find(
        (ref) => ref.item.name === 'moved_definition',
      )?.item.def;
      expect(moved?.file && moved.start.line).to.equal(2);
      expect(queried?.file && queried.start.line).to.equal(2);
    } finally {
      restore();
      project.dispose();
    }
  });

  it('withdraws pending retired owners and their external references when disposed before another analysis', async function () {
    const project = await createProject({
      Provider: 'function kept(){return 1;}',
      Macros: '#macro FINISH kept()\n',
      Consumer: 'var result=FINISH;',
    });
    const analysis = project.analysis;
    const consumer = project.testCode('Consumer');
    const spelling = project.testCode('Macros').path.absolute;
    const refs = [...consumer.refs];
    expect(refs.length).to.be.greaterThan(0);
    expect(analysis.spellingReferences(spelling).length).to.be.greaterThan(0);
    analysis.retire(consumer);
    project.dispose();
    expect(analysis.references).to.deep.equal([]);
    expect(analysis.spellingReferences(spelling)).to.deep.equal([]);
    expect(consumer.analysisState.status).to.equal('retired');
    for (const ref of refs) expect(ref.item.refs.has(ref)).to.equal(false);
    project.dispose();
    expect(analysis.references).to.deep.equal([]);
  });

  it('withdraws retired contributions after a pre-publication failure has cleared retirement notifications', async function () {
    const project = await createProject({
      Provider: 'function RetireMe(){return 1;}',
      Consumer: 'var result=RetireMe();',
      Stable: 'function Keep(){return true;}',
    });
    const symbol = project.self.getMember('RetireMe')!;
    const stable = callable(project, 'Keep');
    const failure = new Error('injected before publication preparation');
    const restore = patchInstance(project.analysis, 'resourceInput', () => {
      throw failure;
    });
    let cold: MemoryProject | undefined;
    try {
      expect(await rejection(project.retireTestResource('Provider'))).to.equal(
        failure,
      );
      restore();
      const consumer = project.testCode('Consumer');
      await consumer.reload('var result=RetireMe();\n');
      expect(missing(consumer, 'RetireMe')).not.to.have.lengthOf(0);
      expect(symbol.def).to.equal(undefined);
      expect(callable(project, 'Keep')).to.equal(stable);
      cold = await createProject(currentSources(project));
      expect(snapshot(project)).to.deep.equal(snapshot(cold));
    } finally {
      restore();
      cold?.dispose();
      project.dispose();
    }
  });

  it('keeps unrelated public graph work across local allocation and missing-member edits', async function () {
    const initial = {
      Stable: 'function Keep()constructor{field=1;}',
      Edit: 'function Edit(){var target={field:1};return target.field;}',
    };
    const project = await createProject(initial);
    const stable = callable(project, 'Keep');
    const symbol = project.self.getMember('Keep')!;
    const replace = stable.replaceOwnMembers.bind(stable);
    const metadata = symbol.replaceMetadata.bind(symbol);
    let typeCopies = 0,
      symbolCopies = 0;
    stable.replaceOwnMembers = (...args) => {
      typeCopies++;
      return replace(...args);
    };
    symbol.replaceMetadata = (...args) => {
      symbolCopies++;
      return metadata(...args);
    };
    for (const source of [
      'function Edit(){var extra={nested:1};var target={field:1};return target.field;}',
      'function Edit(){var target={field:1};return target.missing;}',
      initial.Edit,
    ]) {
      await project.testCode('Edit').reload(source);
      expect(typeCopies).to.equal(0);
      expect(symbolCopies).to.equal(0);
      expect(callable(project, 'Keep')).to.equal(stable);
      expect(project.self.getMember('Keep')).to.equal(symbol);
      expect(snapshot(project)).to.deep.equal(
        snapshot(await createProject({ ...initial, Edit: source })),
      );
    }
  });

  for (const outcome of ['cancel', 'failure']) {
    it(`discards a consumed private publication buffer after ${outcome} before commit`, async function () {
      const initial = 'function Candidate(){return 1;}';
      const changed = 'function Candidate(){return "candidate";}';
      const recovered = 'function Candidate(){return true;}';
      const project = await createProject({ A: initial });
      const code = project.testCode('A');
      const publicType = callable(project, 'Candidate');
      const failure = new Error(
        'injected after private publication preparation',
      );
      const prepare = ContributionGraph.prepare;
      let attempts = 0;
      const restore = patchInstance(
        ContributionGraph,
        'prepare',
        (...args: Parameters<typeof prepare>) => {
          const candidate = prepare(...args);
          attempts++;
          expect(kinds(publicType.returns)).to.deep.equal(['Real']);
          if (attempts === 1) {
            if (outcome === 'failure') throw failure;
            code.setBufferContent(recovered);
          } else {
            expect(
              args[2],
              'consumed publication buffer must not survive cancellation/failure',
            ).to.equal(undefined);
          }
          return candidate;
        },
      );
      try {
        if (outcome === 'failure') {
          expect(await rejection(code.reload(changed))).to.equal(failure);
          expect(code.refs).to.deep.equal([]);
          expect(code.getDiagnostics().ANALYSIS[0].message).to.include(
            failure.message,
          );
          await code.readContent(recovered);
          await project.analysis.analyze();
        } else {
          await code.reload(changed);
        }
      } finally {
        restore();
      }
      expect(attempts).to.equal(2);
      expect(kinds(publicType.returns)).to.deep.equal(['Bool']);
      expect(snapshot(project)).to.deep.equal(
        snapshot(await createProject({ A: recovered })),
      );
    });
  }

  it('clears retired public handles and references while preserving unrelated handles', async function () {
    const project = await createProject({
      A: 'function RetireMe(){return 1;}',
      B: 'function KeepMe(){return 2;}',
    });
    const symbol = project.self.getMember('RetireMe')!;
    const type = symbol.getTypeByKind('Function')!;
    const keep = callable(project, 'KeepMe');
    const references = [...symbol.refs];
    await project.retireTestResource('A');
    expect(symbol.type.hasTypes).to.equal(false);
    expect(symbol.def).to.equal(undefined);
    expect(symbol.refs.size).to.equal(0);
    expect(type.returns).to.equal(undefined);
    expect(type.listMembers(true)).to.deep.equal([]);
    expect(callable(project, 'KeepMe')).to.equal(keep);
    for (const reference of references)
      expect(project.analysis.references).not.to.include(reference);
    expect(snapshot(project)).to.deep.equal(
      snapshot(await createProject(currentSources(project))),
    );
  });

  it('preserves a shared anonymous public union while copying only one keyed owner', function () {
    const project = new MemoryProject();
    const shared = Type.Struct;
    shared.items = value(shared);
    const globals = Type.Struct,
      left = Type.Struct,
      right = Type.Struct;
    globals.semanticKey = globalOwner;
    left.semanticKey = 'left';
    right.semanticKey = 'right';
    left.items = value(shared);
    right.items = value(shared);
    const symbols = [
      new Signifier(globals, 'left', left),
      new Signifier(globals, 'right', right),
    ];
    for (const symbol of symbols) {
      symbol.semanticKey = `global:${symbol.name}`;
      globals.setOwnMember(symbol);
    }
    const root = {
      types: new Map([
        [globalOwner, globals],
        ['right', right],
      ]),
      namedTypes: new Map<string, string>(),
      symbols: new Map(
        symbols.map((item) => [
          item.semanticKey!,
          {
            key: item.semanticKey!,
            item,
            owner: globalOwner,
            unitId: 'root',
            exported: true,
          },
        ]),
      ),
    };
    const index = (description: string) => {
      const current = new ContributionIndex();
      const changed = Type.Struct;
      changed.semanticKey = 'left';
      changed.description = description;
      changed.items = value(shared);
      current.replace('root', root);
      current.replace('left', {
        types: new Map([['left', changed]]),
        symbols: new Map(),
        namedTypes: new Map(),
      });
      return current;
    };
    // Exercise the actual synchronous publication boundary with a closed input
    // graph and no documents, avoiding parser allocation identities in this case.
    const commit = Reflect.get(project.analysis, 'commit') as (
      graph: ContributionGraph,
      states: Map<never, never>,
      evaluated: Set<string>,
    ) => unknown;
    const first = ContributionGraph.prepare(index('before'), () => undefined);
    commit.call(project.analysis, first, new Map<never, never>(), new Set());
    const publicLeft = project.self.getMember('left')!.getTypeByKind('Struct')!;
    const publicRight = project.self
      .getMember('right')!
      .getTypeByKind('Struct')!;
    const next = ContributionGraph.prepare(
      index('after'),
      () => undefined,
      first,
    );
    expect(publicLeft.description).to.equal('before');
    commit.call(project.analysis, next, new Map<never, never>(), new Set());
    expect(publicLeft.description).to.equal('after');
    expect(value(publicLeft.items, publicRight.items).type).to.have.length(1);
    expect(publicLeft.items!.type[0]).to.equal(publicRight.items!.type[0]);
    expect(publicLeft.items!.type[0]).not.to.equal(
      next.type('left').items!.type[0],
    );
    expect(publicLeft.items!.type[0].items!.type[0]).to.equal(
      publicLeft.items!.type[0],
    );
  });
});
