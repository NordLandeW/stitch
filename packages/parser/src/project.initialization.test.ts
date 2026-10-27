import { pathy } from '@bscotch/pathy';
import { Yy, yypSchema } from '@bscotch/yy';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextCheckPhase } from 'node:timers/promises';
import {
  Native,
  NativeSpecError,
  type NativeSpecStage,
} from './project.native.js';
import { Project, type ProjectOptions } from './project.js';

const emptySpec =
  '<GameMakerLanguageSpec RuntimeVersion="2024.11.0.0" Module="Base"/>';
const duplicateEnumSpec = `<GameMakerLanguageSpec RuntimeVersion="2024.11.0.0" Module="Base">
<Enumerations>
<Enumeration Name="Repeated"><Member Name="First" Value="0" Deprecated="false"/></Enumeration>
<Enumeration Name="Repeated"><Member Name="Second" Value="1" Deprecated="false"/></Enumeration>
</Enumerations>
</GameMakerLanguageSpec>`;

type InitializationOutcome =
  | { readonly status: 'resolved' }
  | { readonly status: 'rejected'; readonly error: unknown };

/**
 * Only environment discovery is substituted. Project.initialize, its progress
 * continuations, loadGmlSpec, Native.from, and failure disposal are production
 * implementations. Every project/spec read is inside this invocation's root.
 * These tests are serial, as required by the parser's existing test command.
 */
async function initializeFixture(
  specification: string | undefined,
  onLoadProgress?: ProjectOptions['onLoadProgress'],
) {
  const root = await mkdtemp(join(tmpdir(), 'stitch-project-initialization-'));
  const projectPath = join(root, 'fixture.yyp');
  const specPath = pathy(join(root, 'GmlSpec.xml')).absolute;
  const originalListSpecFiles = Native.listSpecFiles;
  const originalFindHelpLinksFile = Native.findHelpLinksFile;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  let selections = 0;
  let helpLookups = 0;
  let initialized: Project | undefined;
  try {
    const yyp = yypSchema.parse({
      name: 'initialization_fixture',
      resources: [],
      configs: { name: 'Default', children: [] },
      MetaData: { IDEVersion: '2024.11.0.0' },
      resourceVersion: '1.6',
    });
    await Yy.write(projectPath, yyp, 'project');
    await writeFile(
      join(root, 'stitch.config.json'),
      JSON.stringify({
        runtimeVersion: '2024.11.0.0',
      }),
      'utf8',
    );
    if (specification !== undefined)
      await writeFile(specPath, specification, 'utf8');

    // No installed runtime/IDE discovery, release-feed access, or foreign help
    // files. Do not replace initialize, loadGmlSpec, Native.from, or promises.
    Native.listSpecFiles = async (options) => {
      selections++;
      assert.equal(options.runtimeVersion, '2024.11.0.0');
      return [pathy(specPath)];
    };
    Native.findHelpLinksFile = async () => {
      helpLookups++;
      return undefined;
    };
    process.on('unhandledRejection', onUnhandled);

    // Install both terminal handlers immediately. An unexpectedly successful
    // initialization is also owned and disposed, rather than leaking a model.
    const outcome: InitializationOutcome = await Project.initialize(
      projectPath,
      {
        logger: { log() {}, warn() {}, error() {} },
        onLoadProgress,
      },
    ).then(
      (project) => {
        initialized = project;
        return { status: 'resolved' as const };
      },
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    // The selected spec I/O / throwing progress callback has settled before
    // the primary initialization result. Its native/help dependents now only
    // have promise reactions left. Cross two Node check phases so the failed
    // turn's unhandled-rejection dispatch has run, including when the primary
    // settles during a check callback. This is not a timed sleep or a latency
    // assertion; no fixture/discovery I/O remains outstanding at this boundary.
    await nextCheckPhase();
    await nextCheckPhase();
    return {
      outcome,
      specPath,
      selections,
      helpLookups,
      unhandled: [...unhandled],
    };
  } finally {
    try {
      initialized?.dispose();
    } finally {
      Native.listSpecFiles = originalListSpecFiles;
      Native.findHelpLinksFile = originalFindHelpLinksFile;
      process.off('unhandledRejection', onUnhandled);
      // Only the root returned by this invocation's mkdtemp is removed.
      await rm(root, { recursive: true, force: true });
      await assert.rejects(access(root), { code: 'ENOENT' });
    }
  }
}

describe('Project initialization promise ownership', function () {
  const loadFailures: readonly {
    stage: NativeSpecStage;
    specification: string | undefined;
  }[] = [
    { stage: 'read', specification: undefined },
    { stage: 'xml', specification: '<GameMakerLanguageSpec>' },
    { stage: 'schema', specification: '<GameMakerLanguageSpec/>' },
    { stage: 'load', specification: duplicateEnumSpec },
  ];

  for (const { stage, specification } of loadFailures) {
    it(`owns a selected spec ${stage} rejection through the real Project.initialize`, async function () {
      const progress: string[] = [];
      const result = await initializeFixture(
        specification,
        (_increment, message) => {
          if (message) progress.push(message);
        },
      );
      assert.equal(result.outcome.status, 'rejected');
      assert(result.outcome.status === 'rejected');
      const error = result.outcome.error;
      assert(error instanceof NativeSpecError);
      assert.equal(error.specFilePath, result.specPath);
      assert.equal(error.stage, stage);
      assert(error.cause instanceof Error);
      assert.equal(result.selections, 1);
      assert.equal(result.helpLookups, 0);
      assert.deepEqual(progress, ['Loaded project file']);
      assert.deepEqual(result.unhandled, []);
    });
  }

  for (const failingMessage of [
    'Loaded project file',
    'Loaded GML spec',
  ] as const) {
    it(`owns a throwing ${failingMessage} progress callback rather than an orphaned continuation`, async function () {
      const injected = new Error(
        `injected progress failure: ${failingMessage}`,
      );
      const progress: string[] = [];
      const result = await initializeFixture(
        emptySpec,
        (_increment, message) => {
          if (message) progress.push(message);
          if (message === failingMessage) throw injected;
        },
      );
      assert.equal(result.outcome.status, 'rejected');
      assert(result.outcome.status === 'rejected');
      assert.equal(result.outcome.error, injected);
      assert.deepEqual(
        progress,
        failingMessage === 'Loaded project file'
          ? ['Loaded project file']
          : ['Loaded project file', 'Loaded GML spec'],
      );
      assert.equal(
        result.selections,
        failingMessage === 'Loaded project file' ? 0 : 1,
      );
      assert.equal(result.helpLookups, 0);
      assert.deepEqual(result.unhandled, []);
    });
  }
});
