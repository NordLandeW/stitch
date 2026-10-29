import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { CstNode } from 'chevrotain';
import { parser } from '../parser.js';

describe('postfix expression roots', () => {
  it('keeps literal indexing and calls within one complete initializer', () => {
    for (const value of [
      '[10,20][0]',
      '([10,20])[0]',
      '({member:1}).member',
      '{member:1}.member',
      '(function(arg){return arg*2;})(2)',
      'function(arg){return arg*2;}(2)',
    ]) {
      const result = parser.parse(`var result=${value};`);
      assert.equal(result.lexed.errors.length, 0, value);
      assert.equal(
        result.errors.length,
        0,
        result.errors.map((error) => error.message).join('\n'),
      );
      const statements = result.cst.children.statements[0] as CstNode;
      assert.equal(
        statements.children.statement.length,
        1,
        `${value} was split into separate statements`,
      );
    }
  });
  it('accepts grouped members, constructor values and calls in expression positions', () => {
    for (const source of [
      'function Probe(){var record={member:1};(record).member=2;return (record).member;}',
      'function Record(value) constructor{member=value;}var result=new (Record)(2);',
      'var result=new (function(value) constructor{member=value;})(2);',
      'var result=new function(value) constructor{member=value;}(2);',
      'var record=(begin member:1 end);var result=record.member;',
      'function Compute(value){return value*2;}function Probe(){(Compute)(2);return (Compute)(3);}',
      'function Probe(){var left={member:1},right={member:2};return (true?left:right).member;}',
    ]) {
      const parsed = parser.parse(source);
      assert.equal(parsed.lexed.errors.length, 0, source);
      assert.equal(
        parsed.errors.length,
        0,
        parsed.errors.map((error) => error.message).join('\n'),
      );
    }
  });
  it('treats individual block-keyword properties as names across comments and template boundaries', () => {
    for (const name of ['begin', 'end'])
      for (const separator of ['', ' ', '/** comment */ ', '// comment\r\n']) {
        const source = `function Probe(){var record={};record.${name}=1;return $"before {record.${separator}${name}} after";}function After(){return 2;}`;
        const parsed = parser.parse(source);
        assert.equal(parsed.lexed.errors.length, 0, source);
        assert.equal(
          parsed.errors.length,
          0,
          parsed.errors.map((error) => error.message).join('\n'),
        );
        for (const token of parsed.lexed.tokens)
          assert.equal(
            source.slice(token.startOffset, token.endOffset! + 1),
            token.image,
          );
      }
  });
  it('keeps empty and trailing-comma legacy structs separate from keyword keys', () => {
    for (const source of [
      'var record=begin end;',
      'var record=begin if:1, end;',
      'var record={begin:1,constructor:2};',
      'var record=begin begin /* key */ :1 end;',
    ]) {
      const parsed = parser.parse(source);
      assert.equal(parsed.lexed.errors.length, 0, source);
      assert.equal(parsed.errors.length, 0, source);
    }
  });
  it('requires parentheses for struct-root postfix statements while preserving bare blocks', () => {
    for (const [open, close] of [
      ['{', '}'],
      ['begin', 'end'],
    ]) {
      const literal = `${open} member:1 ${close}`;
      assert(
        parser.parse(`function Probe(){${literal}.member=2;}`).errors.length >
          0,
      );
      assert.equal(
        parser.parse(`function Probe(){(${literal}).member=2;}`).errors.length,
        0,
      );
      assert.equal(
        parser.parse(`function Probe(){${open} var member=1; ${close}}`).errors
          .length,
        0,
      );
    }
  });
  it('preserves complete statement consumers for overlapping expression prefixes', () => {
    for (const [source, consumer] of [
      ['value=1', 'variableAssignmentStatement'],
      ['value(2)', 'expressionStatement'],
      ['value.member=2', 'expressionStatement'],
      ['value++', 'expressionStatement'],
      ['++value', 'expressionStatement'],
      ['self.member=1', 'expressionStatement'],
      ['other.member=1', 'expressionStatement'],
      ['global.member=1', 'expressionStatement'],
      ['new Record()', 'expressionStatement'],
      ['(function(value){return value+1;})(2)', 'expressionStatement'],
      ['function Named(value){return value+1;}', 'functionStatement'],
      ['function Record() constructor{}', 'functionStatement'],
    ]) {
      const parsed = parser.parse(`${source};var after=2;`);
      assert.equal(parsed.errors.length, 0, source);
      const statements = (parsed.cst.children.statements[0] as CstNode).children
        .statement as CstNode[];
      assert.equal(statements.length, 2, source);
      assert(statements[0].children[consumer], source);
      assert(statements[1].children.localVarDeclarationsStatement, source);
    }
  });
});
