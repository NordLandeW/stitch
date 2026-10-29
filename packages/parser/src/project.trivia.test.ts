import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Code } from './project.code.js';
import { Project } from './project.js';
import { logger, setLogger, type Logger } from './logger.js';

// Real Project/Code/Native and both visitors; only the edited buffer is unsaved.
describe('comment annotation consumers', function () {
  this.timeout(30000);
  let root: string;
  let project: Project;
  let code: Code;
  let previous: Logger;
  let errors: unknown[][] = [];
  let serial = 0;
  before(async () => {
    previous = {
      info: logger.info,
      log: logger.log,
      debug: logger.debug,
      warn: logger.warn,
      error: logger.error,
      dir: logger.dir,
    };
    setLogger({
      ...previous,
      debug() {},
      info() {},
      log() {},
      error: (...args) => errors.push(args),
    });
    root = await mkdtemp(path.join(tmpdir(), 'stitch-trivia-'));
    await cp('samples/project', root, { recursive: true });
    await writeFile(
      path.join(root, 'stitch.config.json'),
      JSON.stringify({ runtimeVersion: '0.0.0.0' }),
    );
    project = await Project.initialize(root, { configuration: 'Default' });
  });
  after(async () => {
    setLogger(previous);
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    errors = [];
    code = new Code(
      project.getAssetByName('Script1')!,
      project.dir.join(`trivia-${serial++}.gml`),
    );
    await code.reload('');
  });
  afterEach(() => {
    code.retire();
    project.macros.flush();
    assert.equal(
      errors.length,
      0,
      errors.map((args) => args.map(String).join(' ')).join('\n'),
    );
  });
  function reference(fragment: string, name: string) {
    const at = code.content.indexOf(fragment) + fragment.indexOf(name);
    assert(code.content.includes(fragment));
    const ref = code.getReferenceAt(at);
    assert(ref, `${name} at authored offset ${at}`);
    assert.equal(ref.item.name, name);
    assert.equal(ref.source.start.offset, at);
    assert.equal(ref.source.end.offset, at + name.length - 1);
    return ref;
  }
  function ranges() {
    for (const ref of code.refs) {
      const source = ref.source;
      assert.equal(
        code.content.slice(source.start.offset, source.end.offset + 1),
        ref.item.name,
      );
      assert(
        [
          source.start.offset,
          source.end.offset,
          source.start.line,
          source.end.line,
          source.start.column,
          source.end.column,
        ].every(Number.isFinite),
      );
    }
    for (const doc of code.jsdocs)
      for (const type of doc.typeRanges)
        assert.equal(
          code.content.slice(type.start.offset, type.end.offset + 1),
          type.content,
        );
  }
  it('retains annotated types and descriptions through UTF-16 insert/delete/repair on the same Code', async () => {
    for (const newline of ['\n', '\r\n']) {
      for (const header of [
        '/** @type {String} Declared description */',
        '/// @type {String} Declared description',
        '',
      ]) {
        await code.reload(
          `var note="😀";${newline}${header}${newline}var typed=1; var after=typed;`,
        );
        assert.equal(
          reference('var typed', 'typed').item.type.kind,
          header ? 'String' : 'Real',
        );
        assert.equal(
          reference('var after', 'after').item.type.kind,
          header ? 'String' : 'Real',
        );
        assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
        assert.equal(code.jsdocs.length, header ? 1 : 0);
        if (header)
          assert.equal(
            code.jsdocs[0].description.trim(),
            'Declared description',
          );
        ranges();
      }
    }
  });
  it('preserves function docs while comments in formals, expressions and before the body remain trivia', async () => {
    await code.reload(
      '/// @param {String} value\n/// @returns {Real}\nfunction Documented(/** @type {Bool} */value) /** plain */ {return 1 /** @type {String} */+2;} var after=Documented("ok");',
    );
    const fn = reference(
      'function Documented',
      'Documented',
    ).item.getTypeByKind('Function')!;
    assert.equal(fn.getParameter(0)?.type.kind, 'String');
    assert.equal(fn.returns?.type[0].kind, 'Real');
    assert.equal(reference('var after', 'after').item.type.kind, 'Real');
    assert.equal(code.jsdocs.length, 1);
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    ranges();
  });
  it('does not leak inline, operator-adjacent or omitted-slot annotations to the next declaration', async () => {
    for (const source of [
      'var value=1 + /** @type {String} */ 2;',
      'var value=1\n/** @type {String} */ +2;',
      'var value=1 /** @type {String} */ <2;',
      'function F(first=1,second=2){return second;} var value=F(/** @type {String} */,2);',
      'function F(){return 1;} var value=F(/** @type {String} */);',
    ]) {
      await code.reload(`${source} var after=3;`);
      assert.equal(
        reference('var after', 'after').item.type.kind,
        'Real',
        source,
      );
      assert.equal(code.jsdocs.length, 0, source);
      assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0, source);
      ranges();
    }
  });
  it('preserves statement, member and callback annotation attachment', async () => {
    await code.reload(
      '/** @type {String} */ var rootValue=1\nif(true) /** @type {String} */ var bodyValue=1; var record={/** @type {Real} */ /** @type {String} */ member:1}; var after=record.member;',
    );
    assert.equal(
      reference('var rootValue', 'rootValue').item.type.kind,
      'String',
    );
    assert.equal(
      reference('var bodyValue', 'bodyValue').item.type.kind,
      'String',
    );
    assert.equal(reference('var after', 'after').item.type.kind, 'String');
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    ranges();
    await code.reload(
      'var callback=method(self, /** @param {String} input\n * @returns {Real} */ function(input){return 1;}); var after=2;',
    );
    const fn = code.jsdocs.find((doc) => doc.kind === 'function');
    assert.equal(fn?.params?.[0].type?.content, 'String');
    assert.equal(
      reference('function(input)', 'input').item.type.kind,
      'String',
    );
    assert.equal(reference('var after', 'after').item.type.kind, 'Real');
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    ranges();
  });
  it('retains doc-only and trailing global declarations and withdraws them on replacement', async () => {
    for (const prefix of ['', 'var value=1;\n']) {
      await code.reload(
        prefix + '/// @globalvar {Real} TriviaDeclaredGlobal A description',
      );
      assert.equal(
        project.self.getMember('TriviaDeclaredGlobal')?.type.kind,
        'Real',
      );
      assert.equal(
        project.self.getMember('TriviaDeclaredGlobal')?.def?.file,
        code,
      );
      assert.equal(code.jsdocs.length, 1);
      ranges();
      await code.reload('var after=2;');
      assert(!project.self.getMember('TriviaDeclaredGlobal')?.def);
      assert.equal(reference('var after', 'after').item.type.kind, 'Real');
      assert.equal(code.jsdocs.length, 0);
    }
  });
  it('keeps complete inner trailing docs at empty or unfinished block boundaries', async () => {
    for (const body of ['', 'var value=1;']) {
      for (const close of ['', '}']) {
        await code.reload(
          `function Scope(){${body}/** @localvar {String} documented */${close}`,
        );
        assert.equal(code.jsdocs.length, 1);
        assert.equal(
          reference('documented */', 'documented').item.type.kind,
          'String',
        );
        ranges();
      }
    }
    await code.reload(
      'function Scope(){var value=method(/** @type {String} */',
    );
    assert.equal(code.jsdocs.length, 0);
    assert(code.getDiagnostics().SYNTAX_ERROR.length);
  });
  it('keeps the code after backslash closes and region titles available across edits', async () => {
    for (const prefix of [
      '/* slash\\*/',
      '#region !!!\r\n#endregion done!!!\r\n',
      '',
      '/* slash\\\\*/',
    ]) {
      await code.reload(`${prefix}var after=2; var result=after;`);
      assert.equal(reference('var result', 'result').item.type.kind, 'Real');
      assert.equal(reference('var after', 'after').item.def?.file, code);
      assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
      ranges();
    }
  });
  it('retains root-boundary annotations around skipped tokens and doc-only tails', async () => {
    for (const source of [
      '} /// @globalvar {Real} TriviaRecoveredGlobal',
      '/// @globalvar {Real} TriviaRecoveredGlobal\n} var after=2;',
      'var before=1; /** @globalvar {Real} TriviaRecoveredGlobal */ }',
    ]) {
      await code.reload(source);
      assert(code.getDiagnostics().SYNTAX_ERROR.length);
      assert.equal(
        project.self.getMember('TriviaRecoveredGlobal')?.type.kind,
        'Real',
      );
      assert.equal(
        project.self.getMember('TriviaRecoveredGlobal')?.def?.file,
        code,
      );
      assert.equal(code.jsdocs.length, 1);
      ranges();
    }
    await code.reload('} /** @type {String} */ } var after=2;');
    assert.equal(reference('var after', 'after').item.type.kind, 'String');
    assert.equal(code.jsdocs.length, 1);
    ranges();
  });
  it('keeps independent trailing docs after a damaged but closed statement', async () => {
    for (const broken of ['var broken=;', 'function Scope(){var broken=;}']) {
      await code.reload(`${broken}\n/// @globalvar {Real} TriviaTailGlobal`);
      assert(code.getDiagnostics().SYNTAX_ERROR.length);
      assert.equal(
        project.self.getMember('TriviaTailGlobal')?.type.kind,
        'Real',
      );
      assert.equal(project.self.getMember('TriviaTailGlobal')?.def?.file, code);
      assert.equal(code.jsdocs.length, 1);
      ranges();
      await code.reload('');
    }
  });
  it('keeps line annotation grouping across blank lines and ordinary comments', async () => {
    await code.reload(
      '/// @param {String} value\n\n/* ordinary */\n/// @returns {Real}\nfunction Grouped(value){return 2;}',
    );
    const fn = reference('function Grouped', 'Grouped').item.getTypeByKind(
      'Function',
    )!;
    assert.equal(fn.getParameter(0)?.type.kind, 'String');
    assert.equal(fn.returns?.type[0].kind, 'Real');
    assert.equal(code.jsdocs.length, 1);
    ranges();
  });
  it('preserves macro comment masking and original-source bindings', async () => {
    await code.reload(
      '#macro DOCUMENTED_VALUE 1 /** @type {String} */ + 2\nvar value=DOCUMENTED_VALUE; var after=value;',
    );
    assert.equal(reference('var value', 'value').item.type.kind, 'Real');
    assert.equal(reference('var after', 'after').item.type.kind, 'Real');
    assert.equal(code.getDiagnostics().SYNTAX_ERROR.length, 0);
    assert.equal(code.jsdocs.length, 0);
  });
});
