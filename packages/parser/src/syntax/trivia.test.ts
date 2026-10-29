import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { CstNode } from 'chevrotain';
import { parser } from '../parser.js';
import { GmlLexer } from '../lexer.js';

// Comparing the code CST to an authored comment-free control detects a split
// initializer even when both the split and correct expressions infer Real.
function codeShape(current: CstNode): unknown {
  if (
    current.name === 'jsdoc' ||
    (current.name === 'statement' && current.children.jsdoc)
  )
    return;
  const children: Record<string, unknown[]> = {};
  for (const [key, entries] of Object.entries(current.children)) {
    const values = entries
      .map((child) => ('children' in child ? codeShape(child) : child.image))
      .filter((value) => value !== undefined);
    if (values.length) children[key] = values;
  }
  return { name: current.name, children };
}

const examples = [
  [
    'var value=1 +2; var after=2;',
    'var value=1 /** comment */ +2; var after=2;',
  ],
  [
    'var value=1 +2; var after=2;',
    'var value=1 + /** comment */ 2; var after=2;',
  ],
  [
    'var value=1 <2; var after=2;',
    'var value=1 /** comment */ <2; var after=2;',
  ],
  [
    'var value=1 +2; var after=2;',
    'var value=1 + /// 999 ignored\n2; var after=2;',
  ],
  [
    'function F(a=1,b=2){return a+b;}',
    'function F(/** comment */ a=1, /** comment */ b=2) /** comment */ {return a /** comment */ +b;}',
  ],
  ['var value=F(); var after=2;', 'var value=F(/** comment */); var after=2;'],
  [
    'var value=F(,2,); var after=2;',
    'var value=F(/** @type {String} */,/** comment */2,/** comment */); var after=2;',
  ],
  [
    'var value=F(1,2); var after=2;',
    'var value=F(/** first */ /** second */1,/** comment */2); var after=2;',
  ],
  [
    'var value={key:1};',
    'var value={/** first */ /** second */key:/** comment */1};',
  ],
  ['var value=[1,2];', 'var value=[/** comment */1,/** comment */2];'],
  ['var value=record.member;', 'var value=record./** comment */member;'],
  ['if(true) var value=1;', 'if(true) /** comment */ var value=1;'],
  ['while(true) var value=1;', 'while(true) /** comment */ var value=1;'],
  [
    'do var value=1; until true;',
    'do /** comment */ var value=1; /** comment */ until true;',
  ],
  ['try{}catch(error){}', 'try{} /** comment */ catch(/** comment */error){}'],
  [
    'switch(1){case 1:case 2:break;default:}',
    'switch(1){case 1:/** comment */case 2:break;/** comment */default:/** comment */}',
  ],
  ['var value=1\nvar after=2', 'var value=1\n/** comment */var after=2'],
  [
    'var value=1\n+2; var after=3;',
    'var value=1\n/** @type {String} */+2; var after=3;',
  ],
  ['var value=1+2;', 'var value=1/**/ + /** */ /***/2;'],
  ['', '/// @globalvar {Real} DocumentedOnly'],
  ['function F(){}', 'function F(){/** @localvar {String} localDoc */}'],
];

describe('comment trivia', () => {
  for (const [plain, commented] of examples) {
    it(`preserves code shape: ${commented.slice(0, 72)}`, () => {
      const control = parser.parse(plain);
      assert.equal(control.errors.length, 0, plain);
      const actual = parser.parse(commented);
      assert.equal(actual.lexed.errors.length, 0, commented);
      assert.equal(
        actual.errors.length,
        0,
        actual.errors.map((error) => error.message).join('\n'),
      );
      assert.deepEqual(codeShape(actual.cst), codeShape(control.cst));
    });
  }
  it('keeps comments before else transparent to the current control-flow grammar', () => {
    const control = parser.parse('if(true) var value=1; else var alternate=2;');
    const actual = parser.parse(
      'if(true) var value=1; /** comment */ else var alternate=2;',
    );
    assert.equal(control.errors.length, 0);
    assert.equal(actual.errors.length, 0);
    assert.deepEqual(codeShape(actual.cst), codeShape(control.cst));
  });
  it('retains the complete lexer result and the authored UTF-16 document tokens', () => {
    const source = 'var note="😀";\r\n/** @type {String} */ var value=1;';
    const lexed = GmlLexer.tokenize(source);
    const original = [...lexed.tokens];
    assert.strictEqual(parser.parse(source, lexed).lexed, lexed);
    assert.deepEqual(lexed.tokens, original);
    const doc = lexed.tokens.find(
      (token) => token.tokenType.name === 'JsdocJs',
    )!;
    assert(doc);
    assert.equal(source.slice(doc.startOffset, doc.endOffset! + 1), doc.image);
  });
  it('terminates normal block comments at the first close after ordinary backslashes', () => {
    for (const count of [0, 1, 2, 3, 16]) {
      const source = `var before=1; /* hidden ${'\\'.repeat(count)}*/ var after=2;`;
      const result = parser.parse(source);
      assert.equal(result.lexed.errors.length, 0);
      assert.equal(result.errors.length, 0);
      assert(result.lexed.tokens.some((token) => token.image === 'after'));
      assert(!result.lexed.tokens.some((token) => token.image === 'hidden'));
    }
    const unclosed = parser.parse('var before=1; /* unfinished var hidden=2;');
    assert(!unclosed.lexed.tokens.some((token) => token.image === 'hidden'));
  });
  it('consumes region comment text through LF/CRLF and EOF without leaking punctuation', () => {
    for (const newline of ['\n', '\r\n']) {
      for (const title of ['', 'done!!!', '[]{}()/\\"#macro Fake 1 中文😀']) {
        const source = `#region ${title}${newline}var value=1;${newline}#endregion ${title}${newline}var after=2;`;
        const parsed = parser.parse(source);
        assert.equal(parsed.lexed.errors.length, 0, source);
        assert.equal(parsed.errors.length, 0, source);
        assert.deepEqual(
          codeShape(parsed.cst),
          codeShape(parser.parse('var value=1; var after=2;').cst),
        );
        const eof = parser.parse(`#endregion ${title}`);
        assert.equal(eof.lexed.tokens.length, 0);
        assert.equal(eof.errors.length, 0);
      }
    }
  });
  it('retains raw token and CST line-column coordinates after region directives', () => {
    for (const directive of [
      '#region title',
      '#endregion done',
      '#endregion done!!!',
    ]) {
      for (const newline of ['\n', '\r\n']) {
        const source = `${directive}${newline}/** @type {String} */${newline}var after=2;`;
        const parsed = parser.parse(source);
        assert.equal(parsed.errors.length, 0);
        assert.equal(parsed.lexed.errors.length, 0);
        const point = (offset: number) => {
          const lines = source.slice(0, offset).split(/\r\n|\r|\n/);
          return [lines.length, lines.at(-1)!.length + 1];
        };
        const nodes = [parsed.cst];
        for (let i = 0; i < nodes.length; i++)
          for (const entries of Object.values(nodes[i].children))
            for (const child of entries)
              if ('children' in child) nodes.push(child);
        for (const position of [
          ...parsed.lexed.tokens,
          ...nodes.map((node) => node.location),
        ]) {
          assert(position);
          assert.deepEqual(
            [
              position.startLine,
              position.startColumn,
              position.endLine,
              position.endColumn,
            ],
            [...point(position.startOffset), ...point(position.endOffset!)],
            source,
          );
        }
      }
      const crOnly = parser.parse(`${directive}\rvar = ;\rvar after=2;`);
      assert.equal(crOnly.lexed.tokens.length, 0);
      assert.equal(crOnly.errors.length, 0);
    }
  });
  it('recovers interleaved root damage and docs using the filtered input coordinates', () => {
    const source = Array.from(
      { length: 64 },
      (_, i) => `} /** @type {Real} */ var recovered${i}=${i};`,
    ).join('\n');
    const parsed = parser.parse(source);
    assert.equal(parsed.errors.length, 64);
    const code = JSON.stringify(codeShape(parsed.cst));
    for (let i = 0; i < 64; i++)
      assert.equal(code.split(`"recovered${i}"`).length - 1, 1);
    const normal = parser.parse('var after=2;');
    assert.equal(normal.errors.length, 0);
    assert(!JSON.stringify(normal.cst).includes('recovered'));
  });
});
