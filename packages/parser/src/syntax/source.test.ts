import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { collectMacros, MacroEnvironment } from './macros.js';
import { SourceLines, SourceMap } from './source.js';

const collect = (uri: string, text: string) => collectMacros({ uri, text });

describe('macro source mapping', () => {
  it('keeps identity boundaries, empty documents and EOF bidirectional', () => {
    for (const text of ['', 'a', '😀\r\nb']) {
      const map = new SourceMap({ uri: 'file', text });
      for (const offset of [0, Math.max(0, text.length - 1), text.length]) {
        assert.equal(map.origin(offset).spelling.start, offset);
        assert.deepEqual(map.generatedOffsets('file', offset), [offset]);
      }
      assert.equal(map.origin(text.length).editable, false);
    }
  });

  it('maps nested repeated spellings and invocation boundaries without mixing sources', () => {
    const defs = collect(
      'defs',
      '#macro A (local_value + \\\r\nlocal_value)\r\n#macro B A',
    );
    const use = collect(
      'use',
      'var text = "😀"; var first = B; var second = B; var tail = 7;',
    );
    const result = new MacroEnvironment([defs, use]).expand(use);
    const map = result.sourceMap!;
    const spelling = defs.document.text.indexOf('local_value');
    const generated = [...result.text.matchAll(/local_value/g)].map(
      (match) => match.index,
    );
    assert.equal(generated.length, 4);
    assert.deepEqual(
      map.generatedOffsets('defs', spelling).sort((a, b) => a - b),
      [generated[0], generated[2]],
    );
    for (const offset of generated) {
      const origin = map.origin(offset, offset + 10);
      assert.equal(origin.spelling.uri, 'defs');
      assert.equal(
        defs.document.text.slice(
          origin.spelling.start,
          origin.spelling.end + 1,
        ),
        'local_value',
      );
      assert.equal(
        use.document.text.slice(
          origin.expansion!.start,
          origin.expansion!.end + 1,
        ),
        'B',
      );
    }
    const synthetic = map.segments.find((segment) => !segment.origin.editable)!;
    assert(synthetic);
    assert.equal(map.origin(synthetic.start).editable, false);
    const composite = map.origin(generated[0], generated[1] + 10);
    assert.equal(composite.editable, false);
    assert.equal(composite.expansion!.uri, 'use');
    const tail = result.text.indexOf('tail');
    assert.equal(
      map.origin(tail).spelling.start,
      use.document.text.indexOf('tail'),
    );
    assert.equal(
      map.origin(result.text.length).spelling.start,
      use.document.text.length,
    );
    assert.deepEqual(map.generatedOffsets('use', use.document.text.length), [
      result.text.length,
    ]);
  });

  it('clamps columns to their physical line for LF, CRLF and CR', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const lines = new SourceLines(`😀a${newline}b`);
      assert.equal(lines.offset({ line: 1, column: 100 }), 3);
      assert.equal(lines.offset({ line: 2, column: 100 }), 4 + newline.length);
      assert.deepEqual(lines.position(3 + newline.length), {
        offset: 3 + newline.length,
        line: 2,
        column: 1,
      });
    }
  });
});
