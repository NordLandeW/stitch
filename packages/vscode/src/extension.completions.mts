import vscode, { CancellationToken, CompletionContext } from 'vscode';
import { stitchConfig } from './config.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import {
  documentationCompletions,
  documentationContext,
} from './language/documentation-context.mjs';

export const completionTriggerCharacters = [
  '.',
  '{',
  '<',
  '|',
  '/',
  '@',
  '[',
  ',',
  ' ',
] as const;
const kinds = {
  enum: vscode.CompletionItemKind.Enum,
  constructor: vscode.CompletionItemKind.Constructor,
  function: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
  interface: vscode.CompletionItemKind.Interface,
  keyword: vscode.CompletionItemKind.Keyword,
};

export class StitchCompletionProvider implements vscode.CompletionItemProvider {
  private registration?: vscode.Disposable;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly requests = new WeakMap<vscode.TextDocument, number>();
  private requestId = 0;
  private commitEpoch = 0;
  private disposed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private pending?: {
    document: vscode.TextDocument;
    version: number;
    position: vscode.Position;
  };

  constructor(readonly provider: StitchWorkspace) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: CancellationToken,
    context: CompletionContext,
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    if (this.disposed || document.isClosed || token.isCancellationRequested)
      return;
    const requestId = ++this.requestId;
    this.requests.set(document, requestId);
    if (this.pending?.document === document) this.clearPending();
    const version = document.version;
    const commitEpoch = this.commitEpoch;
    const offset = document.offsetAt(position);
    const documentation = documentationContext(document.getText(), offset);
    if (
      !documentation &&
      context.triggerCharacter &&
      ['/', '@', '[', ',', ' '].includes(context.triggerCharacter)
    )
      return;
    const linePrefix = document.getText(
      new vscode.Range(position.line, 0, position.line, position.character),
    );
    // Capture physical edit ranges before yielding. Snapshot candidates contain
    // names/types from analysis, never source offsets from an older document.
    const prefix = /\b[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)?.[0] || '';
    const suffix = /^[A-Za-z0-9_]*/.exec(
      document.lineAt(position.line).text.slice(position.character),
    )![0];
    const start = position.character - prefix.length;
    // Documentation spellings are replaced as a whole even in insert mode, so
    // completing in the middle cannot duplicate the remaining qualified name.
    const range = documentation
      ? new vscode.Range(
          document.positionAt(documentation.start),
          document.positionAt(documentation.end),
        )
      : {
          inserting: new vscode.Range(
            position.line,
            start,
            position.line,
            position.character,
          ),
          replacing: new vscode.Range(
            position.line,
            start,
            position.line,
            position.character + suffix.length,
          ),
        };
    const candidates =
      documentation && documentation.kind !== 'type'
        ? documentationCompletions(documentation, [])
        : await this.provider.query(
            document,
            {
              kind: 'completion',
              offset,
              trigger: context.triggerCharacter,
              // Snapshot reuse supports contextual candidates. Native-only fallback
              // remains limited to bare identifiers when no usable snapshot exists.
              allowNativeFallback:
                !context.triggerCharacter &&
                /^\s*[A-Za-z_][A-Za-z0-9_]*$/.test(linePrefix),
            },
            token,
          );
    if (
      this.disposed ||
      document.isClosed ||
      document.version !== version ||
      token.isCancellationRequested ||
      this.requests.get(document) !== requestId
    )
      return;
    const items = candidates
      ?.filter((candidate) => {
        const prefix = stitchConfig.autocompleteIgnoredPrefix;
        return !(
          prefix &&
          candidate.name.startsWith(prefix) &&
          candidate.definitionPath &&
          vscode.Uri.file(candidate.definitionPath).toString() ===
            document.uri.toString()
        );
      })
      .map((candidate) => {
        const item = new vscode.CompletionItem(
          candidate.name,
          kinds[candidate.kind],
        );
        item.detail =
          candidate.fallback === 'snapshot'
            ? ['Analysis updating · last analyzed result', candidate.detail]
                .filter(Boolean)
                .join(' · ')
            : candidate.detail;
        item.range = range;
        if (candidate.insertText !== undefined)
          item.insertText = candidate.snippet
            ? new vscode.SnippetString(candidate.insertText)
            : candidate.insertText;
        return item;
      });
    if (items && candidates?.some((candidate) => candidate.fallback)) {
      if (this.registration) {
        this.pending = { document, version, position };
        if (!this.isPendingEditorCurrent()) this.clearPending();
        // A commit can arrive while the query Promise is being delivered.
        if (this.commitEpoch !== commitEpoch) this.scheduleRefresh();
      }
      return new vscode.CompletionList(items, true);
    }
    return items;
  }

  private isPendingEditorCurrent(): boolean {
    const pending = this.pending;
    const editor = vscode.window.activeTextEditor;
    return !!(
      pending &&
      editor &&
      !pending.document.isClosed &&
      editor.document === pending.document &&
      pending.document.version === pending.version &&
      editor.selection.active.line === pending.position.line &&
      editor.selection.active.character === pending.position.character
    );
  }

  private clearPending() {
    this.pending = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private scheduleRefresh() {
    if (this.disposed || !this.pending || this.refreshTimer !== undefined)
      return;
    this.refreshTimer = setTimeout(() => {
      const refresh = this.isPendingEditorCurrent();
      this.clearPending();
      if (!refresh || this.disposed || !this.registration) return;
      // VS Code has no completion-change event or public widget-visible query.
      // Registry changes refresh only an active suggest session in SuggestModel
      // (verified in 1.107 and 1.145); a dismissed widget stays closed. Unlike
      // triggerSuggest, this leaves that decision on the editor's own thread.
      // Register first: removing the sole provider would cancel the session.
      // The two registry notifications can also retrigger other active editors.
      const previous = this.registration;
      this.registration = this.registerProvider();
      previous.dispose();
    }, 0);
  }

  private registerProvider() {
    return vscode.languages.registerCompletionItemProvider(
      { language: 'gml', scheme: 'file' },
      this,
      ...completionTriggerCharacters,
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPending();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.registration?.dispose();
    this.registration = undefined;
  }

  static register(provider: StitchWorkspace) {
    const completion = new StitchCompletionProvider(provider);
    try {
      completion.registration = completion.registerProvider();
      const subscribe = (subscription: vscode.Disposable) =>
        completion.subscriptions.push(subscription);
      subscribe(
        provider.onDidCommitLanguage(() => {
          completion.commitEpoch++;
          completion.scheduleRefresh();
        }),
      );
      subscribe(
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
          if (completion.pending?.document === document)
            completion.clearPending();
        }),
      );
      subscribe(
        vscode.workspace.onDidCloseTextDocument((document) => {
          if (completion.pending?.document === document)
            completion.clearPending();
        }),
      );
      subscribe(
        vscode.workspace.onDidChangeConfiguration(() =>
          completion.clearPending(),
        ),
      );
      subscribe(
        vscode.window.onDidChangeActiveTextEditor(() =>
          completion.clearPending(),
        ),
      );
      subscribe(
        vscode.window.onDidChangeTextEditorSelection(() => {
          if (!completion.isPendingEditorCurrent()) completion.clearPending();
        }),
      );
      return completion;
    } catch (error) {
      completion.dispose();
      throw error;
    }
  }
}
