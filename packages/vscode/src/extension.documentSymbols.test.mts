import {
  Position,
  Range,
  type Code,
  type Signifier,
} from '@bscotch/gml-parser';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGmlDocumentSymbols } from './extension.documentSymbols.core.mjs';

interface TestFunctionType {
  isConstructor: boolean;
  listParameters(): { name: string; optional: boolean }[];
  self?: {
    extends?: {
      name?: string;
    };
  };
}

type TestSignifier = Signifier & {
  functionType?: TestFunctionType;
};

function createFixture() {
  const file = { refs: [] } as unknown as Code;
  const refs = file.refs as any[];
  const rootContainer = {
    kind: 'Struct',
    signifier: { asset: true },
  };
  const position = (offset: number) =>
    new Position(file, offset, 1, offset + 1);
  const range = (start: number, end = start) =>
    new Range(position(start), position(end));

  function define(
    name: string,
    selectionStart: number,
    selectionEnd: number,
    declarationStart = selectionStart,
    declarationEnd = selectionEnd,
    parent: object = rootContainer,
  ) {
    const item = {
      name,
      parent,
      def: range(selectionStart, selectionEnd),
      declaration: range(declarationStart, declarationEnd),
      deprecated: false,
      enum: false,
      enumMember: false,
      global: false,
      instance: false,
      local: false,
      macro: false,
      parameter: false,
      static: false,
      functionType: undefined,
      structType: undefined,
      getTypeByKind(
        this: { functionType?: TestFunctionType; structType?: object },
        kind: string,
      ) {
        if (kind === 'Function') return this.functionType;
        if (kind === 'Struct') return this.structType;
        return;
      },
    } as unknown as TestSignifier;
    refs.push({ isDef: true, item });
    return item;
  }

  const constructor = define('Player', 9, 14, 0, 99);
  constructor.global = true;
  const constructorContainer = {
    kind: 'Struct',
    _signifier: constructor,
    extends: { name: 'Entity' },
  };
  constructor.functionType = {
    isConstructor: true,
    listParameters: () => [{ name: '_name', optional: false }],
    self: constructorContainer,
  };
  const parameter = define('_name', 16, 20);
  parameter.parameter = true;

  const field = define('health', 30, 35, 30, 35, constructorContainer);
  field.instance = true;

  const method = define('take_damage', 43, 53, 40, 80);
  method.functionType = {
    isConstructor: false,
    listParameters: () => [],
  };

  const temporary = define('temporary', 82, 85);
  temporary.local = true;

  const localFunction = define('local_handler', 88, 92, 87, 93);
  localFunction.local = true;
  localFunction.functionType = {
    isConstructor: false,
    listParameters: () => [],
  };

  const staticLocal = define('cached_value', 96, 98);
  staticLocal.local = true;
  staticLocal.static = true;

  const enumSymbol = define('State', 105, 109, 100, 140);
  enumSymbol.enum = true;
  enumSymbol.global = true;
  for (const [name, start, end] of [
    ['idle', 115, 118],
    ['moving', 125, 130],
  ] as const) {
    const member = define(name, start, end);
    member.enumMember = true;
  }

  const macro = define('MAX_SPEED', 150, 158, 143, 165);
  macro.macro = true;
  macro.global = true;

  const config = define('config', 170, 175, 168, 220) as TestSignifier & {
    structType?: object;
  };
  config.global = true;
  const configContainer = {
    kind: 'Struct',
    signifier: config,
  };
  config.structType = configContainer;
  const enabled = define('enabled', 185, 191, 185, 191, configContainer);
  enabled.instance = true;

  const anonymousContainer = {
    kind: 'Struct',
    signifier: undefined,
  };
  const anonymousMember = define(
    'payload_name',
    230,
    241,
    230,
    241,
    anonymousContainer,
  );
  anonymousMember.instance = true;

  const emptyConstructor = define('Empty', 250, 254, 245, 280);
  emptyConstructor.functionType = {
    isConstructor: true,
    listParameters: () => [],
  };

  const localConfig = define(
    'local_config',
    300,
    311,
    295,
    350,
  ) as TestSignifier & {
    structType?: object;
  };
  localConfig.local = true;
  const localConfigContainer = {
    kind: 'Struct',
    signifier: localConfig,
  };
  localConfig.structType = localConfigContainer;
  const localConfigMember = define(
    'local_enabled',
    320,
    332,
    320,
    332,
    localConfigContainer,
  );
  localConfigMember.instance = true;

  return {
    file,
    constructor,
    emptyConstructor,
    field,
    macro,
    method,
  };
}

test('collects parser definitions into a source-ordered symbol hierarchy', () => {
  const { file, constructor, field, macro, method } = createFixture();
  const symbols = collectGmlDocumentSymbols(file);

  assert.deepEqual(
    symbols.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'Player', kind: 'constructor' },
      { name: 'State', kind: 'enum' },
      { name: 'MAX_SPEED', kind: 'constant' },
      { name: 'config', kind: 'struct' },
      { name: 'Empty', kind: 'constructor' },
    ],
  );
  assert.deepEqual(
    symbols[0].children.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'health', kind: 'field' },
      { name: 'take_damage', kind: 'method' },
      { name: 'local_handler', kind: 'function' },
      { name: 'cached_value', kind: 'field' },
    ],
  );
  assert.deepEqual(
    symbols[1].children.map(({ name, kind }) => ({ name, kind })),
    [
      { name: 'idle', kind: 'enumMember' },
      { name: 'moving', kind: 'enumMember' },
    ],
  );
  assert.equal(symbols[0].item, constructor);
  assert.equal(symbols[0].detail, 'constructor (_name) : Entity');
  assert.equal(symbols[1].detail, '');
  assert.equal(symbols[0].children[0].item, field);
  assert.equal(symbols[0].children[1].item, method);
  assert.equal(symbols[2].item, macro);
  assert.equal(symbols[2].detail, '');
  assert.deepEqual(
    symbols[3].children.map(({ name, kind }) => ({ name, kind })),
    [{ name: 'enabled', kind: 'field' }],
  );
  assert.equal(symbols[3].detail, 'global');
  assert(!symbols[0].children.some(({ name }) => name === '_name'));
  assert(!symbols[0].children.some(({ name }) => name === 'temporary'));
  assert(!symbols.some(({ name }) => name === 'payload_name'));
  assert(!symbols.some(({ name }) => name === 'local_config'));
  assert(!symbols.some(({ name }) => name === 'local_enabled'));
  assert.equal(symbols.at(-1)?.name, 'Empty');
  assert.equal(symbols.at(-1)?.detail, 'constructor ()');
});

test('falls back to the identifier range for declarations without a full range', () => {
  const { file, macro } = createFixture();
  macro.declaration = undefined;

  const symbols = collectGmlDocumentSymbols(file);
  const macroSymbol = symbols.find(({ item }) => item === macro);

  assert(macroSymbol);
  assert(macro.def instanceof Range);
  assert.equal(macroSymbol.range.start.offset, macro.def.start.offset);
  assert.equal(macroSymbol.range.end.offset, macro.def.end.offset);
});
