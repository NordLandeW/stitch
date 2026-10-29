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
    let ref = this.workspace.getReference(document, position);
    if (!ref && position.character > 0) {
      // Might be that the cursor is *after* the symbol. Try one position prior.
      ref = this.workspace.getReference(document, position.translate(0, -1));
    }
    assertUserClaim(
      ref,
      'No unique symbol reference; a shared macro spelling may bind to different symbols',
    );
    const range = rangeFrom(ref);
    const text = document.getText(range);
    assertUserClaim(
      !['other', 'self', 'global'].includes(text),
      'Cannot rename special variables',
    );
    const signifier = ref.item;
    assertUserClaim(signifier, 'No signifier found for reference');
    assertUserClaim(signifier.name, 'No name found for signifier');
    assertUserClaim(text === ref.item.name, 'Cannot rename from type string');
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
  ): Promise<vscode.Range | undefined> {
    if (!(await this.workspace.ensureProjectCurrent(document, token))) return;
    // Find the signifier ref at this position
    const toRename = this.assertRenameableReference(document, position);
    return toRename.range;
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
  ) {
    if (!(await this.workspace.ensureProjectCurrent(document, token))) return;
    const toRename = this.assertRenameableReference(document, position);
    const plan = toRename.ref.file.project.renameEdits(
      toRename.ref.item,
      newName,
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
