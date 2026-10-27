import type {
  Code,
  CompletionCandidate,
  Signifier,
  Type,
} from '@bscotch/gml-parser';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InScopeCompletionItems,
  captureCompletionView,
  completionScopeSymbols,
  type GmlCompletionKind,
} from './extension.completions.core.mjs';

interface TestItem {
  label: string;
  kind: GmlCompletionKind;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
}

function symbol(
  name: string,
  kind: GmlCompletionKind = 'variable',
  filePath?: string,
) {
  let detailCalls = 0;
  const signifier = {
    name,
    native: undefined,
    global: false,
    local: false,
    parameter: false,
    def: filePath
      ? { file: { path: { equals: (path: string) => path === filePath } } }
      : undefined,
    type: {
      type: [
        {
          kind:
            kind === 'enum'
              ? 'Enum'
              : kind === 'variable'
                ? 'Real'
                : 'Function',
          isConstructor: kind === 'constructor',
        },
      ],
      toFeatherString() {
        detailCalls++;
        return 'Real | String';
      },
    },
    getTypeByKind(type: string) {
      if (kind === 'enum' && type === 'Enum') return {};
      if (
        (kind === 'constructor' || kind === 'function') &&
        type === 'Function'
      ) {
        return { isConstructor: kind === 'constructor' };
      }
      return undefined;
    },
  } as unknown as Signifier;
  return { signifier, detailCalls: () => detailCalls };
}

function fixture(ignoredPrefix: string | null = null) {
  const completions = new InScopeCompletionItems<TestItem>();
  const options = {
    documentPath: 'active.gml',
    ignoredPrefix,
    createItem: (label: string, kind: GmlCompletionKind): TestItem => ({
      label,
      kind,
    }),
  };
  return { completions, options };
}

test('initial completion items keep kinds/order without computing any type strings', () => {
  const f = fixture();
  const symbols = [
    symbol('variable'),
    symbol('Constructor', 'constructor'),
    symbol('function', 'function'),
    symbol('Enum', 'enum'),
  ];
  const items = f.completions.create(
    symbols.map(({ signifier }) => signifier),
    f.options,
  );
  assert.deepEqual(items, [
    { label: 'variable', kind: 'variable' },
    { label: 'Constructor', kind: 'constructor' },
    { label: 'function', kind: 'function' },
    { label: 'Enum', kind: 'enum' },
  ]);
  for (const source of symbols) assert.equal(source.detailCalls(), 0);
  const before = { ...items[1] };
  assert.equal(f.completions.resolve(items[1]), items[1]);
  assert.equal(items[1].detail, 'Real | String');
  assert.deepEqual(
    { ...items[1], detail: undefined },
    { ...before, detail: undefined },
  );
  assert.deepEqual(
    symbols.map((source) => source.detailCalls()),
    [0, 1, 0, 0],
  );
  f.completions.resolve(items[1]);
  assert.equal(symbols[1].detailCalls(), 1);
});

test('resolve retains the existing detail flags and does not change insertion/filter fields', () => {
  const f = fixture();
  const source = symbol('argument');
  source.signifier.native = 'base';
  source.signifier.global = true;
  source.signifier.local = true;
  source.signifier.parameter = true;
  const [item] = f.completions.create([source.signifier], f.options);
  Object.assign(item, {
    documentation: 'unchanged docs',
    sortText: 'sort',
    filterText: 'filter',
    insertText: 'insert',
  });
  f.completions.resolve(item);
  assert.deepEqual(item, {
    label: 'argument',
    kind: 'variable',
    detail: 'Real | String native global local parameter',
    documentation: 'unchanged docs',
    sortText: 'sort',
    filterText: 'filter',
    insertText: 'insert',
  });
});

test('ignored prefixes retain same-file symbols and hide unrelated or undefined sources', () => {
  const f = fixture('_');
  const native = symbol('_native');
  native.signifier.native = 'base';
  native.signifier.global = true;
  const symbols = [
    symbol('_same_file', 'variable', 'active.gml'),
    symbol('_other_file', 'variable', 'other.gml'),
    symbol('_no_file'),
    native,
    symbol('visible', 'variable', 'other.gml'),
    symbol(''),
  ];
  const sources = symbols.map(({ signifier }) => signifier);
  const items = f.completions.create(sources, f.options);
  assert.deepEqual(
    items.map(({ label }) => label),
    ['_same_file', 'visible'],
  );
  for (const source of symbols) assert.equal(source.detailCalls(), 0);
  for (const ignoredPrefix of [null, '']) {
    const unfiltered = f.completions.create(sources, {
      ...f.options,
      ignoredPrefix,
    });
    assert.deepEqual(
      unfiltered.map(({ label }) => label),
      ['_same_file', '_other_file', '_no_file', '_native', 'visible'],
    );
  }
});

test('cancelled resolve does not compute or consume the lazy source', () => {
  const f = fixture();
  const source = symbol('value');
  const [item] = f.completions.create([source.signifier], f.options);
  assert.equal(
    f.completions.resolve(item, () => true),
    item,
  );
  assert.equal(item.detail, undefined);
  assert.equal(source.detailCalls(), 0);
  f.completions.resolve(item, () => false);
  assert.equal(item.detail, 'Real | String');
  assert.equal(source.detailCalls(), 1);
  const unrelated: TestItem = { label: 'JSDoc type', kind: 'variable' };
  assert.equal(f.completions.resolve(unrelated), unrelated);
  assert.equal(unrelated.detail, undefined);
});

test('cancelled initial requests discard partial results without formatting details', () => {
  const f = fixture();
  const first = symbol('first');
  const second = symbol('second');
  let cancelled = false;
  const items = f.completions.create([first.signifier, second.signifier], {
    ...f.options,
    isCancelled: () => cancelled,
    createItem(label, kind) {
      cancelled = true;
      return { label, kind };
    },
  });
  assert.deepEqual(items, []);
  assert.equal(first.detailCalls(), 0);
  assert.equal(second.detailCalls(), 0);
});

test('an invalidated captured view retires lazy details without changing initial fields', () => {
  const f = fixture();
  const source = symbol('value');
  let current = true;
  const [item] = f.completions.create([source.signifier], {
    ...f.options,
    isCurrent: () => current,
  });
  const initial = { ...item };
  current = false;
  assert.equal(f.completions.resolve(item), item);
  assert.deepEqual(item, initial);
  assert.equal(source.detailCalls(), 0);
  current = true;
  f.completions.resolve(item);
  assert.equal(source.detailCalls(), 0);
});

function memberContainer(...members: Signifier[]): Type {
  return { listMembers: () => members } as unknown as Type;
}

test('ignored prefixes retain visible local/self identities, not same-name global symbols', () => {
  const f = fixture('_');
  const local = symbol('_local', 'variable', 'other.gml');
  const self = symbol('_self', 'variable', 'other.gml');
  const global = symbol('_global', 'variable', 'other.gml');
  const sameNameGlobal = symbol('_self', 'variable', 'other.gml');
  global.signifier.global = true;
  sameNameGlobal.signifier.global = true;
  const globals = memberContainer(global.signifier, sameNameGlobal.signifier);
  const scope = {
    local: memberContainer(local.signifier),
    self: memberContainer(self.signifier),
    isDotAccessor: false,
  } as unknown as NonNullable<Parameters<typeof completionScopeSymbols>[0]>;
  const scopeSymbols = completionScopeSymbols(scope, globals);
  const items = f.completions.create(
    [
      local.signifier,
      self.signifier,
      global.signifier,
      sameNameGlobal.signifier,
    ],
    { ...f.options, scopeSymbols },
  );
  assert.deepEqual(
    items.map(({ label }) => label),
    ['_local', '_self'],
  );
  for (const source of [local, self, global, sameNameGlobal]) {
    assert.equal(source.detailCalls(), 0);
  }
});

test('global self is not a same-scope exemption and dot scopes do not expose locals', () => {
  const local = symbol('_local').signifier;
  const self = symbol('_self').signifier;
  const global = symbol('_global').signifier;
  const globals = memberContainer(global);
  const localContainer = memberContainer(local);
  const scope = {
    local: localContainer,
    self: globals,
    isDotAccessor: false,
  } as unknown as NonNullable<Parameters<typeof completionScopeSymbols>[0]>;
  assert.deepEqual([...completionScopeSymbols(scope, globals)], [local]);
  scope.self = memberContainer(self) as typeof scope.self;
  scope.isDotAccessor = true;
  assert.deepEqual([...completionScopeSymbols(scope, globals)], [self]);
  assert.deepEqual([...completionScopeSymbols(undefined, globals)], []);
});

function viewFixture() {
  const state = {
    contentVersion: 1,
    syntaxVersion: 2,
    semanticVersion: 3,
    projectVersion: 4,
    status: 'complete' as Code['analysisState']['status'],
  };
  const code = {
    content: 'unchanged source',
    get analysisState() {
      return { ...state };
    },
  };
  const current = {
    code: code as Pick<Code, 'analysisState'> | undefined,
    generation: 4,
  };
  const document = { version: 5, isClosed: false };
  const isCurrent = captureCompletionView(
    code,
    () => current.code,
    () => current.generation,
    document,
  );
  return { state, code, current, document, isCurrent };
}

for (const field of [
  'contentVersion',
  'syntaxVersion',
  'semanticVersion',
  'projectVersion',
] as const) {
  test(`completion resolution invalidates when ${field} changes without a text change`, () => {
    const f = viewFixture();
    assert.equal(f.isCurrent(), true);
    f.state[field]++;
    assert.equal(f.code.content, 'unchanged source');
    assert.equal(f.isCurrent(), false);
  });
}

test('completion view captures values, Code identity, project generation and editor version', () => {
  const unchanged = viewFixture();
  assert.notEqual(unchanged.code.analysisState, unchanged.code.analysisState);
  assert.equal(unchanged.isCurrent(), true);
  const replacement = viewFixture();
  replacement.current.code = { analysisState: { ...replacement.state } };
  assert.equal(replacement.isCurrent(), false);
  const retired = viewFixture();
  retired.current.code = undefined;
  assert.equal(retired.isCurrent(), false);
  const project = viewFixture();
  project.current.generation++;
  assert.equal(project.isCurrent(), false);
  const edited = viewFixture();
  edited.document.version++;
  assert.equal(edited.isCurrent(), false);
  const closed = viewFixture();
  closed.document.isClosed = true;
  assert.equal(closed.isCurrent(), false);
});

test('only unchanged complete/degraded views may resolve semantic details', () => {
  for (const status of ['unparsed', 'parsed', 'failed', 'retired'] as const) {
    const f = viewFixture();
    f.state.status = status;
    assert.equal(
      captureCompletionView(
        f.code,
        () => f.code,
        () => 4,
      )(),
      false,
    );
  }
  const degraded = viewFixture();
  degraded.state.status = 'degraded';
  const validDegraded = captureCompletionView(
    degraded.code,
    () => degraded.code,
    () => 4,
  );
  assert.equal(validDegraded(), true);
  degraded.state.status = 'complete';
  assert.equal(validDegraded(), false);
  const complete = viewFixture();
  complete.state.status = 'failed';
  assert.equal(complete.isCurrent(), false);
});

test('resolve uses the captured semantic guard and leaves first-round edit fields unchanged', () => {
  const f = fixture();
  const source = symbol('value');
  const view = viewFixture();
  const [item] = f.completions.create([source.signifier], {
    ...f.options,
    isCurrent: view.isCurrent,
  });
  Object.assign(item, {
    sortText: 'sort',
    filterText: 'filter',
    insertText: 'insert',
  });
  const initial = { ...item };
  view.state.semanticVersion++;
  assert.equal(f.completions.resolve(item), item);
  assert.deepEqual(item, initial);
  assert.equal(source.detailCalls(), 0);
});

// Aggregated display values must not accidentally resolve only the first symbol.
test('partial candidates expose availability immediately and lazily resolve their combined type', () => {
  const f = fixture();
  const first = symbol('shared');
  const second = symbol('shared');
  first.signifier.native = 'base';
  let detailCalls = 0;
  const candidate = {
    name: 'shared',
    symbols: [first.signifier, second.signifier],
    type: {
      type: [{ kind: 'Real' }, { kind: 'String' }],
      toFeatherString() {
        detailCalls++;
        return 'Real|String';
      },
    },
    availability: { present: 2, total: 3 },
  } as unknown as CompletionCandidate;
  const availability: CompletionCandidate['availability'][] = [];
  const [item] = f.completions.create([candidate], {
    ...f.options,
    createItem(label, kind, coverage) {
      availability.push(coverage);
      return { label, kind };
    },
  });
  assert.deepEqual(availability, [{ present: 2, total: 3 }]);
  assert.equal(detailCalls, 0);
  assert.equal(item.detail, undefined);
  f.completions.resolve(item);
  assert.equal(
    item.detail,
    'Real|String available in 2/3 receiver alternatives',
  );
  assert.equal(detailCalls, 1);
  assert.equal(first.detailCalls(), 0);
  assert.equal(second.detailCalls(), 0);
  f.completions.resolve(item);
  assert.equal(detailCalls, 1);
});

test('mixed candidate kinds do not depend on which union branch comes first', () => {
  const f = fixture();
  const source = symbol('mixed', 'function');
  const alternatives = [
    { kind: 'Real' },
    { kind: 'Function', isConstructor: true },
  ];
  for (const types of [alternatives, [...alternatives].reverse()]) {
    const candidate = {
      name: 'mixed',
      symbols: [source.signifier],
      type: { type: types },
      availability: { present: 2, total: 2 },
    } as unknown as CompletionCandidate;
    const [item] = f.completions.create([candidate], f.options);
    assert.equal(item.kind, 'variable');
    assert.equal(item.detail, undefined);
  }
});
