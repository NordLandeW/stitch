import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Code } from './project.code.js';
import { Project } from './project.js';
import { Range, type IRange } from './project.location.js';
import { logger, setLogger, type Logger } from './logger.js';
import { GmlSignifierVisitor } from './visitor.js';
import { GmlGlobalDeclarationsVisitor } from './visitor.globals.js';
import { parseJsdoc } from './jsdoc.js';
import {
  flattenFeatherTypes,
  parseFeatherTypeString,
} from './jsdoc.feather.js';

// Real project queues, symbol visitors and bundled native specification. Only
// the unsaved GML buffers are in memory; expected names and positions come from
// authored source, never from the implementation's candidate/reference lists.
describe('diagnostic and recovery safety', function () {
  this.timeout(30000);
  let project: Project;
  let code: Code;
  let neighbor: Code;
  let root: string;
  let serial = 0;
  let errors: unknown[][] = [];
  let expectedErrors = 0;
  let previousLogger: Logger;
  before(async () => {
    previousLogger = {
      info: logger.info,
      log: logger.log,
      debug: logger.debug,
      warn: logger.warn,
      error: logger.error,
      dir: logger.dir,
    };
    setLogger({
      ...previousLogger,
      debug: () => {},
      info: () => {},
      log: () => {},
      error: (...args) => errors.push(args),
    });
    root = await mkdtemp(path.join(tmpdir(), 'stitch-recovery-'));
    await cp('samples/project', root, { recursive: true });
    await writeFile(
      path.join(root, 'stitch.config.json'),
      JSON.stringify({ runtimeVersion: '0.0.0.0' }),
    );
    project = await Project.initialize(root, { configuration: 'Default' });
  });
  after(async () => {
    setLogger(previousLogger);
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    errors = [];
    expectedErrors = 0;
    const asset = project.getAssetByName('Script1')!;
    code = new Code(asset, project.dir.join(`recovery-${serial}.gml`));
    neighbor = new Code(
      asset,
      project.dir.join(`recovery-neighbor-${serial++}.gml`),
    );
    await code.reload('');
    await neighbor.reload('');
  });
  afterEach(() => {
    code.retire();
    neighbor.retire();
    project.macros.flush();
    assert.equal(
      errors.length,
      expectedErrors,
      errors.map((args) => args.map(String).join(' ')).join('\n'),
    );
  });

  const diagnostics = (file = code) =>
    Object.values(file.getDiagnostics()).flat();
  function reference(name: string, source = code.content, file = code) {
    const at = source.indexOf(name);
    assert(at >= 0);
    const ref = file.getReferenceAt(at);
    assert(ref, `Missing ${name} at authored offset ${at}`);
    assert.equal(ref.item.name, name);
    assert.equal(ref.source.start.offset, at);
    assert.equal(ref.source.end.offset, at + name.length - 1);
    return ref;
  }
  function finiteRanges(file = code) {
    const ranges: IRange[] = [
      ...file.refs,
      ...file.scopes,
      ...file.functionArgRanges,
      ...file.structNewMemberRanges,
      ...diagnostics(file).map((d) => d.location),
    ];
    for (const ref of file.refs) {
      if (ref.item.def?.file) ranges.push(ref.item.def);
      if (ref.item.declaration) ranges.push(ref.item.declaration);
      assert(
        ref.item.name,
        'No inserted empty identifier may become a reference',
      );
    }
    for (const range of ranges) {
      const tag = range instanceof Range ? range.$tag : 'diagnostic';
      for (const value of range instanceof Range
        ? [range, range.source, range.invocation]
        : [range]) {
        assert(
          [
            value.start.offset,
            value.start.line,
            value.start.column,
            value.end.offset,
            value.end.line,
            value.end.column,
          ].every(Number.isFinite),
          `Non-finite ${tag}`,
        );
        assert(
          value.start.offset >= 0 && value.end.offset >= value.start.offset,
          `Reversed ${tag}`,
        );
      }
      const physical = range instanceof Range ? range.source : range;
      const owner = physical instanceof Range ? physical.file : file;
      assert(
        physical.end.offset <= owner.content.length,
        `Out-of-document ${tag}`,
      );
      for (const point of [physical.start, physical.end]) {
        assert(point.line >= 1 && point.column >= 1);
      }
    }
    for (const doc of file.jsdocs) {
      for (const range of [
        doc,
        ...doc.tags,
        ...doc.typeRanges,
        ...doc.diagnostics,
      ]) {
        assert(
          [
            range.start.offset,
            range.start.line,
            range.start.column,
            range.end.offset,
            range.end.line,
            range.end.column,
          ].every(Number.isFinite),
        );
        assert(
          range.start.offset >= 0 && range.end.offset >= range.start.offset,
        );
      }
    }
  }
  const tail =
    ' function RecoveryAfter(){return 2;} var recovered=RecoveryAfter();';
  function healthyTail() {
    const definition = reference('RecoveryAfter');
    assert.equal(definition.item.def?.file, code);
    assert.equal(project.self.getMember('RecoveryAfter'), definition.item);
    assert.equal(reference('recovered').item.type.kind, 'Real');
    const callAt = code.content.lastIndexOf('RecoveryAfter');
    assert.equal(code.getReferenceAt(callAt)?.item, definition.item);
    assert.equal(
      code.refs.filter((ref) => ref.item === definition.item).length,
      2,
    );
    finiteRanges();
  }

  it('publishes ordinary lexer errors at original UTF-16 positions and retracts them after repair', async () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const text = `var note="😀";${eol}§ var after=2;`;
      await code.reload(text);
      const error = diagnostics().find((d) =>
        d.message.includes('unexpected character'),
      );
      assert(
        error,
        'A lexer failure must reach diagnostics without a source map',
      );
      assert.equal(error.location.start.offset, text.indexOf('§'));
      assert.equal(error.location.start.line, 2);
      assert.equal(error.location.start.column, 1);
      assert.equal(reference('after').item.type.kind, 'Real');
      finiteRanges();
      await code.reload(text.replace('§', ''));
      assert(
        !diagnostics().some((d) => d.message.includes('unexpected character')),
      );
      assert.equal(reference('after').item.type.kind, 'Real');
    }
    const text = 'var note = "😀"; § var after = 2;';
    await code.reload(text);
    assert.equal(
      diagnostics().find((d) => d.message.includes('unexpected character'))!
        .location.start.offset,
      17,
    );
    assert.equal(reference('after').source.start.offset, 23);
  });

  it('reports invalid quote/newline lexing while preserving valid escaped and verbatim strings', async () => {
    for (const expression of [
      '"first\nsecond"',
      '$"first\nsecond"',
      "'text'",
    ]) {
      await code.reload(`var text=${expression}; var after=2;`);
      assert(
        diagnostics().some((d) => /unexpected character/i.test(d.message)),
        expression,
      );
      assert.equal(reference('after').item.type.kind, 'Real');
      finiteRanges();
    }
    for (const expression of [
      '"first\\nsecond"',
      '@"first\nsecond"',
      "@'first\nsecond'",
    ]) {
      await code.reload(`var text=${expression}; var after=2;`);
      assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0, expression);
      assert.equal(reference('after').item.type.kind, 'Real');
      finiteRanges();
    }
  });

  for (const bad of [
    '}',
    'else',
    '} else }',
    'var broken=;',
    'var broken=true? :2;',
    'var broken={ and:1 };',
    'begin member:1 end;',
    '{member:1}.member=2;',
    'enum BrokenEnum{A=1<<2}',
  ]) {
    it(`preserves the independent root tail after ${JSON.stringify(bad)}`, async () => {
      await code.reload(`var good=1; ${bad}${tail}`);
      assert(code.getDiagnostics().SYNTAX_ERROR.length);
      assert.equal(reference('good').item.type.kind, 'Real');
      healthyTail();
      await code.reload(`var good=1;${tail}`);
      assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
      healthyTail();
    });
  }

  it('handles many interleaved root errors iteratively without losing or duplicating the tail', async () => {
    const text =
      Array.from(
        { length: 4096 },
        (_, index) => `} var recovery_${index}=1;`,
      ).join('\n') + tail;
    await code.reload(text);
    healthyTail();
    assert.equal(reference('recovery_4095').item.type.kind, 'Real');
    assert.equal(
      code.refs.filter((ref) => /^recovery_\d+$/.test(ref.item.name)).length,
      4096,
    );
    assert.equal(
      code
        .getDiagnostics()
        .SYNTAX_ERROR.filter((d) => /between statements/.test(d.message))
        .length,
      4096,
    );
    await code.reload(tail);
    healthyTail();
    assert(!code.refs.some((ref) => /^recovery_\d+$/.test(ref.item.name)));
  });

  it('keeps delimiters inside strings/comments and complete function bodies out of root recovery', async () => {
    await code.reload(
      'var text="} function Fake(){}"; // } else\n/* } function OtherFake(){} */\nfunction RecoveryBefore(){var local=1; return local;}' +
        tail,
    );
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    assert(!project.self.getMember('Fake')?.def?.file);
    assert(!project.self.getMember('OtherFake')?.def?.file);
    healthyTail();
  });

  it('safely processes truncated CST nodes and withdraws their old symbols on the same Code', async () => {
    for (const text of [
      'with(',
      'var partial={',
      'show_debug_message(',
      'try{}catch(',
      'enum PartialEnum{',
      'function PartialFunction(){var local=1;',
      'function PartialFunction(,value){}',
    ]) {
      await code.reload(text);
      assert(code.getDiagnostics().SYNTAX_ERROR.length, text);
      assert(
        !diagnostics().some((d) =>
          /Internal .* analysis failed/.test(d.message),
        ),
        text,
      );
      finiteRanges();
      await code.reload(tail);
      healthyTail();
      assert(!project.self.getMember('PartialEnum')?.def?.file);
      assert(!project.self.getMember('PartialFunction')?.def?.file);
    }
  });

  it('restores local/self contexts after malformed delimited functions, with bodies and catch clauses', async () => {
    for (const text of [
      'function RecoveryBroken(){var private_local=;}',
      'with({member:1}){var private_local=;}',
      'try{}catch(){}',
      'try{}catch(problem){var private_local=;}',
    ]) {
      await code.reload(text + tail);
      healthyTail();
      assert(!project.self.getMember('private_local')?.def?.file);
      assert(!project.self.getMember('problem')?.def?.file);
      const scope = code.getScopeRangeAt(
        code.content.indexOf('var recovered'),
      )!;
      assert.equal(scope.self, project.self);
      assert(!scope.local.getMember('problem'));
    }
  });

  it('keeps nested recovery follow sets separate from root continuation', async () => {
    for (const bad of ['else', '%', 'var missing=; else']) {
      await code.reload(
        `function RecoveryOuter(){${bad} var hidden=1;} var after=2;`,
      );
      assert(
        !code
          .getInScopeSymbolsAt(code.content.indexOf('var after'))
          .some((symbol) => symbol.name === 'hidden'),
      );
      finiteRanges();
    }
  });

  it('retains earlier root diagnostics when the tail is also incomplete', async () => {
    await code.reload('} else }\nvar value={member:1}; value.');
    assert.equal(
      code
        .getDiagnostics()
        .SYNTAX_ERROR.filter((d) => /between statements/.test(d.message))
        .length,
      3,
    );
    finiteRanges();
  });

  it('keeps empty, whitespace and comment scopes finite through the real end of the buffer', async () => {
    for (const text of [
      '',
      ' \r\n\t',
      '// comment',
      '/* comment */\r',
      '#macro ONLY_MACRO 1',
    ]) {
      await code.reload(text);
      finiteRanges();
      assert.equal(code.scopes.at(-1)!.end.offset, text.length);
      assert(code.getScopeRangeAt(text.length));
    }
  });

  it('anchors an inserted call closer before the next statement and preserves incomplete-call signature ranges', async () => {
    const text = 'show_debug_message(1; var after=2;';
    await code.reload(text);
    finiteRanges();
    assert.equal(reference('after').item.type.kind, 'Real');
    assert(code.functionArgRanges.length);
    assert(
      code.functionArgRanges.every(
        (range) => range.end.offset <= text.indexOf(';'),
      ),
    );
    await code.reload('show_debug_message(');
    finiteRanges();
    assert(
      code.functionArgRanges.some(
        (range) =>
          range.start.offset <= code.content.length &&
          range.end.offset === code.content.length,
      ),
    );
    await code.reload('show_debug_message(1); var after=2;');
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    finiteRanges();
  });

  it('retains nested incomplete call and struct boundaries without losing the next statement', async () => {
    for (const depth of [1, 8, 32]) {
      for (const kind of ['call', 'struct']) {
        const text =
          'function RecoveryNested(value){return value;}\nvar nested=' +
          (kind === 'call' ? 'RecoveryNested(' : '{value:').repeat(depth) +
          '1;' +
          tail;
        await code.reload(text);
        healthyTail();
        assert(code.getDiagnostics().SYNTAX_ERROR.length);
        const boundary = text.indexOf(';', text.indexOf('var nested='));
        const ranges =
          kind === 'call'
            ? code.functionArgRanges.filter(
                (range) =>
                  range.type ===
                  reference('RecoveryNested').item.getTypeByKind('Function'),
              )
            : code.structNewMemberRanges;
        assert(ranges.length >= depth);
        assert(ranges.every((range) => range.end.offset <= boundary));
      }
    }
    await code.reload(tail);
    healthyTail();
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
  });

  it('retains physical ranges and a healthy tail across long/short macro expansions and repair', async () => {
    await neighbor.reload(
      '#macro RECOVERY_EXPR ' +
        Array(80).fill('1').join('+') +
        '\n#macro RECOVERY_CLOSE )',
    );
    for (const expression of ['RECOVERY_EXPR', '1']) {
      await code.reload(
        `var note="😀"; var value=${expression}; show_debug_message(1;` + tail,
      );
      healthyTail();
      assert.equal(reference('value').item.type.kind, 'Real');
      const calledType =
        reference('show_debug_message').item.getTypeByKind('Function');
      const argumentsForCall = code.functionArgRanges.filter(
        (range) => range.type === calledType,
      );
      assert(argumentsForCall.length);
      assert(
        argumentsForCall.every(
          (range) =>
            range.source.end.offset <=
            code.content.indexOf(
              ';',
              code.content.indexOf('show_debug_message'),
            ),
        ),
      );
    }
    await code.reload('show_debug_message(1 RECOVERY_CLOSE;' + tail);
    assert.equal(
      code.getDiagnostics().SYNTAX_ERROR.length,
      0,
      'A valid closing-delimiter macro fragment must not inherit isolated lexer mode errors',
    );
    healthyTail();
    finiteRanges(neighbor);
  });

  it('contains malformed annotations locally and retracts old globals/diagnostics without disturbing a neighbor', async () => {
    await neighbor.reload('function RecoveryNeighbor(){return "kept";}');
    const originalNeighbor = reference(
      'RecoveryNeighbor',
      neighbor.content,
      neighbor,
    ).item;
    await code.reload('function RecoveryOld(){return 1;}');
    const bad = '/// @type {Real>String}\nvar annotated=1;' + tail;
    for (const text of [
      bad,
      bad,
      bad.replace('Real>String', 'Real|String'),
      bad,
    ]) {
      await code.reload(text);
      healthyTail();
      assert(reference('annotated'));
      assert(!project.self.getMember('RecoveryOld')?.def?.file);
      assert.equal(
        project.self.getMember('RecoveryNeighbor'),
        originalNeighbor,
      );
      assert.equal(
        code
          .getDiagnostics()
          .JSDOC.filter((d) => /Unexpected closing bracket/.test(d.message))
          .length,
        text === bad ? 1 : 0,
      );
    }
    await code.reload(tail);
    healthyTail();
    assert.equal(code.getDiagnostics().JSDOC.length, 0);
    assert(project.native);
  });

  it('preserves valid sibling parameters and the next annotation after a malformed type', async () => {
    const text =
      '/// @param {Real>String} bad\n/// @param {String} good\nfunction RecoveryDoc(bad,good){return good;}\n/// @type {Real}\nvar annotated_next=2;\nvar result=RecoveryDoc(1,"text");';
    await code.reload(text);
    finiteRanges();
    assert(code.getDiagnostics().JSDOC.length);
    assert.equal(reference('annotated_next').item.type.kind, 'Real');
    assert.equal(reference('result').item.type.kind, 'String');
    const fn = reference('RecoveryDoc').item.getTypeByKind('Function')!;
    assert.equal(fn.getParameter(1)?.type.kind, 'String');
  });

  it('accepts underscore type identifiers without aborting local or global analysis', async () => {
    for (const header of [
      '/// @type {_RecoveryUnknown}\nvar annotated=1;',
      '/// @globalvar {_RecoveryUnknown} RecoveryDocumentedGlobal',
      '/// @type {OrdinaryUnknown}\nvar annotated=1;',
    ]) {
      await code.reload(header + '\n' + tail);
      healthyTail();
      assert.equal(code.getDiagnostics().JSDOC.length, 0);
      assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    }
  });

  it('keeps underscore generic parameter and return types available to consumers', async () => {
    await code.reload(
      '/// @template _T\n/// @param {_T} value\n/// @returns {_T}\nfunction RecoveryGeneric(value){return value;}' +
        tail,
    );
    healthyTail();
    const fn = reference('RecoveryGeneric').item.getTypeByKind('Function')!;
    assert.equal(fn.getParameter(0)?.type.toFeatherString(), '_T');
    assert.equal(fn.returns?.type[0].toFeatherString(), '_T');
    assert.equal(code.getDiagnostics().JSDOC.length, 0);
  });

  it('keeps deep valid and incomplete annotations usable through type conversion and display', async () => {
    const complete = 'Array<'.repeat(8192) + 'Real' + '>'.repeat(8192);
    for (const type of [complete, complete.slice(0, -1)]) {
      await code.reload(
        `/// @type {${type}}\nvar deeply_typed=undefined;` + tail,
      );
      healthyTail();
      assert(
        reference('deeply_typed').item.type.toFeatherString() === complete,
        'Deep annotation display must retain every container and the Real leaf',
      );
      assert.equal(
        code.getDiagnostics().JSDOC.length,
        type === complete ? 0 : 1,
      );
    }
    await code.reload(tail);
    healthyTail();
  });

  it('retains wide annotation types and source ranges through complete Code analysis and repair', async () => {
    const space = ' '.repeat(10000);
    for (const annotation of [
      `@param {${space}Real${space}} value`,
      `@param {${space}Real${space}}`,
      `@param {${space}`,
      `@param {${'$'.repeat(10000)}Real} value`,
    ]) {
      const text =
        `/// ${annotation}\n/// @returns {String}\nfunction RecoveryWide(value){return "ok";}\n` +
        tail;
      await code.reload(text);
      healthyTail();
      const fn = reference('RecoveryWide').item.getTypeByKind('Function')!;
      assert.equal(
        code.getDiagnostics().JSDOC.length > 0,
        annotation !== `@param {${space}Real${space}} value`,
      );
      if (annotation.endsWith(' value'))
        assert.equal(fn.getParameter(0)?.type.kind, 'Real');
      for (const doc of code.jsdocs)
        for (const type of doc.typeRanges)
          assert.equal(
            text.slice(type.start.offset, type.end.offset + 1),
            type.content,
          );
    }
    await code.reload(tail);
    healthyTail();
    assert.equal(code.getDiagnostics().JSDOC.length, 0);
  });

  it('retains an unexpected global-analysis failure diagnostic through symbol analysis', async () => {
    const original = GmlGlobalDeclarationsVisitor.prototype.identifierAccessor;
    expectedErrors = 1;
    try {
      GmlGlobalDeclarationsVisitor.prototype.identifierAccessor = () => {
        throw new Error('Controlled unexpected global visitor failure');
      };
      await code.reload('var fault=abs(-1);');
    } finally {
      GmlGlobalDeclarationsVisitor.prototype.identifierAccessor = original;
    }
    assert(
      diagnostics().some((d) =>
        /Internal global analysis failed/.test(d.message),
      ),
    );
    finiteRanges();
    await code.reload(tail);
    healthyTail();
    assert(
      !diagnostics().some((d) => /Internal .* analysis failed/.test(d.message)),
    );
  });

  it('publishes an explicit partial-analysis diagnostic for an unexpected visitor fault', async () => {
    const original = GmlSignifierVisitor.prototype.primaryExpression;
    expectedErrors = 1;
    try {
      GmlSignifierVisitor.prototype.primaryExpression = () => {
        throw new Error('Controlled unexpected visitor failure');
      };
      await code.reload('var fault=1;');
    } finally {
      GmlSignifierVisitor.prototype.primaryExpression = original;
    }
    assert(
      diagnostics().some((d) =>
        /Internal symbol analysis failed/.test(d.message),
      ),
    );
    finiteRanges();
    await code.reload(tail);
    healthyTail();
    assert(
      !diagnostics().some((d) => /Internal .* analysis failed/.test(d.message)),
    );
  });
});

describe('JSDoc local recovery', () => {
  it('reports malformed groups at their authored positions while retaining later recognizable types', () => {
    for (const bad of [
      'Real>String',
      'Array<Real]',
      'Array<Real',
      'Real||String',
      'Real$String',
      '',
    ]) {
      const text = `/// @type {${bad}}`;
      const doc = parseJsdoc(text);
      assert(doc.diagnostics.length, bad);
      for (const diagnostic of doc.diagnostics) {
        assert(Number.isFinite(diagnostic.start.offset));
        assert(
          diagnostic.start.offset >= text.indexOf('{') &&
            diagnostic.end.offset < text.length,
        );
      }
      for (const type of doc.typeRanges)
        assert.equal(
          text.slice(type.start.offset, type.end.offset + 1),
          type.content,
        );
    }
  });
  it('keeps missing braces within one annotation line and locates type text after its tag', () => {
    const text =
      '/// @param {Array<Real> broken\n/// @param {String} good\n/// @returns {Real}';
    const doc = parseJsdoc(text);
    assert(doc.diagnostics.length);
    assert.equal(
      doc.params!.find((param) => param.name?.content === 'good')!.type
        ?.content,
      'String',
    );
    assert.equal(doc.returns?.type?.content, 'Real');
    const repeated = parseJsdoc('/// @type {type}');
    assert.equal(repeated.typeRanges[0].start.offset, 11);
  });
  it('recovers wide unfinished or invalid type annotations while retaining the following annotation', () => {
    for (const annotation of [
      '@param {' + ' '.repeat(10000),
      '@type {' + ' '.repeat(10000),
      '@type {' + '$'.repeat(10000) + 'Real}',
    ]) {
      const text = `/// ${annotation}\n/// @returns {String}`;
      const doc = parseJsdoc(text)!;
      assert.ok(doc.diagnostics.length > 0);
      assert.equal(doc.returns?.type?.content, 'String');
      assert.ok(
        doc.typeRanges.some(
          (type) =>
            type.content === 'String' &&
            type.start.offset === text.lastIndexOf('String'),
        ),
      );
      if (annotation.includes('Real'))
        assert.ok(doc.typeRanges.some((type) => type.content === 'Real'));
    }
  });

  it('retains supported Feather spellings and iteratively flattens deep incomplete groups', () => {
    for (const text of [
      'Array[Real|String]',
      '<Real|String>',
      '[Real|String]',
      'Array<Real OR String>',
    ]) {
      const diagnostics: { message: string; offset: number; length: number }[] =
        [];
      const parsed = parseFeatherTypeString(text, diagnostics);
      assert.equal(diagnostics.length, 0, text);
      assert(
        flattenFeatherTypes(parsed).some(
          (type) => type.name.content === 'String',
        ),
      );
    }
    const text = 'Array<'.repeat(8192) + 'Real';
    const diagnostics: { message: string; offset: number; length: number }[] =
      [];
    const parsed = parseFeatherTypeString(text, diagnostics);
    assert.equal(diagnostics.length, 8192);
    const flat = flattenFeatherTypes(parsed);
    assert.equal(flat.length, 8193);
    assert.equal(flat.at(-1)!.name.offset, text.length - 4);
  });
});
