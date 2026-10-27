export type AnalysisStatus =
  | 'unparsed'
  | 'parsed'
  | 'complete'
  | 'degraded'
  | 'failed'
  | 'retired';

/** Query freshness includes semantic inputs, not just equality of source text. */
export interface AnalysisState {
  readonly contentVersion: number;
  readonly syntaxVersion: number;
  readonly semanticVersion: number;
  readonly projectVersion: number;
  readonly status: AnalysisStatus;
}
