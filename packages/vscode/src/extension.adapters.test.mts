import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHost } from './test/host.mjs';

const token = { isCancellationRequested: false };

async function fixture(t: TestContext, sources: Record<string, string>) {
  const host = await createHost({ realAdapters: true });
  t.after(() => host.dispose());
  const workspace = host.newWorkspace();
  const project = await host.project();
  workspace.projects.push(project);
  const files: Record<string, any> = {};
  const documents: Record<string, any> = {};
  const byUri = new Map<string, any>();
  for (const [name, text] of Object.entries(sources)) {
    files[name] = host.subject.addCode(project, name, text);
    documents[name] = host.document(files[name], text);
    host.documents.push(documents[name]);
    byUri.set(documents[name].uri.toString(), documents[name]);
  }
  await project.analysis.analyze();
  return {
    host,
    workspace,
    project,
    files,
    documents,
    byUri,
    definitions: new host.subject.StitchDefinitionsProvider(workspace),
    references: new host.subject.StitchReferenceProvider(workspace),
    rename: new host.subject.StitchRenameProvider(workspace),
    tokens: workspace.semanticHighlightProvider,
  };
}

// Expected offsets come from the author-written fixtures, not parser references
// or an adapter algorithm. VS Code's public ranges have an exclusive end.
function span(document: any, text: string, from = 0) {
  const start = document.getText().indexOf(text, from);
  assert(start >= 0, `Missing fixture spelling ${text}`);
  return { uri: document.uri.toString(), start, end: start + text.length };
}
function position(document: any, text: string, from = 0) {
  return document.positionAt(span(document, text, from).start);
}
function locationSpan(byUri: Map<string, any>, location: any) {
  assert(location);
  const document = byUri.get(location.uri.toString());
  assert(
    document,
    'A returned location must belong to an author-written fixture',
  );
  return {
    uri: location.uri.toString(),
    start: document.offsetAt(location.range.start),
    end: document.offsetAt(location.range.end),
  };
}
function sorted<T extends { uri: string; start: number; end: number }>(
  values: T[],
) {
  return [...values].sort(
    (a, b) => a.uri.localeCompare(b.uri) || a.start - b.start || a.end - b.end,
  );
}
function referenceSpans(f: any, locations: any[] | undefined) {
  assert(locations);
  return sorted(locations.map((location) => locationSpan(f.byUri, location)));
}
function editSpans(f: any, edit: any) {
  assert(edit);
  return sorted(
    edit.entries().flatMap(([uri, edits]: [any, any[]]) =>
      edits.map((value) => ({
        ...locationSpan(f.byUri, { uri, range: value.range }),
        newText: value.newText,
      })),
    ),
  );
}
function tokenSpans(document: any, tokens: any) {
  assert(tokens, 'The actual semantic-token provider must produce a view');
  return tokens.entries.map((entry: any) => {
    const { range } = entry;
    assert.equal(range.isSingleLine, true);
    assert(range.start.line >= 0 && range.end.line < document.lineCount);
    assert(
      range.start.character >= 0 &&
        range.end.character <= document.lineAt(range.end.line).text.length,
    );
    return {
      uri: document.uri.toString(),
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end),
      type: entry.type,
    };
  });
}

// These invoke real providers and real workspace/Project/Code/service inputs.
// Only VS Code's Location/WorkspaceEdit/Builder APIs are recording boundaries;
// no lookup, macro mapping, rename planning, or token classification is copied.
test(
  'macro navigation separates invocation anchors from shared physical rename spellings',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Definitions:
        'function ExtremelyLongTargetName() { return 1; }\n#macro CALL ExtremelyLongTargetName\n',
      Consumer:
        'function Invoke() { return CALL() + CALL() + ExtremelyLongTargetName(); }',
    });
    const definitions = f.documents.Definitions;
    const consumer = f.documents.Consumer;
    const targetDeclaration = span(definitions, 'ExtremelyLongTargetName');
    const targetSpelling = span(
      definitions,
      'ExtremelyLongTargetName',
      targetDeclaration.end,
    );
    const macroDeclaration = span(definitions, 'CALL');
    const firstInvocation = span(consumer, 'CALL');
    const secondInvocation = span(consumer, 'CALL', firstInvocation.end);
    const directUse = span(consumer, 'ExtremelyLongTargetName');

    const macroDefinition = await f.definitions.provideDefinition(
      consumer,
      position(consumer, 'CALL'),
      token,
    );
    assert.deepEqual(locationSpan(f.byUri, macroDefinition), macroDeclaration);
    const physicalDefinition = await f.definitions.provideDefinition(
      definitions,
      definitions.positionAt(targetSpelling.start),
      token,
    );
    assert.deepEqual(
      locationSpan(f.byUri, physicalDefinition),
      targetDeclaration,
    );
    assert.deepEqual(
      referenceSpans(
        f,
        await f.references.provideReferences(
          definitions,
          definitions.positionAt(targetSpelling.start),
          { includeDeclaration: false },
          token,
        ),
      ),
      sorted([targetSpelling, firstInvocation, secondInvocation, directUse]),
    );
    assert.deepEqual(
      referenceSpans(
        f,
        await f.references.provideReferences(
          consumer,
          position(consumer, 'CALL'),
          { includeDeclaration: true },
          token,
        ),
      ),
      sorted([macroDeclaration, firstInvocation, secondInvocation]),
    );

    const prepared = await f.rename.prepareRename(
      definitions,
      definitions.positionAt(targetSpelling.start),
      token,
    );
    assert.equal(prepared.placeholder, 'ExtremelyLongTargetName');
    assert.deepEqual(
      locationSpan(f.byUri, { uri: definitions.uri, range: prepared.range }),
      targetSpelling,
    );
    const targetEdits = await f.rename.provideRenameEdits(
      definitions,
      definitions.positionAt(targetSpelling.start),
      'RenamedTarget',
      token,
    );
    assert.deepEqual(
      editSpans(f, targetEdits),
      sorted([
        { ...targetDeclaration, newText: 'RenamedTarget' },
        { ...targetSpelling, newText: 'RenamedTarget' },
        { ...directUse, newText: 'RenamedTarget' },
      ]),
    );
    const macroEdits = await f.rename.provideRenameEdits(
      consumer,
      position(consumer, 'CALL'),
      'NEXT',
      token,
    );
    assert.deepEqual(
      editSpans(f, macroEdits),
      sorted([
        { ...macroDeclaration, newText: 'NEXT' },
        { ...firstInvocation, newText: 'NEXT' },
        { ...secondInvocation, newText: 'NEXT' },
      ]),
    );
  },
);

test(
  'an ambiguous macro body has no arbitrary definition and rejects an incomplete local rename',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Definitions: '#macro READ value\n',
      Consumer:
        'function One() { var value = 1; return READ; }\nfunction Two() { var value = "text"; return READ; }',
    });
    const definitions = f.documents.Definitions;
    const consumer = f.documents.Consumer;
    const physical = position(definitions, 'value');
    assert.equal(
      await f.definitions.provideDefinition(definitions, physical, token),
      undefined,
    );
    assert.equal(
      await f.references.provideReferences(
        definitions,
        physical,
        { includeDeclaration: true },
        token,
      ),
      undefined,
    );
    await assert.rejects(
      f.rename.prepareRename(definitions, physical, token),
      /Not a symbol reference/,
    );
    await assert.rejects(
      f.rename.provideRenameEdits(
        consumer,
        position(consumer, 'value'),
        'renamed',
        token,
      ),
      /macro spelling denotes different symbols/i,
    );
  },
);

test(
  'shorthand value and property roles retain independent definitions, references and rename recipes',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Shorthand:
        'function Probe() { var original = 1; var holder = { original }; return holder.original; }',
    });
    const document = f.documents.Shorthand;
    const declaration = span(document, 'original');
    const shorthand = span(document, 'original', declaration.end);
    const member = span(document, 'original', shorthand.end);
    assert.notEqual(
      f.workspace.getReference(document, document.positionAt(declaration.start))
        .item,
      f.workspace.getReference(document, document.positionAt(member.start))
        .item,
    );
    assert.deepEqual(
      locationSpan(
        f.byUri,
        await f.definitions.provideDefinition(
          document,
          document.positionAt(shorthand.start),
          token,
        ),
      ),
      declaration,
    );
    assert.deepEqual(
      locationSpan(
        f.byUri,
        await f.definitions.provideDefinition(
          document,
          document.positionAt(member.start),
          token,
        ),
      ),
      shorthand,
    );
    assert.deepEqual(
      referenceSpans(
        f,
        await f.references.provideReferences(
          document,
          document.positionAt(declaration.start),
          { includeDeclaration: true },
          token,
        ),
      ),
      sorted([declaration, shorthand]),
    );
    assert.deepEqual(
      referenceSpans(
        f,
        await f.references.provideReferences(
          document,
          document.positionAt(member.start),
          { includeDeclaration: true },
          token,
        ),
      ),
      sorted([shorthand, member]),
    );
    assert.deepEqual(
      editSpans(
        f,
        await f.rename.provideRenameEdits(
          document,
          document.positionAt(declaration.start),
          'changed',
          token,
        ),
      ),
      sorted([
        { ...declaration, newText: 'changed' },
        { ...shorthand, newText: 'original: changed' },
      ]),
    );
    assert.deepEqual(
      editSpans(
        f,
        await f.rename.provideRenameEdits(
          document,
          document.positionAt(member.start),
          'field',
          token,
        ),
      ),
      sorted([
        { ...shorthand, newText: 'field: original' },
        { ...member, newText: 'field' },
      ]),
    );
  },
);

test(
  'semantic tokens use current physical spans and never serve an old view after edit or Code retirement',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Definitions:
        'function ExtremelyLongTargetName() { return 1; }\n#macro CALL ExtremelyLongTargetName\n',
      Consumer:
        'function Invoke() {\n  return CALL() + CALL() + ExtremelyLongTargetName();\n}',
    });
    assert(f.tokens instanceof f.host.subject.GameMakerSemanticTokenProvider);
    const consumer = f.documents.Consumer;
    const definitions = f.documents.Definitions;
    const before = await f.tokens.provideDocumentSemanticTokens(
      consumer,
      token,
    );
    const consumerTokens = tokenSpans(consumer, before);
    const first = span(consumer, 'CALL');
    const second = span(consumer, 'CALL', first.end);
    for (const invocation of [first, second]) {
      assert.deepEqual(
        consumerTokens.filter((entry: any) => entry.start === invocation.start),
        [{ ...invocation, type: 'macro' }],
      );
    }
    assert.equal(
      await f.tokens.provideDocumentSemanticTokens(consumer, token),
      before,
      'An unchanged view reuses its own token object',
    );
    const declaration = span(definitions, 'ExtremelyLongTargetName');
    const physical = span(
      definitions,
      'ExtremelyLongTargetName',
      declaration.end,
    );
    const definitionTokens = tokenSpans(
      definitions,
      await f.tokens.provideDocumentSemanticTokens(definitions, token),
    );
    assert.deepEqual(
      definitionTokens.filter((entry: any) => entry.start === physical.start),
      [{ ...physical, type: 'function' }],
    );

    consumer.setText('var x = 1;');
    assert.equal(
      await f.workspace.ensureDocumentCurrent(consumer),
      f.files.Consumer,
    );
    const edited = await f.tokens.provideDocumentSemanticTokens(
      consumer,
      token,
    );
    assert.notEqual(edited, before);
    assert.deepEqual(
      tokenSpans(consumer, edited).map(
        ({ type: _type, ...range }: any) => range,
      ),
      [span(consumer, 'x')],
    );
    assert.equal(
      await f.tokens.provideDocumentSemanticTokens(consumer, token),
      edited,
    );

    consumer.setText('var fresh = 2;');
    const replacement = f.host.subject.replaceCode(
      f.files.Consumer,
      'var stale = 0;',
    );
    assert.equal(
      await f.workspace.ensureDocumentCurrent(consumer),
      replacement,
    );
    assert.equal(f.files.Consumer.analysisState.status, 'retired');
    const replaced = await f.tokens.provideDocumentSemanticTokens(
      consumer,
      token,
    );
    assert.notEqual(replaced, edited);
    assert.deepEqual(
      tokenSpans(consumer, replaced).map(
        ({ type: _type, ...range }: any) => range,
      ),
      [span(consumer, 'fresh')],
    );
    assert.equal(
      await f.tokens.provideDocumentSemanticTokens(consumer, {
        isCancellationRequested: true,
      }),
      undefined,
    );

    f.project.analysis.retire(replacement);
    replacement.asset.gmlFiles.delete(replacement.path.absolute.toLowerCase());
    await f.project.analysis.analyze();
    assert.equal(replacement.analysisState.status, 'retired');
    assert.equal(
      await f.tokens.provideDocumentSemanticTokens(consumer, token),
      undefined,
    );
  },
);

for (const [left, right] of [
  ['1', '"text"'],
  ['"text"', '1'],
]) {
  test(
    `union member navigation retains both targets and rejects ambiguous rename (${left} first)`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t, {
        Union: `function Probe(flag){var receiver=flag?{shared:${left}}:{shared:${right}};return receiver.shared;}`,
      });
      const document = f.documents.Union;
      const first = span(document, 'shared');
      const second = span(document, 'shared', first.end);
      const use = span(document, 'shared', second.end);
      const point = document.positionAt(use.start);
      const candidates = f.files.Union.getReferenceCandidatesAt(use.start);
      assert.equal(candidates.length, 2);
      assert.equal(f.files.Union.getReferenceAt(use.start), undefined);
      assert.deepEqual(
        candidates
          .map((ref: any) => ref.evaluatedType.toFeatherString())
          .sort(),
        ['Real', 'String'],
      );
      const definitions = await f.definitions.provideDefinition(
        document,
        point,
        token,
      );
      assert(Array.isArray(definitions));
      assert.deepEqual(
        sorted(
          definitions.map((location: any) => locationSpan(f.byUri, location)),
        ),
        sorted([first, second]),
      );
      assert.deepEqual(
        referenceSpans(
          f,
          await f.references.provideReferences(
            document,
            point,
            { includeDeclaration: true },
            token,
          ),
        ),
        sorted([first, second, use]),
      );
      assert.deepEqual(
        referenceSpans(
          f,
          await f.references.provideReferences(
            document,
            point,
            { includeDeclaration: false },
            token,
          ),
        ),
        [use],
      );
      const hover = await new f.host.subject.StitchHoverProvider(
        f.workspace,
      ).provideHover(document, point, token);
      assert.deepEqual(
        hover.contents.codeBlocks.map((block: any) => block.value).sort(),
        ['Real', 'String'],
      );
      await assert.rejects(
        f.rename.prepareRename(document, point, token),
        /multiple possible symbols/,
      );
      await assert.rejects(
        f.rename.provideRenameEdits(
          document,
          document.positionAt(first.start),
          'renamed',
          token,
        ),
        /ambiguous/,
      );
    },
  );
}

test(
  'rename from a qualified type annotation edits its suffix and preserves the namespace',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Definition: 'function Struct() constructor {field=1;}',
      Consumer:
        'function Probe(){\nvar Renamed=0;\n/// @type {Struct.Struct}\nvar instance;\n}',
    });
    const definition = span(f.documents.Definition, 'Struct');
    const annotation = span(f.documents.Consumer, 'Struct.Struct');
    const point = f.documents.Consumer.positionAt(
      annotation.start + 'Struct.'.length,
    );
    const prepared = await f.rename.prepareRename(
      f.documents.Consumer,
      point,
      token,
    );
    assert.equal(prepared.placeholder, 'Struct');
    assert.deepEqual(
      locationSpan(f.byUri, {
        uri: f.documents.Consumer.uri,
        range: prepared.range,
      }),
      { ...annotation, start: annotation.start + 'Struct.'.length },
    );
    assert.deepEqual(
      editSpans(
        f,
        await f.rename.provideRenameEdits(
          f.documents.Consumer,
          point,
          'Renamed',
          token,
        ),
      ),
      sorted([
        { ...definition, newText: 'Renamed' },
        { ...annotation, newText: 'Struct.Renamed' },
      ]),
    );
  },
);

// A member can have different constructed types in its possible receiver shapes.
// Type navigation must retain both constructor declarations, not just the first.
test(
  'union member type navigation retains every constructed alternative',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      First: 'function First() constructor { left=1; }',
      Second: 'function Second() constructor { right=1; }',
      Consumer:
        'function Probe(flag){var receiver=flag?{shared:new First()}:{shared:new Second()};return receiver.shared;}',
    });
    const document = f.documents.Consumer;
    const point = document.positionAt(document.getText().lastIndexOf('shared'));
    const provider = new f.host.subject.StitchTypeDefinitionProvider(
      f.workspace,
    );
    const locations = await provider.provideTypeDefinition(
      document,
      point,
      token,
    );
    assert.deepEqual(
      referenceSpans(f, locations),
      sorted([
        span(f.documents.First, 'First'),
        span(f.documents.Second, 'Second'),
      ]),
    );
  },
);

for (const reverse of [false, true]) {
  test(
    `union completion exposes all names, partial labels and combined types (${reverse ? 'reverse' : 'forward'})`,
    { timeout: 30_000 },
    async (t) => {
      const shapes = ['{alpha:1,common:1}', '{beta:1,common:"text"}'];
      if (reverse) shapes.reverse();
      const source = `function Probe(flag){var receiver=flag?${shapes[0]}:${shapes[1]};return receiver.common;}`;
      const f = await fixture(t, { Consumer: source });
      const document = f.documents.Consumer;
      const point = document.positionAt(
        source.lastIndexOf('receiver.') + 'receiver.'.length,
      );
      const provider = new f.host.subject.StitchCompletionProvider(f.workspace);
      const context = { triggerKind: 1, triggerCharacter: '.' };
      const items = await provider.provideCompletionItems(
        document,
        point,
        token,
        context,
      );
      const nameOf = (item: any) =>
        typeof item.label === 'string' ? item.label : item.label.label;
      assert.deepEqual(items.map(nameOf).sort(), ['alpha', 'beta', 'common']);
      assert(items.every((item: any) => item.detail === undefined));
      const partial = items.find((item: any) => nameOf(item) === 'alpha');
      assert.deepEqual(partial.label, {
        label: 'alpha',
        description: 'partial 1/2',
      });
      const common = items.find((item: any) => nameOf(item) === 'common');
      assert.equal(common.label, 'common');
      provider.resolveCompletionItem(common, token);
      assert.match(common.detail, /^Real\|String(?: |$)/);
      assert(!common.detail.includes('receiver alternatives'));
      provider.resolveCompletionItem(partial, token);
      assert.match(partial.detail, /available in 1\/2 receiver alternatives/);
      assert.equal(partial.filterText, undefined);
      assert.equal(partial.insertText, undefined);
      assert.deepEqual(partial.label, {
        label: 'alpha',
        description: 'partial 1/2',
      });
      const stale = (
        await provider.provideCompletionItems(document, point, token, context)
      ).find((item: any) => nameOf(item) === 'common');
      await f.files.Consumer.reload(source.replace('"text"', 'false'));
      provider.resolveCompletionItem(stale, token);
      assert.equal(stale.detail, undefined);
    },
  );
}

test(
  'completion keeps uncertain receivers partial and unresolved dot namespaces empty',
  { timeout: 30_000 },
  async (t) => {
    const source =
      'function Probe(flag){var receiver=flag?{alpha:1}:undefined;return receiver.alpha;}';
    const f = await fixture(t, {
      Consumer: source,
      Unknown: 'function sentinel(){} missing.',
    });
    const provider = new f.host.subject.StitchCompletionProvider(f.workspace);
    const context = { triggerKind: 1, triggerCharacter: '.' };
    const items = await provider.provideCompletionItems(
      f.documents.Consumer,
      f.documents.Consumer.positionAt(
        source.lastIndexOf('receiver.') + 'receiver.'.length,
      ),
      token,
      context,
    );
    assert.deepEqual(
      items.map((item: any) => item.label),
      [{ label: 'alpha', description: 'partial 1/2' }],
    );
    const unknown = f.documents.Unknown;
    assert.deepEqual(
      await provider.provideCompletionItems(
        unknown,
        unknown.positionAt(unknown.getText().length),
        token,
        context,
      ),
      [],
    );
  },
);

test(
  'GML extension navigation follows the implementation even when its API is native-backed',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, {
      Extension: '#define external_impl\nreturn 1;\n',
      Consumer: 'var extension_result = public_entry();',
    });
    f.files.Extension.setSourceContext({
      kind: 'extension',
      extensionFunctions: [
        {
          sourceName: 'external_impl',
          name: 'public_entry',
          hidden: false,
          signatureKey: 'fixture:extension-signature',
        },
      ],
    });
    await f.project.analysis.analyze();
    assert.equal(f.project.self.getMember('public_entry').native, 'Extension');
    const result = await f.definitions.provideDefinition(
      f.documents.Consumer,
      position(f.documents.Consumer, 'public_entry'),
      token,
    );
    assert.deepEqual(
      locationSpan(f.byUri, result),
      span(f.documents.Extension, 'external_impl'),
    );
  },
);
