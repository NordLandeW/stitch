import { Pathy } from '@bscotch/pathy';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  emitLog,
  formatLogArgument,
  getErrorMessage,
  stringifyError,
  writeLogLine,
  type LogHost,
} from './log.core.mjs';

function fixture(
  workspaceFolders: LogHost['workspaceFolders'] = () => undefined,
) {
  const lines: string[] = [];
  const echoes: string[][] = [];
  const host: LogHost = {
    workspaceFolders,
    appendLine: (line) => lines.push(line),
    console: (type, ...args) => echoes.push([type, ...args]),
  };
  return { host, lines, echoes };
}

for (const folders of [undefined, []] as const) {
  test(`folderless logging uses the absolute path (${folders ? 'empty' : 'undefined'} folders)`, () => {
    const path = new Pathy(join(tmpdir(), 'stitch-log-tests', 'script.gml'));
    const f = fixture(() => folders);
    assert.doesNotThrow(() =>
      emitLog(f.host, 'warn', 'Stitch', 'query', ['No project for', path]),
    );
    assert.equal(f.lines.length, 1);
    assert(f.lines[0].includes(`WARN `));
    assert(f.lines[0].includes(`[query] No project for ${path.absolute}`));
    assert.equal(f.echoes.length, 1);
    assert.equal(f.echoes[0][0], 'warn');
    assert.equal(f.echoes[0][1], 'Stitch');
    assert(f.echoes[0].includes(path.absolute));
  });
}

test('workspace paths stay relative and document/URI arguments stay readable', () => {
  const root = new Pathy(join(tmpdir(), 'stitch-log-tests'));
  const file = root.join('script.gml');
  const folders = () => [{ uri: { fsPath: root.absolute } }];
  assert.equal(formatLogArgument(file, folders), 'script.gml');
  assert.equal(formatLogArgument({ fsPath: file.absolute }), file.absolute);
  assert.equal(
    formatLogArgument({
      uri: { fsPath: file.absolute },
      contents: 'not logged',
    }),
    file.absolute,
  );
  assert.equal(
    formatLogArgument(file, () => {
      throw new Error('no root');
    }),
    file.absolute,
  );
});

test('hostile values do not interrupt logging or run fallback inspection hooks', () => {
  let inspected = false;
  const hostile = {
    toString() {
      throw new Error('bad toString');
    },
    toJSON() {
      throw new Error('bad toJSON');
    },
    [inspect.custom]() {
      inspected = true;
      throw new Error('bad inspect');
    },
  };
  const getter = Object.defineProperty({}, 'uri', {
    enumerable: true,
    get() {
      throw new Error('bad getter');
    },
  });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const values = [
    hostile,
    getter,
    circular,
    { count: 1n },
    { uri: null },
    Object.create(null),
  ];
  const f = fixture();
  assert.doesNotThrow(() =>
    emitLog(f.host, 'info', 'Stitch', undefined, [
      'before',
      ...values,
      'after',
    ]),
  );
  assert.equal(inspected, false);
  assert.equal(f.lines.length, 1);
  assert(f.lines[0].includes('before'));
  assert(f.lines[0].endsWith('after'));
  assert.equal(f.echoes.length, 1);
});

test('errors retain their own stack and nested causes even beside a bad value', () => {
  const cause = new Error('native spec unreadable');
  cause.stack = 'Error: native spec unreadable\n  at native-loader';
  const error = new Error('project failed', { cause });
  error.stack = 'Error: project failed\n  at project-loader';
  const f = fixture();
  emitLog(f.host, 'error', 'Stitch', undefined, [
    {
      toString() {
        throw new Error('bad value');
      },
    },
    error,
  ]);
  assert(f.lines[0].includes('ERROR: project failed'));
  assert(f.lines[0].includes('at project-loader'));
  assert(f.lines[0].includes('CAUSE: native spec unreadable'));
  assert(f.lines[0].includes('at native-loader'));
  assert.equal(
    getErrorMessage(error),
    'project failed ← native spec unreadable',
  );
  assert.equal(getErrorMessage('not an Error'), '');
});

test('cyclic and non-Error causes are finite and readable', () => {
  const first = new Error('first');
  const second = new Error('second', { cause: first });
  first.cause = second;
  const text = stringifyError(first, true);
  assert(text.includes('CAUSE: second'));
  assert(text.includes('[Circular error cause]'));
  assert.equal(getErrorMessage(first), 'first ← second');
  assert(
    stringifyError(new Error('failed', { cause: 'offline' })).includes(
      'CAUSE: offline',
    ),
  );
});

test('throwing error fields and revoked causes do not discard the original error', () => {
  const error = new Error('original failure');
  Object.defineProperty(error, 'stack', {
    get() {
      throw new Error('bad stack');
    },
  });
  Object.defineProperty(error, 'cause', {
    get() {
      throw new Error('bad cause');
    },
  });
  const text = formatLogArgument(error);
  assert(text.includes('ERROR: original failure'));
  assert(text.includes('[Unreadable error stack]'));
  assert(text.includes('[Unreadable error cause]'));
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const withRevokedCause = formatLogArgument(
    new Error('still readable', { cause: revoked.proxy }),
  );
  assert(withRevokedCause.includes('ERROR: still readable'));
  assert.equal(getErrorMessage(revoked.proxy), '');
});

test('output and console failures are independent and never escape', () => {
  const f = fixture();
  f.host.appendLine = () => {
    throw new Error('disposed output');
  };
  assert.doesNotThrow(() =>
    emitLog(f.host, 'warn', 'Stitch', undefined, ['message']),
  );
  assert.equal(f.echoes.length, 1);
  f.host.appendLine = (line) => f.lines.push(line);
  f.host.console = () => {
    throw new Error('console failure');
  };
  assert.doesNotThrow(() =>
    emitLog(f.host, 'warn', 'Stitch', undefined, ['message']),
  );
  assert.equal(f.lines.length, 1);
  assert.doesNotThrow(() =>
    writeLogLine(
      formatLogArgument({ nested: { ok: true } }, undefined, 2),
      () => {
        throw new Error('output failure');
      },
      () => {
        throw new Error('console failure');
      },
    ),
  );
});
