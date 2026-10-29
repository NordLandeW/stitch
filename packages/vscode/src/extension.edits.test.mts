import type { ProjectEditBatch } from '@bscotch/gml-parser';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHost } from './test/host.mjs';

type DocumentEdit = ProjectEditBatch['documents'][number];
type Replacement = DocumentEdit['edits'][number];

async function fixture(t: TestContext, sources: Record<string, string>) {
  const host = await createHost();
  const api = host.vscode.workspace;
  const documents: Record<string, any> = {};
  const byUri = new Map<string, { name: string; document: any }>();
  const opened: string[] = [];
  const events: string[] = [];
  const applications: { edit: any; metadata: unknown }[] = [];
  const originalOpen = Object.getOwnPropertyDescriptor(api, 'openTextDocument');
  const originalApply = Object.getOwnPropertyDescriptor(api, 'applyEdit');
  t.after(() => {
    if (originalOpen)
      Object.defineProperty(api, 'openTextDocument', originalOpen);
    else Reflect.deleteProperty(api, 'openTextDocument');
    if (originalApply) Object.defineProperty(api, 'applyEdit', originalApply);
    else Reflect.deleteProperty(api, 'applyEdit');
    host.dispose();
  });
  for (const [name, text] of Object.entries(sources)) {
    // Identity only: createHost never creates or reads this project directory.
    const document = host.document(
      { path: { absolute: path.join(host.root, `${name}.gml`) } },
      text,
    );
    documents[name] = document;
    host.documents.push(document);
    byUri.set(document.uri.toString(), { name, document });
  }
  api.openTextDocument = async (uri: any) => {
    const entry = byUri.get(uri.toString());
    assert(entry, `Unexpected document open: ${uri.toString()}`);
    opened.push(uri.toString());
    events.push(`open:${entry.name}`);
    return entry.document;
  };
  api.applyEdit = async (edit: any, metadata: unknown) => {
    applications.push({ edit, metadata });
    events.push('apply');
    return true;
  };
  assert.equal(typeof host.subject.applyProjectEdits, 'function');
  return { host, api, documents, opened, events, applications };
}

function change(
  document: any,
  expectedText: string,
  edits: readonly Replacement[],
): DocumentEdit {
  return { filePath: document.uri.fsPath, expectedText, edits };
}

// Real applyProjectEdits owns all preflight, range conversion and submission.
// Doubles only return editor documents or record the submitted WorkspaceEdit;
// they never apply edits, rename files, or reproduce a file/text editing algorithm.
test(
  'project edits preflight later documents before submitting any workspace edit',
  { timeout: 30_000 },
  async (t) => {
    for (const invalid of ['stale', 'closed'] as const) {
      const f = await fixture(t, { A: 'alpha', B: 'beta' });
      if (invalid === 'stale') f.documents.B.setText('changed by the user');
      else f.documents.B.isClosed = true;
      let validations = 0;
      const batch: ProjectEditBatch = {
        label: 'Preflight all documents',
        documents: [
          change(f.documents.A, 'alpha', [{ start: 0, end: 5, text: 'A' }]),
          change(f.documents.B, 'beta', [{ start: 0, end: 4, text: 'B' }]),
        ],
        renames: [
          {
            from: f.documents.A.uri.fsPath,
            to: path.join(f.host.root, 'Renamed.gml'),
          },
        ],
        validate: () => {
          validations++;
        },
      };
      assert.equal(
        await f.host.subject.applyProjectEdits(batch),
        false,
        invalid,
      );
      assert.deepEqual(f.opened, [
        f.documents.A.uri.toString(),
        f.documents.B.uri.toString(),
      ]);
      assert.deepEqual(f.events, ['open:A', 'open:B']);
      assert.equal(validations, 0);
      assert.equal(f.applications.length, 0);
      assert.equal(f.documents.A.getText(), 'alpha');
      assert.equal(
        f.documents.B.getText(),
        invalid === 'stale' ? 'changed by the user' : 'beta',
      );
    }
  },
);

test(
  'opening a later document invalidates an earlier captured version or closed state before submission',
  { timeout: 30_000 },
  async (t) => {
    for (const invalid of ['version-only', 'closed'] as const) {
      const f = await fixture(t, { A: 'alpha', B: 'beta' });
      const originalVersion = f.documents.A.version;
      const open = f.api.openTextDocument;
      f.api.openTextDocument = async (uri: any) => {
        const document = await open(uri);
        if (document === f.documents.B) {
          if (invalid === 'version-only') f.documents.A.setText('alpha');
          else f.documents.A.isClosed = true;
        }
        return document;
      };
      let validations = 0;
      const batch: ProjectEditBatch = {
        label: 'Revalidate captured documents',
        documents: [
          change(f.documents.A, 'alpha', [{ start: 0, end: 5, text: 'A' }]),
          change(f.documents.B, 'beta', [{ start: 0, end: 4, text: 'B' }]),
        ],
        renames: [],
        validate: () => {
          validations++;
        },
      };
      assert.equal(
        await f.host.subject.applyProjectEdits(batch),
        false,
        invalid,
      );
      assert.equal(
        f.documents.A.getText(),
        'alpha',
        'Equal bytes do not make a newer version safe',
      );
      assert.equal(
        f.documents.A.version,
        originalVersion + (invalid === 'version-only' ? 1 : 0),
      );
      assert.deepEqual(f.events, ['open:A', 'open:B']);
      assert.equal(validations, 0);
      assert.equal(f.applications.length, 0);
    }
  },
);

test(
  'delegates generation validation after all asynchronous opens and propagates its rejection without submission',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { A: 'alpha', B: 'beta' });
    const workspace = f.host.newWorkspace();
    const project = await f.host.project();
    workspace.projects.push(project);
    const generation = project.analysis.generation;
    const stale = new Error(
      'Project generation changed during document preflight',
    );
    const open = f.api.openTextDocument;
    f.api.openTextDocument = async (uri: any) => {
      const document = await open(uri);
      if (document === f.documents.B) project.analysis.invalidate();
      return document;
    };
    let validatedGeneration: number | undefined;
    const batch: ProjectEditBatch = {
      label: 'Generation guard',
      documents: [
        change(f.documents.A, 'alpha', [{ start: 0, end: 5, text: 'A' }]),
        change(f.documents.B, 'beta', [{ start: 0, end: 4, text: 'B' }]),
      ],
      renames: [],
      validate: () => {
        f.events.push('validate');
        validatedGeneration = project.analysis.generation;
        if (validatedGeneration !== generation) throw stale;
      },
    };
    await assert.rejects(
      f.host.subject.applyProjectEdits(batch),
      (error: unknown) => error === stale,
    );
    assert.equal(validatedGeneration, project.analysis.generation);
    assert.notEqual(validatedGeneration, generation);
    assert.deepEqual(f.events, ['open:A', 'open:B', 'validate']);
    assert.equal(f.applications.length, 0);
    assert.equal(f.documents.A.getText(), 'alpha');
    assert.equal(f.documents.B.getText(), 'beta');
  },
);

test(
  'submits UTF-16 half-open edits to the final resources after their moves',
  { timeout: 30_000 },
  async (t) => {
    const text = 'first😀\r\nsecond\n';
    const f = await fixture(t, { A: text, B: 'tail' });
    const a = f.documents.A.uri.fsPath;
    const b = f.documents.B.uri.fsPath;
    const renamedA = path.join(f.host.root, 'RenamedA.gml');
    const renamedB = path.join(f.host.root, 'RenamedB.gml');
    const batch: ProjectEditBatch = {
      label: 'Buffer and resource rename',
      documents: [
        change(f.documents.A, text, [
          { start: 5, end: 7, text: 'STAR' },
          { start: 9, end: 15, text: 'SECOND' },
          { start: 16, end: 16, text: '// EOF insertion' },
        ]),
        change(f.documents.B, 'tail', [{ start: 0, end: 4, text: 'TAIL' }]),
      ],
      renames: [
        { from: a, to: renamedA },
        { from: b, to: renamedB },
      ],
      validate: () => {
        f.events.push('validate');
      },
    };
    assert.equal(await f.host.subject.applyProjectEdits(batch), true);
    assert.deepEqual(f.events, ['open:A', 'open:B', 'validate', 'apply']);
    assert.equal(f.applications.length, 1);
    const { edit, metadata } = f.applications[0];
    assert.deepEqual(metadata, { isRefactoring: true });
    for (const operation of edit.operations)
      assert.deepEqual(operation.metadata, {
        label: batch.label,
        needsConfirmation: false,
      });
    const moves = edit.operations.filter(
      (operation: any) => operation.kind === 'renameFile',
    );
    assert.deepEqual(
      moves.map((move: any) => [move.oldUri.fsPath, move.newUri.fsPath]),
      [
        [a, renamedA],
        [b, renamedB],
      ],
    );
    const replacements = edit.operations.filter(
      (operation: any) => operation.kind === 'replace',
    );
    assert(
      moves.every(
        (move: any) =>
          edit.operations.indexOf(move) <
          edit.operations.indexOf(replacements[0]),
      ),
    );
    assert.deepEqual(
      replacements.map((operation: any) => ({
        path: operation.uri.fsPath,
        start: [operation.range.start.line, operation.range.start.character],
        end: [operation.range.end.line, operation.range.end.character],
        text: operation.newText,
      })),
      [
        { path: renamedA, start: [0, 5], end: [0, 7], text: 'STAR' },
        { path: renamedA, start: [1, 0], end: [1, 6], text: 'SECOND' },
        {
          path: renamedA,
          start: [2, 0],
          end: [2, 0],
          text: '// EOF insertion',
        },
        { path: renamedB, start: [0, 0], end: [0, 4], text: 'TAIL' },
      ],
    );
    // Recording the boundary is not proof of editor application or Undo.
    assert.equal(f.documents.A.getText(), text);
    assert.equal(f.documents.B.getText(), 'tail');
  },
);

test(
  'rejects invalid source ranges with the affected path and never submits a malformed plan',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { A: 'alpha' });
    const filePath = f.documents.A.uri.fsPath;
    let validations = 0;
    for (const range of [
      { start: -1, end: 0 },
      { start: 2, end: 1 },
      { start: 0, end: 0.5 },
      { start: 0, end: 6 },
    ]) {
      const batch: ProjectEditBatch = {
        label: 'Invalid source range',
        documents: [
          change(f.documents.A, 'alpha', [{ ...range, text: 'invalid' }]),
        ],
        renames: [],
        validate: () => {
          validations++;
        },
      };
      await assert.rejects(
        f.host.subject.applyProjectEdits(batch),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /invalid text edit range/i);
          assert(error.message.includes(filePath));
          return true;
        },
      );
    }
    assert.equal(validations, 0);
    assert.equal(f.applications.length, 0);
    assert.equal(f.documents.A.getText(), 'alpha');
  },
);

test(
  'throws on submitted editor failures, preserving causes and affected paths instead of returning clean false',
  { timeout: 30_000 },
  async (t) => {
    for (const mode of [
      'resource-false',
      'resource-throw',
      'text-false',
    ] as const) {
      const f = await fixture(t, { A: 'alpha', B: 'beta' });
      const cause = new Error(
        'Editor resource application stopped after an earlier operation',
      );
      const destination = path.join(f.host.root, 'Renamed.gml');
      const hasResourceEdits = mode !== 'text-false';
      f.api.applyEdit = async (edit: any, metadata: unknown) => {
        f.applications.push({ edit, metadata });
        f.events.push('apply');
        if (mode === 'resource-throw') throw cause;
        return false;
      };
      const batch: ProjectEditBatch = {
        label: `Failure: ${mode}`,
        documents: [
          change(f.documents.A, 'alpha', [{ start: 0, end: 5, text: 'A' }]),
          change(f.documents.B, 'beta', [{ start: 0, end: 4, text: 'B' }]),
        ],
        renames: hasResourceEdits
          ? [{ from: f.documents.A.uri.fsPath, to: destination }]
          : [],
        validate: () => {
          f.events.push('validate');
        },
      };
      await assert.rejects(
        f.host.subject.applyProjectEdits(batch),
        (error: unknown) => {
          assert(error instanceof Error);
          assert(error.message.includes(f.documents.A.uri.fsPath));
          assert(error.message.includes(f.documents.B.uri.fsPath));
          if (hasResourceEdits) {
            assert.match(error.message, /some files may have changed/i);
            assert(error.message.includes(destination));
          } else {
            assert.match(error.message, /could not apply the text edit/i);
            assert.doesNotMatch(error.message, /some files may have changed/i);
          }
          if (mode === 'resource-throw') assert.equal(error.cause, cause);
          else {
            assert(error.cause instanceof Error);
            assert.match(error.cause.message, /editor rejected/i);
          }
          return true;
        },
      );
      assert.deepEqual(f.events, ['open:A', 'open:B', 'validate', 'apply']);
      assert.equal(
        f.applications.length,
        1,
        'A submitted failure must never be retried as a preflight refusal',
      );
      assert.deepEqual(f.applications[0].metadata, { isRefactoring: true });
    }
  },
);

for (const editMovedDocument of [false, true]) {
  test(`dependent resource moves retain directory Undo and ${editMovedDocument ? 'edit' : 'include'} the moved buffer`, async (t) => {
    const f = await fixture(t, { 'Old/Old': 'original', project: 'metadata' });
    const document = f.documents['Old/Old'],
      project = f.documents.project;
    const old = path.dirname(document.uri.fsPath),
      next = path.join(f.host.root, 'New');
    const finalFile = path.join(next, 'New.gml');
    const renames = [
      { from: document.uri.fsPath, to: path.join(old, 'New.gml') },
      { from: old, to: next },
    ];
    assert.equal(
      await f.host.subject.applyProjectEdits({
        label: 'Nested resource rename',
        documents: [
          change(project, 'metadata', [
            { start: 0, end: 8, text: 'new metadata' },
          ]),
          ...(editMovedDocument
            ? [
                change(document, 'original', [
                  { start: 0, end: 8, text: 'updated' },
                ]),
              ]
            : []),
        ],
        renames,
        validate() {},
      }),
      true,
    );
    const operations = f.applications[0].edit.operations;
    const moves = operations.filter(
      (operation: any) => operation.kind === 'renameFile',
    );
    assert.deepEqual(
      moves.map((move: any) => ({
        from: move.oldUri.fsPath,
        to: move.newUri.fsPath,
      })),
      renames,
    );
    const first = operations.indexOf(moves[0]),
      second = operations.indexOf(moves[1]);
    // Real VS Code groups adjacent file edits against one working-copy view.
    // The parent move must see the completed child group, and remain a native
    // directory move so Undo removes the destination directory as well.
    assert(
      operations
        .slice(first + 1, second)
        .some(
          (operation: any) =>
            operation.kind === 'replace' && operation.newText === '',
        ),
    );
    const finalText = operations
      .slice(second + 1)
      .filter((operation: any) => operation.kind === 'replace');
    assert(
      finalText.some(
        (operation: any) =>
          operation.uri.fsPath === project.uri.fsPath &&
          operation.newText === 'new metadata',
      ),
    );
    const movedText = finalText.filter(
      (operation: any) => operation.uri.fsPath === finalFile,
    );
    assert.equal(movedText.length, 1);
    assert.equal(movedText[0].newText, editMovedDocument ? 'updated' : '');
    if (!editMovedDocument)
      assert.deepEqual(movedText[0].range.start, movedText[0].range.end);
    // This observes the API boundary; actual application/Undo belongs to the
    // isolated real-host validation, not a second editor implementation here.
    assert.equal(document.getText(), 'original');
    assert.equal(project.getText(), 'metadata');
  });
}
