import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { CstNode } from 'chevrotain';
import { parser } from '../parser.js';

function withoutThen(node: CstNode): unknown {
  return {
    name: node.name,
    children: Object.fromEntries(
      Object.entries(node.children)
        .filter(([key]) => key !== 'Then')
        .map(([key, values]) => [
          key,
          values.map((child) =>
            'children' in child ? withoutThen(child) : child.image,
          ),
        ]),
    ),
  };
}

function child(node: CstNode, name: string, index = 0): CstNode {
  const result = node.children[name]?.[index];
  assert(result && 'children' in result, `${node.name}.${name}[${index}]`);
  return result;
}

describe('control statement syntax', () => {
  for (const source of [
    '{}; var after=1;',
    '{var value=1;} var after=value;',
    'function Scope(){{var value=1;{var nested=value;}}return nested;}',
    'if(true){{var value=1;}}else{{var alternate=2;}}',
    'while(false){{var value=1;}}',
    'repeat(2){{var value=1;}}',
    'do{{var value=1;}}until true;',
    'with(self){{var value=1;}}',
    'switch(1){case 1:{var value=1;}var tail=value;break;case 2:case 3:break;default:{var alternate=2;}}',
    'try{{var value=1;}}catch(error){{var caught=error;}}finally{{var finished=2;}}',
    'var record={member:1,nested:{value:2}};if(true){var after=record.nested.value;}',
  ]) {
    it(`accepts nested statements: ${source.slice(0, 70)}`, () => {
      const parsed = parser.parse(source);
      assert.equal(parsed.lexed.errors.length, 0, source);
      assert.equal(
        parsed.errors.length,
        0,
        parsed.errors.map((error) => error.message).join('\n'),
      );
    });
  }
  it('preserves dangling-else association when optional then keywords are present', () => {
    for (const plain of [
      'if(false) var value=1;else if(true) var alternate=2;else var fallback=3;',
      'if(true) if(false) var value=1;else if(true) var alternate=2;else var fallback=3;',
      'if(true){if(false) var value=1;}else if(true){var alternate=2;}else{var fallback=3;}',
    ]) {
      const explicit = plain
        .replaceAll(') ', ') then ')
        .replaceAll('){', ') then {');
      const control = parser.parse(plain);
      const actual = parser.parse(explicit);
      assert.equal(control.errors.length, 0, plain);
      assert.equal(actual.errors.length, 0, explicit);
      assert.deepEqual(withoutThen(actual.cst), withoutThen(control.cst));
    }
  });
  it('associates else with the nearest unbraced if and respects an explicit block', () => {
    for (const then of ['', ' then']) {
      const nested = parser.parse(`if(a)${then} if(b)${then} x=1;else x=2;`);
      const braced = parser.parse(`if(a)${then}{if(b)${then} x=1;}else x=2;`);
      assert.equal(nested.errors.length, 0);
      assert.equal(braced.errors.length, 0);
      const outer = child(
        child(child(nested.cst, 'statements'), 'statement'),
        'ifStatement',
      );
      const inner = child(
        child(child(outer, 'blockableStatement'), 'statement'),
        'ifStatement',
      );
      assert.equal(outer.children.elseStatement, undefined);
      assert.equal(inner.children.elseStatement?.length, 1);
      const blockOuter = child(
        child(child(braced.cst, 'statements'), 'statement'),
        'ifStatement',
      );
      const blockInner = child(
        child(
          child(child(blockOuter, 'blockableStatement'), 'blockStatement'),
          'statement',
        ),
        'ifStatement',
      );
      assert.equal(blockOuter.children.elseStatement?.length, 1);
      assert.equal(blockInner.children.elseStatement, undefined);
    }
  });
  it('retains nested standalone blocks instead of flattening recovered statements', () => {
    const parsed = parser.parse(
      '{var first=1;{var second=first;}} var tail=second;',
    );
    assert.equal(parsed.errors.length, 0);
    const statements = child(parsed.cst, 'statements');
    assert.equal(statements.children.statement.length, 2);
    const outer = child(child(statements, 'statement'), 'blockStatement');
    assert.equal(outer.children.statement.length, 2);
    const inner = child(child(outer, 'statement', 1), 'blockStatement');
    assert.equal(inner.children.statement.length, 1);
    assert(
      child(child(statements, 'statement', 1), 'localVarDeclarationsStatement'),
    );
  });
  it('accepts legacy and mixed delimiters in supported block and literal contexts', () => {
    for (const [open, close] of [
      ['{', '}'],
      ['begin', 'end'],
      ['begin', '}'],
      ['{', 'end'],
    ]) {
      for (const source of [
        `${open} ${open} var value=1; ${close} ${close} var after=2;`,
        `function Scope(){ if(true) then ${open} var value=1; ${close} else if(false) then ${open} value=2; ${close} return value; end`,
        `while(false) ${open} break; ${close} repeat(2) ${open} var value=1; ${close}`,
        `do ${open} var value=1; ${close} until true; with(self) ${open} var local=1; ${close}`,
        `switch(1) ${open} case 1: ${open} var value=1; ${close} value+=1; break; default: ${open} ${close} break; ${close}`,
        `try ${open} var value=1; ${close} catch(error) ${open} var caught=error; ${close} finally ${open} var finished=2; ${close}`,
        `var record=${open} member:1,nested:${open} value:2 ${close} ${close}; var after=record.nested.value;`,
        `enum Choice ${open} First=1,Second, ${close} var after=Choice.First;`,
      ]) {
        const parsed = parser.parse(source);
        assert.equal(parsed.lexed.errors.length, 0, source);
        assert.equal(
          parsed.errors.length,
          0,
          parsed.errors.map((error) => error.message).join('\n'),
        );
      }
    }
  });
  it('retains actual legacy delimiter tokens and template interpolation boundaries', () => {
    const source =
      'var note="😀 begin end";\r\nfunction Scope(){begin var beginning=$"{1} {2}"; var endless=begin member:1 end; end return endless; end';
    const parsed = parser.parse(source);
    assert.equal(parsed.lexed.errors.length, 0);
    assert.equal(parsed.errors.length, 0);
    const nodes = [parsed.cst];
    let legacyStarts = 0;
    let legacyEnds = 0;
    while (nodes.length) {
      const node = nodes.pop()!;
      for (const [key, entries] of Object.entries(node.children))
        for (const entry of entries) {
          if ('children' in entry) nodes.push(entry);
          else {
            assert.strictEqual(
              parsed.lexed.tokens.find((token) => token === entry),
              entry,
            );
            assert.equal(
              source.slice(entry.startOffset, entry.endOffset! + 1),
              entry.image,
            );
            if (entry.image === 'begin') {
              assert.equal(key, 'StartBrace');
              legacyStarts++;
            }
            if (entry.image === 'end') {
              assert.equal(key, 'EndBrace');
              legacyEnds++;
            }
          }
        }
    }
    assert.equal(legacyStarts, 2);
    assert.equal(legacyEnds, 3);
    // Interpolation itself still needs }, even though GML blocks accept end.
    assert(parser.parse('var text=$"{1 end";').errors.length > 0);
  });
  it('requires literal function and constructor opening braces while accepting end closers', () => {
    for (const suffix of ['', ' constructor']) {
      assert.equal(
        parser.parse(`function Scope()${suffix}{return 1; end`).errors.length,
        0,
      );
      assert(
        parser.parse(`function Scope()${suffix} begin return 1; end`).errors
          .length > 0,
      );
    }
    assert(parser.parse('begin member:1 end;').errors.length > 0);
  });
  it('keeps the for operation and body when trailing semicolons are present', () => {
    for (const tail of ['', ';', ';;', ';;;;']) {
      const source = `for(var index=0;index<3;index++${tail}) begin var value=index; end var after=2;`;
      const parsed = parser.parse(source);
      assert.equal(parsed.lexed.errors.length, 0);
      assert.equal(parsed.errors.length, 0, source);
      const statements = child(parsed.cst, 'statements');
      assert.equal(statements.children.statement.length, 2);
      const loop = child(child(statements, 'statement'), 'forStatement');
      assert.equal(loop.children.expression.length, 2);
      assert.equal(loop.children.localVarDeclarations.length, 1);
      const images = (node: CstNode) => JSON.stringify(withoutThen(node));
      assert(images(child(loop, 'expression', 0)).includes('"<"'));
      assert(images(child(loop, 'expression', 1)).includes('"++"'));
      assert(images(child(loop, 'blockableStatement')).includes('"value"'));
      assert.equal(loop.children.Semicolon.length, 2 + tail.length);
    }
    for (const source of [
      'for(;;);',
      'for(var index=0;index<3;) index++;',
      'for(var index=0;;index++;;) break;',
    ]) {
      assert.equal(parser.parse(source).errors.length, 0, source);
    }
    for (const source of ['for(;;;);', 'for(var index=0;index<3;;) index++;']) {
      assert(parser.parse(source).errors.length > 0, source);
    }
  });
});
