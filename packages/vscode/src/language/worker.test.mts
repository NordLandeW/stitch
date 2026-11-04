import assert from 'node:assert/strict';
import { Yy } from '@bscotch/yy';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { workerFixture } from '../test/worker.mjs';

const factory = (value: string) =>
  `function use_factory(){return make_factory().member;}\nfunction make_factory(){return {member:${value}};}\nvar observed=use_factory();`;

test(
  'production worker preserves source-anchored providers through forward edits, removal and repair',
  { timeout: 60000 },
  async () => {
    const initial = factory('1');
    const use = 'var box=make_factory(); var result=box.member;';
    const f = await workerFixture({ Producer: initial, Consumer: use });
    try {
      await f.service.ready;
      for (const [text, type] of [
        [initial, 'Real'],
        [factory('"text"'), 'String'],
        ['// shifted\r\n' + initial, 'Real'],
        [initial, 'Real'],
      ]) {
        await f.edit('Producer', text);
        const offset = use.lastIndexOf('member');
        const hover = await f.service.query({
          kind: 'hover',
          path: f.files.Consumer,
          offset,
        });
        assert(
          hover?.code.some((code) => code.includes(type)),
          JSON.stringify(hover),
        );
        const definitions = await f.service.query({
          kind: 'definition',
          path: f.files.Consumer,
          offset,
        });
        assert.equal(definitions?.length, 1);
        assert.equal(
          definitions[0].path.replace(/\\/g, '/'),
          f.files.Producer.replace(/\\/g, '/'),
        );
        const lines = text.split(/\r\n|\r|\n/);
        const target = definitions[0];
        assert.equal(
          lines[target.start.line].slice(
            target.start.character,
            target.end.character,
          ),
          'member',
        );
        const inferred = await f.service.query({
          kind: 'hover',
          path: f.files.Producer,
          offset: text.indexOf('observed'),
        });
        assert(inferred?.code.some((code) => code.includes(type)));
        const rename = await f.service.query({
          kind: 'rename',
          path: f.files.Consumer,
          offset,
          newName: 'edge',
        });
        assert.equal(rename?.edits.length, 3);
        assert.equal(rename.sources.length, 2);
        assert(rename.sources.some((source) => source.text === text));
        assert(
          ![...f.diagnostics.values()].some((snapshot) =>
            snapshot.diagnostics.some((diagnostic) =>
              diagnostic.message.includes('Internal'),
            ),
          ),
        );
      }
      await f.edit(
        'Producer',
        'function make_factory(){return {different:1};}',
      );
      const hover = await f.service.query({
        kind: 'hover',
        path: f.files.Consumer,
        offset: use.lastIndexOf('member'),
      });
      assert(!hover?.code.some((code) => code === 'Real'));
      await f.edit('Producer', initial);
      assert(
        (
          await f.service.query({
            kind: 'hover',
            path: f.files.Consumer,
            offset: use.lastIndexOf('member'),
          })
        )?.code.includes('Real'),
      );
      assert.equal(
        await f.diskText('Producer'),
        initial,
        'Worker inputs never write project files',
      );
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'production worker retains macro multibinding safeguards and applies configuration, close/reopen and retirement in order',
  { timeout: 60000 },
  async () => {
    const macros =
      '#macro PICK local_value\n#macro VALUE {base_member:1}\n#macro Test:VALUE {test_member:1}';
    const use =
      'function first(){var local_value=1;return PICK;}\nfunction second(){var local_value="text";return PICK;}\nvar value=VALUE;\nvalue.';
    const f = await workerFixture({ Definitions: macros, Use: use });
    try {
      await f.service.ready;
      const completion = () =>
        f.service.query({
          kind: 'completion',
          path: f.files.Use,
          offset: use.length,
          trigger: '.',
        });
      assert((await completion())?.some((item) => item.name === 'base_member'));
      f.service.update({ kind: 'configuration', name: 'Test' }, true);
      assert((await completion())?.some((item) => item.name === 'test_member'));
      const multibinding = await f.service.query({
        kind: 'definition',
        path: f.files.Definitions,
        offset: macros.indexOf('local_value'),
      });
      assert.equal(multibinding?.length, 2);
      await assert.rejects(
        f.service.query({
          kind: 'prepareRename',
          path: f.files.Definitions,
          offset: macros.indexOf('local_value'),
        }),
        /unique symbol reference/,
      );
      await assert.rejects(
        f.service.query({
          kind: 'rename',
          path: f.files.Use,
          offset: use.indexOf('local_value'),
          newName: 'changed',
        }),
        /shared macro spelling/,
      );
      f.service.update({ kind: 'configuration', name: 'Default' }, true);
      await f.edit(
        'Definitions',
        macros.replace('base_member', 'unsaved_member'),
        1,
      );
      assert(
        (await completion())?.some((item) => item.name === 'unsaved_member'),
      );
      f.service.update(
        { kind: 'close', path: f.files.Definitions, generation: 1 },
        true,
      );
      assert((await completion())?.some((item) => item.name === 'base_member'));
      await f.edit(
        'Definitions',
        macros.replace('base_member', 'reopened_member'),
        2,
      );
      f.service.update(
        { kind: 'close', path: f.files.Definitions, generation: 1 },
        true,
      );
      assert(
        (await completion())?.some((item) => item.name === 'reopened_member'),
        'A late close must not retire a new buffer generation',
      );
      f.service.update(
        {
          kind: 'document',
          path: f.files.Definitions,
          generation: 2,
          version: 0,
          text: macros.replace('base_member', 'outdated_member'),
        },
        true,
      );
      assert(
        (await completion())?.some((item) => item.name === 'reopened_member'),
        'A lower version in the same generation must not overwrite the current buffer',
      );
      f.yyp.resources = f.yyp.resources.filter(
        (resource) => resource.id.name !== 'Definitions',
      );
      await writeFile(f.yypPath, Yy.stringify(f.yyp));
      f.service.update({ kind: 'project' }, true);
      assert(
        !(await completion())?.some((item) => item.name === 'reopened_member'),
      );
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'production worker reports incomplete static syntax, preserves the later declaration and recovers',
  { timeout: 60000 },
  async () => {
    const source =
      'function StaticBox() constructor { static kept=1; }\nfunction tail(){return 1;}';
    const f = await workerFixture({
      Producer: source,
      Use: 'var value=new StaticBox(); value.kept;',
    });
    try {
      await f.service.ready;
      const broken =
        'function StaticBox() constructor { static }\nfunction tail(){return "changed";}';
      await f.edit('Producer', broken);
      const diagnostics = [...f.diagnostics.values()].find(
        (snapshot) =>
          snapshot.path.replace(/\\/g, '/') ===
          f.files.Producer.replace(/\\/g, '/'),
      );
      assert(diagnostics?.diagnostics.length);
      assert(
        !diagnostics.diagnostics.some((diagnostic) =>
          diagnostic.message.includes('Internal'),
        ),
      );
      const hover = await f.service.query({
        kind: 'hover',
        path: f.files.Producer,
        offset: broken.indexOf('tail'),
      });
      assert(hover?.code.some((code) => code.includes('String')));
      await f.edit('Producer', source);
      const restored = await f.service.query({
        kind: 'hover',
        path: f.files.Use,
        offset: 'var value=new StaticBox(); value.'.length,
      });
      assert(restored?.code.includes('Real'));
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'native-spec reload replaces built-ins and preserves current open source',
  { timeout: 60000 },
  async () => {
    const f = await workerFixture({ Use: 'show_debug_message(1);' });
    try {
      await f.service.ready;
      const xml = await import('node:fs/promises').then((fs) =>
        fs.readFile(f.input.nativeSpecFiles![0], 'utf8'),
      );
      const modified = f.directory + '/modified-spec.xml';
      await writeFile(
        modified,
        xml.replace('Name="show_debug_message"', 'Name="worker_native_probe"'),
      );
      await f.edit('Use', 'worker_native_probe(1);');
      f.service.update({ kind: 'native', files: [modified] }, true);
      const candidates = await f.service.query({
        kind: 'completion',
        path: f.files.Use,
        offset: 0,
      });
      assert(candidates?.some((item) => item.name === 'worker_native_probe'));
      assert(!candidates?.some((item) => item.name === 'show_debug_message'));
      const selection = await f.service.query({
        kind: 'selection',
        path: f.files.Use,
        offset: 3,
      });
      assert.equal(selection?.native, true);
      assert.equal(await f.diskText('Use'), 'show_debug_message(1);');
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  },
);
