import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost } from '../test/host.mjs';
import { completionPublication } from './completion-snapshot.mjs';
import { snapshotCompletion } from './completion-context.mjs';
import { queryLanguage } from './query.mjs';

const labels = (value: any) => value?.map((item: any) => item.name);
const names = (value: any) => labels(value)?.sort();
async function fixture(text: string) {
  const host = await createHost();
  const project = await host.project();
  const code = await host.subject.addCode(project, 'CompletionSource', text);
  const overlay = { path: code.path.absolute, text, version: 1, generation: 1 };
  const publication = completionPublication(project, [overlay]);
  const document = publication.documents[0];
  assert(document);
  return {
    host,
    project,
    code,
    overlay,
    publication,
    document,
    read(current: string, offset: number, generation = 1) {
      return snapshotCompletion(
        publication,
        document,
        { ...overlay, text: current, version: 2, generation },
        { kind: 'completion', path: overlay.path, offset },
        true,
      );
    },
  };
}

test('committed completion regions preserve source-defined members and lexical shadowing at every token', async () => {
  const text =
    'function First(){var box={alpha:1,beta:2}; var local_first=1;\nbox.alpha;\nlocal_first;\n}\nfunction Second(){var box={gamma:1};\nbox.gamma;\n}';
  const f = await fixture(text);
  try {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const offset = match.index + match[0].length;
      const exact = queryLanguage(f.project, {
        kind: 'completion',
        path: f.overlay.path,
        offset,
      });
      assert.deepEqual(
        names(f.read(text, offset)),
        names(exact),
        `${match[0]} at ${offset}`,
      );
    }
    assert.deepEqual(
      names(f.read(text, text.indexOf('box.alpha') + 'box.al'.length)),
      ['alpha', 'beta'],
    );
    assert.deepEqual(
      names(f.read(text, text.indexOf('box.gamma') + 'box.g'.length)),
      ['gamma'],
    );
    assert(
      f
        .read(text, text.indexOf('local_first;') + 5)
        ?.some((item) => item.name === 'local_first'),
    );
    assert(
      !f
        .read(text, text.indexOf('box.gamma'))
        ?.some((item) => item.name === 'local_first'),
    );
  } finally {
    f.host.dispose();
  }
});

test('safe prefix edits and a first simple member accessor reuse analyzed bindings without reanalysis', async () => {
  const text = 'function Use(){var box={alpha:1,beta:2};\nbox.alpha;\n}';
  const f = await fixture(text);
  try {
    for (const prefix of ['', 'a', 'al', 'alpha']) {
      const changed = text.replace('box.alpha;', `box.${prefix};`);
      const value = f.read(
        changed,
        changed.indexOf('box.') + 4 + prefix.length,
      );
      assert.deepEqual(names(value), ['alpha', 'beta']);
      assert(value?.every((item) => item.fallback === 'snapshot'));
    }
    assert.equal(
      f.read(
        text.replace('box.alpha', 'other.alpha'),
        text.indexOf('box.alpha') + 9,
      ),
      undefined,
    );
    assert.equal(
      f.read(
        text.replace('{alpha:1,beta:2}', '{different:1}'),
        text.indexOf('box.alpha'),
      ),
      undefined,
    );
    assert.equal(f.read(text, text.indexOf('box.alpha'), 2), undefined);
  } finally {
    f.host.dispose();
  }
  const bare = 'function Use(){var box={alpha:1,beta:2};\nbox\n}';
  const g = await fixture(bare);
  try {
    const changed = bare.replace('\nbox\n', '\nbox.al\n');
    assert.deepEqual(names(g.read(changed, changed.indexOf('\nbox.al') + 7)), [
      'alpha',
      'beta',
    ]);
    const unknown = bare.replace('\nbox\n', '\ntoString.\n');
    assert.equal(g.read(unknown, unknown.indexOf('toString.') + 9), undefined);
  } finally {
    g.host.dispose();
  }
});

test('physical macro-backed member contexts keep the original query semantics', async () => {
  const text =
    '#macro BOX {alpha:1,beta:2}\nfunction Use(){var box=BOX;\nbox.alpha;\n}';
  const f = await fixture(text);
  try {
    const offset = text.indexOf('box.alpha') + 'box.al'.length;
    assert.deepEqual(
      names(
        queryLanguage(f.project, {
          kind: 'completion',
          path: f.overlay.path,
          offset,
        }),
      ),
      ['alpha', 'beta'],
    );
    assert.deepEqual(names(f.read(text, offset)), ['alpha', 'beta']);
    const changed = text.replace('box.alpha', 'box.a');
    assert.deepEqual(names(f.read(changed, changed.indexOf('box.a') + 5)), [
      'alpha',
      'beta',
    ]);
  } finally {
    f.host.dispose();
  }
});

test('grammar and macro-prefix changes withdraw stale contexts; empty stale groups wait for current results', async () => {
  const f = await fixture('function Scope(){var record=begi end;return 1;}');
  try {
    const changed = f.overlay.text.replace('begi ', 'begin ');
    assert.equal(f.read(changed, changed.indexOf('begin') + 5), undefined);
  } finally {
    f.host.dispose();
  }
  const g = await fixture(
    '#macro OPEN begin\nfunction Scope(){var record=OPE end;return 1;}',
  );
  try {
    const changed = g.overlay.text.replace('=OPE ', '=OPEN ');
    assert.equal(g.read(changed, changed.indexOf('=OPEN') + 5), undefined);
  } finally {
    g.host.dispose();
  }
  const e = await fixture('function Use(){var record={};record.}');
  try {
    const offset = e.overlay.text.indexOf('record.') + 7;
    assert.equal(e.read(e.overlay.text, offset), undefined);
    assert.deepEqual(
      snapshotCompletion(
        e.publication,
        e.document,
        e.overlay,
        { kind: 'completion', offset },
        false,
      ),
      [],
    );
  } finally {
    e.host.dispose();
  }
});

test('keyword-named macros retain precedence over synthetic self and global receivers', async () => {
  for (const keyword of ['self', 'global']) {
    const text = `#macro ${keyword} record\nfunction Scope(){var record={macro_member:1};return ${keyword};}`;
    const f = await fixture(text);
    try {
      const changed = text.replace(`return ${keyword};`, `return ${keyword}.;`);
      const offset = changed.lastIndexOf(`${keyword}.`) + keyword.length + 1;
      assert.equal(f.read(changed, offset), undefined);
      await f.code.reload(changed);
      assert.deepEqual(
        names(
          queryLanguage(f.project, {
            kind: 'completion',
            path: f.overlay.path,
            offset,
          }),
        ),
        ['macro_member'],
      );
    } finally {
      f.host.dispose();
    }
  }
});

test('compressed publication preserves every physical caret across ordinary and macro source boundaries', async () => {
  for (const text of [
    'var x={a:1}; function f(){var local=2; x.a;}\r\nvar y=begin k:1 end;',
    '#macro BOX {a:1}\nvar x=BOX; function f(){var local=2; x.a;}',
  ]) {
    const f = await fixture(text);
    try {
      for (let offset = 0; offset <= text.length; offset++) {
        const query = {
          kind: 'completion' as const,
          path: f.overlay.path,
          offset,
        };
        const fast = snapshotCompletion(
          f.publication,
          f.document,
          f.overlay,
          query,
          false,
        );
        if (fast === undefined) continue; // Ambiguous macro projections stay on the exact path.
        assert.deepEqual(
          labels(fast),
          labels(queryLanguage(f.project, query)),
          `caret ${offset} in ${text}`,
        );
      }
    } finally {
      f.host.dispose();
    }
  }
});

test('shared global receivers retain local scalar shadowing and candidate order', async () => {
  const text =
    'globalvar shared; shared={global_member:1};\nfunction First(){var shared=1;\nshared;\n}\nfunction Second(){\nshared;\n}';
  const f = await fixture(text);
  try {
    const first = text.indexOf('\nshared;') + 1;
    const second = text.lastIndexOf('\nshared;') + 1;
    for (const offset of [first, second]) {
      const query = {
        kind: 'completion' as const,
        path: f.overlay.path,
        offset,
      };
      assert.deepEqual(
        labels(
          snapshotCompletion(
            f.publication,
            f.document,
            f.overlay,
            query,
            false,
          ),
        ),
        labels(queryLanguage(f.project, query)),
      );
    }
    const changed = text.slice(0, first) + 'shared.' + text.slice(first + 6);
    assert.equal(
      f.read(changed, first + 7),
      undefined,
      'A scalar local must block the global receiver',
    );
    const global = text.slice(0, second) + 'shared.' + text.slice(second + 6);
    assert.deepEqual(names(f.read(global, second + 7)), ['global_member']);
  } finally {
    f.host.dispose();
  }
});
