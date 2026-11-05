import type {
  Completion,
  CompletionPublication,
  Overlay,
  Query,
} from './protocol.mjs';

const identifier = /[A-Za-z0-9_]/;
// Crossing a grammar keyword is not an identifier-only edit. This conservative
// display guard does not parse or infer types on the host.
const syntaxWords = new Set(
  'begin end if then else while do for break continue with until repeat exit and or xor not return mod div switch case default var globalvar enum function try catch finally static new delete constructor'.split(
    ' ',
  ),
);
export function completionWord(text: string, offset: number) {
  offset = Math.max(0, Math.min(offset, text.length));
  let start = offset,
    end = offset;
  while (start > 0 && identifier.test(text[start - 1])) start--;
  while (end < text.length && identifier.test(text[end])) end++;
  return { start, end };
}
/** A caret is between characters; a typed member belongs to its identifier. */
export function completionAnchor(text: string, offset: number): number {
  const word = completionWord(text, offset);
  // Ordinary carets may be immediately after a keyword opener (e.g. begin).
  // Only a dot member needs to move inside the preceding identifier's scope.
  return /\.\s*$/.test(text.slice(0, word.start)) ? word.start : offset;
}

/** Reuse a committed scope only when the source anchor survives. This maps text,
 * not types: the worker remains the only language analyzer. Structural edits and
 * receiver replacements fall through to a current worker query. */
export function snapshotCompletion(
  publication: CompletionPublication,
  document: CompletionPublication['documents'][number],
  current: Overlay,
  query: Query<'completion'>,
  stale: boolean,
): Completion[] | undefined {
  if (
    current.generation !== document.generation ||
    (query.trigger && query.trigger !== '.')
  )
    return;
  const text = current.text,
    old = document.text;
  const word = completionWord(text, query.offset || 0);
  let offset = completionAnchor(text, query.offset || 0),
    receiver: string | undefined;
  if (text !== old) {
    const previous = completionWord(old, word.start);
    const currentWord = text.slice(word.start, word.end);
    const previousWord = old.slice(previous.start, previous.end);
    if (
      [currentWord, previousWord].some(
        (value) =>
          syntaxWords.has(value) || publication.macroNames.includes(value),
      )
    )
      return;
    if (
      previous.start === word.start &&
      text.slice(0, word.start) === old.slice(0, previous.start) &&
      text.slice(word.end) === old.slice(previous.end)
    ) {
      offset = previous.start;
    } else {
      // A new simple receiver accessor can use the analyzed binding at this
      // location. Calls/indexes/chains without a committed anchor wait instead.
      const match = /\b([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(
        text.slice(0, word.start),
      );
      if (!match) return;
      const start = word.start - match[0].length;
      const previous = completionWord(old, start);
      const spelling = old.slice(previous.start, previous.end);
      if (
        previous.start !== start ||
        (spelling && spelling !== match[1]) ||
        text.slice(0, start) !== old.slice(0, start) ||
        text.slice(word.end) !== old.slice(previous.end)
      )
        return;
      offset = start;
      receiver = match[1];
    }
  }
  // Regions are nonoverlapping physical UTF-16 intervals. The last one includes
  // EOF so a new identifier can reuse the enclosing scope at the end of a file.
  let lo = 0,
    hi = document.regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (document.regions[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  const region = document.regions[lo];
  if (!region || offset < region.start || region.group < 0) return;
  let group = publication.groups[region.group];
  if (receiver) {
    if (region.member) return;
    const base =
      group.receiverBase === undefined
        ? undefined
        : publication.groups[group.receiverBase].receivers;
    const id =
      group.receivers && Object.hasOwn(group.receivers, receiver)
        ? group.receivers[receiver]
        : base && Object.hasOwn(base, receiver)
          ? base[receiver]
          : undefined;
    if (id === undefined || id < 0) return;
    group = publication.groups[id];
  }
  // An empty list cannot carry the per-candidate updating marker and may close
  // the suggest session. Wait for current analysis rather than publish it as final.
  if (stale && !group.spans.length) return;
  const values: Completion[] = [];
  for (const span of group.spans)
    for (let id = span.start; id < span.start + span.count; id++)
      values.push(publication.candidates[id]);
  return stale
    ? values.map((value) => ({ ...value, fallback: 'snapshot' as const }))
    : values;
}
