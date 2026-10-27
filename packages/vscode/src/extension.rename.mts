import { planReferenceRename } from '@bscotch/gml-parser';
import vscode from 'vscode';
import { assertUserClaim } from './assert.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { rangeFrom } from './lib.mjs';

export class StitchRenameProvider implements vscode.RenameProvider {
  constructor(readonly workspace: StitchWorkspace) {}

  /** Get the reference at a given position, else throw */
  protected assertRenameableReference(
    document: vscode.TextDocument,
    position: vscode.Position,
  ) {
    const file = this.workspace.getGmlFile(document);
    assertUserClaim(file, 'The document is no longer part of the project');
    const at = (where: vscode.Position) => {
      const candidates = file.getReferenceCandidatesAt(
        document.offsetAt(where),
      );
      assertUserClaim(
        candidates.length <= 1,
        'This source spelling has multiple possible symbols and cannot be renamed safely',
      );
      return candidates[0];
    };
    let ref = at(position);
    if (!ref && position.character > 0) {
      // Might be that the cursor is *after* the symbol. Try one position prior.
      ref = at(position.translate(0, -1));
    }
    assertUserClaim(ref, 'Not a symbol reference');
    const query =
      ref.queryRange && ref.queryRange.file === file ? ref.queryRange : ref;
    assertUserClaim(
      query.file === file,
      'This expansion has no editable range in the document',
    );
    let range = rangeFrom(query);
    let text = document.getText(range);
    if (ref.role === 'type' && text.endsWith(ref.item.name)) {
      range = new vscode.Range(
        document.positionAt(
          query.start.offset + text.length - ref.item.name.length,
        ),
        range.end,
      );
      text = document.getText(range);
    }
    assertUserClaim(
      !['other', 'self', 'global'].includes(text),
      'Cannot rename special variables',
    );
    const signifier = ref.item;
    assertUserClaim(signifier, 'No signifier found for reference');
    assertUserClaim(signifier.name, 'No name found for signifier');
    assertUserClaim(
      text === ref.item.name || ref.rename?.kind === 'string-key',
      'This source range does not directly spell the symbol',
    );
    assertUserClaim(!signifier.native, 'Cannot rename native functions');
    assertUserClaim(!signifier.asset, 'Rename assets using the asset tree');
    assertUserClaim(
      signifier.isRenameable && ref.isRenameable,
      'Cannot rename this symbol',
    );
    return { ref, text, range };
  }

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<{ range: vscode.Range; placeholder: string } | undefined> {
    if (!(await this.workspace.ensureDocumentCurrent(document, token))) return;
    // Find the signifier ref at this position
    const toRename = this.assertRenameableReference(document, position);
    return { range: toRename.range, placeholder: toRename.ref.item.name };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ) {
    if (!(await this.workspace.ensureProjectCurrent(document, token))) return;
    const toRename = this.assertRenameableReference(document, position);
    const plan = planReferenceRename(
      toRename.ref.item.refs,
      newName,
      toRename.ref.file.project.analysis.references,
    );
    const edits = new vscode.WorkspaceEdit();
    for (const edit of plan) {
      edits.replace(
        vscode.Uri.file(edit.range.file.path.absolute),
        rangeFrom(edit.range),
        edit.text,
      );
    }
    return edits;
  }

  static register(workspace: StitchWorkspace) {
    const provider = new StitchRenameProvider(workspace);
    return [
      vscode.languages.registerRenameProvider(
        { language: 'gml', scheme: 'file' },
        provider,
      ),
    ];
  }
}
