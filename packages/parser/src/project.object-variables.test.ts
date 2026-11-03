import { expect } from 'chai';
import {
  YyObjectPropertyVarType,
  type YyObject,
  type YyObjectProperty,
} from '@bscotch/yy';
import { Project } from './project.js';

function property(
  name: string,
  varType = YyObjectPropertyVarType.Expression,
): YyObjectProperty {
  return {
    name,
    varType,
    value: '["A", "B"]',
    rangeMin: 0,
    rangeMax: 10,
    rangeEnabled: false,
    listItems: [],
    multiselect: false,
    filters: [],
    resourceVersion: '1.0',
    resourceType: 'GMObjectProperty',
  };
}

describe('Object variable declarations', function () {
  it('keeps a sibling without YY declarations separate from shared rename protection', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const a = project.getAssetByName('o_child1')!;
    const b = project.getAssetByName('o_child2')!;
    (parent.yy as YyObject).properties = [];
    (a.yy as YyObject).properties = [];
    (b.yy as YyObject).properties = [];
    await parent
      .getEventByName('Create_0')!
      .reload('settings = { height: "parent" };', { reloadDirty: true });
    const create = b.getEventByName('Create_0')!;
    const source = 'event_inherited(); settings = { height: 1 };';
    await create.reload(source, { reloadDirty: true });
    const reader = project
      .getAssetByName('o_object')!
      .getEventByName('Step_0')!;
    await reader.reload('var value = o_child2.settings.height;', {
      reloadDirty: true,
    });
    const originalType = reader.refs
      .find((ref) => ref.item.name === 'height')
      ?.item.type.toFeatherString();
    expect(b.variables!.getMember('settings', true) === undefined).to.equal(
      true,
    );
    await create.reload('event_inherited();', { reloadDirty: true });
    (a.yy as YyObject).properties = [property('settings')];
    await a
      .getEventByName('Create_0')!
      .reload('event_inherited(); var value = settings.height;', {
        reloadDirty: true,
      });
    await create.reload(source, { reloadDirty: true });
    expect(
      reader.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal(originalType);
    expect(b.variables!.getMember('settings', true) === undefined).to.equal(
      true,
    );
    await create.reload('event_inherited();', { reloadDirty: true });
    expect(
      reader.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('String');
    expect(
      reader.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
    expect(parent.variables!.getMember('settings')!.isRenameable).to.equal(
      false,
    );
  });

  it('rebinds external child readers when its inherited metadata owner changes', async function () {
    const project = await Project.initialize('samples/project');
    const a = project.getAssetByName('o_parent')!;
    const b = project.getAssetByName('o_child2')!;
    const child = project.getAssetByName('o_child1')!;
    for (const asset of [a, b]) {
      (asset.yy as YyObject).properties = [property('settings')];
      asset.refreshObjectVariables();
    }
    await a
      .getEventByName('Create_0')!
      .reload('settings = { height: 1 };', { reloadDirty: true });
    await b
      .getEventByName('Create_0')!
      .reload('settings = { height: "second" };', { reloadDirty: true });
    await child
      .getEventByName('Create_0')!
      .reload('event_inherited();', { reloadDirty: true });
    const reader = project
      .getAssetByName('o_object')!
      .getEventByName('Step_0')!;
    await reader.reload('var value = o_child1.settings.height;', {
      reloadDirty: true,
    });
    expect(
      reader.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('Real');
    // Match the in-memory YY first so the public parent setter performs no file write.
    (child.yy as YyObject).parentObjectId = b.resource.id;
    child.parent = b as any;
    child.refreshObjectVariables(true);
    project.drainDirtyFileUpdateQueue();
    expect(
      reader.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('String');
  });

  it('inherits parent GML types for child-only metadata and releases rename protection with that metadata', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child1')!;
    (parent.yy as YyObject).properties = [];
    (child.yy as YyObject).properties = [property('settings')];
    await parent
      .getEventByName('Create_0')!
      .reload('settings = { height: 1 };', { reloadDirty: true });
    const create = child.getEventByName('Create_0')!;
    await create.reload('event_inherited(); var value = settings.height;', {
      reloadDirty: true,
    });
    expect(
      create.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('Real');
    expect(child.variables!.getMember('settings')!.isRenameable).to.equal(
      false,
    );
    const sibling = project.getAssetByName('o_child2')!;
    (sibling.yy as YyObject).properties = [property('settings')];
    await sibling
      .getEventByName('Create_0')!
      .reload('event_inherited(); var value = settings.height;', {
        reloadDirty: true,
      });
    (child.yy as YyObject).properties = [];
    child.refreshObjectVariables(true);
    project.drainDirtyFileUpdateQueue();
    expect(parent.variables!.getMember('settings')!.isRenameable).to.equal(
      false,
    );
    sibling.retire();
    project.assets.delete(sibling.name.toLowerCase());
    project.drainDirtyFileUpdateQueue();
    expect(parent.variables!.getMember('settings')!.isRenameable).to.equal(
      true,
    );
    expect(
      create.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('Real');
  });

  it('restores implicit Create inheritance when the child Create event is retired', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child1')!;
    (parent.yy as YyObject).properties = [property('settings')];
    parent.refreshObjectVariables();
    await parent
      .getEventByName('Create_0')!
      .reload('settings = { height: 1 };', { reloadDirty: true });
    const create = child.getEventByName('Create_0')!;
    await create.reload('var value = settings;', { reloadDirty: true });
    const reader = project
      .getAssetByName('o_object')!
      .getEventByName('Step_0')!;
    await reader.reload('var value = o_child1.settings;', {
      reloadDirty: true,
    });
    create.retire();
    child.gmlFiles.delete(create.path.absolute.toLowerCase());
    project.drainDirtyFileUpdateQueue();
    expect(
      child
        .variables!.getMember('settings')!
        .getTypeByKind('Struct')
        ?.getMember('height')
        ?.type.toFeatherString(),
    ).to.equal('Real');
    expect(
      reader.refs.find((ref) => ref.item.name === 'settings')?.item.def
        ?.file === parent.getEventByName('Create_0'),
    ).to.equal(true);
  });

  it('keeps qualified child writes independent and restores inherited types when the write is removed', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child1')!;
    const sibling = project.getAssetByName('o_child2')!;
    (parent.yy as YyObject).properties = [property('settings')];
    parent.refreshObjectVariables();
    child.refreshObjectVariables();
    await parent
      .getEventByName('Create_0')!
      .reload('settings = { height: "parent" };', { reloadDirty: true });
    await child
      .getEventByName('Create_0')!
      .reload('event_inherited();', { reloadDirty: true });
    const writer = sibling.getEventByName('Create_0')!;
    const reader = project
      .getAssetByName('o_object')!
      .getEventByName('Step_0')!;
    await writer.reload('o_child1.settings = { height: 1 };', {
      reloadDirty: true,
    });
    await reader.reload(
      'var childValue = o_child1.settings.height; var parentValue = o_parent.settings.height;',
      { reloadDirty: true },
    );
    const heights = () =>
      reader.refs
        .filter((ref) => ref.item.name === 'height')
        .map((ref) => ref.item.type.toFeatherString());
    expect(heights()).to.deep.equal(['Real', 'String']);
    expect(
      child.variables!.getMember('settings')!.parent === child.variables,
    ).to.equal(true);
    expect(
      child.variables!.getMember('settings')!.def?.file === writer,
    ).to.equal(true);
    await writer.reload('// removed external assignment', {
      reloadDirty: true,
    });
    expect(heights()).to.deep.equal(['String', 'String']);
    expect(
      reader.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
  });

  it('keeps child GML assignments from becoming the parent metadata declaration', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child1')!;
    (parent.yy as YyObject).properties = [property('lists')];
    (child.yy as YyObject).properties = [];
    parent.refreshObjectVariables();
    child.refreshObjectVariables();
    const parentCreate = parent.getEventByName('Create_0')!;
    const childCreate = child.getEventByName('Create_0')!;
    await parentCreate.reload('var size = array_length(lists);', {
      reloadDirty: true,
    });
    await childCreate.reload('lists = ["child"]; event_inherited();', {
      reloadDirty: true,
    });
    const parentSymbol = parent.variables!.getMember('lists')!;
    expect(parentSymbol.def?.file === childCreate).to.equal(false);
    expect(parentSymbol.resourceDefinition?.path).to.equal(
      parent.yyPath.absolute,
    );
    await parentCreate.reload('// restored\nvar size = array_length(lists);', {
      reloadDirty: true,
    });
    expect(
      parentCreate.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
    expect(
      childCreate.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
  });

  it('inherits the parent GML type when its Create event is inherited', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child1')!;
    (parent.yy as YyObject).properties = [property('settings')];
    (child.yy as YyObject).properties = [];
    parent.refreshObjectVariables();
    child.refreshObjectVariables();
    const parentCreate = parent.getEventByName('Create_0')!;
    const childCreate = child.getEventByName('Create_0')!;
    await parentCreate.reload('settings = { height: 1 };', {
      reloadDirty: true,
    });
    await childCreate.reload(
      'event_inherited(); var value = settings.height;',
      { reloadDirty: true },
    );
    const ref = childCreate.refs.find((ref) => ref.item.name === 'height')!;
    expect(!!ref).to.equal(true);
    expect(ref.item.type.toFeatherString()).to.equal('Real');
    expect(ref.item.def?.file === parentCreate).to.equal(true);
    await parentCreate.reload('settings = { height: "parent" };', {
      reloadDirty: true,
    });
    expect(
      childCreate.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('String');
    await childCreate.reload('var value = settings;', { reloadDirty: true });
    expect(
      child.variables!.getMember('settings')!.type.toFeatherString(),
    ).to.equal('Any');
    await childCreate.reload(
      'event_inherited(); var value = settings.height;',
      { reloadDirty: true },
    );
    expect(
      childCreate.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('String');
    await childCreate.reload(
      'event_inherited(); settings = { height: 2 }; var value = settings.height;',
      { reloadDirty: true },
    );
    expect(
      childCreate.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('Real');
    expect(
      parent
        .variables!.getMember('settings')!
        .getTypeByKind('Struct')!
        .getMember('height')!
        .type.toFeatherString(),
    ).to.equal('String');
    await childCreate.reload(
      'event_inherited(); var value = settings.height;',
      { reloadDirty: true },
    );
    expect(
      childCreate.refs
        .find((ref) => ref.item.name === 'height')
        ?.item.type.toFeatherString(),
    ).to.equal('String');
  });

  it('recognizes YY variables before Create and through code edits, metadata removal and restoration', async function () {
    const project = await Project.initialize('samples/project');
    const object = project.getAssetByName('o_object')!;
    const create = object.getEventByName('Create_0')!;
    const step = object.getEventByName('Step_0')!;
    const yy = object.yy as YyObject;
    yy.properties = [
      property('lists'),
      property('label', YyObjectPropertyVarType.String),
    ];
    object.refreshObjectVariables();
    await create.reload('listCount = array_length(lists);\nvar text = label;', {
      reloadDirty: true,
    });
    await step.reload('var selected = lists[0];\nvar text = label;', {
      reloadDirty: true,
    });
    for (const source of [
      '// comment\nlistCount = array_length(lists);',
      'listCount = array_length(lists);',
    ]) {
      await create.reload(source, { reloadDirty: true });
      expect(
        create.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
      ).to.have.lengthOf(0);
      expect(
        step.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
      ).to.have.lengthOf(0);
      expect(object.variables!.getMember('lists')!.def).to.exist;
      expect(
        object.variables!.getMember('label')!.type.toFeatherString(),
      ).to.equal('String');
      expect(object.variables!.getMember('lists')!.isRenameable).to.equal(
        false,
      );
    }
    yy.properties = [property('label', YyObjectPropertyVarType.String)];
    object.refreshObjectVariables();
    project.drainDirtyFileUpdateQueue();
    expect(
      step
        .getDiagnostics()
        .UNDECLARED_VARIABLE_REFERENCE.some((d) => d.message.includes('lists')),
    ).to.equal(true);
    yy.properties.push(property('lists'));
    object.refreshObjectVariables();
    project.drainDirtyFileUpdateQueue();
    expect(
      step.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
  });

  it('inherits pre-creation variables without inheriting the parent Create event', async function () {
    const project = await Project.initialize('samples/project');
    const parent = project.getAssetByName('o_parent')!;
    const child = project.getAssetByName('o_child2')!;
    (parent.yy as YyObject).properties = [
      property('inherited_label', YyObjectPropertyVarType.String),
    ];
    (child.yy as YyObject).properties = [
      property('own_flag', YyObjectPropertyVarType.Boolean),
    ];
    child.refreshObjectVariables();
    const code = child.getEventByName('Create_0')!;
    await code.reload('var label = inherited_label;\nvar flag = own_flag;', {
      reloadDirty: true,
    });
    expect(
      code.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
    expect(
      child.variables!.getMember('inherited_label')!.type.toFeatherString(),
    ).to.equal('String');
    expect(
      child.variables!.getMember('own_flag')!.type.toFeatherString(),
    ).to.equal('Bool');
  });

  it('preserves GML assignments and explicit types for metadata-backed variables', async function () {
    const project = await Project.initialize('samples/project');
    const object = project.getAssetByName('o_object')!;
    (object.yy as YyObject).properties = [property('settings')];
    object.refreshObjectVariables();
    const create = object.getEventByName('Create_0')!;
    const step = object.getEventByName('Step_0')!;
    const source = 'settings = { height: 1 };';
    await create.reload(source, { reloadDirty: true });
    await step.reload('var height = settings.height;', { reloadDirty: true });
    await create.reload('// comment\n' + source, { reloadDirty: true });
    expect(
      step.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
    ).to.have.lengthOf(0);
    expect(
      step.refs
        .find((ref) => ref.item.name === 'height' && !ref.isDef)
        ?.item.type.toFeatherString(),
    ).to.equal('Real');
    await create.reload('/// @type {String}\nsettings = 1;', {
      reloadDirty: true,
    });
    expect(
      object.variables!.getMember('settings')!.type.toFeatherString(),
    ).to.equal('String');
  });

  it('preserves metadata declarations after their last GML definition is retired', async function () {
    const project = await Project.initialize('samples/project');
    const object = project.getAssetByName('o_object')!;
    (object.yy as YyObject).properties = [property('resource_only')];
    object.refreshObjectVariables();
    const create = object.getEventByName('Create_0')!;
    await create.reload('resource_only = { height: 1 };', {
      reloadDirty: true,
    });
    for (const source of [
      '// comment\nresource_only = { height: 1 };',
      'var copy = resource_only;',
      'resource_only = { height: 2 };',
    ]) {
      await create.reload(source, { reloadDirty: true });
      const symbol = object.variables!.getMember('resource_only');
      expect(!!symbol?.def).to.equal(true);
      expect(symbol?.resourceDefinition?.name).to.equal('resource_only');
      expect(symbol?.isRenameable).to.equal(false);
      expect(
        create.getDiagnostics().UNDECLARED_VARIABLE_REFERENCE,
      ).to.have.lengthOf(0);
    }
  });
});
