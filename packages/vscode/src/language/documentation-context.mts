import type { Completion } from './protocol.mjs';

export interface DocumentationContext {
  kind: 'tag' | 'type' | 'none';
  /** Physical UTF-16 offsets; end is exclusive. */
  start: number;
  end: number;
  wrapType: boolean;
  hasClosingBrace: boolean;
  templates: string[];
  tagPrefix: string;
  tagHasBody: boolean;
}
interface DocComment {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  line: boolean;
}

/** Locate authored documentation, respecting GML strings, comments and template
 * interpolations. This is a lexical context scan, not a second type analyzer. */
function commentAt(text: string, offset: number): DocComment[] | undefined {
  type Frame =
    | { kind: 'code'; interpolation: boolean; depth: number }
    | { kind: 'string'; quote: string; escaped: boolean; template: boolean };
  const stack: Frame[] = [{ kind: 'code', interpolation: false, depth: 0 }];
  let previous: DocComment[] = [];
  for (let i = 0; i < text.length; ) {
    if (i > offset) return;
    const frame = stack.at(-1)!;
    const character = text[i];
    if (frame.kind === 'string') {
      if (frame.escaped && character === '\\') {
        i += 2;
        continue;
      }
      if (character === frame.quote) stack.pop();
      else if (frame.template && character === '{')
        stack.push({ kind: 'code', interpolation: true, depth: 0 });
      i++;
      continue;
    }
    if (text.startsWith('//', i) || text.startsWith('/*', i)) {
      const line = text[i + 1] === '/';
      const ending = line
        ? text.slice(i).search(/[\r\n]/)
        : text.indexOf('*/', i + 2);
      const contentEnd = ending < 0 ? text.length : line ? i + ending : ending;
      const end = line ? contentEnd : Math.min(text.length, contentEnd + 2);
      const documented = line
        ? text[i + 2] === '/'
        : text[i + 2] === '*' && text[i + 3] !== '/';
      const doc: DocComment = {
        start: i,
        end,
        contentStart: i + 3,
        contentEnd,
        line,
      };
      if (documented) {
        if (
          !line ||
          !previous.at(-1)?.line ||
          /\S/.test(text.slice(previous.at(-1)!.end, i))
        )
          previous = [];
        previous.push(doc);
        if (offset >= doc.contentStart && offset <= contentEnd) {
          if (line) {
            let next = contentEnd;
            while (next < text.length) {
              const whitespace = /^\s*/.exec(text.slice(next))![0];
              next += whitespace.length;
              if (!text.startsWith('///', next)) break;
              const length = text.slice(next).search(/[\r\n]/);
              const stop = length < 0 ? text.length : next + length;
              previous.push({
                start: next,
                end: stop,
                contentStart: next + 3,
                contentEnd: stop,
                line: true,
              });
              next = stop;
            }
          }
          return previous;
        }
      } else previous = [];
      i = end;
      continue;
    }
    if (
      character === '"' ||
      character === "'" ||
      ((character === '@' || character === '$') &&
        (text[i + 1] === '"' || text[i + 1] === "'"))
    ) {
      const prefixed = character === '@' || character === '$';
      stack.push({
        kind: 'string',
        quote: prefixed ? text[i + 1] : character,
        escaped: character !== '@',
        template: character === '$',
      });
      previous = [];
      i += prefixed ? 2 : 1;
      continue;
    }
    if (character === '{') frame.depth++;
    else if (character === '}') {
      if (frame.interpolation && frame.depth === 0) stack.pop();
      else frame.depth--;
    }
    if (/\S/.test(character)) previous = [];
    i++;
  }
  return;
}

const namedTags =
  /^(?:param(?:eter)?|arg(?:ument)?|template|localvar|var|globalvar|instancevar|prop(?:erty)?)$/;
const requiredTypes = /^(?:returns?|type)$/;
const selfTags = /^(?:self|context)$/;
const typeCharacter = /[A-Za-z0-9_.]/;

export function documentationContext(
  text: string,
  offset: number,
): DocumentationContext | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return;
  const comments = commentAt(text, offset);
  if (!comments) return;
  const comment = comments.find(
    (doc) => offset >= doc.contentStart && offset <= doc.contentEnd,
  )!;
  const lineStart = Math.max(
    comment.contentStart,
    text.lastIndexOf('\n', offset - 1) + 1,
    text.lastIndexOf('\r', offset - 1) + 1,
  );
  const newline = text.slice(lineStart, comment.contentEnd).search(/[\r\n]/);
  const lineEnd = newline < 0 ? comment.contentEnd : lineStart + newline;
  const rawLine = text.slice(lineStart, lineEnd);
  const margin = /^[ \t]*(?:\*[ \t]*)?/.exec(rawLine)![0].length;
  const start = lineStart + margin;
  const line = text.slice(start, lineEnd);
  const relative = offset - start;
  const context: DocumentationContext = {
    kind: 'none',
    start: offset,
    end: offset,
    wrapType: false,
    hasClosingBrace: false,
    templates: [],
    tagPrefix: '',
    tagHasBody: false,
  };
  if (relative < 0) return context;
  // Match the parser's grouping: variable-documentation tags start a new group.
  const lines = comments.flatMap((doc) => {
    const result: { text: string; start: number }[] = [];
    let position = doc.contentStart;
    for (const value of text
      .slice(doc.contentStart, doc.contentEnd)
      .split(/(\r\n|\r|\n)/)) {
      if (!/^[\r\n]+$/.test(value))
        result.push({
          text: value.replace(/^[ \t]*\*[ \t]?/, ''),
          start: position,
        });
      position += value.length;
    }
    return result;
  });
  let first = 0,
    last = lines.length;
  for (let index = 0; index < lines.length; index++) {
    if (
      !/^\s*@(localvar|var|globalvar|instancevar|prop(?:erty)?)\b/.test(
        lines[index].text,
      )
    )
      continue;
    if (lines[index].start <= offset) first = index;
    else {
      last = index;
      break;
    }
  }
  context.templates = [
    ...new Set(
      lines.slice(first, last).flatMap((line) => {
        const name =
          /^\s*@template(?:\s+\{[^}]*\})?\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(
            line.text,
          )?.[1];
        return name ? [name] : [];
      }),
    ),
  ];
  const tag = /^@([A-Za-z]*)/.exec(line);
  if (
    (!line.trim() && relative === line.length) ||
    (tag && relative <= tag[0].length)
  ) {
    context.kind = 'tag';
    context.start = tag ? start : offset;
    context.end = tag ? start + tag[0].length : offset;
    context.tagPrefix = !tag && offset === comment.contentStart ? ' ' : '';
    context.tagHasBody = !!tag && !!line.slice(tag[0].length).trim();
    return context;
  }
  if (!tag || relative <= tag[0].length) return context;
  const name = tag[1];
  if (
    !/^\s/.test(line.slice(tag[0].length)) &&
    !(requiredTypes.test(name) && line[tag[0].length] === '{')
  )
    return context;
  if (
    !namedTags.test(name) &&
    !requiredTypes.test(name) &&
    !selfTags.test(name)
  )
    return context;
  const payloadStart =
    start + tag[0].length + /^\s*/.exec(line.slice(tag[0].length))![0].length;
  const hasOpening = text[payloadStart] === '{';
  if (!hasOpening && namedTags.test(name)) return context;
  const typeStart = payloadStart + (hasOpening ? 1 : 0);
  const closing = text.indexOf('}', typeStart);
  const typeEnd =
    hasOpening && closing >= typeStart && closing <= lineEnd
      ? closing
      : lineEnd;
  if (offset < typeStart || offset > typeEnd) return context;
  let wordStart = offset,
    wordEnd = offset;
  while (wordStart > typeStart && typeCharacter.test(text[wordStart - 1]))
    wordStart--;
  while (wordEnd < typeEnd && typeCharacter.test(text[wordEnd])) wordEnd++;
  const before = text.slice(typeStart, wordStart).trimEnd();
  if (before && !/[<\[|,]$/.test(before) && !/\b(?:OR|or)$/.test(before))
    return context;
  // Bare types have no expression boundary: do not complete names/prose or
  // wrap only one token of an existing unbraced generic/union expression.
  if (
    !hasOpening &&
    (before ||
      /^[ \t]*(?:[<\[|,]|(?:OR|or)\b)/.test(text.slice(wordEnd, lineEnd)))
  )
    return context;
  context.kind = 'type';
  context.start = wordStart;
  context.end = wordEnd;
  context.wrapType = !hasOpening && requiredTypes.test(name);
  context.hasClosingBrace = /^\s*}/.test(text.slice(wordEnd, lineEnd));
  return context;
}

// Canonical spellings and insertion shapes follow the existing JSDoc parser.
const tags: Record<string, string> = {
  returns: ' {${1:Any}} $0',
  param: ' {${1:Any}} ${2:name} $0',
  type: ' {${1:Any}} $0',
  self: ' ${1:Struct} $0',
  template: ' ${1:T} $0',
  localvar: ' {${1:Any}} ${2:name} $0',
  globalvar: ' {${1:Any}} ${2:name} $0',
  instancevar: ' {${1:Any}} ${2:name} $0',
  description: ' $0',
  function: ' $0',
  deprecated: ' $0',
  ignore: '',
  mixin: '',
  pure: '',
};

export function documentationCompletions(
  context: DocumentationContext,
  typeNames: readonly string[],
): Completion[] {
  if (context.kind === 'none') return [];
  if (context.kind === 'tag')
    return Object.entries(tags).map(([name, body]) => ({
      name: `@${name}`,
      kind: 'keyword',
      insertText: `${context.tagPrefix}@${name}${context.tagHasBody ? '' : body}`,
      snippet: !context.tagHasBody && !!body,
    }));
  return [...new Set([...typeNames, ...context.templates])].map((name) => ({
    name,
    kind: 'interface',
    ...(context.wrapType
      ? { insertText: `{${name}${context.hasClosingBrace ? '' : '}'}` }
      : {}),
  }));
}
