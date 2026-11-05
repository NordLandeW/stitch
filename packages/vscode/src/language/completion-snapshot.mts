import {
  Range,
  type Code,
  type Project,
  type Signifier,
  type Type,
} from '@bscotch/gml-parser';
import { pathy } from '@bscotch/pathy';
import type { CompletionPublication, Overlay } from './protocol.mjs';
import { completionTypeNames, completionValue } from './query.mjs';

/** Publish values from the sole committed graph. Candidate strings are serialized
 * once per symbol and groups share indexes, never cloned live parser objects. */
export function completionPublication(
  project: Project,
  overlays: Iterable<Overlay>,
): CompletionPublication {
  const macroNames = project.macros.activeSymbols().map((item) => item.name!);
  const macroSet = new Set(macroNames);
  const publication: CompletionPublication = {
    candidates: [],
    macroNames,
    typeNames: completionTypeNames(project),
    groups: [],
    documents: [],
  };
  const open = [...overlays];
  if (!open.length) return publication;
  const symbols = new Map<Signifier, number>();
  const groups = new Map<string, number>();
  const members = new Map<Type, number>();
  const itemId = (symbol: Signifier) => {
    let id = symbols.get(symbol);
    if (id === undefined) {
      id = publication.candidates.length;
      symbols.set(symbol, id);
      publication.candidates.push(completionValue(symbol));
    }
    return id;
  };
  const groupId = (items: Signifier[], includeGlobals = false) => {
    const spans: { start: number; count: number }[] = [];
    for (const item of items) {
      if (!item.name) continue;
      const id = itemId(item),
        previous = spans.at(-1);
      if (previous && previous.start + previous.count === id) previous.count++;
      else spans.push({ start: id, count: 1 });
    }
    if (includeGlobals) {
      // Global IDs form one consecutive run. Remove only names shadowed by the
      // parser's macro/local/self prefix, without walking globals for every scope.
      const shadowed = items
        .flatMap((item) => {
          const id = globalIds.get(item.name!);
          return id === undefined ? [] : [id];
        })
        .sort((a, b) => a - b);
      let start = 0;
      for (const id of shadowed) {
        if (start < id) spans.push({ start, count: id - start });
        start = id + 1;
      }
      if (start < globalCount)
        spans.push({ start, count: globalCount - start });
    }
    const key = spans.map((span) => `${span.start}:${span.count}`).join(',');
    let id = groups.get(key);
    if (id === undefined) {
      id = publication.groups.length;
      groups.set(key, id);
      publication.groups.push({ spans });
    }
    return id;
  };
  const memberId = (type: Type) => {
    let id = members.get(type);
    if (id === undefined) {
      const items = type
        .listMembers()
        .filter((item) =>
          type === project.self
            ? !item.native &&
              !!item.def?.file &&
              !item.macro &&
              !item.getTypeByKind('Enum')
            : item.def || item.native,
        );
      id = groupId(items);
      members.set(type, id);
    }
    return id;
  };
  // Type member lists can include inherited names. Match the parser's first
  // defined/native binding before assigning the common consecutive ID range.
  const globalNames = new Set<string>();
  const globals = project.self.listMembers().filter((item) => {
    if (!item.name || globalNames.has(item.name) || !(item.def || item.native))
      return false;
    globalNames.add(item.name);
    return true;
  });
  const globalGroup = groupId(globals);
  const globalCount = publication.candidates.length;
  const globalIds = new Map(globals.map((item) => [item.name!, itemId(item)]));
  const receiverIds = new Map<Signifier, number>();
  const receiversFor = (
    items: Signifier[],
    inherited?: Record<string, number>,
  ) => {
    const receivers: Record<string, number> = Object.create(null);
    for (const item of items) {
      if (!item.name) continue;
      let id = receiverIds.get(item);
      if (id === undefined) {
        const types = item.type.type.filter(
          (type) =>
            type.kind === 'Struct' ||
            type.kind === 'Asset.GMObject' ||
            type.kind === 'Id.Instance' ||
            type.kind === 'Enum',
        );
        id = types.length === 1 ? memberId(types[0]) : -1;
        receiverIds.set(item, id);
      }
      // Non-dottable names only need an entry when masking a shared receiver.
      if (id >= 0 || (inherited && Object.hasOwn(inherited, item.name)))
        receivers[item.name] = id;
    }
    return receivers;
  };
  const globalReceivers = receiversFor(globals);
  publication.groups[globalGroup].receivers = globalReceivers;
  // Ordinary lookup depends on local/self owners, not each accessor-delimited
  // Scope range. Reuse the exact query values across equivalent regions.
  const scopeGroups = new Map<Type, Map<Type, number>>();
  const structGroups = new Map<Type, number>();
  const at = (
    file: Code,
    offset: number,
  ): { group: number; member: boolean } => {
    if (file.getJsdocAt(offset)) return { group: -1, member: false };
    const struct = file.getStructNewMemberRangeAt(offset)?.type;
    if (struct) {
      let group = structGroups.get(struct);
      if (group === undefined) {
        group = groupId(struct.listMembers());
        structGroups.set(struct, group);
      }
      return { group, member: true };
    }
    const scope = file.getScopeRangeAt(offset);
    // Multiple macro expansion scopes have no single safe source/binding anchor.
    if (!scope) return { group: -1, member: false };
    if (scope.isDotAccessor)
      return { group: memberId(scope.self), member: true };
    let bySelf = scopeGroups.get(scope.local);
    if (!bySelf) scopeGroups.set(scope.local, (bySelf = new Map()));
    let group = bySelf.get(scope.self);
    if (group === undefined) {
      const items = file.getInScopeSymbolsAt(offset, undefined, {
        includeGlobals: false,
      });
      const candidateGroup = groupId(items, true);
      const receivers = receiversFor(items, globalReceivers);
      if (!macroNames.includes('self')) receivers.self = memberId(scope.self);
      if (!macroNames.includes('global'))
        receivers.global = memberId(project.self);
      // A shared list may occur in distinct receiver scopes. Keep its binding
      // metadata local rather than letting another scope overwrite it.
      group = publication.groups.length;
      publication.groups.push({
        spans: publication.groups[candidateGroup].spans,
        receivers,
        receiverBase: globalGroup,
      });
      bySelf.set(scope.self, group);
    }
    return { group, member: scope.isDotAccessor };
  };
  for (const overlay of open) {
    const file = project.getGmlFile(pathy(overlay.path));
    if (!file || file.isRetired || file.content !== overlay.text) continue;
    const boundaries = new Set([0, file.content.length + 1]);
    const add = (offset: number) => {
      if (
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= file.content.length
      )
        boundaries.add(offset);
    };
    for (const range of [
      ...file.scopes,
      ...file.structNewMemberRanges,
      ...file.jsdocs,
    ]) {
      const source: Range =
        'source' in range ? range.source : Range.from(file, range).source;
      if (source.file !== file) continue;
      add(source.start.offset);
      add(source.end.offset + 1);
    }
    // Scope/type/doc endpoints cover ordinary source. Macro projection can
    // additionally change context at a spelling boundary. Definition files keep
    // all word edges, since their replacement text may have foreign bindings.
    const hasDefinitions = file.content.includes('#macro');
    for (const match of file.content.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\./g)) {
      if (hasDefinitions || match[0] === '.' || macroSet.has(match[0])) {
        add(match.index);
        add(match.index + match[0].length);
      }
    }
    const points = [...boundaries].sort((a, b) => a - b);
    const regions: CompletionPublication['documents'][number]['regions'] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const value = at(file, points[i]);
      const previous = regions.at(-1);
      if (previous?.group === value.group && previous.member === value.member)
        previous.end = points[i + 1];
      else regions.push({ start: points[i], end: points[i + 1], ...value });
    }
    publication.documents.push({ ...overlay, regions });
  }
  return publication;
}
