import { expect } from 'chai';
import { computeAssetDeps, importAssets } from './modules.js';
import { Project } from './project.js';
import { Native } from './project.native.js';
import { resetSandbox } from './test.lib.js';
import { assert } from './util.js';
import { assertThrowsAsync } from './util.test.js';

describe('Modules', function () {
  const listSpecFiles = Native.listSpecFiles;
  const findHelpLinksFile = Native.findHelpLinksFile;
  before(function () {
    // Import semantics use bundled native declarations; runtime discovery and
    // release-network availability are covered independently.
    Native.listSpecFiles = async () => [Native.fallbackGmlSpecPath];
    Native.findHelpLinksFile = async () => undefined;
  });
  after(function () {
    Native.listSpecFiles = listSpecFiles;
    Native.findHelpLinksFile = findHelpLinksFile;
  });

  it('can compute intra-project dependencies', async function () {
    const projectDir = 'samples/project';
    const project = await Project.initialize(projectDir);
    assert(project);

    const deps = computeAssetDeps(project);
    assert(deps.size > 0, 'No dependencies found');

    // o_object refers to a lot of stuff
    const o_object = [...deps.keys()].find((a) => a.name === 'o_object');
    assert(o_object, 'o_object not found');
    const o_object_deps = deps.get(o_object);
    assert(o_object_deps, 'o_object deps not found');
    assert(o_object_deps.length > 0, 'o_object has no deps');
    assert(
      o_object_deps[0].requiredBy.name === 'o_object',
      'o_object deps are wrong',
    );
  });

  it('can perform a simple import', async function () {
    const targetProject = await resetSandbox();
    const project = await Project.initialize('samples/project');
    assert(project);

    await assertThrowsAsync(async () => {
      await importAssets(project, targetProject, {
        sourceAsset: 'o_child1_child',
      });
    }, 'Missing dependency not caught');

    await importAssets(project, targetProject, {
      sourceAsset: 'o_child1_child',
      onMissingDependency: 'skip',
    });
    expect(targetProject.getAssetByName('o_child1_child')).to.exist;
    expect(targetProject.analysis.isCurrent).to.equal(true);
  });

  it('can perform a deep import', async function () {
    const targetProject = await resetSandbox();
    const project = await Project.initialize('samples/project');
    assert(project);

    const results = await importAssets(project, targetProject, {
      sourceAsset: 'o_child1_child',
      onMissingDependency: 'include',
    });
    expect(results.errors).to.be.empty;
    expect(results.skipped).to.be.empty;
    expect(results.updated).to.be.empty;
    expect(results.created).to.have.lengthOf(3);
    expect(targetProject.getAssetByName('o_child1_child')).to.exist;
    expect(targetProject.getAssetByName('o_child1')).to.exist;
    expect(targetProject.getAssetByName('o_parent')).to.exist;
  });

  it('propagates imported-code analysis failures to the import caller', async function () {
    const target = await resetSandbox();
    const source = await Project.initialize('samples/project');
    const analyze = target.initiallyParseAssetCode;
    const failure = new Error('Imported analysis failed');
    const rejected = Promise.reject(failure);
    // Keep the injected failure observed even when testing an implementation
    // that drops the returned promise instead of making importAssets await it.
    void rejected.catch(() => {});
    target.initiallyParseAssetCode = () => rejected;
    try {
      await importAssets(source, target, {
        sourceAsset: 'o_child1_child',
        onMissingDependency: 'skip',
      }).then(
        () => expect.fail('Import returned before its analysis failure'),
        (error) => expect(error).to.equal(failure),
      );
    } finally {
      target.initiallyParseAssetCode = analyze;
      target.dispose();
      source.dispose();
    }
  });

  xit('can identify import conflicts', async function () {
    // TODO: Add a "conflicted-target" project that has the various sorts of conflicts we can test against.
  });
});
