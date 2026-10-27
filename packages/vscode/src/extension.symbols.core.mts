interface SymbolSearchOptions {
  isCancelled?(): boolean;
  isCurrent?(): boolean;
  yieldToHost?(): Promise<void>;
}

export function captureSymbolProjectGeneration(project: {
  readonly analysis: { readonly generation: number };
}): () => boolean {
  const generation = project.analysis.generation;
  return () => project.analysis.generation === generation;
}

/** One literal fuzzy query, one compiled pattern, one score per distinct name. */
export class WorkspaceSymbolSearch {
  readonly query: string;
  private readonly pattern: RegExp;
  private readonly scores = new Map<string, number>();
  private work = 0;

  constructor(
    query: string,
    private readonly options: SymbolSearchOptions = {},
  ) {
    this.query = query.trim();
    this.pattern = new RegExp(
      this.query
        .split('')
        .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*'),
      'i',
    );
  }

  get cancelled(): boolean {
    return this.options.isCancelled?.() ?? false;
  }

  get stopped(): boolean {
    return this.cancelled || !(this.options.isCurrent?.() ?? true);
  }

  /** Call inside scans, awaiting only at batch boundaries (not per symbol). */
  checkpoint(): Promise<void> | undefined {
    if (this.stopped || ++this.work % 128 !== 0) return;
    return this.options.yieldToHost
      ? this.options.yieldToHost()
      : new Promise<void>((resolve) => setImmediate(resolve));
  }

  matches(name: string): boolean {
    return this.score(name) > 0;
  }

  score(name: string): number {
    const cached = this.scores.get(name);
    if (cached !== undefined) return cached;
    const score = this.computeScore(name);
    this.scores.set(name, score);
    return score;
  }

  protected computeScore(name: string): number {
    if (!this.query || !name) return 0;
    const match = this.pattern.exec(name);
    if (!match) return 0;
    // Preserve the existing greedy fuzzy-match scoring and case-insensitivity.
    const characterProximityScore = this.query.length / match[0].length;
    const matchLengthScore = this.query.length / name.length;
    const positionScore = 1 - match.index / name.length;
    return characterProximityScore * 2 + positionScore + matchLengthScore;
  }

  async rank<Item extends { name: string }>(
    items: Iterable<Item>,
    maxResults: number,
  ): Promise<Item[]> {
    if (this.stopped) return [];
    const ranked: { item: Item; score: number }[] = [];
    for (const item of items) {
      const pending = this.checkpoint();
      if (pending) await pending;
      if (this.stopped) return [];
      ranked.push({ item, score: this.score(item.name) });
    }
    if (this.stopped) return [];
    ranked.sort(
      (a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name),
    );
    if (this.stopped) return [];
    return ranked.slice(0, maxResults).map(({ item }) => item);
  }
}
