import type { ProjectEditBatch } from '@bscotch/gml-parser';
import vscode from 'vscode';

/** Apply one validated library edit plan through the editor's buffer/file owner. */
export async function applyProjectEdits(
  batch: ProjectEditBatch,
): Promise<boolean> {
  const snapshots: {
    document: vscode.TextDocument;
    expectedText: string;
    version: number;
  }[] = [];
  const edit = new vscode.WorkspaceEdit();
  const metadata: vscode.WorkspaceEditEntryMetadata = {
    label: batch.label,
    needsConfirmation: false,
  };
  for (const change of batch.documents) {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(change.filePath),
    );
    if (document.isClosed || document.getText() !== change.expectedText)
      return false;
    snapshots.push({
      document,
      expectedText: change.expectedText,
      version: document.version,
    });
    for (const replacement of change.edits) {
      if (
        !Number.isInteger(replacement.start) ||
        !Number.isInteger(replacement.end) ||
        replacement.start < 0 ||
        replacement.end < replacement.start ||
        replacement.end > change.expectedText.length
      ) {
        throw new Error(`Invalid text edit range for ${change.filePath}`);
      }
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(replacement.start),
          document.positionAt(replacement.end),
        ),
        replacement.text,
        metadata,
      );
    }
  }
  for (const rename of batch.renames) {
    edit.renameFile(
      vscode.Uri.file(rename.from),
      vscode.Uri.file(rename.to),
      { overwrite: false, ignoreIfExists: false },
      metadata,
    );
  }
  // Opening another document can yield to user edits. Check every captured
  // version and the project generation again immediately before submission.
  if (
    snapshots.some(
      ({ document, expectedText, version }) =>
        document.isClosed ||
        document.version !== version ||
        document.getText() !== expectedText,
    )
  )
    return false;
  batch.validate();
  const affected = [
    ...batch.documents.map((document) => document.filePath),
    ...batch.renames.flatMap((rename) => [rename.from, rename.to]),
  ];
  try {
    const applied = await vscode.workspace.applyEdit(edit, {
      isRefactoring: true,
    });
    if (!applied)
      throw new Error('The editor rejected the submitted workspace edit');
    return true;
  } catch (cause) {
    // VS Code guarantees all-or-nothing for text-only batches. Resource edits
    // may stop after earlier operations succeeded; blind reverse edits could
    // overwrite concurrent user changes. Preserve that failure for recovery.
    // https://code.visualstudio.com/api/references/vscode-api#workspace.applyEdit
    const message = batch.renames.length
      ? 'The workspace edit failed and some files may have changed. Inspect the affected resources or undo the edit before retrying.'
      : 'The editor could not apply the text edit.';
    throw new Error(`${message}\n${affected.join('\n')}`, { cause });
  }
}
