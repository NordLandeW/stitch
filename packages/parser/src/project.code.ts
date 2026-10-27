import type { Pathy } from '@bscotch/pathy';
import { YyObject } from '@bscotch/yy';
import type { CodeSemanticView } from './analysis/model.js';
import { value } from './analysis/values.js';
import type { AnalysisState, AnalysisStatus } from './language/state.js';
import {
  collectMacros,
  MacroEnvironment,
  type PreprocessedDocument,
} from './syntax/macros.js';
import { getProjectAnalysis } from './language/service.js';
import { SourceMap } from './syntax/source.js';
import type { JsdocSummary } from './jsdoc.js';
import { ObjectEvent, getEventFromFilename } from './lib.objects.js';
import { logger } from './logger.js';
import { parser, type GmlParsed } from './parser.js';
import type { Asset } from './project.asset.js';
import {
  extensionDefinitionNames,
  roomInstances,
  type GmlSourceContext,
} from './project.sources.js';
import {
  Diagnostic,
  DiagnosticCollectionName,
  DiagnosticCollections,
} from './project.diagnostics.js';
import {
  FunctionArgRange,
  IPosition,
  IRange,
  LinePosition,
  Position,
  Range,
  Reference,
  ReferenceableType,
  Scope,
  StructNewMemberRange,
  type CompletionCandidate,
} from './project.location.js';
import type { Signifier } from './signifiers.js';
import { getTypeOfKind } from './types.checks.js';
import { Type, type StructType } from './types.js';
import { assert, isBeforeRange, isInRange } from './util.js';

export interface CodeSyntaxView {
  readonly parsed: GmlParsed;
  readonly processed: PreprocessedDocument;
  readonly diagnostics: readonly Diagnostic[];
}

/** Represenation of a GML code file. */
export class Code {
  readonly $tag = 'gmlFile';
  readonly scopes: Scope[] = [];
  readonly jsdocs: JsdocSummary[] = [];

  protected diagnostics!: DiagnosticCollections;
  /** List of all symbol references in this file, in order of appearance. */
  protected _refs: Reference[] = [];
  /** Ranges representing function call arguments,
   * in order of appearance. Useful for signature help. */
  protected _functionArgRanges: FunctionArgRange[] = [];
  /** Ranges representing locations where new struct
   * members could be added. Useful for autocomplete. */
  protected _structNewMemberRanges: StructNewMemberRange[] = [];
  /** List of function calls, where each root item is a list
   * of argument ranges for that call. Useful for diagnostics.*/
  protected _functionCalls: FunctionArgRange[][] = [];
  protected _rangesAreSorted = false;
  private _content = '';
  private _contentVersion = 0;
  private _syntaxVersion = 0;
  private _semanticVersion = 0;
  private _projectVersion = -1;
  private _analysisStatus: AnalysisStatus = 'unparsed';
  private _syntaxDiagnostics: Diagnostic[] = [];
  private _internalDiagnostics: Diagnostic[] = [];
  private _preprocessed?: PreprocessedDocument;
  protected _parsed!: GmlParsed;

  private resourceContext?: GmlSourceContext;
  private extensionNames?: { text: string; names: ReadonlySet<string> };
  get extensionDefinitions(): ReadonlySet<string> {
    if (this.extensionNames?.text !== this.content)
      this.extensionNames = {
        text: this.content,
        names: extensionDefinitionNames(this.content),
      };
    return this.extensionNames.names;
  }
  get sourceContext(): GmlSourceContext {
    return (
      this.resourceContext ||
      (this.isScript
        ? { kind: 'script' }
        : this.isObjectEvent
          ? {
              kind: 'object-event',
              selfOwner: `object:${this.asset.name}:self`,
            }
          : { kind: 'other' })
    );
  }
  setSourceContext(context: GmlSourceContext): void {
    if (JSON.stringify(this.sourceContext) === JSON.stringify(context)) return;
    this.resourceContext = Object.freeze({ ...context });
    getProjectAnalysis(this.project).invalidate(this);
  }

  get content(): string {
    return this._content;
  }
  set content(value: string) {
    if (value === this._content) return;
    this._content = value;
    this._contentVersion++;
    this._analysisStatus = 'unparsed';
    getProjectAnalysis(this.project).invalidate(this);
  }

  get analysisState(): AnalysisState {
    return {
      contentVersion: this._contentVersion,
      syntaxVersion: this._syntaxVersion,
      semanticVersion: this._semanticVersion,
      projectVersion: this._projectVersion,
      status: this._analysisStatus,
    };
  }

  get sourceMap(): SourceMap {
    return (
      this._preprocessed?.sourceMap ||
      new SourceMap({ uri: this.path.absolute, text: this.content })
    );
  }

  get syntaxText(): string {
    return this._preprocessed?.text ?? this.content;
  }
  get preprocessed(): PreprocessedDocument | undefined {
    return this._preprocessed;
  }

  /** Host commit only: no parsing, inference, publication or shared graph reset. */
  replaceSemanticView(view: CodeSemanticView): void {
    this._refs = [...view.refs];
    this.scopes.splice(0, this.scopes.length, ...view.scopes);
    this.jsdocs.splice(0, this.jsdocs.length, ...view.jsdocs);
    this._functionArgRanges = [...view.functionArgRanges];
    this._functionCalls = view.functionCalls.map((call) => [...call]);
    this._structNewMemberRanges = [...view.structNewMemberRanges];
    this.callsSuper = view.callsSuper;
    this._rangesAreSorted = false;
    this.clearAllDiagnostics();
    this.diagnostics.SYNTAX_ERROR.push(...this._syntaxDiagnostics);
    this.diagnostics.ANALYSIS.push(...this._internalDiagnostics);
    for (const [collection, diagnostics] of Object.entries(view.diagnostics)) {
      this.diagnostics[collection as DiagnosticCollectionName].push(
        ...diagnostics,
      );
    }
  }

  markAnalyzed(projectVersion: number, status: 'complete' | 'degraded'): void {
    this._projectVersion = projectVersion;
    this._semanticVersion++;
    this._analysisStatus = status;
    this._internalDiagnostics = [];
    this.diagnostics.ANALYSIS = [];
  }

  markAnalysisFailed(error: unknown, projectVersion: number): void {
    this._projectVersion = projectVersion;
    this._analysisStatus = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    this._internalDiagnostics = [
      Diagnostic.error(
        `Language analysis failed: ${message}`,
        this.startRange,
        error,
      ),
    ];
    this.diagnostics.ANALYSIS = [...this._internalDiagnostics];
  }

  retireAnalysis(): void {
    this._analysisStatus = 'retired';
    this._refs = [];
    this.scopes.length = 0;
    this.jsdocs.length = 0;
    this._functionArgRanges = [];
    this._functionCalls = [];
    this._structNewMemberRanges = [];
    this._syntaxDiagnostics = [];
    this._internalDiagnostics = [];
    this.clearAllDiagnostics();
  }

  // Metadata
  /** For object events, whether or not `event_inherited` is unambiguously being called */
  public callsSuper = false;

  constructor(
    readonly asset: Asset,
    readonly path: Pathy<string>,
  ) {
    this.clearAllDiagnostics();
    getProjectAnalysis(this.project).register(this);
  }

  /**
   * If this is the Create event for an object, that object's
   * variables. Else undefined. Used for determining the initial
   * "definitive self" during code processing.
   */
  get definitiveSelf(): StructType | undefined {
    if (this.isCreateEvent) {
      return this.asset.variables;
    }
    return;
  }

  /** When set to `true`, this file will be flagged for reprocessing. */
  set dirty(value: boolean) {
    if (value) {
      this.project.queueDirtyFileUpdate(this);
    }
  }

  get isScript() {
    return this.asset.assetKind === 'scripts';
  }

  get isObjectEvent() {
    return this.asset.assetKind === 'objects';
  }

  get isCreateEvent() {
    return this.name === 'Create_0';
  }

  get isStepEvent() {
    return this.name.startsWith('Step_');
  }

  get project() {
    return this.asset.project;
  }

  get startPosition() {
    return Position.fromFileStart(this);
  }

  /**
   * If this is an object event and Stitch knows about
   * its type, return the info about that event.
   */
  get objectEventInfo(): ObjectEvent | undefined {
    if (!this.isObjectEvent) return undefined;
    return getEventFromFilename(this.path.absolute);
  }

  /** A zero-length range at the start of the file. */
  get startRange() {
    return new Range(this.startPosition, this.startPosition);
  }

  protected isInRange(
    range: { start: IPosition; end: IPosition },
    offset: number | LinePosition,
  ) {
    return isInRange(range, offset);
  }

  protected isBeforeRange(range: IRange, offset: number | LinePosition) {
    return isBeforeRange(range, offset);
  }

  getTextAt(offsetStart: number, offsetEnd: number): string {
    return this.content.slice(offsetStart, offsetEnd + 1);
  }

  getReferenceAt(offset: number): Reference | undefined;
  getReferenceAt(position: LinePosition): Reference | undefined;
  getReferenceAt(line: number, column: number): Reference | undefined;
  getReferenceAt(
    offset: number | LinePosition,
    column?: number,
  ): Reference | undefined {
    const candidates = this.getReferenceCandidatesAt(offset, column);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** All possible bindings at one spelling; a union must not choose its first branch. */
  getReferenceCandidatesAt(
    offset: number | LinePosition,
    column?: number,
  ): readonly Reference[] {
    if (typeof offset === 'number' && typeof column === 'number')
      offset = { line: offset, column };
    const refs = this.refs;
    assert(refs, 'Refs must be an array');
    const matches: Reference[] = [];
    let first: IRange | undefined;
    for (const ref of refs) {
      const query = ref.queryRange || ref;
      if (this.isInRange(query, offset)) {
        first ||= query;
        if (
          query.start.offset === first.start.offset &&
          query.end.offset === first.end.offset
        )
          matches.push(ref);
      } else if (this.isBeforeRange(query, offset)) break;
    }
    if (matches.length) {
      // Invocation names win over their expanded body, and shorthand queries
      // select the value role while rename still sees both independent roles.
      const macro = matches.find(
        (ref) =>
          ref.item.macro && ref.file === this && this.isInRange(ref, offset),
      );
      if (macro) return [macro];
      const shorthand = matches.filter((ref) => ref.role === 'shorthand-value');
      return [
        ...new Map(
          (shorthand.length ? shorthand : matches).map((ref) => [
            ref.item,
            ref,
          ]),
        ).values(),
      ];
    }
    const external = getProjectAnalysis(this.project)
      .spellingReferences(this.path.absolute)
      .filter((ref) => this.isInRange(ref, offset));
    // A physical macro body has no invoking scope to disambiguate its bindings.
    return new Set(external.map((ref) => ref.item)).size === 1
      ? [external[0]]
      : [];
  }

  getJsdocAt(
    offset: number | LinePosition,
    column?: number,
  ): JsdocSummary | undefined {
    if (typeof offset === 'number' && typeof column === 'number') {
      offset = { line: offset, column };
    }
    assert(this.jsdocs, 'Jsdocs must be an array');
    for (let i = 0; i < this.jsdocs.length; i++) {
      const jsdoc = this.jsdocs[i];
      if (this.isInRange(jsdoc, offset)) {
        return jsdoc;
      } else if (this.isBeforeRange(jsdoc, offset)) {
        return undefined;
      }
    }
    return undefined;
  }

  getFunctionArgRangeAt(
    offset: number | LinePosition,
    column?: number,
  ): FunctionArgRange | undefined {
    if (typeof offset === 'number' && typeof column === 'number') {
      offset = { line: offset, column };
    }
    let match: FunctionArgRange | undefined;
    const ranges = this.functionArgRanges;
    assert(ranges, 'Function arg ranges must be an array');
    for (let i = 0; i < ranges.length; i++) {
      const argRange = ranges[i];
      if (this.isInRange(argRange, offset)) {
        // These could be nested, so an outer arg range might contain an inner one.
        // Since these are sorted by start offset, we can return the *last* one to ensure that we're in the innermost range.
        match = argRange;
        continue;
      } else if (this.isBeforeRange(argRange, offset)) {
        return match;
      }
    }
    return match;
  }

  getStructNewMemberRangeAt(
    offset: number | LinePosition,
    column?: number,
  ): StructNewMemberRange | undefined {
    if (typeof offset === 'number' && typeof column === 'number') {
      offset = { line: offset, column };
    }
    const ranges = this.structNewMemberRanges;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (this.isInRange(range, offset)) {
        return range;
      } else if (this.isBeforeRange(range, offset)) {
        return undefined;
      }
    }
    return undefined;
  }

  getScopeRangeAt(
    offset: number | LinePosition,
    column?: number,
  ): Scope | undefined {
    if (typeof offset === 'number' && typeof column === 'number') {
      offset = { line: offset, column };
    }
    for (const scopeRange of this.scopes) {
      if (this.isInRange(scopeRange, offset)) {
        return scopeRange;
      }
    }
    // Default to the last scope,
    // since we can end up with wonkiness with EOF trailing whitespace
    return this.scopes.at(-1);
  }

  /** Aggregate names for presentation while retaining every real binding. */
  getCompletionCandidatesAt(
    offset: number | LinePosition,
    column?: number,
  ): CompletionCandidate[] {
    const scope = this.getScopeRangeAt(offset, column);
    if (!scope) return [];
    if (!scope.isDotAccessor) {
      return this.getInScopeSymbolsAt(offset, column).map((symbol) => ({
        name: symbol.name,
        symbols: [symbol],
        type: symbol.type,
        availability: { present: 1, total: 1 },
      }));
    }
    const receivers = scope.dotReceivers || [scope.self];
    const candidates = new Map<
      string,
      {
        symbols: Set<Signifier>;
        types: Type[];
        present: number;
      }
    >();
    for (const receiver of receivers) {
      if (
        !['Struct', 'Enum', 'Id.Instance', 'Asset.GMObject'].includes(
          receiver.kind,
        )
      )
        continue;
      const names = new Set<string>();
      for (const symbol of receiver.listMembers()) {
        if (
          symbol.hidden ||
          names.has(symbol.name) ||
          (!symbol.def && !symbol.native)
        )
          continue;
        names.add(symbol.name);
        if (receiver === this.project.self) {
          const definedInProject = !symbol.native && !!symbol.def?.file;
          const canLiveOnGlobal =
            !symbol.macro && !getTypeOfKind(symbol, ['Enum']);
          if (!definedInProject || !canLiveOnGlobal) continue;
        }
        let candidate = candidates.get(symbol.name);
        if (!candidate) {
          candidate = { symbols: new Set(), types: [], present: 0 };
          candidates.set(symbol.name, candidate);
        }
        candidate.symbols.add(symbol);
        candidate.types.push(
          ...(scope.memberTypes?.get(symbol) || symbol.type).type,
        );
        candidate.present++;
      }
    }
    return [...candidates]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, candidate]) => ({
        name,
        symbols: [...candidate.symbols].sort((a, b) =>
          (a.semanticKey || a.name).localeCompare(b.semanticKey || b.name),
        ),
        type: value(...candidate.types),
        availability: { present: candidate.present, total: receivers.length },
      }));
  }

  getInScopeSymbolsAt(
    offset: number | LinePosition,
    column?: number,
  ): Signifier[] {
    if (typeof offset === 'number' && typeof column === 'number') {
      offset = { line: offset, column };
    }
    const scopeRange = this.getScopeRangeAt(offset);
    if (!scopeRange) {
      return [];
    }
    if (scopeRange.isDotAccessor) {
      return [
        ...new Set(
          this.getCompletionCandidatesAt(offset).flatMap(
            (item) => item.symbols,
          ),
        ),
      ];
    }
    // Add to a flat list, and remove all entries that don't have
    // a definition if they are not native
    const allSignifiers = [
      // Local variables
      ...(scopeRange.local.listMembers() || []),
      // Self variables, if not global
      ...((scopeRange.self !== this.project.self
        ? scopeRange.self.listMembers()
        : []) || []),
      // Project globals
      ...(this.project.self.listMembers() || []),
    ];

    // Signifiers were added in order of precedence, so we can remove
    // non-uniques by just keeping the first one we find.
    const uniqueSignifiers = new Map<string, Signifier>();
    for (const signifier of allSignifiers) {
      if (
        !signifier.hidden &&
        !uniqueSignifiers.has(signifier.name) &&
        (signifier.def || signifier.native)
      ) {
        uniqueSignifiers.set(signifier.name, signifier);
      }
    }

    return [...uniqueSignifiers.values()];
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  get refs() {
    this.sortRanges();
    return [...this._refs];
  }

  get functionArgRanges() {
    this.sortRanges();
    return [...this._functionArgRanges];
  }

  get structNewMemberRanges() {
    this.sortRanges();
    return [...this._structNewMemberRanges];
  }

  get name() {
    return this.path.name;
  }

  get basename() {
    return this.path.basename;
  }

  get cst() {
    return this._parsed.cst;
  }

  /**
   * Load the file and parse it, resulting in an updated
   * CST for future steps. If content is directly provided,
   * it will be used instead of reading from disk. This
   * is useful for editors that want to provide a live preview.
   */
  private bufferOwned = false;
  private bufferEpoch = 0;

  setBufferContent(text: string): void {
    if (
      this.project.isDisposed ||
      getProjectAnalysis(this.project).document(this.path.absolute) !== this
    )
      return;
    this.bufferEpoch++;
    this.bufferOwned = true;
    this.content = text;
  }
  releaseBuffer(): void {
    this.bufferEpoch++;
    this.bufferOwned = false;
  }
  private lineStarts?: { version: number; starts: number[] };

  positionAt(offset: number): Position {
    offset = Number.isFinite(offset)
      ? Math.max(0, Math.min(offset, this.content.length))
      : 0;
    if (this.lineStarts?.version !== this._contentVersion) {
      const starts = [0];
      for (let index = 0; index < this.content.length; index++)
        if (this.content[index] === '\n') starts.push(index + 1);
      this.lineStarts = { version: this._contentVersion, starts };
    }
    const starts = this.lineStarts.starts;
    let lower = 0,
      upper = starts.length - 1;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (starts[middle] <= offset) lower = middle;
      else upper = middle - 1;
    }
    return new Position(this, offset, lower + 1, offset - starts[lower] + 1);
  }

  async readContent(content?: string, forceDisk = false): Promise<void> {
    const service = getProjectAnalysis(this.project);
    if (
      this.project.isDisposed ||
      service.document(this.path.absolute) !== this
    )
      return;
    if (typeof content === 'string') {
      this.setBufferContent(content);
      return;
    }
    const buffer = this.project.options?.documentText?.(this.path.absolute);
    if (typeof buffer === 'string') {
      this.setBufferContent(buffer);
      return;
    }
    if (this.bufferOwned && !forceDisk) return;
    const version = this._contentVersion,
      epoch = this.bufferEpoch;
    const disk = await this.path.read();
    // Ownership can change without changing the text (opening an equal buffer).
    if (
      this.project.isDisposed ||
      service.document(this.path.absolute) !== this ||
      version !== this._contentVersion ||
      epoch !== this.bufferEpoch
    )
      return;
    const latest = this.project.options?.documentText?.(this.path.absolute);
    if (typeof latest === 'string') {
      this.setBufferContent(latest);
      return;
    }
    this.bufferOwned = false;
    this.content = disk;
  }

  get hasSyntaxErrors(): boolean {
    return this._syntaxDiagnostics.length > 0;
  }

  prepareSyntax(
    processed: PreprocessedDocument,
    parsed = parser.parse(processed.text),
  ): CodeSyntaxView {
    const diagnostics: Diagnostic[] = [];
    const range = (start: number, end: number) => {
      const origin = processed.sourceMap.origin(start, end);
      const span = origin.expansion || origin.spelling;
      const file =
        span.uri === this.path.absolute
          ? this
          : getProjectAnalysis(this.project).document(span.uri) || this;
      return new Range(file.positionAt(span.start), file.positionAt(span.end));
    };
    for (const diagnostic of processed.diagnostics) {
      const file =
        diagnostic.span.uri === this.path.absolute
          ? this
          : getProjectAnalysis(this.project).document(diagnostic.span.uri) ||
            this;
      diagnostics.push(
        Diagnostic.error(
          diagnostic.message,
          new Range(
            file.positionAt(diagnostic.span.start),
            file.positionAt(diagnostic.span.end),
          ),
          diagnostic,
        ),
      );
    }
    for (const diagnostic of parsed.lexed.errors) {
      diagnostics.push(
        Diagnostic.error(
          diagnostic.message,
          range(
            diagnostic.offset,
            diagnostic.offset + Math.max(1, diagnostic.length) - 1,
          ),
          diagnostic,
        ),
      );
    }
    for (const diagnostic of parsed.errors) {
      const token = Number.isFinite(diagnostic.token.startOffset)
        ? diagnostic.token
        : diagnostic.previousToken;
      const start = token?.startOffset ?? processed.text.length;
      const end = token?.endOffset ?? start;
      diagnostics.push(
        Diagnostic.error(diagnostic.message, range(start, end), diagnostic),
      );
    }
    return { parsed, processed, diagnostics };
  }

  replaceSyntaxView(view: CodeSyntaxView): void {
    if (this._parsed !== view.parsed) this._syntaxVersion++;
    this._parsed = view.parsed;
    this._preprocessed = view.processed;
    this._syntaxDiagnostics = [...view.diagnostics];
    this._analysisStatus = 'parsed';
    this.diagnostics.SYNTAX_ERROR = [...view.diagnostics];
  }

  parsePreprocessed(processed: PreprocessedDocument): void {
    this.replaceSyntaxView(this.prepareSyntax(processed));
    getProjectAnalysis(this.project).invalidate(this);
  }

  async parse(content?: string): Promise<void> {
    await this.readContent(content);
    const document = { uri: this.path.absolute, text: this.content };
    this.parsePreprocessed(
      new MacroEnvironment([collectMacros(document)]).expand(document),
    );
  }

  /**
   * Replace all refs for a signifier with a new name,
   * followed by fully reprocessing the file.
   */
  async renameSignifier(signifier: Signifier, newName: string) {
    await this.project.renameSignifier(signifier, newName);
  }

  get hasOwnedBuffer(): boolean {
    return (
      this.bufferOwned ||
      typeof this.project.options?.documentText?.(this.path.absolute) ===
        'string'
    );
  }

  clearDiagnosticCollection(collection: DiagnosticCollectionName) {
    this.diagnostics[collection] = [];
  }

  protected clearAllDiagnostics() {
    this.diagnostics = {
      ANALYSIS: [],
      GLOBAL_SELF: [],
      INVALID_OPERATION: [],
      JSDOC_MISMATCH: [],
      MISSING_EVENT_INHERITED: [],
      MISSING_REQUIRED_ARGUMENT: [],
      SYNTAX_ERROR: [],
      TOO_MANY_ARGUMENTS: [],
      UNDECLARED_GLOBAL_REFERENCE: [],
      UNDECLARED_VARIABLE_REFERENCE: [],
      JSDOC: [],
      UNUSED: [],
    };
  }

  addDiagnostic(collection: DiagnosticCollectionName, diagnostic: Diagnostic) {
    this.diagnostics[collection].push(diagnostic);
  }

  addRef(ref: Reference) {
    this._refs.push(ref);
  }

  addStructNewMemberRange(range: StructNewMemberRange) {
    this._structNewMemberRanges.push(range);
  }

  addFunctionArgRange(range: FunctionArgRange) {
    this._functionArgRanges.push(range);
  }

  addFunctionCall(call: FunctionArgRange[]) {
    this._functionCalls.push(call);
  }

  protected sortRanges() {
    if (this._rangesAreSorted) return;
    interface Offset {
      start: { offset: number };
    }
    const sorter = (a: Offset, b: Offset) => {
      assert(a, 'Ref a does not exist');
      assert(b, 'Ref b does not exist');
      assert(a.start && b.start, 'Ref does not have a start');
      return a.start.offset - b.start.offset;
    };
    this._refs.sort((a, b) => sorter(a.queryRange || a, b.queryRange || b));
    this._functionArgRanges.sort(sorter);
    this._structNewMemberRanges.sort(sorter);
    this._rangesAreSorted = true;
  }

  protected async removeFromYy() {
    const source = this.sourceContext;
    if (source.kind === 'instance-creation') {
      for (const instance of roomInstances(
        (this.asset.yy as { layers: unknown[] }).layers,
      ))
        if (instance.name === source.instanceName)
          instance.hasCreationCode = false;
      await this.asset.saveYy();
      return;
    }
    if (source.kind === 'room-creation') {
      (this.asset.yy as { creationCodeFile: string }).creationCodeFile = '';
      await this.asset.saveYy();
      return;
    }
    if (source.kind === 'timeline') {
      const yy = this.asset.yy as { momentList: { moment: number }[] };
      yy.momentList = yy.momentList.filter(
        (entry) => entry.moment !== source.moment,
      );
      await this.asset.saveYy();
      return;
    }
    if (source.kind === 'extension') {
      const yy = this.asset.yy as { files: { filename?: string }[] };
      yy.files = yy.files.filter(
        (entry) =>
          !entry.filename ||
          this.asset.dir.join(entry.filename).absolute.toLocaleLowerCase() !==
            this.path.absolute.toLocaleLowerCase(),
      );
      await this.asset.saveYy();
      return;
    }
    if (!this.asset.isObject) return;
    const eventInfo = this.objectEventInfo;
    if (!eventInfo) {
      logger.warn(`Stitch does not know about the ${this.name} event type!`);
      return;
    }

    // find the match for this event
    const yy = this.asset.yy as YyObject;
    const eventIdx = yy.eventList.findIndex(
      (event) =>
        event.eventNum === eventInfo.eventNum &&
        event.eventType === eventInfo.eventType,
    );
    if (eventIdx > -1) {
      yy.eventList.splice(eventIdx, 1);
      await this.asset.saveYy();
    }
  }

  async remove() {
    await this.project.withResourceUpdate(async () => {
      assert(
        this.analysisState.status !== 'retired' &&
          this.project
            .sourceOwners(this.path)
            .every((owner) => owner === this.asset),
        'A shared or retired GML source cannot be deleted through one resource.',
      );
      await this.removeFromYy();
      await this.path.delete();
      this.asset.gmlFiles.delete(this.path.absolute.toLocaleLowerCase());
      getProjectAnalysis(this.project).retire(this);
      // Explicit Code-only hosts own their registrations without disk metadata.
      if (this.asset.sourceCandidates !== undefined)
        await this.asset.reload(false);
    });
  }

  /**
   * Reprocess after a modification to the file. Optionally
   * provide new content to use instead of reading from disk.
   */
  async reload(
    content?: string,
    _options?: { reloadDirty?: boolean },
  ): Promise<void> {
    const analysis = getProjectAnalysis(this.project);
    if (analysis.document(this.path.absolute) !== this)
      throw new Error('Cannot reload a retired document');
    await this.readContent(content, content === undefined);
    if (
      this.project.isDisposed ||
      analysis.document(this.path.absolute) !== this
    )
      return;
    analysis.invalidate(this);
    await analysis.analyze();
  }

  computeUnusedSymbolDiagnostics() {
    this.diagnostics.UNUSED = [];
    const unused = new Set<Signifier>();
    for (const ref of this.refs) {
      if (
        unused.has(ref.item) ||
        !ref.isDef ||
        ref.item.native ||
        !ref.item.getTypeByKind('Function') ||
        !ref.item.global // For now restrict to global functions. The rest requires some nuance!
      ) {
        continue;
      }
      // Are all refs to the definition?
      const hasNonDefRefs = [...ref.item.refs.values()].some((r) => !r.isDef);
      if (!hasNonDefRefs) {
        unused.add(ref.item);
        this.diagnostics.UNUSED.push(
          Diagnostic.info(`Unused function \`${ref.item.name}\``, ref),
        );
      }
    }
  }

  /** Publish only the completed view. Semantic computation belongs to ProjectAnalysis. */
  publishDiagnostics() {
    const allDiagnostics: Diagnostic[] = [];
    for (const items of Object.values(this.diagnostics)) {
      allDiagnostics.push(...items);
    }
    this.project.emitDiagnostics(this, allDiagnostics);
    return allDiagnostics;
  }

  updateDiagnostics() {
    getProjectAnalysis(this.project).analyzeSync();
    return Object.values(this.diagnostics).flat();
  }

  /** @deprecated The service binds all declarations before evaluating any unit. */
  updateGlobals() {
    getProjectAnalysis(this.project).analyzeSync();
  }
  /** @deprecated Use reload() or Project.analysis.analyze(). */
  updateAllSymbols() {
    getProjectAnalysis(this.project).analyzeSync();
  }
}
