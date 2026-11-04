import assert from 'node:assert/strict';
import { Project } from '@bscotch/gml-parser';
import { pathy } from '@bscotch/pathy';
import { Yy } from '@bscotch/yy';
import {
  readFile,
  writeFile,
  rm,
  stat,
  mkdir,
  mkdtemp,
  cp,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { WorkerLanguageService } from './client.mjs';
import { buildTestWorker, parserRoot, workerFixture } from '../test/worker.mjs';
import { createHost } from '../test/host.mjs';

const nativeSpecFiles = [path.join(parserRoot, 'assets/GmlSpec.xml')];
const facade = (yypPath: string) =>
  Project.initialize(yypPath, {
    analysis: 'resources',
    nativeSpecFiles,
    documentation: false,
  });

test(
  'resource-only initialization, warm reload, creation and retirement do not create a language graph',
  { timeout: 60000 },
  async () => {
    const f = await workerFixture({ seed: 'function seed(){static }' });
    try {
      const project = await Project.initialize(f.yypPath, {
        analysis: 'resources',
        nativeSpecFiles: [path.join(f.directory, 'deliberately-absent.xml')],
        documentation: false,
      });
      assert.equal(project.native, undefined);
      assert.equal(project.self, undefined);
      assert.equal(project.types.size, 0);
      const asset = project.getAssetByName('seed', { assertExists: true });
      assert.equal(asset.signifier, undefined);
      assert.equal(asset.gmlFile?.content, undefined);
      await asset.reload();
      await asset.gmlFile!.reload('static } damaged');
      assert.equal(asset.gmlFile!.refs.length, 0);
      project.setAnalysisConfiguration('Test');
      const created = await project.createObject('Test/o_created');
      const child = await project.createObject('Test/o_child');
      assert(created && child);
      child.parent = created;
      await project.whenSourcesCurrent();
      assert.equal(child.parent, created);
      await child.reload();
      assert.equal(child.parent, created);
      await project.removeAssetByName('o_created');
      assert.equal(child.parent, undefined);
      await project.reloadYyp();
      assert.equal(project.native, undefined);
      assert.equal(project.self, undefined);
      assert.equal(project.types.size, 0);
      assert.equal(
        [...project.assets.values()]
          .flatMap((item) => item.gmlFilesArray)
          .some((code) => code.refs.length),
        false,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  'resource rename validates worker plan before writes and maps references inside the moved resource',
  { timeout: 60000 },
  async () => {
    const f = await workerFixture({ use: 'var target=o_old;' });
    try {
      const project = await facade(f.yypPath);
      const asset = await project.createObject('Test/o_old');
      const child = await project.createObject('Test/o_child');
      assert(asset && child);
      child.parent = asset;
      await project.whenSourcesCurrent();
      await writeFile(asset.gmlFile!.path.absolute, 'var own=o_old;');
      f.service.update({ kind: 'project', configuration: 'Default' }, true);
      const plan = await f.service.query({
        kind: 'assetRename',
        assetName: 'o_old',
        newName: 'o_new',
      });
      assert(plan);
      assert.equal(plan.edits.length, 2);
      const originalYyp = await readFile(f.yypPath, 'utf8');
      await assert.rejects(
        project.renameAsset('o_old', 'o_new'),
        /requires.*plan/,
      );
      await writeFile(f.files.use, 'var target=o_old; // changed');
      await assert.rejects(
        project.renameAsset('o_old', 'o_new', { plan }),
        /source changed/,
      );
      assert.equal(await readFile(f.yypPath, 'utf8'), originalYyp);
      assert(await stat(asset.dir.absolute));
      await writeFile(f.files.use, 'var target=o_old;');
      await project.renameAsset('o_old', 'o_new', { plan });
      const renamed = project.getAssetByName('o_new', { assertExists: true });
      assert.equal(project.getAssetByName('o_old'), undefined);
      assert.equal(
        await readFile(renamed.gmlFile!.path.absolute, 'utf8'),
        'var own=o_new;',
      );
      assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_new;');
      assert.equal(
        project.getAssetByName('o_child', { assertExists: true }).parent,
        renamed,
      );
      f.service.update({ kind: 'project', configuration: 'Default' }, true);
      const definitions = await f.service.query({
        kind: 'definition',
        path: f.files.use,
        offset: 'var target='.length,
      });
      assert.equal(definitions?.[0].path, renamed.gmlFile!.path.absolute);
      assert.equal(project.self, undefined);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'worker import planning preserves missing-dependency checks and resource facade applies only a current plan',
  { timeout: 60000 },
  async () => {
    const source = await workerFixture({
      entry: 'function imported(){return helper();}',
      dependency: 'function helper(){return 1;}',
    });
    const target = await workerFixture({
      keep: 'function keep(){return imported();}',
    });
    try {
      const from = await facade(source.yypPath),
        to = await facade(target.yypPath);
      const options = {
        sourceAsset: 'entry',
        onMissingDependency: 'error' as const,
      };
      const plan = await target.service.query({
        kind: 'importPlan',
        sourceProject: source.yypPath,
        sourceNativeSpecFiles: nativeSpecFiles,
        importOptions: options,
      });
      assert(plan && plan.missing.length);
      await assert.rejects(to.import(from, options), /requires.*plan/);
      await assert.rejects(to.import(from, options, plan), /dependencies/);
      assert.equal(to.getAssetByName('entry'), undefined);
      const include = { ...options, onMissingDependency: 'include' as const };
      const valid = await target.service.query({
        kind: 'importPlan',
        sourceProject: source.yypPath,
        sourceNativeSpecFiles: nativeSpecFiles,
        importOptions: include,
      });
      assert(valid);
      await writeFile(source.files.entry, 'function imported(){return 2;}');
      await assert.rejects(to.import(from, include, valid), /source changed/);
      const revision = target.service.revision;
      const replanned = await target.service.query({
        kind: 'importPlan',
        sourceProject: source.yypPath,
        sourceNativeSpecFiles: nativeSpecFiles,
        importOptions: include,
      });
      assert.equal(target.service.revision, revision);
      assert.equal(
        replanned?.sources.find((item) => item.path === source.files.entry)
          ?.text,
        'function imported(){return 2;}',
      );
      await writeFile(
        source.files.entry,
        'function imported(){return helper();}',
      );
      const result = await to.import(from, include, valid);
      assert.equal(result.errors.length, 0);
      assert(to.getAssetByName('entry'));
      assert(to.getAssetByName('dependency'));
      assert.equal(to.self, undefined);
      target.service.update(
        { kind: 'project', configuration: 'Default' },
        true,
      );
      const hover = await target.service.query({
        kind: 'hover',
        path: target.files.keep,
        offset: 'function '.length,
      });
      assert(hover?.code.some((code) => code.includes('Real')));
    } finally {
      await source.dispose();
      await target.dispose();
    }
  },
);

async function renameFixture() {
  const f = await workerFixture({ use: 'var target=o_old;' });
  const project = await facade(f.yypPath);
  const asset = await project.createObject('Test/o_old');
  assert(asset);
  f.service.update({ kind: 'project', configuration: 'Default' }, true);
  const plan = await f.service.query({
    kind: 'assetRename',
    assetName: 'o_old',
    newName: 'o_new',
  });
  assert(plan);
  return { f, project, asset, plan };
}

test(
  'full-analysis resource rename uses the same source and metadata transaction',
  { timeout: 60000 },
  async () => {
    const f = await workerFixture({ use: 'var target=o_old;' });
    try {
      const resources = await facade(f.yypPath);
      const asset = await resources.createObject('Test/o_old');
      const child = await resources.createObject('Test/o_child');
      assert(asset && child);
      child.parent = asset;
      await resources.whenSourcesCurrent();
      await writeFile(asset.gmlFile!.path.absolute, 'var own=o_old;');
      const project = await Project.initialize(f.yypPath, {
        nativeSpecFiles,
        documentation: false,
      });
      assert.equal(
        project
          .getGmlFile(pathy(f.files.use))
          ?.getReferenceAt('var target='.length)?.item,
        project.getAssetByName('o_old')?.signifier,
      );
      await project.renameAsset('o_old', 'o_new');
      const renamed = project.getAssetByName('o_new', { assertExists: true });
      assert.equal(project.getAssetByName('o_old'), undefined);
      assert.equal(
        project.getAssetByName('o_child', { assertExists: true }).parent,
        renamed,
      );
      assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_new;');
      assert.equal(
        await readFile(renamed.gmlFile!.path.absolute, 'utf8'),
        'var own=o_new;',
      );
      assert(
        project
          .getGmlFile(pathy(f.files.use))
          ?.getReferenceAt('var target='.length)?.item.def,
      );
    } finally {
      await f.dispose();
    }
  },
);

for (const fault of ['second-write', 'after-directory-move'])
  test(
    `resource rename recovers actual files after ${fault} failure and allows retry`,
    { timeout: 60000 },
    async () => {
      const { f, project, asset, plan } = await renameFixture();
      const originalYyp = await readFile(f.yypPath, 'utf8');
      const original = (project as any).renameResourceFile;
      let calls = 0,
        failed = false;
      (project as any).renameResourceFile = async (
        from: string,
        to: string,
      ) => {
        calls++;
        if (
          !failed &&
          (fault === 'second-write'
            ? calls === 2
            : from.endsWith('/o_new/o_old.yy'))
        ) {
          failed = true;
          throw new Error('Injected filesystem failure');
        }
        return original(from, to);
      };
      try {
        await assert.rejects(
          project.renameAsset('o_old', 'o_new', { plan }),
          /Original files were restored/,
        );
        assert(failed, 'The selected IO fault must actually run');
        assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_old;');
        assert.equal(await readFile(f.yypPath, 'utf8'), originalYyp);
        assert(await stat(asset.dir.absolute));
        assert.equal(project.getAssetByName('o_new'), undefined);
        (project as any).renameResourceFile = original;
        await project.renameAsset('o_old', 'o_new', { plan });
        assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_new;');
      } finally {
        (project as any).renameResourceFile = original;
        await f.dispose();
      }
    },
  );

test(
  'rename recovery preserves a subsequent external edit and retains original recovery data',
  { timeout: 60000 },
  async () => {
    const { f, project, plan } = await renameFixture();
    const original = (project as any).renameResourceFile;
    let calls = 0,
      first = '',
      recovery = '';
    (project as any).renameResourceFile = async (from: string, to: string) => {
      if (++calls === 1) {
        first = to;
        return original(from, to);
      }
      if (calls === 2) {
        await writeFile(first, '// external writer');
        throw new Error('Injected filesystem failure');
      }
      return original(from, to);
    };
    try {
      await assert.rejects(
        project.renameAsset('o_old', 'o_new', { plan }),
        (error: any) => {
          recovery = /Recovery data: (.+)$/.exec(error.message)?.[1] || '';
          return !!recovery && /Recovery is incomplete/.test(error.message);
        },
      );
      assert.equal(await readFile(first, 'utf8'), '// external writer');
      const journal = JSON.parse(
        await readFile(path.join(recovery, 'recovery.json'), 'utf8'),
      );
      assert.equal(journal.status, 'rollback-incomplete');
      assert(
        journal.batch.texts.some(
          (text: any) => text.path === first && text.before.includes('o_old'),
        ),
      );
    } finally {
      (project as any).renameResourceFile = original;
      if (recovery) await rm(recovery, { recursive: true, force: true });
      await f.dispose();
    }
  },
);

test(
  'resource command rejects dirty affected buffers and leaves unrelated unsaved documents alone',
  { timeout: 60000 },
  async () => {
    const { f, project, asset } = await renameFixture();
    const host = await createHost();
    const workspace = host.newWorkspace();
    const originalYyp = await readFile(f.yypPath, 'utf8');
    try {
      (project as any).includesFile = (document: any) =>
        (document.uri || document).fsPath
          .replaceAll('\\', '/')
          .toLowerCase()
          .startsWith(project.dir.absolute.toLowerCase() + '/');
      workspace.projects.push(project);
      workspace.createLanguageService = () => f.service;
      const use = host.document(
        { path: { absolute: f.files.use } },
        'var target=o_old;',
      );
      const moved = host.document(
        { path: { absolute: asset.gmlFile!.path.absolute } },
        await readFile(asset.gmlFile!.path.absolute, 'utf8'),
      );
      const unrelated = host.document(
        {
          path: {
            absolute: project.dir.join('scripts/Unrelated/Unrelated.gml')
              .absolute,
          },
        },
        'unsaved unrelated text',
      );
      host.documents.push(use, moved, unrelated);
      unrelated.isDirty = true;
      use.isDirty = true;
      await assert.rejects(
        workspace.renameAsset(asset, 'o_new'),
        /Save modified files affected/,
      );
      assert.equal(await readFile(f.yypPath, 'utf8'), originalYyp);
      use.isDirty = false;
      moved.isDirty = true;
      await assert.rejects(
        workspace.renameAsset(asset, 'o_new'),
        /Save modified files affected/,
      );
      assert.equal(await readFile(f.yypPath, 'utf8'), originalYyp);
      moved.isDirty = false;
      await workspace.renameAsset(asset, 'o_new');
      assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_new;');
      assert.equal(unrelated.getText(), 'unsaved unrelated text');
      assert.equal(unrelated.isDirty, true);
    } finally {
      host.dispose();
      await f.dispose();
    }
  },
);

test(
  'import guards dirty destination files even before an asset is registered and protects target YYP edits',
  { timeout: 60000 },
  async () => {
    const source = await workerFixture({
      entry: 'function imported(){return 1;}',
    });
    const target = await workerFixture({ keep: 'function keep(){return 2;}' });
    const host = await createHost(),
      workspace = host.newWorkspace();
    try {
      const from = await facade(source.yypPath),
        to = await facade(target.yypPath);
      (to as any).includesFile = (document: any) =>
        (document.uri || document).fsPath
          .replaceAll('\\', '/')
          .toLowerCase()
          .startsWith(to.dir.absolute.toLowerCase() + '/');
      workspace.projects.push(to);
      workspace.createLanguageService = () => target.service;
      const destination = to.dir.join('scripts/entry/entry.gml').absolute;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, '// existing unregistered file');
      const opened = host.document(
        { path: { absolute: destination } },
        '// unsaved destination',
      );
      opened.isDirty = true;
      host.documents.push(opened);
      const options = { sourceAsset: 'entry' };
      await assert.rejects(
        workspace.importAssets(to, from, options),
        /modified target resource/,
      );
      assert.equal(
        await readFile(destination, 'utf8'),
        '// existing unregistered file',
      );
      opened.isDirty = false;
      const yyp = host.document(
        { path: { absolute: target.yypPath } },
        await readFile(target.yypPath, 'utf8'),
      );
      yyp.languageId = 'yy';
      yyp.isDirty = true;
      host.documents.push(yyp);
      await assert.rejects(
        workspace.importAssets(to, from, options),
        /modified target YYP/,
      );
      assert.equal(to.getAssetByName('entry'), undefined);
    } finally {
      host.dispose();
      await source.dispose();
      await target.dispose();
    }
  },
);

for (const metadata of ['yy', 'yyp'] as const)
  test(
    `rename rejects an external ${metadata} change between validation and before-capture`,
    { timeout: 60000 },
    async () => {
      const { f, project, asset, plan } = await renameFixture();
      const file = metadata === 'yy' ? asset.yyPath.absolute : f.yypPath;
      const oldYyp = await readFile(f.yypPath, 'utf8');
      const changed: any = Yy.parse(await readFile(file, 'utf8'));
      if (metadata === 'yy') changed.visible = !changed.visible;
      else changed.name = 'ExternalProjectEdit';
      const external = Yy.stringify(
        changed,
        metadata === 'yy' ? 'objects' : 'project',
      );
      const validate = project.validateResourceState.bind(project);
      let boundaryReached = false;
      project.validateResourceState = async (expected) => {
        const valid = await validate(expected);
        assert(
          valid,
          'The original plan must still be valid at the controlled boundary',
        );
        boundaryReached = true;
        await writeFile(file, external);
        return valid;
      };
      try {
        await assert.rejects(
          project.renameAsset('o_old', 'o_new', { plan }),
          /metadata changed while capturing rename inputs/,
        );
        assert(boundaryReached);
        assert.equal(
          await readFile(file, 'utf8'),
          external,
          'The concurrent external metadata edit must survive unchanged',
        );
        assert.equal(await readFile(f.files.use, 'utf8'), 'var target=o_old;');
        if (metadata === 'yy')
          assert.equal(await readFile(f.yypPath, 'utf8'), oldYyp);
        assert(await stat(asset.dir.absolute));
        assert.equal(project.getAssetByName('o_new'), undefined);
      } finally {
        project.validateResourceState = validate;
        await f.dispose();
      }
    },
  );

for (const analysis of ['full', 'resources'] as const)
  test(
    `${analysis} resource rename preserves complete room numeric and unknown metadata`,
    { timeout: 60000 },
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'stitch-rename-room-'),
      );
      let service: WorkerLanguageService | undefined;
      let worker: Worker | undefined;
      try {
        await cp(path.join(parserRoot, 'samples/project'), directory, {
          recursive: true,
        });
        const yypPath = path.join(directory, 'project.yyp');
        const roomPath = path.join(directory, 'rooms/Room1/Room1.yy');
        const source = path.join(
          directory,
          'scripts/Complicated/Complicated.gml',
        );
        const untouched = path.join(directory, 'scripts/Script1/Script1.yy');
        const untouchedBytes = await readFile(untouched, 'utf8');
        const documented = path.join(
          directory,
          'scripts/FunctionSelf/FunctionSelf.gml',
        );
        const originalDocumentation = await readFile(documented, 'utf8');
        const room = Yy.parse(await readFile(roomPath, 'utf8')) as Record<
          string,
          any
        >;
        const instance = room.layers[0].instances[0];
        instance.imageSpeed = 0.123456789;
        instance.rotation = -45.625;
        instance.scaleX = 1.125;
        instance.scaleY = 0.8125;
        room.layers[1].animationFPS = 29.97;
        room.physicsSettings.PhysicsWorldPixToMetres = 0.0125;
        room.volume = 0.875;
        room.customMetadata = {
          exactInteger: 9007199254740993n,
          nested: { value: 1.23456789012345 },
        };
        await writeFile(roomPath, Yy.stringify(room));
        const originalRoom = Yy.parse(
          await readFile(roomPath, 'utf8'),
        ) as Record<string, any>;
        await writeFile(source, 'var target=o_object;');
        const project = await Project.initialize(yypPath, {
          analysis,
          nativeSpecFiles,
          documentation: false,
        });
        if (analysis === 'resources') {
          const workerPath = await buildTestWorker(directory);
          worker = new Worker(workerPath);
          service = new WorkerLanguageService(
            { yypPath, configuration: 'Default', nativeSpecFiles },
            workerPath,
            { createWorker: () => worker!, delay: () => 0 },
          );
          const plan = await service.query({
            kind: 'assetRename',
            assetName: 'o_object',
            newName: 'o_renamed',
          });
          assert(plan);
          await project.renameAsset('o_object', 'o_renamed', { plan });
        } else {
          await project.renameAsset('o_object', 'o_renamed');
        }
        assert.equal(await readFile(source, 'utf8'), 'var target=o_renamed;');
        assert.equal(
          await readFile(documented, 'utf8'),
          originalDocumentation.replaceAll(/\bo_object\b/g, 'o_renamed'),
        );
        assert.equal(project.getAssetByName('o_object'), undefined);
        assert(project.getAssetByName('o_renamed'));
        const actualRoom = Yy.parse(await readFile(roomPath, 'utf8')) as Record<
          string,
          any
        >;
        const actualInstance = actualRoom.layers[0].instances[0];
        assert.deepEqual(actualInstance.objectId, {
          name: 'o_renamed',
          path: 'objects/o_renamed/o_renamed.yy',
        });
        actualInstance.objectId = originalRoom.layers[0].instances[0].objectId;
        assert.deepEqual(actualRoom, originalRoom);
        assert.equal(await readFile(untouched, 'utf8'), untouchedBytes);
      } finally {
        service?.dispose();
        await worker?.terminate();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
