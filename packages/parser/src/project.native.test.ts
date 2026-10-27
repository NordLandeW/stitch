import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Asset } from './project.asset.js';
import { Code } from './project.code.js';
import {
  Native,
  NativeSpecError,
  type NativeSpecStage,
} from './project.native.js';
import type { GmlSpec } from './project.spec.js';
import { Signifier } from './signifiers.js';
import { Type } from './types.js';
import { ok } from './util.js';

/** Real Code/visitors and native symbols; no project loading or on-disk GML. */
function memoryCode(native: Native) {
  const project = {
    self: native.globalSelf,
    types: native.types,
    native,
    options: {},
    queueDirtyFileUpdate() {},
    drainDirtyFileUpdateQueue() {},
    emitDiagnostics() {},
  };
  return new Code(
    {
      project,
      assetKind: 'scripts',
      name: 'native_fixture',
    } as unknown as Asset,
    pathy(join(tmpdir(), 'stitch-native-fixture.gml')),
  );
}

async function specError(
  promise: Promise<unknown>,
  path: string,
  stage: NativeSpecStage,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).to.be.instanceOf(NativeSpecError);
  const error = caught as NativeSpecError;
  expect(error.specFilePath).to.equal(path);
  expect(error.stage).to.equal(stage);
  expect(error.message).to.include(path).and.include(stage);
  expect(error.cause).to.be.instanceOf(Error);
  expect(error.cause).not.to.be.instanceOf(NativeSpecError);
  return error;
}

describe('Native specification loading', function () {
  let xml: string;
  let spec: GmlSpec;
  let directory: string;

  before(async function () {
    xml = await readFile(Native.fallbackGmlSpecPath.absolute, 'utf8');
    spec = await Native.parse(Native.fallbackGmlSpecPath.absolute);
    expect(
      spec.enumerations.length,
      'the real spec must exercise enums',
    ).to.be.greaterThan(0);
  });

  beforeEach(async function () {
    directory = await mkdtemp(join(tmpdir(), 'stitch-native-'));
  });

  afterEach(async function () {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeSpec(name: string, content: string) {
    const path = pathy(join(directory, name));
    await writeFile(path.absolute, content, 'utf8');
    return path;
  }

  function functionXml(name: string) {
    const found = xml
      .match(/<Function\b[^>]*>[\s\S]*?<\/Function>/g)
      ?.find((entry) => entry.includes(`Name="${name}"`));
    ok(found, `Missing real function fixture ${name}`);
    return found;
  }

  function enumerationXml(name: string) {
    const found = xml
      .match(/<Enumeration\b[^>]*>[\s\S]*?<\/Enumeration>/g)
      ?.find((entry) => entry.includes(`Name="${name}"`));
    ok(found, `Missing real enum fixture ${name}`);
    return found;
  }

  function accessEntryXml(kind: 'Variable' | 'Structure', name: string) {
    const pattern = new RegExp(`<${kind}\\b[^>]*>[\\s\\S]*?<\\/${kind}>`, 'g');
    const found = xml
      .match(pattern)
      ?.find((entry) => entry.match(/^[^>]*\bName="([^"]*)"/)?.[1] === name);
    ok(found, `Missing real ${kind} fixture ${name}`);
    return found;
  }

  function accessSubset(
    variables: string[],
    structures: string[],
    module = spec.module,
  ) {
    return `<GameMakerLanguageSpec RuntimeVersion="${spec.runtime}" Module="${module}">
<Variables>${variables.join('\n')}</Variables>
<Structures>${structures.join('\n')}</Structures>
</GameMakerLanguageSpec>`;
  }

  /** Subsets retain actual spec entries, rather than hand-copying signatures. */
  function subset(
    functions: string[],
    enumerations: string[] = [],
    module = 'Base',
    runtime = spec.runtime,
  ) {
    return `<GameMakerLanguageSpec RuntimeVersion="${runtime}" Module="${module}">
<Functions>${functions.join('\n')}</Functions>
<Enumerations>${enumerations.join('\n')}</Enumerations>
</GameMakerLanguageSpec>`;
  }

  it('loads every real enum and member with identity, value and metadata', async function () {
    const native = await Native.from(undefined, new Type('Struct'), new Map());
    for (const enumeration of spec.enumerations) {
      const symbol = native.globalSelf.getMember(enumeration.name);
      ok(symbol, `Missing native enum ${enumeration.name}`);
      const type = symbol.getTypeByKind('Enum');
      ok(type);
      expect(type).to.equal(native.types.get(`Enum.${enumeration.name}`));
      expect(type.signifier).to.equal(symbol);
      expect(symbol.enum).to.equal(true);
      expect(symbol.global).to.equal(true);
      expect(symbol.native).to.equal(enumeration.module);
      expect(symbol.writable).to.equal(false);
      expect(symbol.isRenameable).to.equal(false);
      expect(symbol.def).to.exist;
      expect(type.isReadonly).to.equal(true);
      expect(type.listMembers().map((member) => member.name)).to.deep.equal(
        enumeration.members.map((member) => member.name),
      );
      for (const member of enumeration.members) {
        const loaded = type.getMember(member.name);
        ok(loaded);
        expect(loaded.parent).to.equal(type);
        expect(loaded.type.kind).to.equal('EnumMember');
        expect(loaded.type.type[0].signifier).to.equal(loaded);
        expect(loaded.enumMember).to.equal(true);
        expect(loaded.native).to.equal(enumeration.module);
        expect(loaded.description).to.equal(member.description);
        expect(loaded.deprecated).to.equal(member.deprecated);
        expect(loaded.writable).to.equal(false);
        expect(loaded.isRenameable).to.equal(false);
        expect(loaded.def).to.exist;
        expect(loaded.idx).to.equal(undefined);
        expect(native.getEnumMemberValue(loaded)).to.equal(member.value);
      }
      expect(type.addMember('__not_in_the_spec__')).to.equal(undefined);
      expect(type.getMember('__not_in_the_spec__')).to.equal(undefined);
    }
    expect(
      native.getEnumMemberValue(new Signifier(new Type('Enum'), 'unknown')),
    ).to.equal(undefined);

    // Signatures must use those same enum objects, not detached placeholder types.
    let checkedParameters = 0;
    for (const func of spec.functions) {
      const loaded = native.globalSelf
        .getMember(func.name)
        ?.getTypeByKind('Function');
      for (let index = 0; index < func.parameters.length; index++) {
        const parameter = func.parameters[index];
        if (
          spec.enumerations.some(
            (entry) => parameter.type === `Enum.${entry.name}`,
          )
        ) {
          expect(loaded?.getParameter(index)?.type.type[0]).to.equal(
            native.types.get(parameter.type),
          );
          checkedParameters++;
        }
      }
    }
    expect(checkedParameters).to.be.greaterThan(0);
  });

  it('resolves and completes real enum members while diagnosing an unknown member', async function () {
    const native = await Native.from(undefined, new Type('Struct'), new Map());
    const code = memoryCode(native);
    const accesses = spec.enumerations.flatMap((enumeration) =>
      enumeration.members.map((member) => ({
        enumeration,
        member,
        expression: `${enumeration.name}.${member.name}`,
      })),
    );
    const source = accesses
      .map(({ expression }, index) => `var result_${index} = ${expression};`)
      .join('\n');
    for (const text of [source, source]) {
      await code.reload(text);
      expect(Object.values(code.getDiagnostics()).flat()).to.have.lengthOf(0);
      let cursor = 0;
      for (const { enumeration, member, expression } of accesses) {
        const offset = text.indexOf(expression, cursor);
        const memberOffset = offset + enumeration.name.length + 1;
        cursor = offset + expression.length;
        const symbol = native.globalSelf.getMember(enumeration.name)!;
        const enumType = symbol.getTypeByKind('Enum')!;
        expect(code.getReferenceAt(offset)?.item).to.equal(symbol);
        expect(code.getReferenceAt(memberOffset)?.item).to.equal(
          enumType.getMember(member.name),
        );
        expect(code.getReferenceAt(memberOffset)?.isDef).to.equal(false);
        expect(code.getInScopeSymbolsAt(memberOffset)).to.have.members(
          enumType.listMembers(),
        );
      }
    }

    const enumeration = spec.enumerations[0];
    const unknown = `${enumeration.name}.__not_in_the_spec__`;
    await code.reload(`${source}\nvar bad = ${unknown};`);
    const diagnostics = Object.values(code.getDiagnostics()).flat();
    expect(diagnostics).to.have.lengthOf(1);
    expect(diagnostics[0].message).to.match(/enum member/i);
    expect(diagnostics[0].location.start.offset).to.be.at.least(source.length);
    expect(
      native.types
        .get(`Enum.${enumeration.name}`)
        ?.getMember('__not_in_the_spec__'),
    ).to.equal(undefined);
    await code.reload(source);
    expect(Object.values(code.getDiagnostics()).flat()).to.have.lengthOf(0);
  });

  it('preserves deprecation and nonordinal values from a selected module', async function () {
    const enumeration = spec.enumerations.find((entry) =>
      entry.members.some((member, index) => member.value !== index),
    );
    ok(enumeration, 'The real fixture needs a nonordinal enum value');
    const member = enumeration.members[0];
    const original = enumerationXml(enumeration.name);
    const deprecated = original.replace(
      /(<Member\b[^>]*\bDeprecated=")false(")/,
      '$1true$2',
    );
    expect(deprecated).not.to.equal(original);
    const path = await writeSpec(
      'module.xml',
      subset([], [deprecated], 'FixtureModule'),
    );
    const native = await Native.from([path], new Type('Struct'), new Map());
    const loaded = native.globalSelf
      .getMember(enumeration.name)!
      .getTypeByKind('Enum')!
      .getMember(member.name)!;
    expect(loaded.native).to.equal('FixtureModule');
    expect(loaded.deprecated).to.equal(true);
    expect(native.getEnumMemberValue(loaded)).to.equal(member.value);
    expect(loaded.idx).to.equal(undefined);
  });

  it('preserves real reserved variable and struct field access flags', async function () {
    const reserved = spec.variables.filter((entry) => !entry.readable);
    expect(reserved.length).to.be.greaterThan(0);
    const x = spec.variables.find((entry) => entry.name === 'x');
    const id = spec.variables.find((entry) => entry.name === 'id');
    const structure = spec.structures.find(
      (entry) => entry.properties.length > 0,
    );
    ok(x);
    ok(id);
    ok(structure);
    const variables = [...reserved, x, id];
    const path = await writeSpec(
      'real-access.xml',
      accessSubset(
        variables.map((entry) => accessEntryXml('Variable', entry.name)),
        [accessEntryXml('Structure', structure.name)],
      ),
    );
    const native = await Native.from([path], new Type('Struct'), new Map());
    for (const entry of variables) {
      const symbol = native.globalSelf.getMember(entry.name);
      ok(symbol);
      expect(symbol.readable, entry.name).to.equal(entry.readable);
      expect(symbol.writable, entry.name).to.equal(entry.writable);
      expect(symbol.deprecated, entry.name).to.equal(entry.deprecated);
      expect(symbol.native, entry.name).to.equal(spec.module);
      expect(symbol.def, entry.name).to.exist;
      expect(symbol.placeholder, entry.name).to.equal(false);
      expect(symbol.isRenameable, entry.name).to.equal(false);
    }
    const type = native.types.get(`Struct.${structure.name}`);
    ok(type);
    expect(type.isReadonly).to.equal(true);
    for (const entry of structure.properties) {
      const symbol = type.getMember(entry.name);
      ok(symbol);
      expect(symbol.readable, entry.name).to.equal(entry.readable);
      expect(symbol.writable, entry.name).to.equal(entry.writable);
      expect(symbol.native, entry.name).to.equal(spec.module);
      expect(symbol.def, entry.name).to.exist;
      expect(symbol.placeholder, entry.name).to.equal(false);
      expect(symbol.isRenameable, entry.name).to.equal(false);
    }
  });

  it('loads selected unreadable access variants without losing native identity', async function () {
    const variable = spec.variables.find(
      (entry) => !entry.readable && !entry.writable,
    );
    const structure = spec.structures.find((entry) =>
      entry.properties.some((field) => field.readable && field.writable),
    );
    ok(variable);
    ok(structure);
    const property = structure.properties.find(
      (field) => field.readable && field.writable,
    )!;
    const variableXml = accessEntryXml('Variable', variable.name);
    const structureXml = accessEntryXml('Structure', structure.name);
    const fieldXml = structureXml
      .match(/<Field\b[^>]*>[\s\S]*?<\/Field>/g)
      ?.find(
        (entry) => entry.match(/^[^>]*\bName="([^"]*)"/)?.[1] === property.name,
      );
    ok(fieldXml);
    // The real bundle has no Get=false/Set=true variable, nor unreadable
    // struct fields. These are explicit schema fixtures, not runtime history.
    for (const writable of [true, false]) {
      const selectedVariable = variableXml.replace(
        /\bSet="false"/,
        `Set="${writable}"`,
      );
      const selectedField = fieldXml
        .replace(/\bGet="true"/, 'Get="false"')
        .replace(/\bSet="true"/, `Set="${writable}"`);
      expect(selectedField).not.to.equal(fieldXml);
      const path = await writeSpec(
        `selected-access-${writable}.xml`,
        accessSubset(
          [selectedVariable],
          [structureXml.replace(fieldXml, selectedField)],
          'AccessFixture',
        ),
      );
      const selected = await Native.parse(path.absolute);
      const native = await Native.from([path], new Type('Struct'), new Map());
      const type = native.types.get(`Struct.${structure.name}`)!;
      const symbols = [
        native.globalSelf.getMember(variable.name),
        type.getMember(property.name),
      ];
      expect(selected.variables[0].readable).to.equal(false);
      expect(selected.variables[0].writable).to.equal(writable);
      const selectedProperty = selected.structures[0].properties.find(
        (entry) => entry.name === property.name,
      )!;
      expect(selectedProperty.readable).to.equal(false);
      expect(selectedProperty.writable).to.equal(writable);
      for (const symbol of symbols) {
        ok(symbol);
        expect(symbol.readable, symbol.name).to.equal(false);
        expect(symbol.writable, symbol.name).to.equal(writable);
        expect(symbol.native, symbol.name).to.equal(selected.module);
        expect(symbol.def, symbol.name).to.exist;
        expect(symbol.placeholder, symbol.name).to.equal(false);
        expect(symbol.isRenameable, symbol.name).to.equal(false);
      }
      expect(type.isReadonly).to.equal(true);
    }
  });

  it('exposes immutable, byte-hashed provenance and the complete raw metadata', async function () {
    const native = await Native.from(undefined, new Type('Struct'), new Map());
    const sources = native.getSpecSources();
    expect(sources).to.have.lengthOf(1);
    expect(sources[0]).to.deep.equal({
      path: Native.fallbackGmlSpecPath.absolute,
      runtime: spec.runtime,
      module: spec.module,
      bundled: true,
      sha256: createHash('sha256')
        .update(await readFile(Native.fallbackGmlSpecPath.absolute))
        .digest('hex'),
    });
    expect(Object.isFrozen(sources)).to.equal(true);
    expect(Object.isFrozen(sources[0])).to.equal(true);
    const snapshots = native.getSpecs();
    expect(snapshots).to.deep.equal([spec]);
    expect(Object.isFrozen(snapshots)).to.equal(true);
    expect(Object.isFrozen(snapshots[0])).to.equal(true);
    expect(Object.isFrozen(snapshots[0].enumerations[0].members[0])).to.equal(
      true,
    );
    expect(() => {
      (snapshots[0] as GmlSpec).runtime = 'changed';
    }).to.throw(TypeError);
    expect(native.getSpecSources()[0].runtime).to.equal(spec.runtime);
  });

  it('loads only selected entries without a 2.3 cutoff or hardcoded API injection', async function () {
    const enumeration = spec.enumerations[0];
    const path = await writeSpec(
      'selected.xml',
      subset(
        [],
        [enumerationXml(enumeration.name)],
        'SelectedFixture',
        '1.4.9999.0',
      ),
    );
    const native = await Native.from([path], new Type('Struct'), new Map());
    expect(native.globalSelf.getMember(enumeration.name)).to.exist;
    for (const name of [
      'static_get',
      'display_get_frequency',
      'sprite_get_info',
    ]) {
      expect(native.globalSelf.getMember(name), name).to.equal(undefined);
      expect(native.types.get(`Function.${name}`), name).to.equal(undefined);
    }
    expect(native.types.get('Struct.SpriteInfo')).to.equal(undefined);
    expect(native.getSpecSources()[0].runtime).to.equal('1.4.9999.0');
    expect(native.getSpecSources()[0].bundled).to.equal(false);
    // Changing the header exercises schema-driven loading; this is not a claim
    // that this modern enum was historically available in a 1.4 runtime.
  });

  it('refines only present static_get signatures and retains the selected support set', async function () {
    const actual = spec.functions.find((entry) => entry.name === 'static_get');
    ok(actual);
    for (const structOnly of [false, true]) {
      let entry = functionXml(actual.name);
      if (structOnly) {
        entry = entry.replace(
          /(<Parameter\b[^>]*\bType=")[^"]*(")/,
          '$1Struct$2',
        );
      }
      const path = await writeSpec(`static-${structOnly}.xml`, subset([entry]));
      const selected = await Native.parse(path.absolute);
      const native = await Native.from([path], new Type('Struct'), new Map());
      const symbol = native.globalSelf.getMember(actual.name)!;
      const type = symbol.getTypeByKind('Function')!;
      const parameter = type.getParameter(0)!;
      expect(parameter.name).to.equal(selected.functions[0].parameters[0].name);
      expect(parameter.optional).to.equal(
        selected.functions[0].parameters[0].optional,
      );
      expect(parameter.type.type.map((item) => item.kind).sort()).to.deep.equal(
        Type.fromFeatherString(
          selected.functions[0].parameters[0].type,
          new Map(),
          false,
        )
          .map((item) => item.kind)
          .sort(),
      );
      expect(type.returns?.type[0].kind).to.equal('StaticType');
      expect(symbol.description).to.equal(actual.description);
      expect(symbol.deprecated).to.equal(actual.deprecated);
      expect(symbol.native).to.equal(selected.module);
    }
  });

  it('keeps unfamiliar static_get input types intact instead of mutating named types', async function () {
    const entry = functionXml('static_get').replace(
      /(<Parameter\b[^>]*\bType=")[^"]*(")/,
      '$1Struct.FutureInput$2',
    );
    const path = await writeSpec('static-future.xml', subset([entry]));
    const native = await Native.from([path], new Type('Struct'), new Map());
    const type = native.globalSelf
      .getMember('static_get')!
      .getTypeByKind('Function')!;
    expect(type.getParameter(0)?.type.toFeatherString()).to.equal(
      'Struct.FutureInput',
    );
    expect(native.types.get('Struct.FutureInput')?.name).to.equal(
      'FutureInput',
    );
    expect(type.returns?.toFeatherString()).to.equal('Struct');
  });

  it('supplements SpriteInfo only for a real spec signature that references it', async function () {
    const actual = spec.functions.find(
      (entry) => entry.name === 'sprite_get_info',
    );
    ok(actual);
    const path = await writeSpec(
      'sprite.xml',
      subset([functionXml(actual.name)]),
    );
    const native = await Native.from([path], new Type('Struct'), new Map());
    const type = native.globalSelf
      .getMember(actual.name)!
      .getTypeByKind('Function')!;
    expect(type.returns?.type[0]).to.equal(native.types.get(actual.returnType));
    expect(type.returns?.type[0].getMember('width')?.type.kind).to.equal(
      'Real',
    );
  });

  it('retains spec metadata for display_get_frequency instead of replacing its declaration', async function () {
    const actual = spec.functions.find(
      (entry) => entry.name === 'display_get_frequency',
    );
    ok(actual);
    const path = await writeSpec(
      'display.xml',
      subset([functionXml(actual.name)], [], 'DisplayFixture'),
    );
    const native = await Native.from([path], new Type('Struct'), new Map());
    const symbol = native.globalSelf.getMember(actual.name)!;
    expect(symbol.native).to.equal('DisplayFixture');
    expect(symbol.description).to.equal(actual.description);
    expect(symbol.writable).to.equal(false);
    expect(symbol.type.returns[0].toFeatherString()).to.equal(
      actual.returnType,
    );
  });

  it('retains unknown feature flags as metadata without inventing target availability', async function () {
    const name = 'display_get_frequency';
    const entry = functionXml(name).replace(
      'Pure="true"',
      'Pure="true" FeatureFlag="Future.Target.Feature"',
    );
    expect(entry).not.to.equal(functionXml(name));
    const path = await writeSpec('feature.xml', subset([entry]));
    const native = await Native.from([path], new Type('Struct'), new Map());
    expect(native.globalSelf.getMember(name)).to.exist;
    expect(native.getSpecs()[0].functions[0].featureFlag).to.equal(
      'Future.Target.Feature',
    );
  });

  it('preserves Base precedence and source association for multiple selected modules', async function () {
    const name = 'display_get_frequency';
    const module = await writeSpec(
      'module.xml',
      subset(
        [functionXml(name)],
        [enumerationXml(spec.enumerations[1].name)],
        'ExtraModule',
      ),
    );
    const base = await writeSpec(
      'base.xml',
      subset([functionXml(name)], [enumerationXml(spec.enumerations[0].name)]),
    );
    const native = await Native.from(
      [module, base],
      new Type('Struct'),
      new Map(),
    );
    expect(native.globalSelf.getMember(name)?.native).to.equal('Base');
    expect(native.getSpecSources().map((source) => source.path)).to.deep.equal([
      base.absolute,
      module.absolute,
    ]);
    expect(
      native.globalSelf.getMember(spec.enumerations[1].name)?.native,
    ).to.equal('ExtraModule');
    expect(
      native.globalSelf.getMember(spec.enumerations[0].name)?.native,
    ).to.equal('Base');
  });

  it('attributes read, XML and schema rejection to the failing file and phase', async function () {
    const missing = pathy(join(directory, 'missing.xml'));
    const malformed = await writeSpec(
      'malformed.xml',
      '<GameMakerLanguageSpec><Functions></GameMakerLanguageSpec>',
    );
    const invalid = await writeSpec('invalid.xml', '<GameMakerLanguageSpec/>');
    for (const [path, stage] of [
      [missing, 'read'],
      [malformed, 'xml'],
      [invalid, 'schema'],
    ] as const) {
      await specError(Native.parse(path.absolute), path.absolute, stage);
      const self = new Type('Struct');
      const types = new Map<string, Type>();
      await specError(
        Native.from([Native.fallbackGmlSpecPath, path], self, types),
        path.absolute,
        stage,
      );
      expect(self.listMembers()).to.have.lengthOf(0);
      expect(types.size).to.equal(0);
    }
  });

  it('rejects nonnumeric enum values during schema validation rather than loading NaN', async function () {
    const invalidXml = xml.replace(
      /(<Member\b[^>]*\bValue=")[^"]*(")/,
      '$1not-a-number$2',
    );
    expect(invalidXml).not.to.equal(xml);
    const path = await writeSpec('invalid-value.xml', invalidXml);
    await specError(Native.parse(path.absolute), path.absolute, 'schema');
  });

  it('attributes native type-loading failures without swallowing their cause', async function () {
    const types = new Map<string, Type>([
      [`Enum.${spec.enumerations[0].name}`, new Type('String')],
    ]);
    await specError(
      Native.from([Native.fallbackGmlSpecPath], new Type('Struct'), types),
      Native.fallbackGmlSpecPath.absolute,
      'load',
    );
  });

  it('does not create detached rejected promises for failed selected specs', async function () {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const missing = pathy(join(directory, 'missing.xml'));
      const malformed = await writeSpec(
        'malformed.xml',
        '<GameMakerLanguageSpec><Functions></GameMakerLanguageSpec>',
      );
      const invalid = await writeSpec(
        'invalid.xml',
        '<GameMakerLanguageSpec/>',
      );
      for (const [path, stage] of [
        [missing, 'read'],
        [malformed, 'xml'],
        [invalid, 'schema'],
      ] as const) {
        await specError(
          Native.from(
            [Native.fallbackGmlSpecPath, path],
            new Type('Struct'),
            new Map(),
          ),
          path.absolute,
          stage,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).to.deep.equal([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
