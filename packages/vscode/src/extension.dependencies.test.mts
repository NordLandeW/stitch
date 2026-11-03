import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHost } from './test/host.mjs';

let host: Awaited<ReturnType<typeof createHost>>;
let workspace: any;
let project: any;
const token = { isCancellationRequested: false };
beforeEach(async () => {
  host = await createHost();
  workspace = host.newWorkspace();
  project = await host.project();
  workspace.projects.push(project);
});
afterEach(() => host?.dispose());

async function document(name: string, text: string) {
  const code = await host.subject.addCode(project, name, text);
  const doc = host.document(code, text);
  host.documents.push(doc);
  return { code, doc };
}
async function edit(file: any, text: string) {
  file.doc.setText(text);
  await file.code.reload(text, { reloadDirty: true });
}
function memberAt(file: any, spelling: string) {
  const offset = file.doc.getText().indexOf(spelling);
  assert(offset >= 0, `Missing source position ${spelling}`);
  const memberOffset = offset + spelling.lastIndexOf('.') + 1;
  const ref = file.code.getReferenceAt(memberOffset);
  assert(ref, `Missing reference at ${spelling}`);
  return { ref, position: file.doc.positionAt(memberOffset) };
}
async function declaredMember(
  consumer: any,
  spelling: string,
  producer: any,
  definition: string,
  type: string,
) {
  const { ref, position } = memberAt(consumer, spelling);
  assert.equal(ref.item.type.toFeatherString(), type);
  assert(
    ref.item.def?.file === producer.code,
    'Member definition must belong to the current producer',
  );
  assert.equal(
    ref.item.def.start.offset,
    producer.doc.getText().indexOf(definition),
  );
  const definitions = await new host.subject.StitchDefinitionsProvider(
    workspace,
  ).provideDefinition(consumer.doc, position, token);
  const locations = Array.isArray(definitions) ? definitions : [definitions];
  assert.equal(locations.length, 1);
  assert.equal(locations[0].uri.toString(), producer.doc.uri.toString());
  assert.deepEqual(
    locations[0].range.start,
    producer.doc.positionAt(producer.doc.getText().indexOf(definition)),
  );
  const hover = await new host.subject.StitchHoverProvider(
    workspace,
  ).provideHover(consumer.doc, position, token);
  assert(
    hover.contents.codeBlocks.some((block: any) => block.value.includes(type)),
  );
  assert.equal(
    consumer.code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE.length,
    0,
  );
}

test('returned struct members retain real provider definitions through producer edits and recovery', async () => {
  const source =
    'function TextElement() constructor {\n static get_bbox = function() { return { left: 1, height: 2 }; };\n}';
  const producer = await document('Bounds', source);
  const consumer = await document(
    'DrawBounds',
    'function draw_bounds() {\n var element = new TextElement();\n var bbox = element.get_bbox();\n return bbox.left + bbox.height;\n}',
  );
  for (const text of [source, '// preceding comment\n' + source, source]) {
    await edit(producer, text);
    await declaredMember(consumer, 'bbox.left', producer, 'left: 1', 'Real');
    await declaredMember(
      consumer,
      'bbox.height',
      producer,
      'height: 2',
      'Real',
    );
  }
  await edit(producer, source.replace('left: 1', 'left: "edge"'));
  await declaredMember(
    consumer,
    'bbox.left',
    producer,
    'left: "edge"',
    'String',
  );
  await edit(producer, source.replace('left: 1, ', ''));
  assert.equal(memberAt(consumer, 'bbox.left').ref.item.def, undefined);
  assert(
    consumer.code
      .getDiagnostics()
      .UNDECLARED_VARIABLE_REFERENCE.some((d: any) =>
        d.message.includes('left'),
      ),
  );
  await edit(producer, source);
  await declaredMember(consumer, 'bbox.left', producer, 'left: 1', 'Real');
  const refs = await new host.subject.StitchReferenceProvider(
    workspace,
  ).provideReferences(
    consumer.doc,
    memberAt(consumer, 'bbox.left').position,
    { includeDeclaration: true },
    token,
  );
  assert.equal(refs.length, 2);
  const rename = await new host.subject.StitchRenameProvider(
    workspace,
  ).provideRenameEdits(
    consumer.doc,
    memberAt(consumer, 'bbox.left').position,
    'edge',
    token,
  );
  assert.equal(rename.operations.length, 2);
});

test('dependent aliases and nested return literals refresh in declaration order', async () => {
  const source = 'function leaf_bounds() { return { left: 1 }; }';
  const producer = await document('LeafBounds', source);
  await document(
    'BoxFacade',
    'function bounds_facade() { return { box: leaf_bounds() }; }',
  );
  await document(
    'BoxAlias',
    'function bounds_alias() { return bounds_facade(); }',
  );
  const consumer = await document(
    'UseBounds',
    'function use_bounds() { var value = bounds_alias(); return value.box.left; }',
  );
  for (const text of [
    '// comment\n' + source,
    source.replace('left: 1', 'left: "new"'),
    source,
  ]) {
    await edit(producer, text);
    await declaredMember(
      consumer,
      'value.box.left',
      producer,
      text.includes('"new"') ? 'left: "new"' : 'left: 1',
      text.includes('"new"') ? 'String' : 'Real',
    );
  }
});

test('separate returned literals do not merge when functions and branches are inserted', async () => {
  const source =
    'function first_box() { return { left: 1 }; }\nfunction second_box() { return { right: "r" }; }';
  const producer = await document('IndependentBounds', source);
  const consumer = await document(
    'UseIndependentBounds',
    'function use_boxes() { var a = first_box(); var b = second_box(); return a.left + b.right; }',
  );
  for (const text of [
    source,
    'function unrelated() { return { inserted: true }; }\n' + source,
    source.split('\n').reverse().join('\n'),
    source,
  ]) {
    await edit(producer, text);
    await declaredMember(consumer, 'a.left', producer, 'left: 1', 'Real');
    await declaredMember(consumer, 'b.right', producer, 'right: "r"', 'String');
    assert.equal(
      memberAt(consumer, 'a.left').ref.item.parent.getMember('right'),
      undefined,
    );
    assert.equal(
      memberAt(consumer, 'b.right').ref.item.parent.getMember('left'),
      undefined,
    );
  }
});

test('mutually referencing files finish dependency refresh with current definitions', async () => {
  const source = 'function cyclic_box() { inspect_box(); return { left: 1 }; }';
  const producer = await document('CyclicBounds', source);
  await document(
    'InspectBounds',
    'function inspect_box() { var seen = cyclic_box(); return seen.left; }',
  );
  const consumer = await document(
    'UseCyclicBounds',
    'function use_cyclic_box() { var value = cyclic_box(); return value.left; }',
  );
  await edit(producer, '// changed\n' + source);
  await declaredMember(consumer, 'value.left', producer, 'left: 1', 'Real');
  await edit(producer, source);
  await declaredMember(consumer, 'value.left', producer, 'left: 1', 'Real');
});

test('configuration-driven macro reparsing refreshes non-macro callers', async () => {
  await document(
    'ConfigurationBounds',
    '#macro VALUE 1\n#macro Test:VALUE "edge"\nfunction configured_box() { return { left: VALUE }; }',
  );
  const consumer = await document(
    'UseConfigurationBounds',
    'function use_configured_box() { var value = configured_box(); return value.left; }',
  );
  for (const configuration of ['Test', 'Default', 'Test', 'Default']) {
    workspace.selectAnalysisConfiguration(project, configuration);
    const { ref } = memberAt(consumer, 'value.left');
    assert(ref.item.def?.file);
    assert.equal(
      ref.item.type.toFeatherString(),
      configuration === 'Test' ? 'String' : 'Real',
    );
    assert.equal(
      consumer.code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE.length,
      0,
    );
  }
});

test('same-named members at separate return sites keep separate declaration identities', async () => {
  const source =
    'function choose_bounds(flag) { if (flag) return { height: 1 }; return { height: 2 }; }';
  const producer = await document('ReturnSites', source);
  const consumer = await document(
    'UseReturnSites',
    'function use_choice() { var value = choose_bounds(true); return value.height; }',
  );
  for (const text of [
    source,
    '// shifted\n' + source,
    source.replace('if (flag)', 'if (flag > 0)'),
  ]) {
    await edit(producer, text);
    const definitions = producer.code.refs.filter(
      (ref: any) => ref.isDef && ref.item.name === 'height',
    );
    assert.equal(definitions.length, 2);
    assert.notEqual(definitions[0].item === definitions[1].item, true);
    const { ref } = memberAt(consumer, 'value.height');
    assert(definitions.some((definition: any) => definition.item === ref.item));
    assert.equal(ref.item.type.toFeatherString(), 'Real');
    assert.equal(
      consumer.code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE.length,
      0,
    );
  }
});

test('explicit return annotations remain authoritative after implementation edits', async () => {
  const source =
    'function NamedBounds() constructor { height = 1; }\n/// @returns {Struct.NamedBounds}\nfunction documented_bounds() { return { other: "value" }; }';
  const producer = await document('DocumentedBounds', source);
  const consumer = await document(
    'UseDocumentedBounds',
    'function use_documented() { var value = documented_bounds(); return value.height; }',
  );
  await edit(producer, '// moved\n' + source);
  await declaredMember(
    consumer,
    'value.height',
    producer,
    'height = 1',
    'Real',
  );
});

test('object metadata reload refreshes actual completion, hover and diagnostics without editing readers', async () => {
  const resource = {
    id: {
      name: 'ObjectVariables',
      path: 'objects/ObjectVariables/ObjectVariables.yy',
    },
  };
  const asset = new (class extends host.subject.Asset {
    constructor() {
      super(project, resource, project.dir.join(resource.id.path));
      this.yy = {
        name: resource.id.name,
        resourceType: 'GMObject',
        parentObjectId: null,
        properties: [{ name: 'lists', varType: 4, value: '["A", "B"]' }],
        eventList: [
          { eventType: 0, eventNum: 0 },
          { eventType: 3, eventNum: 0 },
        ],
      };
    }
  })();
  project.assets.set(resource.id.name.toLowerCase(), asset);
  project.yyp.resources.push(resource);
  const documents: any[] = [];
  for (const [name, text] of [
    ['Create_0', 'listCount = array_length(lists);'],
    ['Step_0', 'var selected = lists[0];\nlis'],
  ]) {
    const code = new host.subject.Code(asset, asset.dir.join(name + '.gml'));
    asset.gmlFiles.set(code.path.absolute.toLowerCase(), code);
    await code.parse(text);
    const doc = host.document(code, text);
    host.documents.push(doc);
    documents.push({ code, doc });
  }
  project.initiallyParseAssetCode([asset]);
  const usage = documents[1];
  const cursor = usage.doc.positionAt(usage.doc.getText().length);
  const completion = new host.subject.StitchCompletionProvider(workspace);
  const items = await completion.provideCompletionItems(
    usage.doc,
    cursor,
    token,
    {},
  );
  assert(items.some((item: any) => item.label === 'lists'));
  const position = usage.doc.positionAt(usage.doc.getText().indexOf('lists'));
  const hover = await new host.subject.StitchHoverProvider(
    workspace,
  ).provideHover(usage.doc, position, token);
  assert(hover.contents.codeBlocks.some((block: any) => block.value === 'Any'));
  const rename = new host.subject.StitchRenameProvider(workspace);
  await assert.rejects(
    rename.provideRenameEdits(usage.doc, position, 'items', token),
  );
  Object.defineProperty(asset, 'dir', { value: asset.dir });
  asset.dir.listChildren = async () => documents.map((file) => file.code.path);
  let properties: any[] = [];
  asset.readYy = async () => {
    asset.yy.properties = properties;
    return asset.yy;
  };
  for (const file of documents)
    file.code.path.read = async () => file.doc.getText();
  await workspace.reloadAsset(asset);
  assert(
    usage.code
      .getDiagnostics()
      .UNDECLARED_VARIABLE_REFERENCE.some((d: any) =>
        d.message.includes('lists'),
      ),
  );
  properties = [{ name: 'lists', varType: 4, value: '["A", "B"]' }];
  await workspace.reloadAsset(asset);
  assert(
    !usage.code
      .getDiagnostics()
      .UNDECLARED_VARIABLE_REFERENCE.some((d: any) =>
        d.message.includes('lists'),
      ),
  );
  assert(
    (
      await completion.provideCompletionItems(usage.doc, cursor, token, {})
    ).some((item: any) => item.label === 'lists'),
  );
});

test('recursive return containers retain a usable analysis when an upstream body is edited', async () => {
  const left = await document(
    'RecursiveLeft',
    'function recursive_left(stop) { if (stop) return 0; return [recursive_right(true)]; }',
  );
  await document(
    'RecursiveRight',
    'function recursive_right(stop) { if (stop) return 0; return [recursive_left(true)]; }',
  );
  const consumer = await document(
    'RecursiveUse',
    'function use_recursive() { return recursive_left(true); }',
  );
  await edit(left, '// changed\n' + left.doc.getText());
  assert.equal(consumer.code.getDiagnostics().SYNTAX_ERROR.length, 0);
  assert(memberAt(consumer, 'recursive_left').ref.item.def?.file === left.code);
});

test('constructor parent changes invalidate unchanged member readers', async () => {
  await document(
    'BaseChoices',
    'function ParentA() constructor { height = 1; }\nfunction ParentB() constructor { width = 1; }',
  );
  const producer = await document(
    'ChildChoice',
    'function ChildChoice() : ParentA() constructor {}',
  );
  const consumer = await document(
    'ReadChildChoice',
    'function read_child() { var value = new ChildChoice(); return value.height; }',
  );
  assert(memberAt(consumer, 'value.height').ref.item.def?.file);
  await edit(producer, producer.doc.getText().replace('ParentA', 'ParentB'));
  assert(!memberAt(consumer, 'value.height').ref.item.def);
  assert(
    consumer.code
      .getDiagnostics()
      .UNDECLARED_VARIABLE_REFERENCE.some((d: any) =>
        d.message.includes('height'),
      ),
  );
});

test('symbol dependency chains spanning the same files are not mistaken for recursive instability', async () => {
  const aSource = Array.from({ length: 10 }, (_, i) =>
    i === 9
      ? 'function ChainA10() { return { height: 1 }; }'
      : `function ChainA${i + 1}() { return ChainB${i + 1}(); }`,
  ).join('\n');
  const bSource = Array.from(
    { length: 9 },
    (_, i) => `function ChainB${i + 1}() { return ChainA${i + 2}(); }`,
  ).join('\n');
  const producer = await document('AlternatingA', aSource);
  await document('AlternatingB', bSource);
  project.initiallyParseAssetCode([...project.assets.values()]);
  const consumer = await document(
    'UseAlternating',
    'function use_chain() { var value = ChainA1(); return value.height; }',
  );
  await edit(producer, aSource.replace('height: 1', 'height: "edge"'));
  await declaredMember(
    consumer,
    'value.height',
    producer,
    'height: "edge"',
    'String',
  );
});

test('deep exported annotations remain usable through semantic dependency signatures', async () => {
  const type = 'Array<'.repeat(8192) + 'Real' + '>'.repeat(8192);
  const producer = await document(
    'DeepReturn',
    `/// @returns {${type}}\nfunction deep_return() { return []; }`,
  );
  await edit(producer, '// moved\n' + producer.doc.getText());
  const fn = project.self.getMember('deep_return').getTypeByKind('Function');
  assert.equal(fn.returns.toFeatherString(), type);
});

test('shared returned-type graphs retain all leaf bindings without duplicating their structure', async () => {
  const functions = ['function Shared0() { return { height: 1 }; }'];
  for (let i = 1; i <= 15; i++)
    functions.push(
      `function Shared${i}() { return { left: Shared${i - 1}(), right: Shared${i - 1}() }; }`,
    );
  const source = functions.join('\n');
  const producer = await document('SharedReturns', source);
  const member = 'value' + '.left'.repeat(15) + '.height';
  const consumer = await document(
    'UseSharedReturns',
    `function use_shared() { var value = Shared15(); return ${member}; }`,
  );
  await edit(producer, source.replace('height: 1', 'height: "leaf"'));
  await declaredMember(consumer, member, producer, 'height: "leaf"', 'String');
});
