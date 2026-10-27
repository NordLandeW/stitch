import { pathy } from '@bscotch/pathy';
import { expect } from 'chai';
import type { Asset } from './project.asset.js';
import { Code } from './project.code.js';
import { type IPosition, Position, Reference } from './project.location.js';
import { Signifier } from './signifiers.js';
import { Type } from './types.js';

class LookupCode extends Code {
  copiedReferenceSlots = 0;

  constructor() {
    // Position queries need a document owner, but no initialized semantic inputs
    // or filesystem access. These tests never start project analysis.
    super({ project: {} } as Asset, pathy('lookup.gml'));
  }

  override get refs() {
    const refs = super.refs;
    this.copiedReferenceSlots += refs.length;
    return refs;
  }
}

function at(offset: number, line = 1, column = offset + 1): IPosition {
  return { offset, line, column };
}

function addReference(file: Code, start: IPosition, end = start) {
  const ref = new Reference(
    new Signifier(new Type('Struct'), 'value'),
    Position.from(file, start),
    Position.from(file, end),
  );
  file.addRef(ref);
  return ref;
}

describe('Code position queries', function () {
  it('keeps inclusive reference boundaries and first-match ordering for every overload', function () {
    const file = new LookupCode();
    const later = addReference(file, at(20), at(23));
    const first = addReference(file, at(4), at(12));
    const tied = addReference(file, at(4), at(14));
    addReference(file, at(7), at(8));

    const cases: [number, Reference | undefined][] = [
      [3, undefined],
      [4, first],
      [7, first],
      [12, first],
      [13, tied],
      [14, tied],
      [15, undefined],
      [20, later],
      [23, later],
      [24, undefined],
    ];
    for (const [offset, expected] of cases) {
      expect(file.getReferenceAt(offset)).to.equal(expected);
      expect(file.getReferenceAt({ line: 1, column: offset + 1 })).to.equal(
        expected,
      );
      expect(file.getReferenceAt(1, offset + 1)).to.equal(expected);
    }
  });

  it('finds multiline references by offset and line position', function () {
    const file = new LookupCode();
    const ref = addReference(file, at(2, 1, 3), at(19, 3, 5));
    for (const position of [at(2, 1, 3), at(10, 2, 3), at(19, 3, 5)]) {
      expect(file.getReferenceAt(position.offset)).to.equal(ref);
      expect(file.getReferenceAt(position)).to.equal(ref);
      expect(file.getReferenceAt(position.line, position.column)).to.equal(ref);
    }
    for (const position of [at(1, 1, 2), at(20, 3, 6), at(22, 4, 1)]) {
      expect(file.getReferenceAt(position.offset)).to.equal(undefined);
      expect(file.getReferenceAt(position)).to.equal(undefined);
      expect(file.getReferenceAt(position.line, position.column)).to.equal(
        undefined,
      );
    }
  });

  it('observes references registered after an earlier query', function () {
    const file = new LookupCode();
    expect(file.getReferenceAt(4)).to.equal(undefined);
    const first = addReference(file, at(4), at(7));
    expect(file.getReferenceAt(4)).to.equal(first);
    const later = addReference(file, at(10), at(12));
    expect(file.getReferenceAt(12)).to.equal(later);
  });

  for (const count of [128, 1024]) {
    it(`bounds reference snapshot copying linearly for ${count} references`, function () {
      const file = new LookupCode();
      let last: Reference | undefined;
      for (let i = 0; i < count; i++) {
        last = addReference(file, at(i * 3), at(i * 3 + 1));
      }
      for (const [offset, expected] of [
        [(count - 1) * 3 + 1, last],
        [count * 3, undefined],
      ] as const) {
        file.copiedReferenceSlots = 0;
        expect(file.getReferenceAt(offset)).to.equal(expected);
        // Bound allocation work, allowing constant snapshots or direct access.
        expect(file.copiedReferenceSlots).to.be.at.most(count * 2);
      }
    });
  }
});
