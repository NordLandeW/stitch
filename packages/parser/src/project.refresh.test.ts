import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import { Code } from './project.code.js';
import { Project } from './project.js';
import { logger, setLogger, type Logger } from './logger.js';

// Public symbol/type queries must become correct after edits without requiring
// a consumer edit or a fresh project. Cold equality alone can hide shared bugs.
describe('same-file semantic refresh', function () {
  this.timeout(30000);
  let root: string;
  let project: Project;
  let code: Code;
  let other: Code;
  let errors: unknown[][];
  let previousLogger: Logger;
  before(async () => {
    previousLogger = {
      info: logger.info,
      log: logger.log,
      debug: logger.debug,
      warn: logger.warn,
      error: logger.error,
      dir: logger.dir,
    };
    setLogger({
      ...previousLogger,
      info() {},
      log() {},
      debug() {},
      error: (...args) => errors.push(args),
    });
    root = await mkdtemp(path.join(tmpdir(), 'stitch-refresh-'));
    await cp('samples/project', root, { recursive: true });
    await writeFile(
      path.join(root, 'stitch.config.json'),
      JSON.stringify({ runtimeVersion: '0.0.0.0' }),
    );
  });
  after(async () => {
    setLogger(previousLogger);
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    errors = [];
    project = await Project.initialize(root, { configuration: 'Default' });
    const asset = project.getAssetByName('Script1')!;
    code = new Code(asset, project.dir.join('refresh.gml'));
    other = new Code(asset, project.dir.join('refresh-reader.gml'));
  });
  afterEach(() => {
    assert.equal(
      errors.length,
      0,
      errors.map((args) => args.map(String).join(' ')).join('\n'),
    );
  });
  function reference(file: Code, spelling: string, skip = 0) {
    const offset = file.content.indexOf(spelling);
    assert(offset >= 0, `Missing authored spelling ${spelling}`);
    const found = file.getReferenceAt(offset + skip);
    assert(found, `Missing reference ${spelling}`);
    return found;
  }
  function returns(name: string, expected: string[], file = code) {
    const fn = reference(file, name).item.getTypeByKind('Function');
    assert(fn, `Missing function type ${name}`);
    assert.deepEqual(
      [...new Set(fn.returns?.type.map((type) => type.kind))].sort(),
      [...expected].sort(),
    );
  }
  function memberAndResult(expected: string) {
    const member = reference(code, '.member', 1);
    assert.equal(member.item.type.toFeatherString(), expected);
    assert.equal(member.item.def?.file, code);
    assert.equal(
      member.item.def.source.start.offset,
      code.content.lastIndexOf('member:'),
    );
    returns('RefreshUse', [expected]);
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      expected,
    );
    assert.equal(code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE.length, 0);
  }
  const source = (value = '1') =>
    'function RefreshUse(){return RefreshFactory().member;}\n' +
    `function RefreshFactory(){return {member:${value}};}\n` +
    'var observed=RefreshUse();';

  it('publishes a forward returned member and its transitive return and assignment types', async () => {
    await code.reload(source());
    memberAndResult('Real');
    const counts = [
      code.refs.length,
      code.scopes.length,
      code.functionArgRanges.length,
    ];
    for (let i = 0; i < 3; i++) {
      await code.reload(source() + `\n// Later edit ${i}.`);
      memberAndResult('Real');
      assert.deepEqual(
        [code.refs.length, code.scopes.length, code.functionArgRanges.length],
        counts,
      );
    }
  });

  it('retracts removed members and changes inferred types in unchanged readers', async () => {
    await code.reload(source());
    await other.reload('var external=RefreshUse();');
    for (const [value, kind] of [
      ['"text"', 'String'],
      ['2', 'Real'],
    ]) {
      await code.reload(source(value));
      memberAndResult(kind);
      assert.equal(
        reference(other, 'external').item.type.toFeatherString(),
        kind,
      );
    }
    await code.reload(source().replace('member:1', 'different:1'));
    assert.equal(reference(code, '.member', 1).item.def?.file, undefined);
    assert(code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE.length);
    await code.reload(source('"restored"'));
    memberAndResult('String');
    assert.equal(
      reference(other, 'external').item.type.toFeatherString(),
      'String',
    );
  });

  it('resolves constructor members used before their constructor body', async () => {
    await code.reload(
      'function RefreshUse(){return new RefreshCtor().member;}\n' +
        'function RefreshCtor() constructor {self.member=1;}\nvar observed=RefreshUse();',
    );
    assert.equal(
      reference(code, '.member', 1).item.type.toFeatherString(),
      'Real',
    );
    returns('RefreshUse', ['Real']);
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      'Real',
    );
  });

  for (const length of [3, 12]) {
    it(`resolves a reverse declaration chain of ${length} functions`, async () => {
      const text =
        Array.from(
          { length },
          (_, i) =>
            `function RefreshChain${i}(){return ${i === length - 1 ? '1' : `RefreshChain${i + 1}()`};}`,
        ).join('\n') + '\nvar observed=RefreshChain0();';
      await code.reload(text);
      returns('RefreshChain0', ['Real']);
      assert.equal(
        reference(code, 'observed').item.type.toFeatherString(),
        'Real',
      );
      await code.reload(text.replace('return 1;', 'return "changed";'));
      returns('RefreshChain0', ['String']);
      assert.equal(
        reference(code, 'observed').item.type.toFeatherString(),
        'String',
      );
    });
  }

  it('stabilizes nested local functions without depending only on public summaries', async () => {
    await code.reload(
      'function RefreshNested(){' +
        'var first=function(){return second();};' +
        'var second=function(){return third();};' +
        'var third=function(){return 1;};return first();}' +
        '\nvar observed=RefreshNested();',
    );
    returns('RefreshNested', ['Real']);
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      'Real',
    );
  });

  it('withdraws the old concrete basis when a changed dependency creates a pure cycle', async () => {
    await other.reload('function RefreshB(){return 1;}');
    await code.reload('function RefreshA(){return RefreshB();}');
    returns('RefreshA', ['Real']);
    await other.reload('function RefreshB(){return RefreshA();}');
    for (const [file, name] of [
      [code, 'RefreshA'],
      [other, 'RefreshB'],
    ] as const) {
      const fn = reference(file, name).item.getTypeByKind('Function')!;
      assert(
        !fn.returns?.type.some((type) => type.kind === 'Real'),
        'A recursive cycle with its only concrete basis removed must not keep the old Real',
      );
    }
    await other.reload('function RefreshB(){return "restored";}');
    returns('RefreshA', ['String']);
    returns('RefreshB', ['String'], other);
  });

  it('retains every return branch and honors changed and removed explicit annotations', async () => {
    const body =
      'function RefreshPick(flag){if(flag)return 1;return RefreshFactory().member;}\n' +
      'function RefreshFactory(){return {member:"text"};}\nvar observed=RefreshPick(false);';
    await code.reload(body);
    returns('RefreshPick', ['Real', 'String']);
    await code.reload('/// @returns {Real}\n' + body);
    returns('RefreshPick', ['Real']);
    await code.reload('/// @returns {String}\n' + body);
    returns('RefreshPick', ['String']);
    await code.reload(body);
    returns('RefreshPick', ['Real', 'String']);
    await code.reload(body.replace('member:"text"', 'member:2'));
    returns('RefreshPick', ['Real']);
  });

  for (const [literal, kind] of [
    ['{member:1}', 'Struct'],
    ['[1]', 'Array'],
  ]) {
    it(`stabilizes a recursive ${kind} return with its authored value facts`, async () => {
      await code.reload(
        'function RefreshA(){return RefreshB();}\n' +
          `function RefreshB(flag){if(flag)return ${literal};return RefreshA();}\n` +
          'var observed=RefreshA();',
      );
      returns('RefreshA', [kind]);
      const inferred = reference(code, 'observed').item.type.type;
      assert(inferred.length > 0);
      for (const type of inferred) {
        assert.equal(type.kind, kind);
        if (kind === 'Struct')
          assert.equal(
            type.getMember('member')?.type.toFeatherString(),
            'Real',
          );
        else assert.equal(type.items?.toFeatherString(), 'Real');
      }
    });
  }

  it('keeps cross-file recursive array contents usable after an upstream edit', async () => {
    const left =
      'function recursive_left(stop) { if (stop) return 0; return [recursive_right(true)]; }';
    await code.reload(left);
    await other.reload(
      'function recursive_right(stop) { if (stop) return 0; return [recursive_left(true)]; }',
    );
    const consumer = new Code(
      project.getAssetByName('Script1')!,
      project.dir.join('recursive-consumer.gml'),
    );
    await consumer.reload(
      'function use_recursive() { return recursive_left(true); }',
    );
    await code.reload('// changed\n' + left);
    assert.deepEqual(consumer.getDiagnostics().SYNTAX_ERROR, []);
    assert.equal(reference(consumer, 'recursive_left').item.def?.file, code);
    returns('use_recursive', ['Array', 'Real'], consumer);
  });

  it('keeps separate literal declarations in a recursive union', async () => {
    await code.reload(
      'function RefreshA(){return RefreshB();}\n' +
        'function RefreshB(flag){if(flag)return {member:1};if(!flag)return {member:2};return RefreshA();}\n' +
        'var observed=RefreshA();',
    );
    const inferred = reference(code, 'observed').item.type.type;
    assert.deepEqual(
      [
        ...new Set(
          inferred.map((type) => {
            const definition = type.getMember('member')?.def;
            assert.equal(definition?.file, code);
            assert(definition?.file);
            return definition.start.offset;
          }),
        ),
      ].sort((a, b) => Number(a) - Number(b)),
      [code.content.indexOf('member:1'), code.content.indexOf('member:2')],
    );
  });

  it('matches recursive array arguments inferred from a default parameter', async () => {
    const source =
      'function recursive_left(stop){if(stop)return 0;return [recursive_right(true)];}\n' +
      'function recursive_right(stop){if(stop)return 0;return [recursive_left(true)];}\n' +
      'function consume_recursive(value=recursive_left(true)){return value;}\n' +
      'var observed=consume_recursive(recursive_left(true));';
    await code.reload(source);
    await code.reload('// edit\n' + source);
    assert.deepEqual(code.getDiagnostics().SYNTAX_ERROR, []);
    returns('consume_recursive', ['Array', 'Real']);
    assert.deepEqual(
      [
        ...new Set(
          reference(code, 'observed').item.type.type.map((type) => type.kind),
        ),
      ].sort(),
      ['Array', 'Real'],
    );
  });

  it('preserves a branch changed after selection and retracts its edited members', async () => {
    for (const selection of ['left:right', 'right:left']) {
      for (const value of ['1', '"changed"', undefined]) {
        await code.reload(
          'function Make(){return {base:1};}\n' +
            `function Choose(flag){var left=Make(), right=Make();var selected=flag?${selection};${value ? `right.extra=${value};` : ''}return selected;}\n` +
            'var observed=Choose(true);',
        );
        for (const name of ['selected', 'observed']) {
          const branches = reference(code, name).item.type.type;
          assert(branches.length > 0);
          assert(
            branches.every(
              (type) =>
                type.getMember('base')?.type.toFeatherString() === 'Real',
            ),
          );
          const extra = branches
            .map((type) => type.getMember('extra'))
            .filter((member) => member?.def);
          if (value)
            assert(
              extra.some(
                (member) =>
                  member?.type.toFeatherString() ===
                  (value === '1' ? 'Real' : 'String'),
              ),
            );
          else assert.equal(extra.length, 0);
        }
        assert(
          !reference(code, 'left=Make').item.type.type.some(
            (type) => type.getMember('extra')?.def,
          ),
        );
      }
    }
  });

  it('stabilizes recursive returns based on a readonly native structure', async () => {
    const source =
      '/// @param {Struct.Track} value\nfunction NativeA(flag,value){return NativeB(flag,value);}\n' +
      '/// @param {Struct.Track} value\nfunction NativeB(flag,value){if(flag)return value;return NativeA(flag,value);}\n' +
      'var observed=NativeA(true,undefined);';
    for (const text of [source, '// edit\n' + source]) {
      await code.reload(text);
      assert.deepEqual(code.getDiagnostics().SYNTAX_ERROR, []);
      returns('NativeA', ['Struct']);
      const types = reference(code, 'observed').item.type.type;
      assert(types.length > 0);
      assert(
        types.every(
          (type) =>
            type.name === 'Track' &&
            !!type.getMember('name') &&
            !!type.getMember('tracks'),
        ),
      );
    }
    assert(project.types.get('Struct.Track')?.isReadonly);
  });

  it('keeps shared native function returns when an aliased callback is replaced and removed', async () => {
    const native = project.self
      .getMember('display_get_frequency')!
      .getTypeByKind('Function')!;
    assert.deepEqual(
      native.returns!.type.map((type) => type.kind),
      ['Real'],
    );
    await code.reload(
      'var refreshCallback=display_get_frequency; refreshCallback=function(){return 1;};',
    );
    await code.reload('var observed=display_get_frequency();');
    assert.deepEqual(
      native.returns!.type.map((type) => type.kind),
      ['Real'],
    );
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      'Real',
    );
  });

  it('withdraws return types from readers when their defining source is retired', async () => {
    await other.reload('function RefreshDeleted(){return 1;}');
    await code.reload(
      'function RefreshRead(){return RefreshDeleted();} var observed=RefreshRead();',
    );
    returns('RefreshRead', ['Real']);
    other.retire();
    project.macros.flush();
    assert(
      !reference(code, 'observed').item.type.type.some(
        (type) => type.kind === 'Real',
      ),
    );
    assert.equal(
      code.getReferenceAt(code.content.indexOf('RefreshDeleted'))?.item.def,
      undefined,
    );
  });

  it('withdraws a removed concrete basis through actual asset reload without editing readers', async () => {
    const asset = project.getAssetByName('Script1')!;
    const producer = asset.gmlFilesArray[0];
    const original = await producer.path.read();
    try {
      await producer.reload('function RefreshB(){return 1;}');
      await code.reload('function RefreshA(){return RefreshB();}');
      returns('RefreshA', ['Real']);
      await writeFile(
        producer.path.absolute,
        'function RefreshB(){return RefreshA();}',
      );
      await asset.reload();
      for (const [file, name] of [
        [code, 'RefreshA'],
        [producer, 'RefreshB'],
      ] as const) {
        const fn = reference(file, name).item.getTypeByKind('Function')!;
        assert(!fn.returns?.type.some((type) => type.kind === 'Real'));
      }
      await writeFile(
        producer.path.absolute,
        'function RefreshB(){return "restored";}',
      );
      await asset.reload();
      returns('RefreshA', ['String']);
    } finally {
      await writeFile(producer.path.absolute, original);
    }
  });

  it('withdraws a retired basis from a recursive reader group', async () => {
    await other.reload('function RefreshBasis(){return 1;}');
    await code.reload(
      'function RefreshA(){return RefreshB();}\n' +
        'function RefreshB(flag){if(flag)return RefreshBasis();return RefreshA();}\n' +
        'var observed=RefreshA();',
    );
    returns('RefreshA', ['Real']);
    other.retire();
    project.macros.flush();
    assert(
      !reference(code, 'observed').item.type.type.some(
        (type) => type.kind === 'Real',
      ),
    );
  });

  it('does not rewrite another function when replacing an aliased local callback', async () => {
    await other.reload('function RefreshShared(){return 1;}');
    await code.reload(
      'var callback=RefreshShared;callback=function(){return "replacement";};var observed=RefreshShared();',
    );
    returns('RefreshShared', ['Real'], other);
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      'Real',
    );
    await code.reload('var observed=RefreshShared();');
    returns('RefreshShared', ['Real'], other);
    assert.equal(
      reference(code, 'observed').item.type.toFeatherString(),
      'Real',
    );
  });

  for (const removal of ['reload', 'retire']) {
    it(`retracts metadata from recursive readers through ${removal} when the resource has no code`, async () => {
      const asset = project.getAssetByName('o_object')!;
      const original = await readFile(asset.yyPath.absolute);
      const yy = structuredClone(asset.yy) as any;
      yy.eventList = [];
      const property = {
        $GMObjectProperty: '',
        '%Name': '__refreshBasis',
        name: '__refreshBasis',
        varType: 0,
        value: '1',
        filters: [],
        listItems: [],
        multiselect: false,
        rangeEnabled: false,
        rangeMax: 10,
        rangeMin: 0,
        resourceType: 'GMObjectProperty',
        resourceVersion: '2.0',
      };
      yy.properties = [property];
      try {
        await writeFile(asset.yyPath.absolute, JSON.stringify(yy));
        await asset.reload();
        assert.equal(asset.gmlFilesArray.length, 0);
        await code.reload(
          'function RefreshMetaA(){return RefreshMetaB();}\n' +
            'function RefreshMetaB(flag){if(flag)return o_object.__refreshBasis;return RefreshMetaA();}\n' +
            'var observed=RefreshMetaA();',
        );
        returns('RefreshMetaA', ['Real']);
        property.varType = 2;
        property.value = 'changed';
        await writeFile(asset.yyPath.absolute, JSON.stringify(yy));
        await asset.reload();
        returns('RefreshMetaA', ['String']);
        assert.equal(
          reference(code, 'observed').item.type.toFeatherString(),
          'String',
        );
        if (removal === 'retire') {
          asset.retire();
          project.assets.delete(asset.name);
          project.macros.flush();
        } else {
          yy.properties = [];
          await writeFile(asset.yyPath.absolute, JSON.stringify(yy));
          await asset.reload();
        }
        assert(
          !reference(code, 'observed').item.type.type.some((type) =>
            ['Real', 'String'].includes(type.kind),
          ),
        );
      } finally {
        await writeFile(asset.yyPath.absolute, original);
      }
    });
  }
});
