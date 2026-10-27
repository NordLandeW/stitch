import { expect } from 'chai';
import { SourceMap, type SourceDocument, type SourceSpan } from './source.js';

const usage: SourceDocument = {
  uri: 'file:///source-map/usage.gml',
  text: 'a TOKEN z',
};
const invocation: SourceSpan = { uri: usage.uri, start: 2, end: 6 };

describe('SourceMap', function () {
  it('maps identity spans with inclusive physical offsets and editable spelling', function () {
    const document = {
      uri: 'file:///source-map/identity.gml',
      text: 'first\r\nlast',
    };
    const map = new SourceMap(document);
    for (const [start, end] of [
      [0, 0],
      [0, document.text.length - 1],
      [7, 10],
    ]) {
      const origin = map.origin(start, end);
      expect(origin.spelling).to.deep.equal({ uri: document.uri, start, end });
      expect(origin.editable).to.equal(true);
      expect(origin.expansion).to.equal(undefined);
      expect(
        document.text.slice(origin.spelling.start, origin.spelling.end + 1),
      ).to.equal(document.text.slice(start, end + 1));
    }
  });

  function segmentedMap() {
    return new SourceMap(usage, [
      {
        start: 0,
        end: 1,
        origin: {
          spelling: { uri: usage.uri, start: 0, end: 1 },
          editable: true,
        },
      },
      {
        start: 2,
        end: 4,
        origin: {
          spelling: {
            uri: 'file:///source-map/definitions.gml',
            start: 10,
            end: 12,
          },
          expansion: invocation,
          expansionStack: [invocation],
          macroName: 'TOKEN',
          editable: false,
        },
      },
      {
        start: 5,
        end: 6,
        origin: {
          spelling: { uri: usage.uri, start: 7, end: 8 },
          editable: true,
        },
      },
    ]);
  }

  it('maps segment interiors and both inclusive boundaries without losing expansion provenance', function () {
    const map = segmentedMap();
    const expanded = map.origin(3, 4);
    expect(expanded.spelling).to.deep.equal({
      uri: 'file:///source-map/definitions.gml',
      start: 11,
      end: 12,
    });
    expect(expanded.expansion).to.deep.equal(invocation);
    expect(expanded.expansionStack).to.deep.equal([invocation]);
    expect(expanded.macroName).to.equal('TOKEN');
    expect(expanded.editable).to.equal(false);
    expect(map.origin(1).spelling).to.deep.equal({
      uri: usage.uri,
      start: 1,
      end: 1,
    });
    expect(map.origin(2).spelling.start).to.equal(10);
    expect(map.origin(4).spelling.end).to.equal(12);
    expect(map.origin(5, 6)).to.deep.equal({
      spelling: { uri: usage.uri, start: 7, end: 8 },
      editable: true,
    });
  });

  it('makes composite ranges displayable but never directly editable', function () {
    const map = segmentedMap();
    const entire = map.origin(0, 6);
    expect(entire.editable).to.equal(false);
    expect(entire.expansion).to.deep.equal({
      uri: usage.uri,
      start: 0,
      end: 8,
    });
    const expansionAndSuffix = map.origin(2, 6);
    expect(expansionAndSuffix.editable).to.equal(false);
    expect(expansionAndSuffix.expansion).to.deep.equal({
      uri: usage.uri,
      start: 2,
      end: 8,
    });
  });

  it('does not invent a one-to-one edit for synthesized continuation whitespace', function () {
    const document = {
      uri: 'file:///source-map/continuation.gml',
      text: 'a\\\r\nb',
    };
    const spelling = { uri: document.uri, start: 1, end: 3 };
    const map = new SourceMap(document, [
      { start: 0, end: 0, origin: { spelling, editable: false } },
    ]);
    expect(map.origin(0).spelling).to.deep.equal(spelling);
    expect(map.origin(0).editable).to.equal(false);
  });

  it('recovers EOF and absent segments with bounded, noneditable source anchors', function () {
    const map = new SourceMap(usage);
    for (const offset of [
      usage.text.length,
      usage.text.length + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const origin = map.origin(offset);
      expect(origin.editable).to.equal(false);
      expect(origin.spelling).to.deep.equal({
        uri: usage.uri,
        start: usage.text.length - 1,
        end: usage.text.length - 1,
      });
    }
    const unmapped = new SourceMap(usage, []).origin(3);
    expect(unmapped.editable).to.equal(false);
    expect(unmapped.spelling).to.deep.equal({
      uri: usage.uri,
      start: 3,
      end: 3,
    });
    const extendsPastEof = map.origin(1, usage.text.length);
    expect(extendsPastEof.editable).to.equal(false);
    expect(extendsPastEof.spelling.start).to.be.at.least(0);
    expect(extendsPastEof.spelling.end).to.be.lessThan(usage.text.length);
  });

  it('never marks empty-document recovery as an author-written editable character', function () {
    const document = { uri: 'file:///source-map/empty.gml', text: '' };
    const map = new SourceMap(document);
    for (const offset of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const origin = map.origin(offset);
      expect(origin.spelling).to.deep.equal({
        uri: document.uri,
        start: 0,
        end: 0,
      });
      expect(origin.editable).to.equal(false);
    }
  });
});
