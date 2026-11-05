/** Values crossing the language-worker boundary. Positions are UTF-16,
 * zero-based and end-exclusive; parser objects never cross this boundary. */
export interface Point {
  line: number;
  character: number;
}
export interface Span {
  start: Point;
  end: Point;
}
export interface Location extends Span {
  path: string;
}
export interface Completion {
  name: string;
  kind:
    | 'enum'
    | 'constructor'
    | 'function'
    | 'variable'
    | 'interface'
    | 'keyword';
  insertText?: string;
  snippet?: boolean;
  detail?: string;
  definitionPath?: string;
  fallback?: 'native' | 'snapshot';
}
/** Immutable display values, pooled across the currently open documents. */
export interface CompletionPublication {
  candidates: Completion[];
  /** Preprocessor spellings can change syntax, rather than only a prefix. */
  macroNames: string[];
  typeNames: string[];
  groups: {
    /** Lossless consecutive candidate-ID spans, in the original query order. */
    spans: { start: number; count: number }[];
    /** Negative IDs shadow a shared receiver with a non-dottable binding. */
    receivers?: Record<string, number>;
    receiverBase?: number;
  }[];
  documents: (Overlay & {
    regions: { start: number; end: number; group: number; member: boolean }[];
  })[];
}
export interface Hover {
  code: string[];
  text: string[];
  sprites: string[];
}
export interface Signature {
  label: string;
  description?: string;
  parameters: { name: string; description?: string }[];
  activeParameter: number;
}
export interface Selection {
  name?: string;
  native: boolean;
  assetName?: string;
  type: string;
}
export interface Token {
  range: Span;
  type: string;
  modifiers: string[];
}
export interface DocumentSymbol {
  name: string;
  detail: string;
  kind:
    | 'constant'
    | 'constructor'
    | 'enum'
    | 'enumMember'
    | 'field'
    | 'function'
    | 'method'
    | 'struct'
    | 'variable';
  range: Span;
  selectionRange: Span;
  deprecated: boolean;
  children: DocumentSymbol[];
}
export interface WorkspaceSymbol {
  name: string;
  kind:
    | 'enum'
    | 'enumMember'
    | 'constant'
    | 'constructor'
    | 'function'
    | 'variable'
    | 'module'
    | 'class'
    | 'file';
  container: string;
  location: Location;
}
export interface RenamePlan {
  edits: { location: Location; text: string }[];
  /** Full immutable source baselines, once per edited file. */
  sources: { path: string; text: string }[];
}
export interface DiagnosticSnapshot {
  path: string;
  text?: string;
  folder?: string;
  diagnostics: {
    range: Span;
    message: string;
    severity: 'error' | 'warning' | 'info';
  }[];
}
export interface QueryResults {
  completion: Completion[] | undefined;
  hover: Hover | undefined;
  definition: Location[];
  typeDefinition: Location[];
  references: Location[];
  prepareRename: Span | undefined;
  rename: RenamePlan | undefined;
  signature: Signature | undefined;
  selection: Selection | undefined;
  tokens: Token[];
  documentSymbols: DocumentSymbol[];
  workspaceSymbols: WorkspaceSymbol[];
  assetRename: import('@bscotch/gml-parser').ResourceRenamePlan;
  importPlan: import('@bscotch/gml-parser').ModuleImportPlan;
}
export type QueryKind = keyof QueryResults;
export interface Query<K extends QueryKind = QueryKind> {
  kind: K;
  path?: string;
  offset?: number;
  trigger?: string;
  /** Host only: allow explicitly labelled built-in candidates during source updates. */
  allowNativeFallback?: boolean;
  newName?: string;
  assetName?: string;
  includeInstance?: boolean;
  includeLocal?: boolean;
  sourceProject?: string;
  sourceNativeSpecFiles?: string[];
  importOptions?: import('@bscotch/gml-parser').ImportModuleOptions;
}
export interface Overlay {
  path: string;
  text: string;
  version: number;
  /** Changes on close/reopen even when VS Code reuses its version number. */
  generation: number;
}
export type Input =
  | ({ kind: 'document' } & Overlay)
  | { kind: 'close'; path: string; generation: number }
  | { kind: 'disk'; path: string }
  | { kind: 'asset'; name: string }
  | { kind: 'project'; configuration?: string }
  | { kind: 'configuration'; name?: string }
  | { kind: 'settings'; prefixes: string[] }
  | { kind: 'native'; files: string[] };
export interface Initialization {
  yypPath: string;
  configuration?: string;
  nativeSpecFiles?: string[];
  autoDeclareGlobalsPrefixes?: string[];
}
export type WorkerRequest =
  | { id: number; session: string; kind: 'initialize'; input: Initialization }
  | {
      id: number;
      session: string;
      kind: 'update';
      revision: number;
      inputs: Input[];
    }
  | {
      id: number;
      session: string;
      kind: 'query';
      revision: number;
      query: Query;
    };
export interface Commit {
  revision: number;
  diagnostics: DiagnosticSnapshot[];
}
export type WorkerResponse =
  | {
      id: number;
      session: string;
      ok: true;
      revision: number;
      value: unknown;
      diagnostics?: DiagnosticSnapshot[];
      nativeCandidates?: Completion[];
      completions?: CompletionPublication;
    }
  | { id: number; session: string; ok: false; error: string }
  | { session: string; event: 'progress'; increment: number; message?: string }
  | {
      session: string;
      event: 'log';
      level: 'log' | 'warn' | 'error';
      message: string;
    };
export interface Cancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(callback: () => void): { dispose(): void };
}
export interface LanguageService {
  readonly revision: number;
  readonly isCurrent: boolean;
  update(input: Input, immediate?: boolean): void;
  /** Display-only lookup; never waits for or starts a language transaction. */
  completion?(query: Query<'completion'>): Completion[] | undefined;
  invalidateCompletions?(): void;
  flush(token?: Cancellation): Promise<boolean>;
  query<K extends QueryKind>(
    query: Query<K>,
    token?: Cancellation,
  ): Promise<QueryResults[K] | undefined>;
  dispose(): void;
}
