import type {
  Code,
  CompletionCandidate,
  Scope,
  Signifier,
  Type,
} from '@bscotch/gml-parser';

export type GmlCompletionKind =
  | 'enum'
  | 'constructor'
  | 'function'
  | 'variable';

interface CompletionItem {
  detail?: string;
}

interface CompletionOptions<Item> {
  readonly documentPath: string;
  readonly ignoredPrefix: string | null | undefined;
  readonly scopeSymbols?: ReadonlySet<Signifier>;
  createItem(
    name: string,
    kind: GmlCompletionKind,
    availability: CompletionCandidate['availability'],
  ): Item;
  isCancelled?(): boolean;
  /** Optional validity check for the analysis view captured by the adapter. */
  isCurrent?(): boolean;
}

/** Only actual local/self members count as the current scope, not all globals. */
export function completionScopeSymbols(
  scope:
    | Pick<Scope, 'local' | 'self' | 'isDotAccessor' | 'dotReceivers'>
    | undefined,
  globals: Type,
): ReadonlySet<Signifier> {
  const symbols = new Set<Signifier>();
  if (!scope) return symbols;
  const containers = scope.isDotAccessor
    ? scope.dotReceivers || [scope.self]
    : [scope.local, scope.self];
  for (const container of containers) {
    if (container === globals) continue;
    for (const member of container.listMembers()) symbols.add(member);
  }
  return symbols;
}

/** Capture semantic inputs by value; equal source text is not a validity proof. */
export function captureCompletionView(
  code: Pick<Code, 'analysisState'>,
  currentCode: () => Pick<Code, 'analysisState'> | undefined,
  projectGeneration: () => number,
  document?: { readonly version: number; readonly isClosed: boolean },
): () => boolean {
  const state = { ...code.analysisState };
  const generation = projectGeneration();
  const documentVersion = document?.version;
  return () => {
    if (
      document &&
      (document.isClosed || document.version !== documentVersion)
    ) {
      return false;
    }
    if (currentCode() !== code) return false;
    if (state.status !== 'complete' && state.status !== 'degraded')
      return false;
    const current = code.analysisState;
    return (
      projectGeneration() === generation &&
      current.contentVersion === state.contentVersion &&
      current.syntaxVersion === state.syntaxVersion &&
      current.semanticVersion === state.semanticVersion &&
      current.projectVersion === state.projectVersion &&
      current.status === state.status
    );
  };
}

function candidateOf(
  source: Signifier | CompletionCandidate,
): CompletionCandidate {
  return 'symbols' in source
    ? source
    : {
        name: source.name,
        symbols: [source],
        type: source.type,
        availability: { present: 1, total: 1 },
      };
}

function inferKind(candidate: CompletionCandidate): GmlCompletionKind {
  const types = candidate.type.type;
  if (types.length && types.every((type) => type.kind === 'Enum'))
    return 'enum';
  if (types.length && types.every((type) => type.kind === 'Function')) {
    return types.every((type) => type.isConstructor)
      ? 'constructor'
      : 'function';
  }
  return 'variable';
}

function inferDetails(candidate: CompletionCandidate): string {
  const details = [candidate.type.toFeatherString()];
  for (const flag of ['native', 'global', 'local', 'parameter'] as const) {
    if (
      candidate.symbols.length &&
      candidate.symbols.every((symbol) => symbol[flag])
    )
      details.push(flag);
  }
  const { present, total } = candidate.availability;
  if (present < total)
    details.push(`available in ${present}/${total} receiver alternatives`);
  return details.join(' ');
}

/**
 * Retain only weak item-to-source associations. Initial items keep their label,
 * kind and insertion order; type strings are computed only for resolved items.
 */
export class InScopeCompletionItems<Item extends CompletionItem> {
  private readonly sources = new WeakMap<
    Item,
    { candidate: CompletionCandidate; isCurrent?: () => boolean }
  >();

  create(
    items: readonly (Signifier | CompletionCandidate)[],
    options: CompletionOptions<Item>,
  ): Item[] {
    const completions: Item[] = [];
    for (const source of items) {
      if (options.isCancelled?.()) return [];
      const candidate = candidateOf(source);
      if (!candidate.name) continue;
      if (
        options.ignoredPrefix &&
        candidate.name.startsWith(options.ignoredPrefix) &&
        !candidate.symbols.some(
          (symbol) =>
            options.scopeSymbols?.has(symbol) ||
            symbol.def?.file?.path.equals(options.documentPath),
        )
      )
        continue;
      const item = options.createItem(
        candidate.name,
        inferKind(candidate),
        candidate.availability,
      );
      this.sources.set(item, {
        candidate,
        isCurrent: options.isCurrent,
      });
      completions.push(item);
    }
    return options.isCancelled?.() ? [] : completions;
  }

  resolve(item: Item, isCancelled?: () => boolean): Item {
    if (isCancelled?.()) return item;
    const source = this.sources.get(item);
    if (source) {
      if (source.isCurrent && !source.isCurrent()) {
        this.sources.delete(item);
        return item;
      }
      // This is presentation data, not proof that a semantic view is current.
      item.detail = inferDetails(source.candidate);
      this.sources.delete(item);
    }
    return item;
  }
}
