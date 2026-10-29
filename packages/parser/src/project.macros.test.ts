import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Yy } from '@bscotch/yy';
import { Code } from './project.code.js';
import { Project } from './project.js';
import { Position, Range } from './project.location.js';

// Real Project/Code/visitors and native spec, with only the edited GML buffers
// kept in memory. No editor API or candidate-generated reference supplies an oracle.
describe('macro source integration', function () {
  this.timeout(30000);
  let project: Project;
  let definitions: Code;
  let use: Code;
  let serial = 0;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'stitch-macro-'));
    await cp('samples/project', root, { recursive: true });
    // Select the bundled fallback spec rather than an installed runtime's
    // version-specific API surface. Native discovery may still consult its feed.
    await writeFile(
      path.join(root, 'stitch.config.json'),
      JSON.stringify({ runtimeVersion: '0.0.0.0' }),
    );
    project = await Project.initialize(root, { configuration: 'Default' });
  });
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const asset = project.getAssetByName('Script1')!;
    definitions = new Code(
      asset,
      project.dir.join(`macro-definitions-${serial}.gml`),
    );
    use = new Code(asset, project.dir.join(`macro-usage-${serial++}.gml`));
    await definitions.reload('');
    await use.reload('');
  });
  afterEach(() => {
    use.retire();
    definitions.retire();
    project.setAnalysisConfiguration('Default');
    project.macros.flush();
  });

  it('rejects incomplete inactive-only rename plans and supports them after selecting the active configuration', async () => {
    const originalTree = project.yyp.configs;
    project.yyp.configs = {
      name: 'Default',
      children: [{ name: 'Mobile', children: [] }],
    };
    project.macros.configurationTreeChanged();
    try {
      const source =
        '#macro Mobile:INACTIVE_RENAME 7\n#macro Mobile:INACTIVE_ALIAS INACTIVE_RENAME';
      await definitions.reload(source);
      let macro = definitions.getReferenceAt(
        source.indexOf('INACTIVE_RENAME'),
      )!.item;
      // Inactive template-only references are already complete and may be renamed.
      assert.equal(project.renameEdits(macro, 'ACTIVE_RENAMED').length, 2);
      await use.reload('var inactive_result = INACTIVE_RENAME;');
      await definitions.path.write(definitions.content);
      await use.path.write(use.content);
      macro = definitions.getReferenceAt(
        source.indexOf('INACTIVE_RENAME'),
      )!.item;
      assert.throws(
        () => project.renameEdits(macro, 'ACTIVE_RENAMED'),
        /active configuration/i,
      );
      await assert.rejects(
        project.renameSignifier(macro, 'ACTIVE_RENAMED'),
        /active configuration/i,
      );
      assert.equal(await definitions.path.read(), source);
      assert.equal(
        await use.path.read(),
        'var inactive_result = INACTIVE_RENAME;',
      );
      project.setAnalysisConfiguration('Mobile');
      await project.renameSignifier(macro, 'ACTIVE_RENAMED');
      assert.equal(
        await definitions.path.read(),
        '#macro Mobile:ACTIVE_RENAMED 7\n#macro Mobile:INACTIVE_ALIAS ACTIVE_RENAMED',
      );
      assert.equal(
        await use.path.read(),
        'var inactive_result = ACTIVE_RENAMED;',
      );
      assert.equal(use.getReferenceAt(4)!.item.type.kind, 'Real');
      project.setAnalysisConfiguration('Default');
      assert(
        use
          .getDiagnostics()
          .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
            item.message.includes('ACTIVE_RENAMED'),
          ),
      );
      project.setAnalysisConfiguration('Mobile');
      assert.equal(use.getReferenceAt(4)!.item.type.kind, 'Real');
    } finally {
      project.yyp.configs = originalTree;
      project.macros.configurationTreeChanged();
      project.setAnalysisConfiguration('Default');
    }
  });

  it('clears a surviving duplicate declaration after another event is retired through YY reload', async () => {
    const first = (await project.createObject('Objects/MacroDuplicateFirst'))!;
    const second = (await project.createObject(
      'Objects/MacroDuplicateSecond',
    ))!;
    const firstCode = first.gmlFilesArray[0];
    const secondCode = second.gmlFilesArray[0];
    await firstCode.path.write('#macro DUPLICATE_EVENT_MACRO 1');
    await secondCode.path.write('#macro DUPLICATE_EVENT_MACRO 2');
    await first.reload();
    await second.reload();
    assert(
      secondCode
        .getDiagnostics()
        .SYNTAX_ERROR.some((item) => /duplicate/i.test(item.message)),
    );
    const originalEvents = first.yy.eventList;
    first.yy.eventList = [];
    await Yy.write(first.yyPath.absolute, first.yy, 'objects');
    await first.reload();
    project.drainDirtyFileUpdateQueue();
    assert(await firstCode.path.exists());
    assert.equal(secondCode.getDiagnostics().SYNTAX_ERROR.length, 0);
    assert(
      project.macros
        .activeSymbols()
        .find((symbol) => symbol.name === 'DUPLICATE_EVENT_MACRO')?.def
        ?.file === secondCode,
    );
    first.yy.eventList = originalEvents;
    await Yy.write(first.yyPath.absolute, first.yy, 'objects');
    await first.reload();
    const restored = first.gmlFilesArray[0];
    assert(
      [
        ...restored.getDiagnostics().SYNTAX_ERROR,
        ...secondCode.getDiagnostics().SYNTAX_ERROR,
      ].some((item) => /duplicate/i.test(item.message)),
    );
    await secondCode.remove();
    assert.equal(restored.getDiagnostics().SYNTAX_ERROR.length, 0);
    assert(
      project.macros
        .activeSymbols()
        .find((symbol) => symbol.name === 'DUPLICATE_EVENT_MACRO')?.def
        ?.file === restored,
    );
  });

  it('keeps resource renaming compatible with ordinary and macro-spelled asset references', async () => {
    const cases = [
      [
        'MacroRenameObject',
        'MacroRenamedObject',
        () => project.createObject('Objects/MacroRenameObject'),
      ],
      [
        'MacroRenameShader',
        'MacroRenamedShader',
        () => project.createShader('Scripts/MacroRenameShader'),
      ],
    ] as const;
    for (const [oldName, newName, create] of cases) {
      const asset = (await create())!;
      const originalDefinitions = `#macro RENAME_TARGET ${oldName}`;
      const originalUse = `var direct_asset = ${oldName}; var macro_asset = RENAME_TARGET;`;
      await definitions.path.write(originalDefinitions);
      await use.path.write(originalUse);
      await definitions.reload(originalDefinitions);
      await use.reload(originalUse);
      assert(
        use.getReferenceAt(originalUse.indexOf(oldName))!.item ===
          asset.signifier,
      );
      await assert.rejects(
        project.renameAsset(oldName, 'RENAME_TARGET'),
        /capture/,
      );
      assert(project.getAssetByName(oldName) === asset);
      assert(await asset.yyPath.exists());
      assert.equal(await asset.dir.up().join('RENAME_TARGET').exists(), false);
      assert.equal(await use.path.read(), originalUse);
      await project.renameAsset(oldName, newName);
      const renamed = project.getAssetByName(newName)!;
      assert(renamed && !project.getAssetByName(oldName));
      assert.equal(
        await definitions.path.read(),
        `#macro RENAME_TARGET ${newName}`,
      );
      assert.equal(
        await use.path.read(),
        `var direct_asset = ${newName}; var macro_asset = RENAME_TARGET;`,
      );
      assert(
        use.getReferenceAt(use.content.indexOf(newName))!.item ===
          renamed.signifier,
      );
    }
  });

  it('keeps failed cross-file rename writes inside the source gate until every write settles', async () => {
    await definitions.reload('#macro PICK local_value');
    await use.reload(
      'function macro_failed_write() { var local_value = 7; return PICK; }',
    );
    await definitions.path.write(definitions.content);
    await use.path.write(use.content);
    const originalDefinitionsWrite = definitions.path.write;
    const originalUseWrite = use.path.write;
    const writeUse = originalUseWrite.bind(use.path);
    let entered!: () => void;
    let release!: () => void;
    let completed!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let writeSettled = false;
    definitions.path.write = async () => {
      throw new Error('Injected macro-definition write failure');
    };
    use.path.write = async (...args) => {
      entered();
      await permit;
      try {
        return await writeUse(...args);
      } finally {
        writeSettled = true;
        completed();
      }
    };
    try {
      const symbol = use.getReferenceAt(
        use.content.indexOf('local_value'),
      )!.item;
      const rename = project.renameSignifier(symbol, 'renamed_local').then(
        () => {
          throw new Error('Expected the injected write failure');
        },
        (error) => ({ error, writeSettled }),
      );
      await writing;
      const gate = project.whenSourcesCurrent().then(
        () => writeSettled,
        () => writeSettled,
      );
      // A complete event-loop turn drains the immediate rejection's microtasks;
      // releasing the other write is an explicit synchronization event, not a deadline.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      const [outcome, gateSettled] = await Promise.all([
        rename,
        gate,
        completion,
      ]);
      assert.match(
        String(outcome.error),
        /Injected macro-definition write failure/,
      );
      assert(
        outcome.writeSettled,
        'The rename rejected while another write was still running',
      );
      assert(
        gateSettled,
        'The source gate completed while a write was still running',
      );
      assert.equal(use.content, await use.path.read());
    } finally {
      release();
      definitions.path.write = originalDefinitionsWrite;
      use.path.write = originalUseWrite;
    }
  });

  it('keeps YY-listed event subtypes outside the event-picker list and refreshes their macros', async () => {
    const asset = (await project.createObject('Objects/MacroEventKinds'))!;
    const events = [
      ['Keyboard_65.gml', 5, 65],
      ['KeyPress_66.gml', 9, 66],
      ['KeyRelease_67.gml', 10, 67],
      ['Alarm_11.gml', 2, 11],
      ['Step_1.gml', 3, 1],
      ['Gesture_0.gml', 13, 0],
    ] as const;
    const initial = asset.yy.eventList[0];
    for (const [index, [filename, eventType, eventNum]] of events.entries()) {
      asset.yy.eventList.push({ ...initial, eventType, eventNum });
      await writeFile(
        asset.dir.join(filename).absolute,
        `#macro EVENT_KIND_${index} 7\nvar ordinary_event_${index} = 7;`,
      );
    }
    await use.reload('var event_kind_result = EVENT_KIND_0;');
    await Yy.write(asset.yyPath.absolute, asset.yy, 'objects');
    await asset.reload();
    for (const [index, [filename]] of events.entries()) {
      const code = asset.getGmlFile(asset.dir.join(filename));
      assert(code, `A YY-listed ${filename} must be analyzed`);
      assert.equal(
        code.getReferenceAt(code.content.indexOf(`ordinary_event_${index}`))!
          .item.type.kind,
        'Real',
      );
      assert(
        project.macros
          .activeSymbols()
          .some((symbol) => symbol.name === `EVENT_KIND_${index}`),
      );
    }
    assert.equal(use.getReferenceAt(4)!.item.type.kind, 'Real');
    const keyboardPath = asset.dir.join('Keyboard_65.gml');
    const keyboard = asset.getGmlFile(keyboardPath)!;
    const originalEvents = asset.yy.eventList;
    asset.yy.eventList = originalEvents.filter((item) => item.eventType !== 5);
    await Yy.write(asset.yyPath.absolute, asset.yy, 'objects');
    await asset.reload();
    assert.equal(asset.getGmlFile(keyboardPath), undefined);
    assert(await keyboardPath.exists());
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes('EVENT_KIND_0'),
        ),
    );
    asset.yy.eventList = originalEvents;
    await Yy.write(asset.yyPath.absolute, asset.yy, 'objects');
    await asset.reload();
    assert(asset.getGmlFile(keyboardPath) !== keyboard);
    assert.equal(use.getReferenceAt(4)!.item.type.kind, 'Real');
  });

  it('retires only the collision target removed from YY while preserving its authored file', async () => {
    const asset = (await project.createObject('Objects/MacroCollisionOwner'))!;
    const first = (await project.createObject('Objects/MacroCollisionFirst'))!;
    const second = (await project.createObject(
      'Objects/MacroCollisionSecond',
    ))!;
    const initial = asset.yy.eventList[0];
    for (const target of [first, second]) {
      asset.yy.eventList.push({
        ...initial,
        eventType: 4,
        eventNum: 0,
        collisionObjectId: target.resource.id,
      });
      await writeFile(
        asset.dir.join(`Collision_${target.name}.gml`).absolute,
        `#macro COLLISION_${target.name} 7`,
      );
    }
    await Yy.write(asset.yyPath.absolute, asset.yy, 'objects');
    await asset.reload();
    const firstPath = asset.dir.join(`Collision_${first.name}.gml`);
    const secondPath = asset.dir.join(`Collision_${second.name}.gml`);
    const survivor = asset.getGmlFile(secondPath)!;
    assert(asset.getGmlFile(firstPath) && survivor);
    await use.reload(`var collision_result = COLLISION_${first.name};`);
    assert.equal(use.getReferenceAt(4)!.item.type.kind, 'Real');
    asset.yy.eventList = asset.yy.eventList.filter(
      (item) => item.collisionObjectId?.name !== first.name,
    );
    await Yy.write(asset.yyPath.absolute, asset.yy, 'objects');
    await asset.reload();
    assert.equal(
      !!asset.getGmlFile(firstPath),
      false,
      'A different collision target must not keep this event active',
    );
    assert(asset.getGmlFile(secondPath) === survivor);
    assert(await firstPath.exists());
    assert(
      !project.macros
        .activeSymbols()
        .some((symbol) => symbol.name === `COLLISION_${first.name}`),
    );
    assert(
      project.macros
        .activeSymbols()
        .some((symbol) => symbol.name === `COLLISION_${second.name}`),
    );
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes(`COLLISION_${first.name}`),
        ),
    );
  });

  const body = [
    'function macro_numeric_context() {',
    '    var local_value = 1;',
    '    return WRAP;',
    '}',
    'function macro_text_context() {',
    '    var local_value = "text";',
    '    return WRAP;',
    '}',
    'var macro_numeric_result = macro_numeric_context();',
    'var macro_text_result = macro_text_context();',
  ].join('\n');

  it('binds shared body spellings in each invocation context and exposes both physical definitions', async () => {
    await definitions.reload('#macro PICK local_value\n#macro WRAP PICK');
    await use.reload(body);
    assert.equal(use.content, body);
    assert.equal(
      use.getReferenceAt(body.indexOf('macro_numeric_result'))!.item.type.kind,
      'Real',
    );
    assert.equal(
      use.getReferenceAt(body.indexOf('macro_text_result'))!.item.type.kind,
      'String',
    );
    const firstMacro = use.getReferenceAt(3, 12)!;
    assert.equal(firstMacro.item.name, 'WRAP');
    assert.equal(firstMacro.text, 'WRAP');
    assert(firstMacro.item.def?.file === definitions);
    const candidates = definitions.getReferenceCandidatesAt(1, 13);
    assert.equal(new Set(candidates.map((ref) => ref.item)).size, 2);
    const targets = candidates
      .map((ref) => ref.item.def?.file && ref.item.def.source.start.line)
      .sort();
    assert.deepEqual(targets, [2, 6]);
    assert.equal(definitions.getReferenceAt(1, 13), undefined);
    assert.equal(
      definitions.getDiagnostics().UNDECLARED_GLOBAL_REFERENCE.length,
      0,
    );
    assert.equal(use.getDiagnostics().SYNTAX_ERROR.length, 0);
    assert.equal(
      use.sourceRefs.filter((ref) => ref.item.name === 'WRAP').length,
      2,
    );
  });

  it('renames macro identities once per physical spelling and rejects shared local bindings', async () => {
    const text = '#macro PICK local_value\n#macro WRAP PICK';
    await definitions.reload(text);
    await use.reload(body);
    const points = (symbol: ReturnType<Code['getReferenceAt']>, name: string) =>
      project.renameEdits(symbol!.item, name).map((edit) => ({
        file: edit.range.file,
        offset: edit.range.start.offset,
        text: edit.text,
      }));
    assert.deepEqual(
      points(use.getReferenceAt(body.indexOf('WRAP')), 'RENAMED_WRAP'),
      [
        {
          file: definitions,
          offset: text.indexOf('WRAP'),
          text: 'RENAMED_WRAP',
        },
        { file: use, offset: body.indexOf('WRAP'), text: 'RENAMED_WRAP' },
        { file: use, offset: body.lastIndexOf('WRAP'), text: 'RENAMED_WRAP' },
      ],
    );
    assert.deepEqual(
      points(definitions.getReferenceAt(text.indexOf('PICK')), 'RENAMED_PICK'),
      [
        {
          file: definitions,
          offset: text.indexOf('PICK'),
          text: 'RENAMED_PICK',
        },
        {
          file: definitions,
          offset: text.lastIndexOf('PICK'),
          text: 'RENAMED_PICK',
        },
      ],
    );
    assert.throws(
      () =>
        project.renameEdits(
          use.getReferenceAt(body.indexOf('local_value'))!.item,
          'new_local',
        ),
      /shared macro spelling/,
    );
    assert.throws(
      () =>
        project.renameEdits(
          use.getReferenceAt(body.indexOf('WRAP'))!.item,
          'macro_numeric_result',
        ),
      /capture/,
    );
    assert.throws(
      () =>
        project.renameEdits(
          use.getReferenceAt(body.indexOf('local_value'))!.item,
          'PICK',
        ),
      /capture/,
    );
    assert.equal(use.content, body);
    assert.equal(definitions.content, text);
  });

  it('allows an unambiguous expanded local rename without editing macro invocation names', async () => {
    const text = '#macro PICK local_value\n#macro WRAP PICK';
    const single =
      'function macro_single() { var local_value = 1; return WRAP; }';
    await definitions.reload(text);
    await use.reload(single);
    const edits = project.renameEdits(
      use.getReferenceAt(single.indexOf('local_value'))!.item,
      'renamed_local',
    );
    assert.equal(edits.length, 2);
    assert.deepEqual(
      edits.map((edit) =>
        edit.range.file.content.slice(
          edit.range.start.offset,
          edit.range.end.offset + 1,
        ),
      ),
      ['local_value', 'local_value'],
    );
    assert(edits[0].range.file === definitions);
    assert(edits[1].range.file === use);
    assert(edits.every((edit) => edit.text === 'renamed_local'));
  });

  it('includes inactive configuration declarations and bodies in a macro rename', async () => {
    const text =
      '#macro PICK 1\n#macro WRAP PICK\n#macro Unselected:PICK 2\n#macro Unselected:WRAP PICK';
    await definitions.reload(text);
    await use.reload('var macro_value = WRAP;');
    const symbol = definitions.getReferenceAt(text.indexOf('PICK'))!.item;
    const edits = project.renameEdits(symbol, 'RENAMED_PICK');
    const expected = [...text.matchAll(/PICK/g)].map((match) => match.index);
    assert.deepEqual(
      edits.map((edit) => edit.range.start.offset),
      expected,
    );
    assert(
      edits.every(
        (edit) =>
          edit.range.file === definitions && edit.text === 'RENAMED_PICK',
      ),
    );
    assert.throws(() => project.renameEdits(symbol, 'WRAP'), /capture/);
  });

  it('rejects variable keyword rename targets and collisions in the owning struct', async () => {
    await definitions.reload(
      '#macro PICK 1\n#macro PAIR { macro_left_member: 1, macro_right_member: 2 }',
    );
    await use.reload('var macro_value = PICK; var macro_pair = PAIR;');
    const variable = use.getReferenceAt(
      use.content.indexOf('macro_value'),
    )!.item;
    assert.throws(
      () => project.renameEdits(variable, 'if'),
      /identifier|reserved/i,
    );
    const left = definitions.getReferenceAt(
      definitions.content.indexOf('macro_left_member'),
    )!.item;
    assert.throws(
      () => project.renameEdits(left, 'macro_right_member'),
      /different symbol|already/,
    );
  });

  it('does not treat unrelated global names as collisions for qualified struct properties', async () => {
    await definitions.reload('#macro PAIR { macro_left_member: 1 }');
    await use.reload(
      'var macro_pair = PAIR; var macro_property_value = macro_pair.macro_left_member;',
    );
    const left = definitions.getReferenceAt(
      definitions.content.indexOf('macro_left_member'),
    )!.item;
    const edits = project.renameEdits(left, 'x');
    assert.equal(edits.length, 2);
    assert(edits.every((edit) => edit.text === 'x'));
  });

  it('refreshes unchanged users after a forward definition is added, changed, removed and restored', async () => {
    const text = 'var macro_value = NEW_MACRO; var macro_tail = 7;';
    await use.reload(text);
    await definitions.reload('#macro NEW_MACRO 1');
    assert.equal(
      use.getReferenceAt(text.indexOf('macro_value'))!.item.type.kind,
      'Real',
    );
    await definitions.reload('#macro NEW_MACRO "updated"');
    assert.equal(
      use.getReferenceAt(text.indexOf('macro_value'))!.item.type.kind,
      'String',
    );
    assert.equal(use.content, text);
    assert.equal(
      use.getReferenceAt(text.indexOf('macro_tail'))!.text,
      'macro_tail',
    );
    await definitions.reload('');
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes('NEW_MACRO'),
        ),
    );
    await definitions.reload('#macro NEW_MACRO 2');
    assert.equal(
      use.getReferenceAt(text.indexOf('macro_value'))!.item.type.kind,
      'Real',
    );
    assert.equal(use.getDiagnostics().UNDECLARED_GLOBAL_REFERENCE.length, 0);
  });

  it('preserves definitions after an ordinary edit outside the macro directive', async () => {
    await definitions.reload('#macro PICK 1\n// original');
    await use.reload('var macro_value = PICK;');
    await definitions.reload('#macro PICK 1\n// changed after the directive');
    const macro = use.getReferenceAt(1, 19)!.item;
    assert.equal(macro.name, 'PICK');
    assert(macro.def?.file === definitions);
    assert.equal(macro.def?.file && macro.def.source.start.line, 1);
  });

  it('maps completion scopes and call argument queries after a long expansion', async () => {
    await definitions.reload(
      '#macro VALUE { alpha: 1, beta: "text" }\n#macro CALL macro_add',
    );
    const text =
      'function macro_add(left, right) { return left + right; }\nvar value = VALUE;\nCALL(1, 2);\nvalue.';
    await use.reload(text);
    const names = use.getInScopeSymbolsAt(text.length).map((item) => item.name);
    assert(names.includes('alpha'));
    assert(names.includes('beta'));
    const argument = use.getFunctionArgRangeAt(text.indexOf('2);'));
    assert.equal(argument?.idx, 1);
    assert.equal(argument?.type.name, 'macro_add');
  });

  it('updates configuration inheritance and physical targets without changing the user buffer', async () => {
    const configs = project.yyp.configs;
    project.yyp.configs = {
      name: 'Default',
      children: [
        { name: 'Parent', children: [{ name: 'Child', children: [] }] },
        { name: 'Sibling', children: [] },
      ],
    };
    project.macros.configurationTreeChanged();
    try {
      await definitions.reload(
        '#macro VALUE { base_only: 1 }\n#macro Parent:VALUE { parent_only: 1 }\n#macro Child:VALUE { child_only: 1 }\n#macro Sibling:VALUE { sibling_only: 1 }',
      );
      const text = 'var macro_config_value = VALUE;\nmacro_config_value.';
      await use.reload(text);
      for (const [configuration, member, line] of [
        ['Default', 'base_only', 1],
        ['Parent', 'parent_only', 2],
        ['Child', 'child_only', 3],
        ['Sibling', 'sibling_only', 4],
      ] as const) {
        project.setAnalysisConfiguration(configuration);
        const names = use
          .getInScopeSymbolsAt(text.length)
          .map((item) => item.name);
        assert(names.includes(member), `${configuration}: missing ${member}`);
        assert.equal(names.filter((name) => name.endsWith('_only')).length, 1);
        const macro = use.getReferenceAt(text.indexOf('VALUE'))!.item;
        assert.equal(macro.def?.file && macro.def.source.start.line, line);
        assert.equal(use.content, text);
      }
    } finally {
      project.yyp.configs = configs;
      project.macros.configurationTreeChanged();
      project.setAnalysisConfiguration('Default');
    }
  });

  it('withdraws one caller without deleting another caller or accumulating shared references', async () => {
    await definitions.reload('#macro PICK local_value\n#macro WRAP PICK');
    await use.reload(body);
    const originalCount = definitions.sourceRefs.length;
    for (let i = 0; i < 3; i++) {
      await use.reload(`${body}\n// edit ${i}`);
      assert.equal(definitions.sourceRefs.length, originalCount);
    }
    await use.reload(
      'function macro_numeric_context() { var local_value = 1; return WRAP; }',
    );
    assert.equal(
      new Set(
        definitions.getReferenceCandidatesAt(1, 13).map((ref) => ref.item),
      ).size,
      1,
    );
    use.retire();
    project.macros.flush();
    assert.equal(definitions.getReferenceCandidatesAt(1, 13).length, 0);
  });

  it('retires a macro resource without touching its path and refreshes its remaining users', async () => {
    await definitions.reload('#macro RETIRING 1');
    await use.reload('var macro_value = RETIRING; var macro_tail = 7;');
    definitions.retire();
    project.macros.flush();
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes('RETIRING'),
        ),
    );
    assert.equal(use.getReferenceAt(1, 33)!.text, 'macro_tail');
  });

  it('rejects keyword macro renames that capture existing control-flow words', async () => {
    await definitions.reload('#macro PICK 1');
    await use.reload('if (true) { var macro_value = PICK; }');
    assert.throws(
      () =>
        project.renameEdits(
          use.getReferenceAt(use.content.indexOf('PICK'))!.item,
          'if',
        ),
      /capture/,
    );
  });

  it('keeps macro navigation identity when recursive expansion is diagnosed', async () => {
    await definitions.reload('#macro CYCLE CYCLE');
    await use.reload('var macro_value = CYCLE; var macro_tail = 7;');
    assert.equal(
      use.getReferenceAt(use.content.indexOf('CYCLE'))!.item.macro,
      true,
    );
    assert.equal(
      definitions.getReferenceAt(definitions.content.lastIndexOf('CYCLE'))!.item
        .macro,
      true,
    );
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_tail'))!.text,
      'macro_tail',
    );
  });

  it('withdraws and restores macro resources through real YYP and object YY reloads without deleting source files', async () => {
    const script = (await project.createScript('Scripts/MacroLifecycleDefs'))!;
    const definition = script.gmlFilesArray[0];
    await definition.path.write('#macro DISK_MACRO 7');
    await script.reload();
    await use.reload(
      'var macro_disk_value = DISK_MACRO; var macro_event_value = EVENT_MACRO;',
    );
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_disk_value'))!.item.type
        .kind,
      'Real',
    );
    const resource = script.resource;
    project.yyp.resources = project.yyp.resources.filter(
      (item) => item.id.name !== script.name,
    );
    await Yy.write(project.yypPath!.absolute, project.yyp, 'project');
    await project.reloadYyp();
    assert.equal(project.getAssetByName(script.name), undefined);
    assert(await definition.path.exists());
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes('DISK_MACRO'),
        ),
    );
    project.yyp.resources.push(resource);
    await Yy.write(project.yypPath!.absolute, project.yyp, 'project');
    await project.reloadYyp();
    const restored = project.getAssetByName(script.name)!.gmlFilesArray[0];
    // Boolean identity checks keep failed assertions from expanding cyclic project graphs.
    assert(restored !== definition);
    assert(
      use.getReferenceAt(use.content.indexOf('DISK_MACRO'))!.item.def?.file ===
        restored,
    );
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_disk_value'))!.item.type
        .kind,
      'Real',
    );
    const movedDirectory = path.join(root, 'scripts', script.name, 'relocated');
    await mkdir(movedDirectory, { recursive: true });
    await cp(
      script.yyPath.absolute,
      path.join(movedDirectory, `${script.name}.yy`),
    );
    await writeFile(
      path.join(movedDirectory, `${script.name}.gml`),
      '#macro DISK_MACRO "moved"',
    );
    project.yyp.resources.find(
      (item) => item.id.name === script.name,
    )!.id.path = `scripts/${script.name}/relocated/${script.name}.yy`;
    await Yy.write(project.yypPath!.absolute, project.yyp, 'project');
    await project.reloadYyp();
    const moved = project.getAssetByName(script.name)!.gmlFilesArray[0];
    assert(
      moved !== restored,
      'A changed YYP path must replace the loaded Code identity',
    );
    assert(await restored.path.exists());
    assert(
      use.getReferenceAt(use.content.indexOf('DISK_MACRO'))!.item.def?.file ===
        moved,
    );
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_disk_value'))!.item.type
        .kind,
      'String',
    );
    project.yyp.configs.children.push({ name: 'MacroChild', children: [] });
    await Yy.write(project.yypPath!.absolute, project.yyp, 'project');
    await project.reloadYyp();
    await moved.reload(
      '#macro DISK_MACRO 7\n#macro MacroChild:DISK_MACRO "selected"',
    );
    project.setAnalysisConfiguration('MacroChild');
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_disk_value'))!.item.type
        .kind,
      'String',
    );
    project.yyp.configs.children = project.yyp.configs.children.filter(
      (config) => config.name !== 'MacroChild',
    );
    await Yy.write(project.yypPath!.absolute, project.yyp, 'project');
    await project.reloadYyp();
    assert.equal(project.analysisConfiguration, 'Default');
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_disk_value'))!.item.type
        .kind,
      'Real',
    );
    const object = (await project.createObject(
      'Objects/MacroLifecycleObject',
    ))!;
    const event = object.gmlFilesArray.find(
      (code) => code.path.basename === 'Create_0.gml',
    )!;
    await event.path.write('#macro EVENT_MACRO "event"');
    await object.reload();
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_event_value'))!.item.type
        .kind,
      'String',
    );
    const events = [...object.yy.eventList];
    object.yy.eventList = [];
    await object.saveYy();
    await object.reload();
    assert.equal(object.gmlFilesArray.length, 0);
    assert(await event.path.exists());
    assert(
      use
        .getDiagnostics()
        .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
          item.message.includes('EVENT_MACRO'),
        ),
    );
    object.yy.eventList = events;
    await object.saveYy();
    await object.reload();
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_event_value'))!.item.type
        .kind,
      'String',
    );
  });

  it('rejects non-editable and overlapping physical rename plans before any write', async () => {
    await use.reload(
      'var macro_old_name = 7; var macro_other = macro_old_name;',
    );
    const original = use.getReferenceAt(use.content.indexOf('macro_old_name'))!;
    const symbol = original.item;
    const nonEditable = symbol.addRef(
      new Range(original.start, original.end, {
        editable: () => false,
        project: () => original.source,
      }),
    );
    assert.throws(
      () => project.renameEdits(symbol, 'macro_fresh_name'),
      /non-editable/,
    );
    symbol.refs.delete(nonEditable);
    const overlapping = new Range(
      original.start,
      new Position(
        use,
        original.end.offset + 1,
        original.end.line,
        original.end.column + 1,
      ),
    );
    symbol.addRef(overlapping);
    assert.throws(
      () => project.renameEdits(symbol, 'macro_fresh_name'),
      /Overlapping/,
    );
    assert.equal(
      use.content,
      'var macro_old_name = 7; var macro_other = macro_old_name;',
    );
  });

  it('renames the complete cross-file macro binding through the public Code entry point', async () => {
    await definitions.path.write('#macro PICK local_value');
    await use.path.write(
      'function macro_single_context() { var local_value = 7; return PICK; }',
    );
    await definitions.reload();
    await use.reload();
    const local = use.getReferenceAt(use.content.indexOf('local_value'))!.item;
    await use.renameSignifier(local, 'renamed_local');
    assert.equal(await definitions.path.read(), '#macro PICK renamed_local');
    assert.equal(
      await use.path.read(),
      'function macro_single_context() { var renamed_local = 7; return PICK; }',
    );
    assert.equal(
      definitions.getReferenceAt(definitions.content.indexOf('renamed_local'))!
        .item.name,
      'renamed_local',
    );
    assert.equal(
      use.getReferenceAt(use.content.indexOf('renamed_local'))!.item.type.kind,
      'Real',
    );
  });

  it('reports invalid characters from the complete macro expansion at its physical invocation', async () => {
    await definitions.reload('#macro BAD 1§');
    await use.reload('var macro_value = BAD; var macro_tail = 7;');
    const diagnostic = use
      .getDiagnostics()
      .SYNTAX_ERROR.find((item) => /unexpected character/.test(item.message));
    assert(
      diagnostic,
      'The invalid replacement character must not disappear during lexing',
    );
    assert.equal(diagnostic.location.start.offset, use.content.indexOf('BAD'));
    assert.equal(
      use.getReferenceAt(use.content.indexOf('macro_tail'))!.item.type.kind,
      'Real',
    );
  });

  it('keeps inactive-only macro declarations valid while diagnosing unexpanded runtime uses', async () => {
    const original = project.yyp.configs;
    project.yyp.configs = {
      name: 'Default',
      children: [{ name: 'Mobile', children: [] }],
    };
    try {
      project.macros.configurationTreeChanged();
      await definitions.reload('#macro Mobile:ONLY_MOBILE 7');
      await use.reload('var macro_selected_value = ONLY_MOBILE;');
      const declarationErrors = () =>
        definitions.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE;
      assert.equal(declarationErrors().length, 0);
      assert(
        use
          .getDiagnostics()
          .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
            item.message.includes('ONLY_MOBILE'),
          ),
      );
      project.setAnalysisConfiguration('Mobile');
      assert.equal(declarationErrors().length, 0);
      assert.equal(
        use.getReferenceAt(use.content.indexOf('macro_selected_value'))!.item
          .type.kind,
        'Real',
      );
      project.setAnalysisConfiguration('Default');
      assert.equal(declarationErrors().length, 0);
      assert(
        use
          .getDiagnostics()
          .UNDECLARED_GLOBAL_REFERENCE.some((item) =>
            item.message.includes('ONLY_MOBILE'),
          ),
      );
    } finally {
      project.yyp.configs = original;
      project.macros.configurationTreeChanged();
      project.macros.flush();
    }
  });
});
