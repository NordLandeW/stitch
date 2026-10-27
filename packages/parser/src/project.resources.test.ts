import { pathy } from '@bscotch/pathy';
import { stitchConfigSchema } from '@bscotch/stitch-config';
import {
  Yy,
  yyExtensionSchema,
  yyObjectEventSchema,
  yyObjectSchema,
  yypSchema,
  yyScriptSchema,
  type YyData,
  type YyExtension,
  type YyObject,
  type YypResource,
} from '@bscotch/yy';
import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LanguageProfile } from './language/version.js';
import { Asset, isAssetOfKind } from './project.asset.js';
import type { Code } from './project.code.js';
import type { Diagnostic } from './project.diagnostics.js';
import {
  applyDiskEdits,
  editedText,
  ProjectEditError,
  renamedPath,
  type ProjectEditBatch,
} from './project.edits.js';
import type { Reference } from './project.location.js';
import { Native } from './project.native.js';
import { Project, type ProjectOptions } from './project.js';
import { Signifier } from './signifiers.js';
import { Type, type TypeStore } from './types.js';

type FixtureKind = 'scripts' | 'objects' | 'extensions';

function diagnosticSummary(diagnostic: Diagnostic) {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    start: diagnostic.location.start.offset,
    end: diagnostic.location.end.offset,
  };
}

/** Real Project loading, with explicit bundled native input and no initialize/discovery. */
class ResourceProject extends Project {
  readonly publications: {
    filePath: string;
    diagnostics: ReturnType<typeof diagnosticSummary>[];
  }[] = [];

  constructor(
    root: string,
    options: ProjectOptions = {
      settings: { analysisConfiguration: 'Default' },
    },
  ) {
    super(pathy(join(root, 'fixture.yyp')), options);
    this.config = stitchConfigSchema.parse({ runtimeVersion: '2024.11.0.0' });
    this.yyp = yypSchema.parse({
      name: 'fixture',
      configs: {},
      MetaData: { IDEVersion: '2024.11.0.0' },
      resourceVersion: '1.6',
    });
    this.self = new Type('Struct').named('global');
    this.symbol = new Signifier(this.self, 'global', this.self);
    this.symbol.global = true;
    this.symbol.writable = false;
    this.symbol.def = {};
    this.onDiagnostics(({ filePath, diagnostics }) => {
      this.publications.push({
        filePath,
        diagnostics: diagnostics.map(diagnosticSummary),
      });
    });
  }

  async openFixture(): Promise<void> {
    this.yyp = await Yy.read(this.yypPath.absolute, 'project');
    // The only fixture read outside its owned root is this explicit bundled spec.
    // Use detached native storage, as Project.loadGmlSpec does, before loading assets.
    this.native = await Native.from(
      [Native.fallbackGmlSpecPath],
      new Type('Struct').named('global'),
      new Map<string, Type>(),
    );
    this.languageProfile = new LanguageProfile({
      runtimeVersion: this.config.runtimeVersion,
      ideVersion: this.ideVersion,
      specSources: this.native.getSpecSources(),
    });
    this.analysis.captureNative();
    const added = await this.loadAssets();
    await this.initiallyParseAssetCode(added);
    expectAvailable(this);
  }

  publishedFor(filePath: string) {
    const publication = this.publications
      .filter((item) => item.filePath === filePath)
      .at(-1);
    expect(publication, `diagnostics published for ${filePath}`).not.to.equal(
      undefined,
    );
    return publication!.diagnostics;
  }
}

class ResourceFixture {
  readonly project: ResourceProject;

  constructor(
    readonly root: string,
    readonly options?: ProjectOptions,
  ) {
    this.project = new ResourceProject(root, options);
  }

  /** Every project file read/write is confined to this invocation's mkdtemp root. */
  file(resourcePath: string): string {
    const target = resolve(this.root, resourcePath);
    const fromRoot = relative(this.root, target);
    if (
      isAbsolute(fromRoot) ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`)
    ) {
      throw new Error(`Fixture path escapes its owned root: ${resourcePath}`);
    }
    return target;
  }

  private async add<K extends FixtureKind>(
    kind: K,
    name: string,
    yy: YyData<K>,
  ) {
    const resource: YypResource = {
      id: { name, path: `${kind}/${name}/${name}.yy` },
    };
    expect(
      this.project.yyp.resources.some((item) => item.id.name === name),
    ).to.equal(false);
    await Yy.write(this.file(resource.id.path), yy, kind, this.project.yyp);
    this.project.yyp.resources.push(resource);
    return resource;
  }

  async script(name: string, source: string) {
    const resource = await this.add(
      'scripts',
      name,
      yyScriptSchema.parse({ name }),
    );
    await writeFile(this.file(`scripts/${name}/${name}.gml`), source, 'utf8');
    return resource;
  }

  async object(
    name: string,
    sources: Readonly<Record<string, string>>,
    eventTypes: readonly number[] = [0],
    parent?: YypResource,
  ) {
    const resource = await this.add(
      'objects',
      name,
      yyObjectSchema.parse({
        name,
        parentObjectId: parent?.id ?? null,
        eventList: eventTypes.map((eventType) =>
          yyObjectEventSchema.parse({ eventType, eventNum: 0 }),
        ),
      }),
    );
    for (const [fileName, source] of Object.entries(sources)) {
      await writeFile(this.file(`objects/${name}/${fileName}`), source, 'utf8');
    }
    return resource;
  }

  async extension(name: string) {
    return this.add(
      'extensions',
      name,
      yyExtensionSchema.parse({
        name,
        files: [
          {
            resourceType: 'GMExtensionFile',
            constants: [{ name: 'AUDIT_RESOURCE_EXT_CONST', value: '1' }],
            functions: [
              {
                name: 'audit_resource_ext_fn',
                externalName: 'audit_resource_ext_fn',
                help: 'audit_resource_ext_fn()',
                returnType: 2,
                args: [],
              },
            ],
          },
        ],
      }),
    );
  }

  async load() {
    await Yy.write(this.file('fixture.yyp'), this.project.yyp, 'project');
    await this.project.openFixture();
    return this.project;
  }

  async cold() {
    const project = new ResourceProject(this.root, this.options);
    await project.openFixture();
    return project;
  }

  asset<K extends FixtureKind>(name: string, kind: K): Asset<K> {
    const asset = this.project.getAssetByName(name, { assertExists: true });
    if (!isAssetOfKind(asset, kind))
      throw new Error(`Expected ${name} to be ${kind}`);
    return asset;
  }

  code(name: string, fileName = `${name}.gml`): Code {
    const asset = this.project.getAssetByName(name, { assertExists: true });
    const code = [...asset.gmlFiles.values()].find(
      (file) => file.path.basename === fileName,
    );
    expect(code, `${name}/${fileName} is loaded`).not.to.equal(undefined);
    return code!;
  }

  async updateObject(asset: Asset<'objects'>, change: (yy: YyObject) => void) {
    expect(asset.project).to.equal(this.project);
    const path = this.file(asset.resource.id.path);
    const yy = await Yy.read(path, 'objects');
    change(yy);
    await Yy.write(path, yy, 'objects', this.project.yyp);
    await asset.reload();
    expectAvailable(this.project);
  }

  async updateExtension(
    asset: Asset<'extensions'>,
    change: (yy: YyExtension) => void,
  ) {
    expect(asset.project).to.equal(this.project);
    const path = this.file(asset.resource.id.path);
    const yy = await Yy.read(path, 'extensions');
    change(yy);
    await Yy.write(path, yy, 'extensions', this.project.yyp);
    await asset.reload();
    expectAvailable(this.project);
  }

  async removeFromYyp(name: string) {
    const path = this.file('fixture.yyp');
    const yyp = await Yy.read(path, 'project');
    expect(yyp.resources.some((item) => item.id.name === name)).to.equal(true);
    yyp.resources = yyp.resources.filter((item) => item.id.name !== name);
    // Keep the IDE unchanged so reloadYyp does not invoke runtime discovery.
    expect(yyp.MetaData.IDEVersion).to.equal(this.project.ideVersion);
    await Yy.write(path, yyp, 'project');
    await this.project.reloadYyp();
    expectAvailable(this.project);
  }
}

async function withFixture(
  action: (fixture: ResourceFixture) => Promise<void>,
  options?: ProjectOptions,
) {
  const root = await mkdtemp(join(tmpdir(), 'stitch-parser-resources-'));
  try {
    await action(new ResourceFixture(root, options));
  } finally {
    // Exactly this invocation's returned root; never a caller path, parent, or game.
    await rm(root, { recursive: true, force: true });
  }
}

function kinds(store: TypeStore | undefined): string[] {
  return [...new Set(store?.type.map((type) => type.kind) || [])].sort();
}

function definition(code: Code, name: string): Reference {
  const reference = code.refs.find(
    (item) => item.isDef && item.item.name === name,
  );
  expect(
    reference,
    `definition of ${name} in ${code.path.basename}`,
  ).not.to.equal(undefined);
  return reference!;
}

function expectValue(code: Code, name: string, kind: string) {
  expect(kinds(definition(code, name).item.type), name).to.deep.equal([kind]);
}

function missing(code: Code, name: string) {
  const diagnostics = code.getDiagnostics();
  return [
    ...diagnostics.UNDECLARED_GLOBAL_REFERENCE,
    ...diagnostics.UNDECLARED_VARIABLE_REFERENCE,
  ].filter((diagnostic) => diagnostic.message.includes(name));
}

function expectMissing(project: ResourceProject, code: Code, name: string) {
  const diagnostics = missing(code, name);
  expect(diagnostics, `one unresolved use of ${name}`).to.have.lengthOf(1);
  expect(diagnostics[0].location.start.offset).to.equal(
    code.content.indexOf(name),
  );
  expect(diagnostics[0].location.end.offset).to.equal(
    code.content.indexOf(name) + name.length - 1,
  );
  expect(project.publishedFor(code.path.absolute)).to.deep.include(
    diagnosticSummary(diagnostics[0]),
  );
}

function expectAvailable(project: ResourceProject) {
  expect(project.resourcesPending).to.equal(false);
  expect(project.analysis.error).to.equal(undefined);
  expect(project.analysis.isCurrent).to.equal(true);
  for (const asset of project.assets.values())
    for (const code of asset.gmlFiles.values()) {
      expect(['complete', 'degraded']).to.include(code.analysisState.status);
      expect(code.getDiagnostics().ANALYSIS).to.deep.equal([]);
      expect(project.analysis.document(code.path.absolute)).to.equal(code);
    }
}

function expectRetired(
  project: ResourceProject,
  code: Code,
  oldReferences: readonly Reference[],
) {
  expect(project.analysis.document(code.path.absolute)).to.equal(undefined);
  expect(code.analysisState.status).to.equal('retired');
  expect(code.refs).to.deep.equal([]);
  expect(
    project.analysis.references.some(
      (reference) => reference.ownerUnitId === code.path.absolute,
    ),
  ).to.equal(false);
  for (const reference of oldReferences) {
    expect(reference.item.refs.has(reference)).to.equal(false);
    expect(project.analysis.references).not.to.include(reference);
  }
  expect(project.publishedFor(code.path.absolute)).to.deep.equal([]);
}

function sorted<T>(items: T[]): T[] {
  return items.sort((left, right) =>
    (JSON.stringify(left) ?? '').localeCompare(JSON.stringify(right) ?? ''),
  );
}

function symbolSummary(symbol: Signifier) {
  const fn = symbol.getTypeByKind('Function');
  return {
    name: symbol.name,
    defined: !!symbol.def,
    type: symbol.type.toFeatherString(),
    macro: !!symbol.macro,
    returns: fn?.returns?.toFeatherString(),
    parameters: fn?.listParameters().map(
      (parameter) =>
        parameter && {
          name: parameter.name,
          type: parameter.type.toFeatherString(),
          optional: !!parameter.optional,
        },
    ),
  };
}

/** Public final semantics only, independent of transactions, absolute paths and identity. */
function snapshot(project: ResourceProject) {
  const fileName = (code: Code | undefined) =>
    code?.path.relativeFrom(project.dir).replace(/\\/g, '/');
  return {
    assets: [...project.assets.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((asset) => ({
        name: asset.name,
        kind: asset.assetKind,
        parent: asset.parent?.name,
        members: sorted(
          (asset.variables?.listMembers(true) || []).map(symbolSummary),
        ),
        extensionSymbols: sorted(
          [...asset.extensionSymbols.values()].map(symbolSummary),
        ),
        extensionTypes: [...asset.extensionTypes.keys()].sort(),
        files: [...asset.gmlFiles.values()]
          .sort((a, b) => a.path.basename.localeCompare(b.path.basename))
          .map((code) => ({
            file: fileName(code),
            status: code.analysisState.status,
            refs: sorted(
              code.refs.map((reference) => ({
                name: reference.item.name,
                isDef: reference.isDef,
                start: reference.start.offset,
                end: reference.end.offset,
                type: reference.item.type.toFeatherString(),
                evaluated: reference.evaluatedType?.toFeatherString(),
                definitionFile: fileName(reference.item.def?.file),
                definitionStart: reference.item.def?.file
                  ? reference.item.def.start.offset
                  : undefined,
                definitionEnd: reference.item.def?.file
                  ? reference.item.def.end.offset
                  : undefined,
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
      })),
    globals: sorted(
      project.self
        .listMembers(true)
        .filter((symbol) => !symbol.native)
        .map(symbolSummary),
    ),
    namedTypes: [...project.types]
      .filter(([name]) => !project.native.types.has(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, type]) => ({
        name,
        kind: type.kind,
        members: sorted(type.listMembers(true).map(symbolSummary)),
        returns: type.returns?.toFeatherString(),
      })),
  };
}

describe('Project resource reconciliation with owned temporary files', function () {
  it('removes YYP assets from the model without deleting or rewriting their original files', async function () {
    await withFixture(async (fixture) => {
      const removedResource = await fixture.script(
        'RemovedScript',
        'function audit_resource_removed() { return 1; }',
      );
      await fixture.script(
        'Consumer',
        'var result = audit_resource_removed();',
      );
      const project = await fixture.load();
      const removed = fixture.asset('RemovedScript', 'scripts');
      const removedCode = fixture.code('RemovedScript');
      const consumer = fixture.code('Consumer');
      const consumerSyntax = consumer.analysisState.syntaxVersion;
      const originalYy = await readFile(fixture.file(removedResource.id.path));
      const originalGml = await readFile(
        fixture.file('scripts/RemovedScript/RemovedScript.gml'),
      );
      expectValue(consumer, 'result', 'Real');
      expect(missing(consumer, 'audit_resource_removed')).to.deep.equal([]);
      expect(project.types.has('Function.audit_resource_removed')).to.equal(
        true,
      );
      const symbol = project.self.getMember('audit_resource_removed')!;
      const oldReferences = [...symbol.refs];

      await fixture.removeFromYyp('RemovedScript');

      expect(project.getAssetByName('RemovedScript')).to.equal(undefined);
      expect(removed.gmlFiles.size).to.equal(0);
      expectRetired(project, removedCode, oldReferences);
      expect(project.publishedFor(removed.yyPath.absolute)).to.deep.equal([]);
      expect(symbol.def).to.equal(undefined);
      expect(project.types.has('Function.audit_resource_removed')).to.equal(
        false,
      );
      expectMissing(project, consumer, 'audit_resource_removed');
      expect(kinds(definition(consumer, 'result').item.type)).not.to.deep.equal(
        ['Real'],
      );
      expect(consumer.analysisState.syntaxVersion).to.equal(consumerSyntax);
      expect(
        await readFile(fixture.file(removedResource.id.path)),
      ).to.deep.equal(originalYy);
      expect(
        await readFile(fixture.file('scripts/RemovedScript/RemovedScript.gml')),
      ).to.deep.equal(originalGml);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('reconciles listed YY events, retiring removed Code while leaving every GML file on disk', async function () {
    await withFixture(async (fixture) => {
      const sources = {
        'Create_0.gml': 'create_value = 1;',
        'Step_0.gml': 'var old_step_local = 2;',
        // A physical file is not a model event until it is listed in eventList.
        'Destroy_0.gml': 'var new_destroy_local = "added";',
      };
      await fixture.object('EventObject', sources, [0, 3]);
      const project = await fixture.load();
      const object = fixture.asset('EventObject', 'objects');
      const create = fixture.code('EventObject', 'Create_0.gml');
      const step = fixture.code('EventObject', 'Step_0.gml');
      const oldReferences = step.refs;
      const createSyntax = create.analysisState.syntaxVersion;
      expect(object.gmlFiles.size).to.equal(2);
      expect(
        [...object.gmlFiles.values()].some(
          (code) => code.path.basename === 'Destroy_0.gml',
        ),
      ).to.equal(false);
      expectValue(step, 'old_step_local', 'Real');

      await fixture.updateObject(object, (yy) => {
        yy.eventList = [0, 1].map((eventType) =>
          yyObjectEventSchema.parse({ eventType, eventNum: 0 }),
        );
      });

      expect(object.gmlFiles.size).to.equal(2);
      expectRetired(project, step, oldReferences);
      expect(fixture.code('EventObject', 'Create_0.gml')).to.equal(create);
      expect(create.analysisState.syntaxVersion).to.equal(createSyntax);
      const destroy = fixture.code('EventObject', 'Destroy_0.gml');
      expectValue(destroy, 'new_destroy_local', 'String');
      expect(project.analysis.document(destroy.path.absolute)).to.equal(
        destroy,
      );
      for (const [fileName, source] of Object.entries(sources)) {
        expect(
          await readFile(
            fixture.file(`objects/EventObject/${fileName}`),
            'utf8',
          ),
        ).to.equal(source);
      }
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('clears and replaces object parents, diagnoses metadata cycles, and repairs inheritance without stale fields', async function () {
    await withFixture(async (fixture) => {
      const parentAResource = await fixture.object('ParentA', {
        'Create_0.gml': 'inherited_value = 1; parent_a_only = true;',
      });
      await fixture.object('ParentB', {
        'Create_0.gml': 'inherited_value = "replacement"; parent_b_only = 2;',
      });
      const childSource =
        'event_inherited(); own_value = 3; var observed = inherited_value;';
      await fixture.object(
        'Child',
        { 'Create_0.gml': childSource },
        [0],
        parentAResource,
      );
      const project = await fixture.load();
      const parentA = fixture.asset('ParentA', 'objects');
      const parentB = fixture.asset('ParentB', 'objects');
      const child = fixture.asset('Child', 'objects');
      const childCode = fixture.code('Child', 'Create_0.gml');
      const childSyntax = childCode.analysisState.syntaxVersion;
      expect(child.parent).to.equal(parentA);
      expect(child.variables!.extends).to.equal(parentA.variables);
      expect(child.variables!.getMember('inherited_value')).to.equal(
        parentA.variables!.getMember('inherited_value'),
      );
      expectValue(childCode, 'observed', 'Real');

      await fixture.updateObject(child, (yy) => {
        yy.parentObjectId = null;
      });
      expect(child.parent).to.equal(undefined);
      expect(child.parents).to.deep.equal([]);
      expect(child.variables!.extends).not.to.equal(parentA.variables);
      expect(child.variables!.getMember('parent_a_only')).to.equal(undefined);
      expect(child.variables!.getMember('inherited_value')?.def).to.equal(
        undefined,
      );
      expect(
        kinds(definition(childCode, 'observed').item.type),
      ).not.to.deep.equal(['Real']);
      expect(project.publishedFor(child.yyPath.absolute)).to.deep.equal([]);

      await fixture.updateObject(child, (yy) => {
        yy.parentObjectId = parentB.resource.id;
      });
      expect(child.parent).to.equal(parentB);
      expect(child.parents).to.deep.equal([parentB]);
      expect(child.variables!.extends).to.equal(parentB.variables);
      expect(child.variables!.getMember('parent_a_only')).to.equal(undefined);
      expect(
        kinds(child.variables!.getMember('parent_b_only')?.type),
      ).to.deep.equal(['Real']);
      expectValue(childCode, 'observed', 'String');
      expect(missing(childCode, 'inherited_value')).to.deep.equal([]);
      // Both setter failures occur before its asynchronous save branch; no writes are launched.
      expect(() => {
        child.parent = child;
      }).to.throw(/cycle/i);
      expect(() => {
        parentB.parent = child;
      }).to.throw(/cycle/i);
      expect(child.parent).to.equal(parentB);
      expect(parentB.parent).to.equal(undefined);

      // Simulate externally edited invalid YY rather than constructing an impossible parent graph.
      await fixture.updateObject(parentB, (yy) => {
        yy.parentObjectId = child.resource.id;
      });
      expect(child.parent).to.equal(undefined);
      expect(parentB.parent).to.equal(undefined);
      expect(child.parents).to.deep.equal([]);
      expect(parentB.parents).to.deep.equal([]);
      for (const asset of [child, parentB]) {
        expect(
          project
            .publishedFor(asset.yyPath.absolute)
            .some((diagnostic) => /cycle/i.test(diagnostic.message)),
        ).to.equal(true);
        expect(asset.variables!.extends).not.to.equal(child.variables);
        expect(asset.variables!.extends).not.to.equal(parentB.variables);
      }

      await fixture.updateObject(parentB, (yy) => {
        yy.parentObjectId = null;
      });
      expect(child.parent).to.equal(parentB);
      expect(parentB.parent).to.equal(undefined);
      expect(child.variables!.extends).to.equal(parentB.variables);
      expectValue(childCode, 'observed', 'String');
      expect(child.variables!.getMember('parent_a_only')).to.equal(undefined);
      expect(project.publishedFor(child.yyPath.absolute)).to.deep.equal([]);
      expect(project.publishedFor(parentB.yyPath.absolute)).to.deep.equal([]);
      expect(childCode.analysisState.syntaxVersion).to.equal(childSyntax);
      expect(
        await readFile(fixture.file('objects/Child/Create_0.gml'), 'utf8'),
      ).to.equal(childSource);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));

      // A child Create overrides the parent Create unless it explicitly calls it.
      await writeFile(
        fixture.file('objects/Child/Create_0.gml'),
        'own_value = 3; var observed = inherited_value;',
        'utf8',
      );
      await child.reload();
      expect(child.variables!.extends).not.to.equal(parentB.variables);
      expect(child.variables!.getMember('parent_b_only')).to.equal(undefined);
      expect(
        kinds(definition(childCode, 'observed').item.type),
      ).not.to.deep.equal(['String']);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      await writeFile(
        fixture.file('objects/Child/Create_0.gml'),
        childSource,
        'utf8',
      );
      await child.reload();
      expectValue(childCode, 'observed', 'String');
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      // With no own Create event, the parent's Create is inherited implicitly.
      await fixture.updateObject(child, (yy) => {
        yy.eventList = [];
      });
      expect(child.gmlFiles.size).to.equal(0);
      expect(child.variables!.extends).to.equal(parentB.variables);
      expect(
        kinds(child.variables!.getMember('inherited_value')?.type),
      ).to.deep.equal(['String']);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('updates extension return/constant types and retires removed symbols and whole extension resources', async function () {
    await withFixture(async (fixture) => {
      const resource = await fixture.extension('AuditExtension');
      await fixture.script(
        'ExtensionConsumer',
        [
          'var from_function = audit_resource_ext_fn();',
          'var from_constant = AUDIT_RESOURCE_EXT_CONST;',
        ].join('\n'),
      );
      const project = await fixture.load();
      const extension = fixture.asset('AuditExtension', 'extensions');
      const consumer = fixture.code('ExtensionConsumer');
      const syntaxVersion = consumer.analysisState.syntaxVersion;
      expect(extension.extensionSymbols.size).to.equal(2);
      expect(
        extension.extensionTypes.has('Function.audit_resource_ext_fn'),
      ).to.equal(true);
      expectValue(consumer, 'from_function', 'Real');
      expectValue(consumer, 'from_constant', 'Real');
      expect(missing(consumer, 'audit_resource_ext_fn')).to.deep.equal([]);
      expect(missing(consumer, 'AUDIT_RESOURCE_EXT_CONST')).to.deep.equal([]);
      expect(project.types.has('Function.audit_resource_ext_fn')).to.equal(
        true,
      );
      expect(
        project.self.getMember('AUDIT_RESOURCE_EXT_CONST')?.macro,
      ).to.equal(true);

      await fixture.updateExtension(extension, (yy) => {
        yy.files[0].functions[0].returnType = 1;
        yy.files[0].constants[0].value = '"changed"';
      });
      expectValue(consumer, 'from_function', 'String');
      expectValue(consumer, 'from_constant', 'String');
      expect(
        kinds(
          project.self
            .getMember('audit_resource_ext_fn')
            ?.getTypeByKind('Function')?.returns,
        ),
      ).to.deep.equal(['String']);
      expect(consumer.analysisState.syntaxVersion).to.equal(syntaxVersion);

      await fixture.updateExtension(extension, (yy) => {
        yy.files[0].functions = [];
      });
      expect(extension.extensionSymbols.has('audit_resource_ext_fn')).to.equal(
        false,
      );
      expect(
        extension.extensionTypes.has('Function.audit_resource_ext_fn'),
      ).to.equal(false);
      expect(project.types.has('Function.audit_resource_ext_fn')).to.equal(
        false,
      );
      expect(project.self.getMember('audit_resource_ext_fn')?.def).to.equal(
        undefined,
      );
      expectMissing(project, consumer, 'audit_resource_ext_fn');
      expect(
        kinds(definition(consumer, 'from_function').item.type),
      ).not.to.deep.equal(['String']);
      expectValue(consumer, 'from_constant', 'String');
      expect(missing(consumer, 'AUDIT_RESOURCE_EXT_CONST')).to.deep.equal([]);

      const originalYy = await readFile(fixture.file(resource.id.path));
      await fixture.removeFromYyp('AuditExtension');
      expect(project.getAssetByName('AuditExtension')).to.equal(undefined);
      expect(extension.extensionSymbols.size).to.equal(0);
      expect(extension.extensionTypes.size).to.equal(0);
      expect(project.self.getMember('AUDIT_RESOURCE_EXT_CONST')?.def).to.equal(
        undefined,
      );
      expectMissing(project, consumer, 'audit_resource_ext_fn');
      expectMissing(project, consumer, 'AUDIT_RESOURCE_EXT_CONST');
      expect(
        kinds(definition(consumer, 'from_constant').item.type),
      ).not.to.deep.equal(['String']);
      expect(project.publishedFor(extension.yyPath.absolute)).to.deep.equal([]);
      expect(await readFile(fixture.file(resource.id.path))).to.deep.equal(
        originalYy,
      );
      expect(consumer.analysisState.syntaxVersion).to.equal(syntaxVersion);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });
});

/** Add real room metadata without expanding the existing fixture's production API surface. */
async function addRenameRoomFixture(
  fixture: ResourceFixture,
  name: string,
  objects: readonly YypResource[],
) {
  const resource: YypResource = {
    id: { name, path: `rooms/${name}/${name}.yy` },
  };
  const yy = Yy.schemas.rooms.parse({
    name,
    layers: [
      {
        resourceType: 'GMRInstanceLayer',
        name: 'Instances',
        instances: objects.map((object, index) => ({
          name: `inst_rename_${index}`,
          objectId: object.id,
          x: index * 32,
          y: index * 16,
        })),
      },
    ],
    instanceCreationOrder: objects.map((_, index) => ({
      name: `inst_rename_${index}`,
      path: resource.id.path,
    })),
  });
  await Yy.write(
    fixture.file(resource.id.path),
    yy,
    'rooms',
    fixture.project.yyp,
  );
  fixture.project.yyp.resources.push(resource);
  return resource;
}

function roomObjectReferences(yy: YyData<'rooms'>) {
  return yy.layers.flatMap((layer) =>
    layer.resourceType === 'GMRInstanceLayer'
      ? layer.instances.map((instance) => ({
          name: instance.name,
          objectId: instance.objectId,
        }))
      : [],
  );
}

describe('Project rename APIs with owned temporary files', function () {
  it('renames an object in external GML and its copied own code, retiring the old physical document', async function () {
    await withFixture(async (fixture) => {
      const originalCreate = [
        'var own_asset = RenameBefore;',
        'health = 1;',
        'var label = "RenameBefore";',
        '// RenameBefore must remain a comment',
      ].join('\n');
      const originalConsumer = [
        'var target = RenameBefore;',
        'var label = "RenameBefore";',
        '// RenameBefore must remain a comment',
      ].join('\n');
      await fixture.object('RenameBefore', { 'Create_0.gml': originalCreate });
      await fixture.script('RenameConsumer', originalConsumer);
      const project = await fixture.load();
      const oldAsset = fixture.asset('RenameBefore', 'objects');
      const oldCode = fixture.code('RenameBefore', 'Create_0.gml');
      const consumer = fixture.code('RenameConsumer');
      const oldReferences = [...oldAsset.signifier.refs];
      expect(
        oldCode.refs.some(
          (reference) =>
            reference.item === oldAsset.signifier && !reference.isDef,
        ),
      ).to.equal(true);
      expect(
        consumer.refs.some(
          (reference) =>
            reference.item === oldAsset.signifier && !reference.isDef,
        ),
      ).to.equal(true);
      expect(project.types.has(oldAsset.typeName)).to.equal(true);
      expect(project.types.has(oldAsset.instanceTypeName)).to.equal(true);

      await project.renameAsset('RenameBefore', 'RenameAfter');
      expectAvailable(project);

      const renamed = fixture.asset('RenameAfter', 'objects');
      const newCode = fixture.code('RenameAfter', 'Create_0.gml');
      const expectedCreate = originalCreate.replace(
        '= RenameBefore;',
        '= RenameAfter;',
      );
      const expectedConsumer = originalConsumer.replace(
        '= RenameBefore;',
        '= RenameAfter;',
      );
      expect(project.getAssetByName('RenameBefore')).to.equal(undefined);
      expect(newCode).not.to.equal(oldCode);
      expect(newCode.content).to.equal(expectedCreate);
      expect(consumer.content).to.equal(expectedConsumer);
      expect(
        await readFile(
          fixture.file('objects/RenameAfter/Create_0.gml'),
          'utf8',
        ),
      ).to.equal(expectedCreate);
      expect(
        await readFile(
          fixture.file('scripts/RenameConsumer/RenameConsumer.gml'),
          'utf8',
        ),
      ).to.equal(expectedConsumer);
      expect(
        (await Yy.read(fixture.file(renamed.resource.id.path), 'objects')).name,
      ).to.equal('RenameAfter');
      expect(
        await pathy(
          fixture.file('objects/RenameBefore/RenameBefore.yy'),
        ).exists(),
      ).to.equal(false);
      expect(
        await pathy(fixture.file('objects/RenameBefore/Create_0.gml')).exists(),
      ).to.equal(false);
      expectRetired(project, oldCode, oldReferences);
      expect(project.publishedFor(oldAsset.yyPath.absolute)).to.deep.equal([]);
      expect(project.types.has(oldAsset.typeName)).to.equal(false);
      expect(project.types.has(oldAsset.instanceTypeName)).to.equal(false);
      expect(project.types.has(renamed.typeName)).to.equal(true);
      expect(project.types.has(renamed.instanceTypeName)).to.equal(true);
      for (const code of [newCode, consumer]) {
        expect(
          code.refs.some((reference) => reference.item.name === 'RenameBefore'),
        ).to.equal(false);
        expect(
          code.refs.some(
            (reference) =>
              reference.item === renamed.signifier && !reference.isDef,
          ),
        ).to.equal(true);
        expect(missing(code, 'RenameAfter')).to.deep.equal([]);
        expect(project.publishedFor(code.path.absolute)).to.deep.equal([]);
      }
      expect(kinds(definition(newCode, 'own_asset').item.type)).to.deep.equal([
        'Asset.GMObject',
      ]);
      expect(definition(newCode, 'own_asset').item.type.type[0].name).to.equal(
        'RenameAfter',
      );
      expect(definition(consumer, 'target').item.type.type[0].name).to.equal(
        'RenameAfter',
      );
      const yyp = await Yy.read(fixture.file('fixture.yyp'), 'project');
      expect(
        yyp.resources.some((resource) => resource.id.name === 'RenameBefore'),
      ).to.equal(false);
      expect(
        yyp.resources
          .filter((resource) => resource.id.name === 'RenameAfter')
          .map((resource) => resource.id),
      ).to.deep.equal([renamed.resource.id]);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('migrates child, room-instance and collision references rather than deleting them during object rename', async function () {
    await withFixture(async (fixture) => {
      const before = await fixture.object('MetadataBefore', {
        'Create_0.gml': 'inherited_value = 7;',
      });
      const unrelated = await fixture.object('UnrelatedObject', {
        'Create_0.gml': 'unrelated_value = 2;',
      });
      const childSource = 'event_inherited(); var observed = inherited_value;';
      await fixture.object(
        'RenameChild',
        { 'Create_0.gml': childSource },
        [0],
        before,
      );
      const collisionSource = 'var renamed_hit = 5;';
      const unrelatedCollisionSource = 'var unrelated_hit = "keep";';
      const colliderResource = await fixture.object(
        'CollisionOwner',
        {
          'Collision_MetadataBefore.gml': collisionSource,
          'Collision_UnrelatedObject.gml': unrelatedCollisionSource,
        },
        [],
      );
      const colliderYy = await Yy.read(
        fixture.file(colliderResource.id.path),
        'objects',
      );
      colliderYy.eventList = [before, unrelated].map((resource) =>
        yyObjectEventSchema.parse({
          eventType: 4,
          eventNum: 0,
          collisionObjectId: resource.id,
        }),
      );
      await Yy.write(
        fixture.file(colliderResource.id.path),
        colliderYy,
        'objects',
        fixture.project.yyp,
      );
      const roomResource = await addRenameRoomFixture(fixture, 'RenameRoom', [
        before,
        unrelated,
      ]);
      const project = await fixture.load();
      const oldCode = fixture.code('MetadataBefore', 'Create_0.gml');
      const oldCodeReferences = oldCode.refs;
      const child = fixture.asset('RenameChild', 'objects');
      const childCode = fixture.code('RenameChild', 'Create_0.gml');
      const collider = fixture.asset('CollisionOwner', 'objects');
      const oldCollision = fixture.code(
        'CollisionOwner',
        'Collision_MetadataBefore.gml',
      );
      const oldCollisionReferences = oldCollision.refs;
      const room = project.getAssetByName('RenameRoom', { assertExists: true });
      if (!isAssetOfKind(room, 'rooms'))
        throw new Error('Expected the real room fixture');
      expect(child.parent?.name).to.equal('MetadataBefore');
      expectValue(childCode, 'observed', 'Real');
      expectValue(oldCollision, 'renamed_hit', 'Real');
      expect(
        room.roomInstances.map((instance) => instance.object.name),
      ).to.deep.equal(['MetadataBefore', 'UnrelatedObject']);
      expect(collider.gmlFiles.size).to.equal(2);
      const originalOrder = (
        await Yy.read(fixture.file(roomResource.id.path), 'rooms')
      ).instanceCreationOrder;

      await project.renameAsset('MetadataBefore', 'MetadataAfter');
      expectAvailable(project);

      const renamed = fixture.asset('MetadataAfter', 'objects');
      const persistedChild = await Yy.read(
        fixture.file(child.resource.id.path),
        'objects',
      );
      const persistedCollider = await Yy.read(
        fixture.file(collider.resource.id.path),
        'objects',
      );
      const persistedRoom = await Yy.read(
        fixture.file(roomResource.id.path),
        'rooms',
      );
      const expectedRoomReferences = [
        { name: 'inst_rename_0', objectId: renamed.resource.id },
        { name: 'inst_rename_1', objectId: unrelated.id },
      ];
      // A single metadata summary exposes deletion/corruption of each applicable link.
      expect({
        parent: child.parent?.name,
        parentId: child.yy.parentObjectId,
        persistedParentId: persistedChild.parentObjectId,
        room: roomObjectReferences(room.yy),
        persistedRoom: roomObjectReferences(persistedRoom),
        collisions: collider.yy.eventList
          .map((event) => event.collisionObjectId)
          .sort((a, b) => (a?.name || '').localeCompare(b?.name || '')),
        persistedCollisions: persistedCollider.eventList
          .map((event) => event.collisionObjectId)
          .sort((a, b) => (a?.name || '').localeCompare(b?.name || '')),
      }).to.deep.equal({
        parent: 'MetadataAfter',
        parentId: renamed.resource.id,
        persistedParentId: renamed.resource.id,
        room: expectedRoomReferences,
        persistedRoom: expectedRoomReferences,
        collisions: [renamed.resource.id, unrelated.id],
        persistedCollisions: [renamed.resource.id, unrelated.id],
      });
      expect(persistedRoom.instanceCreationOrder).to.deep.equal(originalOrder);
      expect(
        room.roomInstances.map((instance) => instance.object.name),
      ).to.deep.equal(['MetadataAfter', 'UnrelatedObject']);
      expect(child.parent).to.equal(renamed);
      expect(childCode.content).to.equal(childSource);
      expectValue(childCode, 'observed', 'Real');
      expect(
        await readFile(
          fixture.file('objects/RenameChild/Create_0.gml'),
          'utf8',
        ),
      ).to.equal(childSource);
      expectRetired(project, oldCode, oldCodeReferences);
      expectRetired(project, oldCollision, oldCollisionReferences);
      const collision = fixture.code(
        'CollisionOwner',
        'Collision_MetadataAfter.gml',
      );
      expect(collision.content).to.equal(collisionSource);
      expectValue(collision, 'renamed_hit', 'Real');
      expect(collider.gmlFiles.size).to.equal(2);
      expect(
        await pathy(
          fixture.file('objects/CollisionOwner/Collision_MetadataBefore.gml'),
        ).exists(),
      ).to.equal(false);
      expect(
        await readFile(
          fixture.file('objects/CollisionOwner/Collision_MetadataAfter.gml'),
          'utf8',
        ),
      ).to.equal(collisionSource);
      expect(
        await readFile(
          fixture.file('objects/CollisionOwner/Collision_UnrelatedObject.gml'),
          'utf8',
        ),
      ).to.equal(unrelatedCollisionSource);
      expectValue(
        fixture.code('CollisionOwner', 'Collision_UnrelatedObject.gml'),
        'unrelated_hit',
        'String',
      );
      expect(project.getAssetByName('MetadataBefore')).to.equal(undefined);
      expect(project.publishedFor(child.yyPath.absolute)).to.deep.equal([]);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('renames a global function across real files while preserving distinct local bindings, strings and comments', async function () {
    await withFixture(async (fixture) => {
      const providerSource = (name: string) =>
        [
          '/// @param {Real} value',
          '/// @returns {Real}',
          `function ${name}(value) { return value; }`,
          `var own_result = ${name}(1);`,
          'var label = "audit_rename_before";',
          '// audit_rename_before must remain a comment',
        ].join('\n');
      const consumerSource = [
        'var result = audit_rename_before(2);',
        'function audit_shadow_reader() {',
        '  var audit_rename_before = function() { return "shadow"; };',
        '  return audit_rename_before();',
        '}',
        'var shadow_result = audit_shadow_reader();',
        'var label = "audit_rename_before";',
        '// audit_rename_before must remain a comment',
      ].join('\n');
      await fixture.script(
        'RenameProvider',
        providerSource('audit_rename_before'),
      );
      await fixture.script('RenameUser', consumerSource);
      const project = await fixture.load();
      const provider = fixture.code('RenameProvider');
      const consumer = fixture.code('RenameUser');
      const target = project.self.getMember('audit_rename_before');
      expect(target?.def?.file).to.equal(provider);
      expect(target!.refs.size).to.be.at.least(3);
      expect(
        consumer.refs.filter(
          (reference) =>
            reference.item.name === 'audit_rename_before' &&
            reference.item !== target,
        ).length,
      ).to.be.at.least(2);
      expectValue(provider, 'own_result', 'Real');
      expectValue(consumer, 'result', 'Real');
      expectValue(consumer, 'shadow_result', 'String');
      const oldReferences = [...target!.refs];
      const providerSyntax = provider.analysisState.syntaxVersion;
      const consumerSyntax = consumer.analysisState.syntaxVersion;

      await project.renameSignifier(target!, 'audit_renamed_function');
      expectAvailable(project);

      const expectedProvider = providerSource('audit_renamed_function');
      const expectedConsumer = consumerSource.replace(
        '= audit_rename_before(2);',
        '= audit_renamed_function(2);',
      );
      expect(provider.content).to.equal(expectedProvider);
      expect(consumer.content).to.equal(expectedConsumer);
      expect(
        await readFile(
          fixture.file('scripts/RenameProvider/RenameProvider.gml'),
          'utf8',
        ),
      ).to.equal(expectedProvider);
      expect(
        await readFile(
          fixture.file('scripts/RenameUser/RenameUser.gml'),
          'utf8',
        ),
      ).to.equal(expectedConsumer);
      expect(project.analysis.document(provider.path.absolute)).to.equal(
        provider,
      );
      expect(project.analysis.document(consumer.path.absolute)).to.equal(
        consumer,
      );
      expect(provider.analysisState.syntaxVersion).to.be.greaterThan(
        providerSyntax,
      );
      expect(consumer.analysisState.syntaxVersion).to.be.greaterThan(
        consumerSyntax,
      );
      const renamed = project.self.getMember('audit_renamed_function');
      expect(renamed?.def?.file).to.equal(provider);
      expect(kinds(renamed?.getTypeByKind('Function')?.returns)).to.deep.equal([
        'Real',
      ]);
      expect(project.self.getMember('audit_rename_before')?.def).to.equal(
        undefined,
      );
      expect(
        consumer.refs.filter(
          (reference) => reference.item.name === 'audit_rename_before',
        ).length,
      ).to.be.at.least(2);
      expectValue(provider, 'own_result', 'Real');
      expectValue(consumer, 'result', 'Real');
      expectValue(consumer, 'shadow_result', 'String');
      expect(missing(provider, 'audit_renamed_function')).to.deep.equal([]);
      expect(missing(consumer, 'audit_renamed_function')).to.deep.equal([]);
      expect(missing(consumer, 'audit_rename_before')).to.deep.equal([]);
      for (const reference of oldReferences) {
        expect(project.analysis.references).not.to.include(reference);
        expect(reference.item.refs.has(reference)).to.equal(false);
      }
      expect(project.publishedFor(provider.path.absolute)).to.deep.equal([]);
      expect(project.publishedFor(consumer.path.absolute)).to.deep.equal([]);
      expect(
        (await Yy.read(fixture.file('fixture.yyp'), 'project')).resources
          .map((resource) => resource.id.name)
          .sort(),
      ).to.deep.equal(['RenameProvider', 'RenameUser']);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });
});

/** Host boundary only: production helpers own text edits, path mapping and real disk moves. */
async function applyFixtureHostBatch(
  fixture: ResourceFixture,
  buffers: Map<string, string>,
  batch: ProjectEditBatch,
) {
  for (const document of batch.documents) {
    fixture.file(document.filePath);
    if (buffers.has(document.filePath))
      expect(buffers.get(document.filePath)).to.equal(document.expectedText);
  }
  for (const move of batch.renames) {
    fixture.file(move.from);
    fixture.file(move.to);
  }
  // Dirty documents belong to the host, never the disk writer. Metadata and moves are real.
  await applyDiskEdits({
    ...batch,
    documents: batch.documents.filter(
      (document) => !buffers.has(document.filePath),
    ),
  });
  batch.validate();
  const next = [...buffers].map(([filePath, text]) => {
    const document = batch.documents.find((item) => item.filePath === filePath);
    return [
      pathy(renamedPath(filePath, batch.renames)).absolute,
      document ? editedText(document) : text,
    ] as const;
  });
  buffers.clear();
  for (const [filePath, text] of next) buffers.set(filePath, text);
}

async function rejectedEdit(
  action: () => Promise<unknown>,
): Promise<ProjectEditError> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(
    failure,
    'the public rename rejects rather than reporting success',
  ).to.be.instanceOf(ProjectEditError);
  return failure as ProjectEditError;
}

describe('Project resource and edit host boundaries with owned temporary files', function () {
  it('retires a resource whose YY disappears and restores it through reloadResource without reviving old Code', async function () {
    await withFixture(async (fixture) => {
      const source = 'function audit_missing_yy() { return 1; }';
      const resource = await fixture.script('MissingYyProvider', source);
      await fixture.script(
        'MissingYyConsumer',
        'var result = audit_missing_yy();',
      );
      const project = await fixture.load();
      const oldAsset = fixture.asset('MissingYyProvider', 'scripts');
      const oldCode = fixture.code('MissingYyProvider');
      const consumer = fixture.code('MissingYyConsumer');
      const oldReferences = [
        ...project.self.getMember('audit_missing_yy')!.refs,
      ];
      const consumerSyntax = consumer.analysisState.syntaxVersion;
      const yyPath = fixture.file(resource.id.path);
      const originalYy = await readFile(yyPath, 'utf8');
      expectValue(consumer, 'result', 'Real');

      await rm(yyPath);
      await project.reloadResource(pathy(yyPath));
      expectAvailable(project);
      expect(project.getAssetByName('MissingYyProvider')).to.equal(undefined);
      expect(
        project.yyp.resources.some(
          (item) => item.id.name === 'MissingYyProvider',
        ),
      ).to.equal(true);
      expect(oldAsset.gmlFiles.size).to.equal(0);
      expectRetired(project, oldCode, oldReferences);
      expect(project.types.has('Function.audit_missing_yy')).to.equal(false);
      expectMissing(project, consumer, 'audit_missing_yy');
      const diagnostics = project.publishedFor(oldAsset.yyPath.absolute);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0].message).to.match(
        /listed resource file is missing.*MissingYyProvider/i,
      );
      expect(diagnostics[0]).to.include({
        severity: 'error',
        start: 0,
        end: 0,
      });
      expect(
        await readFile(
          fixture.file('scripts/MissingYyProvider/MissingYyProvider.gml'),
          'utf8',
        ),
      ).to.equal(source);

      await writeFile(yyPath, originalYy, 'utf8');
      await project.reloadResource(pathy(yyPath));
      expectAvailable(project);
      const restored = fixture.code('MissingYyProvider');
      expect(restored).not.to.equal(oldCode);
      expect(project.analysis.document(oldCode.path.absolute)).to.equal(
        restored,
      );
      expect(oldCode.analysisState.status).to.equal('retired');
      expect(oldCode.refs).to.deep.equal([]);
      expect(project.self.getMember('audit_missing_yy')?.def?.file).to.equal(
        restored,
      );
      expectValue(consumer, 'result', 'Real');
      expect(missing(consumer, 'audit_missing_yy')).to.deep.equal([]);
      expect(project.publishedFor(oldAsset.yyPath.absolute)).to.deep.equal([]);
      expect(consumer.analysisState.syntaxVersion).to.equal(consumerSyntax);
      expect(await readFile(yyPath, 'utf8')).to.equal(originalYy);
      expect(
        await readFile(
          fixture.file('scripts/MissingYyProvider/MissingYyProvider.gml'),
          'utf8',
        ),
      ).to.equal(source);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('merges missing listed GML and parent errors at one YY URI and clears each producer independently', async function () {
    await withFixture(async (fixture) => {
      const createSource = 'var create_value = 1;';
      const stepSource = 'var step_value = "restored";';
      const resource = await fixture.object(
        'DiagnosticOwners',
        { 'Create_0.gml': createSource },
        [0, 3],
        {
          id: {
            name: 'UnavailableParent',
            path: 'objects/UnavailableParent/UnavailableParent.yy',
          },
        },
      );
      const project = await fixture.load();
      const object = fixture.asset('DiagnosticOwners', 'objects');
      const oldCreate = fixture.code('DiagnosticOwners', 'Create_0.gml');
      const oldReferences = oldCreate.refs;
      const yyUri = object.yyPath.absolute;
      const initial = project.publishedFor(yyUri);
      expect(initial).to.have.lengthOf(2);
      expect(
        initial.some((item) =>
          /listed GML file is missing: Step_0\.gml/i.test(item.message),
        ),
      ).to.equal(true);
      expect(
        initial.some((item) =>
          /parent object UnavailableParent is unavailable/i.test(item.message),
        ),
      ).to.equal(true);
      expect(
        initial.every(
          (item) =>
            item.severity === 'error' && item.start === 0 && item.end === 0,
        ),
      ).to.equal(true);
      expect(object.parent).to.equal(undefined);

      await writeFile(
        fixture.file('objects/DiagnosticOwners/Step_0.gml'),
        stepSource,
        'utf8',
      );
      await project.reloadResource(pathy(fixture.file(resource.id.path)));
      expectAvailable(project);
      const parentOnly = project.publishedFor(yyUri);
      expect(parentOnly).to.have.lengthOf(1);
      expect(parentOnly[0].message).to.match(
        /parent object UnavailableParent is unavailable/i,
      );
      expectValue(
        fixture.code('DiagnosticOwners', 'Step_0.gml'),
        'step_value',
        'String',
      );
      expect(fixture.code('DiagnosticOwners', 'Create_0.gml')).to.equal(
        oldCreate,
      );

      await rm(fixture.file('objects/DiagnosticOwners/Create_0.gml'));
      await fixture.updateObject(object, (yy) => {
        yy.parentObjectId = null;
      });
      const filesOnly = project.publishedFor(yyUri);
      expect(filesOnly).to.have.lengthOf(1);
      expect(filesOnly[0].message).to.match(
        /listed GML file is missing: Create_0\.gml/i,
      );
      expectRetired(project, oldCreate, oldReferences);
      expect(object.parent).to.equal(undefined);
      expectValue(
        fixture.code('DiagnosticOwners', 'Step_0.gml'),
        'step_value',
        'String',
      );

      await writeFile(
        fixture.file('objects/DiagnosticOwners/Create_0.gml'),
        createSource,
        'utf8',
      );
      await project.reloadResource(pathy(fixture.file(resource.id.path)));
      expectAvailable(project);
      expect(project.publishedFor(yyUri)).to.deep.equal([]);
      expect(fixture.code('DiagnosticOwners', 'Create_0.gml')).not.to.equal(
        oldCreate,
      );
      expectValue(
        fixture.code('DiagnosticOwners', 'Create_0.gml'),
        'create_value',
        'Real',
      );
      expect(
        await readFile(
          fixture.file('objects/DiagnosticOwners/Step_0.gml'),
          'utf8',
        ),
      ).to.equal(stepSource);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('clears missing-YY diagnostics when a never-successfully-loaded resource leaves the YYP', async function () {
    await withFixture(async (fixture) => {
      const source = 'function audit_never_loaded() { return 1; }';
      const resource = await fixture.script('NeverLoaded', source);
      await fixture.script('SurvivingScript', 'var surviving_value = "kept";');
      const yyPath = fixture.file(resource.id.path);
      const yyUri = pathy(yyPath).absolute;
      await rm(yyPath);
      const project = await fixture.load();
      expect(project.getAssetByName('NeverLoaded')).to.equal(undefined);
      expect(
        project.analysis.document(
          pathy(fixture.file('scripts/NeverLoaded/NeverLoaded.gml')).absolute,
        ),
      ).to.equal(undefined);
      const diagnostics = project.publishedFor(yyUri);
      expect(diagnostics).to.have.lengthOf(1);
      expect(diagnostics[0].message).to.match(
        /listed resource file is missing.*NeverLoaded/i,
      );
      expect(project.self.getMember('audit_never_loaded')?.def).to.equal(
        undefined,
      );
      const surviving = fixture.code('SurvivingScript');
      const syntaxVersion = surviving.analysisState.syntaxVersion;

      await fixture.removeFromYyp('NeverLoaded');
      expect(project.publishedFor(yyUri)).to.deep.equal([]);
      expect(fixture.code('SurvivingScript')).to.equal(surviving);
      expect(surviving.analysisState.syntaxVersion).to.equal(syntaxVersion);
      expectValue(surviving, 'surviving_value', 'String');
      expect(await pathy(yyPath).exists()).to.equal(false);
      expect(
        await readFile(
          fixture.file('scripts/NeverLoaded/NeverLoaded.gml'),
          'utf8',
        ),
      ).to.equal(source);
      await project.reloadYyp();
      expectAvailable(project);
      expect(project.publishedFor(yyUri)).to.deep.equal([]);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    });
  });

  it('falls back to the valid first-child configuration after the selected configuration is removed', async function () {
    // Explicit empty options exercise the real default instead of the old fixtures' Default pin.
    await withFixture(async (fixture) => {
      fixture.project.yyp.configs = {
        name: 'Default',
        children: [
          { name: 'Fallback', children: [] },
          { name: 'Selected', children: [] },
        ],
      };
      const providerSource = [
        '#macro AUDIT_REMOVED_CONFIG 1',
        '#macro Fallback:AUDIT_REMOVED_CONFIG "fallback"',
        '#macro Selected:AUDIT_REMOVED_CONFIG 2',
      ].join('\n');
      const consumerSource = 'var configured_value = AUDIT_REMOVED_CONFIG;';
      await fixture.script('ConfigurationProvider', providerSource);
      await fixture.script('ConfigurationConsumer', consumerSource);
      const project = await fixture.load();
      const consumer = fixture.code('ConfigurationConsumer');
      expect(project.defaultAnalysisConfiguration).to.equal('Fallback');
      expect(project.analysisConfigurationLineage).to.deep.equal([
        'Default',
        'Fallback',
      ]);
      expectValue(consumer, 'configured_value', 'String');
      await project.setAnalysisConfiguration('Selected');
      expect(project.analysisConfigurationLineage).to.deep.equal([
        'Default',
        'Selected',
      ]);
      expectValue(consumer, 'configured_value', 'Real');
      const selectedSyntax = consumer.analysisState.syntaxVersion;
      const contentVersion = consumer.analysisState.contentVersion;

      const yyp = await Yy.read(fixture.file('fixture.yyp'), 'project');
      yyp.configs.children = yyp.configs.children.filter(
        (config) => config.name !== 'Selected',
      );
      await Yy.write(fixture.file('fixture.yyp'), yyp, 'project');
      await project.reloadYyp();
      expectAvailable(project);
      expect(project.configs).not.to.include('Selected');
      expect(project.analysisConfigurationLineage).to.deep.equal([
        'Default',
        'Fallback',
      ]);
      expect(project.defaultAnalysisConfiguration).to.equal('Fallback');
      expectValue(consumer, 'configured_value', 'String');
      expect(consumer.analysisState.contentVersion).to.equal(contentVersion);
      expect(consumer.analysisState.syntaxVersion).to.be.greaterThan(
        selectedSyntax,
      );
      expect(consumer.getDiagnostics().SYNTAX_ERROR).to.deep.equal([]);
      expect(missing(consumer, 'AUDIT_REMOVED_CONFIG')).to.deep.equal([]);
      expect(
        await readFile(
          fixture.file(
            'scripts/ConfigurationProvider/ConfigurationProvider.gml',
          ),
          'utf8',
        ),
      ).to.equal(providerSource);
      expect(
        await readFile(
          fixture.file(
            'scripts/ConfigurationConsumer/ConfigurationConsumer.gml',
          ),
          'utf8',
        ),
      ).to.equal(consumerSource);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
    }, {});
  });
});

describe('Project and Code rename callbacks with dirty host documents', function () {
  it('applies a real resource rename through the host without persisting dirty GML buffers to disk', async function () {
    const buffers = new Map<string, string>();
    const options: ProjectOptions = {
      documentText: (filePath) => buffers.get(pathy(filePath).absolute),
    };
    await withFixture(async (fixture) => {
      const diskCreate = 'var own_asset = HostBefore; health = 1;';
      const diskConsumer = 'var target = HostBefore;';
      const dirtyCreate = `${diskCreate}\nvar unsaved_create = "host-only";\n// HostBefore stays a comment`;
      const dirtyConsumer = `${diskConsumer}\nvar label = "HostBefore";\nvar unsaved_consumer = "host-only";`;
      await fixture.object('HostBefore', { 'Create_0.gml': diskCreate });
      await fixture.script('HostResourceConsumer', diskConsumer);
      const oldCreateUri = pathy(
        fixture.file('objects/HostBefore/Create_0.gml'),
      ).absolute;
      const consumerUri = pathy(
        fixture.file('scripts/HostResourceConsumer/HostResourceConsumer.gml'),
      ).absolute;
      buffers.set(oldCreateUri, dirtyCreate);
      buffers.set(consumerUri, dirtyConsumer);
      const batches: ProjectEditBatch[] = [];
      options.applyEdits = async (batch) => {
        batches.push(batch);
        await applyFixtureHostBatch(fixture, buffers, batch);
        return true;
      };
      const project = await fixture.load();
      const before = fixture.asset('HostBefore', 'objects');
      const oldCode = fixture.code('HostBefore', 'Create_0.gml');
      const consumer = fixture.code('HostResourceConsumer');
      const oldReferences = [...before.signifier.refs];
      expect(oldCode.content).to.equal(dirtyCreate);
      expect(consumer.content).to.equal(dirtyConsumer);
      expectValue(oldCode, 'unsaved_create', 'String');

      await project.renameAsset('HostBefore', 'HostAfter');
      expectAvailable(project);
      expect(batches).to.have.lengthOf(1);
      const batch = batches[0];
      expect(
        batch.documents.find((item) => item.filePath === oldCreateUri)
          ?.expectedText,
      ).to.equal(dirtyCreate);
      expect(
        batch.documents.find((item) => item.filePath === consumerUri)
          ?.expectedText,
      ).to.equal(dirtyConsumer);
      expect(batch.renames.length).to.be.greaterThan(0);
      const after = fixture.asset('HostAfter', 'objects');
      const newCode = fixture.code('HostAfter', 'Create_0.gml');
      const expectedCreate = dirtyCreate.replace(
        '= HostBefore;',
        '= HostAfter;',
      );
      const expectedConsumer = dirtyConsumer.replace(
        '= HostBefore;',
        '= HostAfter;',
      );
      expect(newCode.path.absolute).to.equal(
        pathy(renamedPath(oldCreateUri, batch.renames)).absolute,
      );
      expect(buffers.has(oldCreateUri)).to.equal(false);
      expect(buffers.get(newCode.path.absolute)).to.equal(expectedCreate);
      expect(buffers.get(consumerUri)).to.equal(expectedConsumer);
      expect(newCode.content).to.equal(expectedCreate);
      expect(consumer.content).to.equal(expectedConsumer);
      expectValue(newCode, 'unsaved_create', 'String');
      expectValue(consumer, 'unsaved_consumer', 'String');
      expect(definition(newCode, 'own_asset').item.type.type[0].name).to.equal(
        'HostAfter',
      );
      expect(definition(consumer, 'target').item.type.type[0].name).to.equal(
        'HostAfter',
      );
      expect(project.getAssetByName('HostBefore')).to.equal(undefined);
      expectRetired(project, oldCode, oldReferences);
      expect(project.publishedFor(before.yyPath.absolute)).to.deep.equal([]);
      expect(
        (await Yy.read(fixture.file(after.resource.id.path), 'objects')).name,
      ).to.equal('HostAfter');
      const yyp = await Yy.read(fixture.file('fixture.yyp'), 'project');
      expect(
        yyp.resources.some((resource) => resource.id.name === 'HostBefore'),
      ).to.equal(false);
      expect(
        yyp.resources.some((resource) => resource.id.name === 'HostAfter'),
      ).to.equal(true);
      // The directory moved, but the original saved GML bytes were never overwritten by editor text.
      expect(
        await readFile(fixture.file('objects/HostAfter/Create_0.gml'), 'utf8'),
      ).to.equal(diskCreate);
      expect(
        await readFile(
          fixture.file('scripts/HostResourceConsumer/HostResourceConsumer.gml'),
          'utf8',
        ),
      ).to.equal(diskConsumer);
      expect(await pathy(fixture.file('objects/HostBefore')).exists()).to.equal(
        false,
      );
      // Cold comparison deliberately includes the same current host inputs, not stale saved GML.
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      expect(batches).to.have.lengthOf(1);
    }, options);
  });

  it('routes Code.renameSignifier through one host batch for all dirty reference owners without disk writes', async function () {
    const buffers = new Map<string, string>();
    const options: ProjectOptions = {
      documentText: (filePath) => buffers.get(pathy(filePath).absolute),
    };
    await withFixture(async (fixture) => {
      const diskProvider =
        'function audit_host_before() { return 1; }\nvar own_result = audit_host_before();';
      const diskConsumer = 'var result = audit_host_before();';
      const dirtyProvider =
        'function audit_host_before() { return "buffer"; }\nvar own_result = audit_host_before();\n// audit_host_before remains a comment';
      const dirtyConsumer = `${diskConsumer}\nvar unsaved_local = "kept";\nvar label = "audit_host_before";`;
      await fixture.script('HostProvider', diskProvider);
      await fixture.script('HostConsumer', diskConsumer);
      const providerUri = pathy(
        fixture.file('scripts/HostProvider/HostProvider.gml'),
      ).absolute;
      const consumerUri = pathy(
        fixture.file('scripts/HostConsumer/HostConsumer.gml'),
      ).absolute;
      buffers.set(providerUri, dirtyProvider);
      buffers.set(consumerUri, dirtyConsumer);
      const batches: ProjectEditBatch[] = [];
      options.applyEdits = async (batch) => {
        batches.push(batch);
        await applyFixtureHostBatch(fixture, buffers, batch);
        return true;
      };
      const project = await fixture.load();
      const provider = fixture.code('HostProvider');
      const consumer = fixture.code('HostConsumer');
      const target = project.self.getMember('audit_host_before')!;
      const oldReferences = [...target.refs];
      const originalYyp = await readFile(fixture.file('fixture.yyp'));
      expect(target.def?.file).to.equal(provider);
      expectValue(provider, 'own_result', 'String');
      expectValue(consumer, 'result', 'String');

      await provider.renameSignifier(target, 'audit_host_after');
      expectAvailable(project);
      expect(batches).to.have.lengthOf(1);
      expect(batches[0].renames).to.deep.equal([]);
      expect(
        batches[0].documents.map((item) => item.filePath).sort(),
      ).to.deep.equal([providerUri, consumerUri].sort());
      expect(
        batches[0].documents.find((item) => item.filePath === providerUri)
          ?.expectedText,
      ).to.equal(dirtyProvider);
      expect(
        batches[0].documents.find((item) => item.filePath === consumerUri)
          ?.expectedText,
      ).to.equal(dirtyConsumer);
      const expectedProvider = dirtyProvider
        .replace('function audit_host_before()', 'function audit_host_after()')
        .replace('= audit_host_before();', '= audit_host_after();');
      const expectedConsumer = dirtyConsumer.replace(
        '= audit_host_before();',
        '= audit_host_after();',
      );
      expect(buffers.get(providerUri)).to.equal(expectedProvider);
      expect(buffers.get(consumerUri)).to.equal(expectedConsumer);
      expect(provider.content).to.equal(expectedProvider);
      expect(consumer.content).to.equal(expectedConsumer);
      expect(project.analysis.document(providerUri)).to.equal(provider);
      expect(project.analysis.document(consumerUri)).to.equal(consumer);
      expect(project.self.getMember('audit_host_after')?.def?.file).to.equal(
        provider,
      );
      expect(project.self.getMember('audit_host_before')?.def).to.equal(
        undefined,
      );
      expectValue(provider, 'own_result', 'String');
      expectValue(consumer, 'result', 'String');
      expectValue(consumer, 'unsaved_local', 'String');
      for (const reference of oldReferences) {
        expect(project.analysis.references).not.to.include(reference);
        expect(reference.item.refs.has(reference)).to.equal(false);
      }
      expect(
        await readFile(
          fixture.file('scripts/HostProvider/HostProvider.gml'),
          'utf8',
        ),
      ).to.equal(diskProvider);
      expect(
        await readFile(
          fixture.file('scripts/HostConsumer/HostConsumer.gml'),
          'utf8',
        ),
      ).to.equal(diskConsumer);
      expect(await readFile(fixture.file('fixture.yyp'))).to.deep.equal(
        originalYyp,
      );
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      expect(batches).to.have.lengthOf(1);
    }, options);
  });

  it('rejects a host preflight false explicitly and leaves text, resource paths and the live model unchanged', async function () {
    const buffers = new Map<string, string>();
    const options: ProjectOptions = {
      documentText: (filePath) => buffers.get(pathy(filePath).absolute),
    };
    await withFixture(async (fixture) => {
      const createSource = 'var own_asset = RefusedBefore;';
      const savedConsumer = 'var target = RefusedBefore;';
      const dirtyConsumer = `${savedConsumer}\nvar unsaved_local = "retained";`;
      const resource = await fixture.object('RefusedBefore', {
        'Create_0.gml': createSource,
      });
      await fixture.script('RefusedConsumer', savedConsumer);
      const consumerUri = pathy(
        fixture.file('scripts/RefusedConsumer/RefusedConsumer.gml'),
      ).absolute;
      buffers.set(consumerUri, dirtyConsumer);
      const batches: ProjectEditBatch[] = [];
      options.applyEdits = async (batch) => {
        batches.push(batch);
        await Promise.resolve();
        batch.validate();
        return false; // No text replacement or physical move has been submitted.
      };
      const project = await fixture.load();
      const asset = fixture.asset('RefusedBefore', 'objects');
      const code = fixture.code('RefusedBefore', 'Create_0.gml');
      const consumer = fixture.code('RefusedConsumer');
      const before = snapshot(project);
      const originalYyp = await readFile(fixture.file('fixture.yyp'));
      const originalYy = await readFile(fixture.file(resource.id.path));
      // The Code API must delegate a resource symbol to the same resource/host transaction.
      const error = await rejectedEdit(() =>
        code.renameSignifier(asset.signifier, 'RefusedAfter'),
      );
      expect(error.message).to.match(
        /rename preflight rejected.*host rejected.*before applying changes/i,
      );
      expect(batches).to.have.lengthOf(1);
      expect(batches[0].renames.length).to.be.greaterThan(0);
      expect(
        batches[0].documents.some((item) => item.filePath === consumerUri),
      ).to.equal(true);
      for (const path of [
        ...batches[0].documents.map((item) => item.filePath),
        ...batches[0].renames.flatMap((move) => [move.from, move.to]),
      ]) {
        expect(error.affectedPaths).to.include(path);
        expect(error.message).to.include(path);
      }
      expectAvailable(project);
      expect(project.getAssetByName('RefusedBefore')).to.equal(asset);
      expect(project.getAssetByName('RefusedAfter')).to.equal(undefined);
      expect(fixture.code('RefusedBefore', 'Create_0.gml')).to.equal(code);
      expect(code.content).to.equal(createSource);
      expect(consumer.content).to.equal(dirtyConsumer);
      expect(buffers.get(consumerUri)).to.equal(dirtyConsumer);
      expect(snapshot(project)).to.deep.equal(before);
      expect(await readFile(fixture.file('fixture.yyp'))).to.deep.equal(
        originalYyp,
      );
      expect(await readFile(fixture.file(resource.id.path))).to.deep.equal(
        originalYy,
      );
      expect(
        await readFile(
          fixture.file('objects/RefusedBefore/Create_0.gml'),
          'utf8',
        ),
      ).to.equal(createSource);
      expect(
        await readFile(
          fixture.file('scripts/RefusedConsumer/RefusedConsumer.gml'),
          'utf8',
        ),
      ).to.equal(savedConsumer);
      expect(
        await pathy(fixture.file('objects/RefusedAfter')).exists(),
      ).to.equal(false);
      expect(
        project
          .publishedFor(project.yypPath.absolute)
          .some(
            (item) =>
              item.severity === 'error' && /host rejected/i.test(item.message),
          ),
      ).to.equal(true);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      expect(batches).to.have.lengthOf(1);
    }, options);
  });

  it('recovers actual partial host submission state after a throw without rolling back saved edits or newer buffers', async function () {
    const buffers = new Map<string, string>();
    const options: ProjectOptions = {
      documentText: (filePath) => buffers.get(pathy(filePath).absolute),
    };
    await withFixture(async (fixture) => {
      const providerSource =
        'function audit_partial_before() { return 1; }\nvar own_result = audit_partial_before();';
      const consumerSource = 'var result = audit_partial_before();';
      const dirtyConsumer = `${consumerSource}\nvar unsaved_before = "retained";`;
      const newerConsumer = `${dirtyConsumer}\nvar user_after_submit = "newer";`;
      await fixture.script('PartialProvider', providerSource);
      await fixture.script('PartialConsumer', consumerSource);
      const providerUri = pathy(
        fixture.file('scripts/PartialProvider/PartialProvider.gml'),
      ).absolute;
      const consumerUri = pathy(
        fixture.file('scripts/PartialConsumer/PartialConsumer.gml'),
      ).absolute;
      buffers.set(consumerUri, dirtyConsumer);
      const sentinel = new Error(
        'the editor stopped after the first submitted document',
      );
      const batches: ProjectEditBatch[] = [];
      let hostFailure: ProjectEditError | undefined;
      options.applyEdits = async (batch) => {
        batches.push(batch);
        expect(batch.renames).to.deep.equal([]);
        for (const document of batch.documents) fixture.file(document.filePath);
        const providerEdit = batch.documents.find(
          (item) => item.filePath === providerUri,
        );
        expect(providerEdit).not.to.equal(undefined);
        expect(
          batch.documents.find((item) => item.filePath === consumerUri)
            ?.expectedText,
        ).to.equal(dirtyConsumer);
        // Submit exactly one real saved-document edit, not the unfinished consumer plan.
        await applyDiskEdits({
          ...batch,
          documents: [providerEdit!],
          renames: [],
        });
        buffers.set(consumerUri, newerConsumer);
        hostFailure = new ProjectEditError(
          'The host stopped after partial submission',
          batch.documents.map((item) => item.filePath),
          { cause: sentinel },
        );
        throw hostFailure;
      };
      const project = await fixture.load();
      const provider = fixture.code('PartialProvider');
      const consumer = fixture.code('PartialConsumer');
      const target = project.self.getMember('audit_partial_before')!;
      const originalYyp = await readFile(fixture.file('fixture.yyp'));
      expectValue(provider, 'own_result', 'Real');
      expectValue(consumer, 'result', 'Real');

      const error = await rejectedEdit(() =>
        project.renameSignifier(target, 'audit_partial_after'),
      );
      expect(error.message).to.match(
        /rename application failed.*partial submission/i,
      );
      expect(hostFailure).not.to.equal(undefined);
      expect(error.cause).to.equal(hostFailure);
      expect(hostFailure!.cause).to.equal(sentinel);
      expect(error.affectedPaths)
        .to.include(providerUri)
        .and.include(consumerUri);
      expect(error.message).to.include(providerUri).and.include(consumerUri);
      expect(batches).to.have.lengthOf(1);
      expectAvailable(project);
      const providerEdit = batches[0].documents.find(
        (item) => item.filePath === providerUri,
      )!;
      const submittedProvider = editedText(providerEdit);
      expect(submittedProvider).not.to.equal(providerSource);
      expect(
        await readFile(
          fixture.file('scripts/PartialProvider/PartialProvider.gml'),
          'utf8',
        ),
      ).to.equal(submittedProvider);
      expect(provider.content).to.equal(submittedProvider);
      expect(project.self.getMember('audit_partial_after')?.def?.file).to.equal(
        provider,
      );
      expect(project.self.getMember('audit_partial_before')?.def).to.equal(
        undefined,
      );
      expectValue(provider, 'own_result', 'Real');
      expect(buffers.get(consumerUri)).to.equal(newerConsumer);
      expect(consumer.content).to.equal(newerConsumer);
      expectValue(consumer, 'unsaved_before', 'String');
      expectValue(consumer, 'user_after_submit', 'String');
      expectMissing(project, consumer, 'audit_partial_before');
      expect(kinds(definition(consumer, 'result').item.type)).not.to.deep.equal(
        ['Real'],
      );
      expect(
        await readFile(
          fixture.file('scripts/PartialConsumer/PartialConsumer.gml'),
          'utf8',
        ),
      ).to.equal(consumerSource);
      expect(await readFile(fixture.file('fixture.yyp'))).to.deep.equal(
        originalYyp,
      );
      expect(
        project
          .publishedFor(project.yypPath.absolute)
          .some(
            (item) =>
              item.severity === 'error' &&
              /rename application failed/i.test(item.message),
          ),
      ).to.equal(true);
      expect(snapshot(project)).to.deep.equal(snapshot(await fixture.cold()));
      expect(batches).to.have.lengthOf(1); // Recovery is read/reconcile, never retrying or reversing the batch.
    }, options);
  });
});
