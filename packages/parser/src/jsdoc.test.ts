import { pathy } from '@bscotch/pathy';
import { undent } from '@bscotch/utility';
import { expect } from 'chai';
import { parseFeatherTypeString } from './jsdoc.feather.js';
import { parseJsdoc } from './jsdoc.js';
import type { Asset } from './project.asset.js';
import { Code } from './project.code.js';
import type { Diagnostic } from './project.diagnostics.js';
import { typeFromParsedJsdocs } from './types.feather.js';
import { Type } from './types.js';

const functionJsdoc = `
/// @desc This is a multiline
///       description.
/// @param {String} first - This is the first parameter
/// @param {Real} second This is the second parameter,
///        which spans multiple lines.
/// @param {Struct} [third] This parameter is optional
/// @param {Struct} [fourth = "bleh" ] This is optional and has a default value
/// @param {Bool} [...] And so is this one, but there can be as many as you want!
/// @returns {Struct} And here is a multiline
///  description of the return type.
/// @self Struct.AnotherConstructor
/// @deprecated`;

const functionJsdocJs = `
* @desc This is a multiline
*       description.
@param {String} first This is the first parameter
* @param {Real} second - This is the second parameter,
*        which spans multiple lines.
* @param {Struct} [third] This parameter is optional
* @param {Struct} [fourth = "bleh" ] This is optional and has a default value
* @param {Bool} [...] And so is this one, but there can be as many as you want!
* @returns {Struct} And here is a multiline
*  description of the return type.
* @self Struct.AnotherConstructor
* @deprecated`;

describe('JSDocs', function () {
  it('can parse Feather typestrings', function () {
    const complexType =
      'Array<string OR Array<Real>> or Struct.Hello or Id.Map<String,Real>';
    const parsed = parseFeatherTypeString(complexType);
    expect(parsed.kind).to.equal('union');
    expect(parsed.types).to.have.lengthOf(3);
    expect(parsed.types[0].kind).to.equal('type');
    expect(parsed.types[0].name.content).to.equal('Array');
    expect(parsed.types[0].of?.kind).to.equal('union');
    expect(parsed.types[0].of?.types).to.have.lengthOf(2);
    expect(parsed.types[0].of?.types[0].kind).to.equal('type');
    expect(parsed.types[0].of?.types[0].name.content).to.equal('string');
    expect(parsed.types[0].of?.types[1].kind).to.equal('type');
    expect(parsed.types[0].of?.types[1].name.content).to.equal('Array');
    expect(parsed.types[0].of?.types[1].of?.kind).to.equal('union');
    expect(parsed.types[0].of?.types[1].of?.types).to.have.lengthOf(1);
    expect(parsed.types[0].of?.types[1].of?.types[0].kind).to.equal('type');
    expect(parsed.types[0].of?.types[1].of?.types[0].name.content).to.equal(
      'Real',
    );
    expect(parsed.types[1].kind).to.equal('type');
    expect(parsed.types[1].name.content).to.equal('Struct.Hello');
    expect(parsed.types[2].kind).to.equal('type');
    expect(parsed.types[2].name.content).to.equal('Id.Map');
    expect(parsed.types[2].of?.kind).to.equal('union');
    expect(parsed.types[2].of?.types).to.have.lengthOf(2);
    expect(parsed.types[2].of?.types[0].kind).to.equal('type');
    expect(parsed.types[2].of?.types[0].name.content).to.equal('String');
    expect(parsed.types[2].of?.types[1].kind).to.equal('type');
    expect(parsed.types[2].of?.types[1].name.content).to.equal('Real');
  });

  it('can parse GML-style Function JSDocs', function () {
    const jsdoc = functionJsdoc;
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('function');
    expect(parsed.deprecated).to.equal(true);
    expect(parsed.self?.content).to.equal('Struct.AnotherConstructor');
    expect(parsed.description).to.equal('This is a multiline\ndescription.');
    expect(parsed.params).to.have.lengthOf(5);
    expect(parsed.params![0].name?.content).to.equal('first');
    expect(parsed.params![0].type?.content).to.equal('String');
    expect(parsed.params![0].description).to.equal(
      'This is the first parameter',
    );
    expect(parsed.params![1].name?.content).to.equal('second');
    expect(parsed.params![1].type?.content).to.equal('Real');
    expect(parsed.params![1].description).to.equal(
      'This is the second parameter,\nwhich spans multiple lines.',
    );
    expect(parsed.params![2].name?.content).to.equal('third');
    expect(parsed.params![2].type?.content).to.equal('Struct');
    expect(parsed.params![2].optional).to.equal(true);
    expect(parsed.params![2].description).to.equal(
      'This parameter is optional',
    );
    expect(parsed.params![3].name?.content).to.equal('fourth');
    expect(parsed.params![3].type?.content).to.equal('Struct');
    expect(parsed.params![3].optional).to.equal(true);
    expect(parsed.params![3].description).to.equal(
      'This is optional and has a default value',
    );
    expect(parsed.params![4].name?.content).to.equal('...');
    expect(parsed.params![4].type?.content).to.equal('Bool');
    expect(parsed.params![4].optional).to.equal(true);
    expect(parsed.params![4].description).to.equal(
      'And so is this one, but there can be as many as you want!',
    );
  });

  it('can parse JS-style Function JSDocs', function () {
    const jsdoc = functionJsdocJs;
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('function');
    expect(parsed.deprecated).to.equal(true);
    expect(parsed.self?.content).to.equal('Struct.AnotherConstructor');
    expect(parsed.description).to.equal('This is a multiline\ndescription.');
    expect(parsed.params).to.have.lengthOf(5);
    expect(parsed.params![0].name?.content).to.equal('first');
    expect(parsed.params![0].type?.content).to.equal('String');
    expect(parsed.params![0].description).to.equal(
      'This is the first parameter',
    );
    expect(parsed.params![1].name?.content).to.equal('second');
    expect(parsed.params![1].type?.content).to.equal('Real');
    expect(parsed.params![1].description).to.equal(
      'This is the second parameter,\nwhich spans multiple lines.',
    );
    expect(parsed.params![2].name?.content).to.equal('third');
    expect(parsed.params![2].type?.content).to.equal('Struct');
    expect(parsed.params![2].optional).to.equal(true);
    expect(parsed.params![2].description).to.equal(
      'This parameter is optional',
    );
    expect(parsed.params![3].name?.content).to.equal('fourth');
    expect(parsed.params![3].type?.content).to.equal('Struct');
    expect(parsed.params![3].optional).to.equal(true);
    expect(parsed.params![3].description).to.equal(
      'This is optional and has a default value',
    );
    expect(parsed.params![4].name?.content).to.equal('...');
    expect(parsed.params![4].type?.content).to.equal('Bool');
    expect(parsed.params![4].optional).to.equal(true);
    expect(parsed.params![4].description).to.equal(
      'And so is this one, but there can be as many as you want!',
    );
  });

  it('can parse a GML type tag', function () {
    const jsdoc = '/// @type {String} - This is a string';
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('type');
    expect(parsed.type?.content).to.equal('String');
    expect(parsed.description).to.equal('This is a string');
  });

  it('can parse a JS type tag', function () {
    const jsdoc = '@type {String} This is a string';
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('type');
    expect(parsed.type?.content).to.equal('String');
    expect(parsed.description).to.equal('This is a string');
  });

  it('can parse a self tag', function () {
    const jsdoc = '/// @self Struct.Hello';
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('self');
    expect(parsed.self?.content).to.equal('Struct.Hello');
  });

  it('can parse template tags', function () {
    const jsdoc = undent`
      /// @template T
      /// @template {String} U
      /// @param {T} first
      /// @returns {U}
    `;
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('function');
    expect(parsed.templates).to.have.lengthOf(2);
    expect(parsed.templates![0].name?.content).to.equal('T');
    expect(parsed.templates![0].type).to.be.undefined;
    expect(parsed.templates![1].name?.content).to.equal('U');
    expect(parsed.templates![1].type?.content).to.equal('String');
    expect(parsed.params).to.have.lengthOf(1);
    expect(parsed.params![0].name?.content).to.equal('first');
    expect(parsed.params![0].type?.content).to.equal('T');
    expect(parsed.returns?.type?.content).to.equal('U');
  });

  it('can parse utility types', function () {
    const jsdoc = undent`
      /// @template {Asset.GMObject} T
      /// @param {T} first
      /// @returns {InstanceType<T>}
    `;
    const parsed = parseJsdoc(jsdoc);
    expect(parsed.kind).to.equal('function');
    expect(parsed.templates).to.have.lengthOf(1);
    expect(parsed.templates![0].name?.content).to.equal('T');
    expect(parsed.templates![0].type?.content).to.equal('Asset.GMObject');
    expect(parsed.params).to.have.lengthOf(1);
    expect(parsed.params![0].name?.content).to.equal('first');
    expect(parsed.params![0].type?.content).to.equal('T');
    expect(parsed.returns?.type?.content).to.equal('InstanceType<T>');
  });

  it('can identify typstring ranges', function () {
    const jsdoc = '/// @type {X|Array<Struct.GlobalConstructor>|String}';
    const parsed = parseJsdoc(jsdoc);
    const ranges = parsed.typeRanges;
    expect(ranges.length).to.equal(4);

    for (const range of ranges) {
      const startOffset = jsdoc.indexOf(range.content);
      expect(range.start.offset).to.equal(startOffset);
      expect(range.end.offset).to.equal(startOffset + range.content.length - 1);
      expect(range.start.column).to.equal(startOffset + 1);
      expect(range.end.column).to.equal(startOffset + range.content.length);
      expect(range.start.line).to.equal(1);
      expect(range.end.line).to.equal(1);
    }
  });
});

describe('JSDoc type diagnostics', function () {
  for (const source of [
    '/** @param {Array<Real>} value */',
    '   @param {Array<Real>} value',
    '   * @param {Array<Real>} value',
    '   /// @param {Array<Real>} value',
  ]) {
    it(`parses inline and indented tags without shifting type ranges: ${source}`, function () {
      const parsed = parseJsdoc(source);
      expect(parsed.diagnostics).to.deep.equal([]);
      expect(parsed.kind).to.equal('function');
      expect(parsed.params).to.have.lengthOf(1);
      expect(parsed.params![0].name!.content).to.equal('value');
      expect(parsed.params![0].type!.content).to.equal('Array<Real>');
      expect(parsed.tags[0].start.offset).to.equal(source.indexOf('@param'));
      expect(parsed.typeRanges.map((range) => range.content)).to.deep.equal([
        'Array',
        'Real',
      ]);
      for (const range of parsed.typeRanges) {
        const offset = source.indexOf(range.content);
        expect(range.start.offset).to.equal(offset);
        expect(range.end.offset).to.equal(offset + range.content.length - 1);
        expect(range.start.column).to.equal(offset + 1);
        expect(source.slice(range.start.offset, range.end.offset + 1)).to.equal(
          range.content,
        );
      }
    });
  }

  it('retains template/generic types and exact ranges with repeated text', function () {
    const source = [
      '/// @template {Asset.GMObject} T',
      '/// @param {T} item',
      '/// @returns {Array<T>}',
    ].join('\r\n');
    const parsed = parseJsdoc(source, { line: 5, column: 3, offset: 100 });
    expect(parsed.diagnostics).to.deep.equal([]);
    expect(parsed.typeRanges.map((range) => range.content)).to.deep.equal([
      'Asset.GMObject',
      'T',
      'Array',
      'T',
    ]);
    for (const range of parsed.typeRanges) {
      const offset = range.start.offset - 100;
      expect(source.slice(offset, range.end.offset - 100 + 1)).to.equal(
        range.content,
      );
      const prefix = source.slice(0, offset).split('\r\n');
      expect(range.start.line).to.equal(5 + prefix.length - 1);
      expect(range.start.column).to.equal(
        prefix.at(-1)!.length + (prefix.length === 1 ? 3 : 1),
      );
    }
    const type = typeFromParsedJsdocs(parsed, new Map(), false)[0];
    expect(type.kind).to.equal('Function');
    expect(type.getParameter('item')!.type.type[0].isGeneric).to.equal(true);
    expect(type.getParameter('item')!.type.toFeatherString()).to.equal('T');
    expect(type.returns!.type[0].items!.type[0].isGeneric).to.equal(true);
    expect(type.returns!.toFeatherString()).to.equal('Array<T>');

    const repeated = '/// @type {type|Array<type>}';
    const doc = parseJsdoc(repeated);
    expect(doc.type!.start.offset).to.equal(repeated.indexOf('{') + 1);
    expect(doc.typeRanges.map((range) => range.start.offset)).to.deep.equal([
      repeated.indexOf('{') + 1,
      repeated.indexOf('Array'),
      repeated.lastIndexOf('type'),
    ]);
  });

  it('reports the offending closer at a nonzero document position and preserves later tags', function () {
    const source = [
      '/** @param {Real>String} broken',
      ' * @param {Array<Real>} later',
      ' * @returns {String}',
      ' */',
    ].join('\r\n');
    const parsed = parseJsdoc(source, { line: 8, column: 4, offset: 120 });
    expect(parsed.diagnostics).to.have.lengthOf(1);
    const diagnostic = parsed.diagnostics[0];
    const offset = source.indexOf('>');
    expect(diagnostic.message).to.equal("Unexpected closing bracket '>'");
    expect(diagnostic.start).to.deep.equal({
      line: 8,
      column: 4 + offset,
      offset: 120 + offset,
    });
    expect(diagnostic.end).to.deep.equal(diagnostic.start);
    expect(parsed.params!.map((param) => param.name!.content)).to.deep.equal([
      'broken',
      'later',
    ]);
    expect(parsed.params![1].type!.content).to.equal('Array<Real>');
    expect(parsed.returns!.type!.content).to.equal('String');
    expect(parsed.typeRanges.map((range) => range.content)).to.deep.equal([
      'Real',
      'String',
      'Array',
      'Real',
      'String',
    ]);
  });

  for (const source of [
    '/// @type {Array<Array<Real>|String}',
    '/// @type {Array[Real>}',
    '/// @type {Array<>}',
    '/// @type {Real|}',
    '/// @type {Real?String}',
    '/// @type {}',
    '/// @type {   }',
    '/// @type {Real',
    '/// @type {',
    '/// @type',
    '/// @param {Array<Real> unfinished',
  ]) {
    it(`reports incomplete annotations locally without consuming the next tag: ${source}`, function () {
      const parsed = parseJsdoc(`${source}\n/// @returns {Boolean}`);
      expect(parsed.diagnostics.length).to.be.greaterThan(0);
      for (const diagnostic of parsed.diagnostics) {
        expect(diagnostic.start.line).to.equal(1);
        expect(diagnostic.end.line).to.equal(1);
        expect(diagnostic.start.offset).to.be.at.least(0);
        expect(diagnostic.end.offset).to.be.at.least(diagnostic.start.offset);
        expect(diagnostic.end.offset).to.be.lessThan(source.length);
      }
      expect(parsed.returns!.type!.content).to.equal('Boolean');
      expect(parsed.typeRanges.at(-1)!.content).to.equal('Boolean');
      expect(
        parsed.typeRanges.some((range) => range.content === 'Any'),
      ).to.equal(false);
    });
  }

  it('keeps file analysis and JSDoc publication working across valid, malformed and corrected edits', async function () {
    // In-memory script through Code's real parsing/binding/evaluation/checking,
    // without native loading, disk writes or a background dirty-file worker.
    const published: Diagnostic[][] = [];
    const project = {
      self: new Type('Struct').named('global'),
      types: new Map<string, Type>(),
      options: {},
      queueDirtyFileUpdate() {},
      emitDiagnostics(_file: Code, diagnostics: Diagnostic[]) {
        published.push(diagnostics);
      },
    };
    const asset = {
      project,
      assetKind: 'scripts',
      name: 'jsdoc_recovery',
    } as unknown as Asset;
    const code = new Code(asset, pathy('jsdoc_recovery.gml'));
    const validSnapshots: unknown[] = [];
    for (const annotation of [
      'Real',
      'Real>String',
      'Array<Array<Real>',
      '',
      'Real',
    ]) {
      const source = [
        `/// @type {${annotation}}`,
        'var changed = 2;',
        '/// @param {String} value',
        '/// @returns {Real}',
        'function After(value) { var bodyValue = 3; return bodyValue; }',
        'var tail = After("ok");',
        'var unresolved = missing_symbol;',
      ].join('\n');
      await code.reload(source);
      const diagnostics = code.getDiagnostics();
      expect(diagnostics.SYNTAX_ERROR).to.deep.equal([]);
      const valid = annotation === 'Real';
      expect(diagnostics.JSDOC.length).to.equal(valid ? 0 : 1);
      if (!valid) {
        const diagnostic = diagnostics.JSDOC[0];
        expect(diagnostic.severity).to.equal('warning');
        expect(diagnostic.location.start.line).to.equal(1);
        expect(diagnostic.location.end.line).to.equal(1);
        const token =
          annotation === 'Real>String' ? '>' : annotation ? '<' : '}';
        expect(diagnostic.location.start.offset).to.equal(
          source.indexOf(token),
        );
        expect(diagnostic.location.end.offset).to.equal(source.indexOf(token));
        expect(published.at(-1)).to.include(diagnostic);
      }
      if (annotation === 'Real>String') {
        expect(diagnostics.JSDOC[0].location.start.offset).to.equal(
          source.indexOf('>'),
        );
        expect(diagnostics.JSDOC[0].location.end.offset).to.equal(
          source.indexOf('>'),
        );
        const changed = code.refs.find(
          (ref) => ref.isDef && ref.item.name === 'changed',
        )!;
        expect(changed.item.type.type.map((type) => type.kind)).to.have.members(
          ['Real', 'String'],
        );
      }
      const after = project.self.getMember('After')!.getTypeByKind('Function')!;
      expect(after.getParameter('value')!.type.toFeatherString()).to.equal(
        'String',
      );
      expect(after.returns!.toFeatherString()).to.equal('Real');
      const tail = code.refs.find(
        (ref) => ref.isDef && ref.item.name === 'tail',
      );
      expect(tail?.item.type.toFeatherString()).to.equal('Real');
      expect(
        code.refs.some((ref) => ref.item.name === 'bodyValue' && !ref.isDef),
      ).to.equal(true);
      expect(
        code.refs.some((ref) => ref.item.name === 'missing_symbol'),
      ).to.equal(true);
      const undeclared = [
        ...diagnostics.UNDECLARED_GLOBAL_REFERENCE,
        ...diagnostics.UNDECLARED_VARIABLE_REFERENCE,
      ].filter((diagnostic) => diagnostic.message.includes('missing_symbol'));
      expect(undeclared).to.have.lengthOf(1);
      expect(undeclared[0].location.start.offset).to.equal(
        source.indexOf('missing_symbol'),
      );
      expect(undeclared[0].location.end.offset).to.equal(
        source.indexOf('missing_symbol') + 'missing_symbol'.length - 1,
      );
      expect(published.at(-1)).to.include.members(undeclared);
      if (valid) {
        validSnapshots.push({
          refs: code.refs.map((ref) => ({
            name: ref.item.name,
            isDef: ref.isDef,
            offset: ref.start.offset,
            type: ref.item.type.toFeatherString(),
          })),
          diagnostics: Object.fromEntries(
            Object.entries(diagnostics).map(([kind, items]) => [
              kind,
              items.map((diagnostic) => ({
                message: diagnostic.message,
                start: diagnostic.location.start.offset,
                end: diagnostic.location.end.offset,
              })),
            ]),
          ),
        });
      }
    }
    expect(validSnapshots).to.have.lengthOf(2);
    expect(validSnapshots[1]).to.deep.equal(validSnapshots[0]);
  });
});
