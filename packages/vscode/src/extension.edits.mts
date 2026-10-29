import { renamedPath, type ProjectEditBatch } from '@bscotch/gml-parser';
import vscode from 'vscode';
import {
  prepareResourceMoves,
  resourcePathKey,
} from './extension.edits.resources.mjs';

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
  const replacements: { uri: vscode.Uri; range: vscode.Range; text: string }[] =
    [];
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
      replacements.push({
        uri: vscode.Uri.file(renamedPath(document.uri.fsPath, batch.renames)),
        range: new vscode.Range(
          document.positionAt(replacement.start),
          document.positionAt(replacement.end),
        ),
        text: replacement.text,
      });
    }
  }
  const groups = prepareResourceMoves(batch.renames);
  if (groups.length > 1 && !snapshots.length)
    throw new Error(
      'Dependent resource moves require a document snapshot for the editor transaction.',
    );
  const moved: ProjectEditBatch['renames'][number][] = [];
  for (const group of groups) {
    if (moved.length) {
      // A no-op text entry separates native file-operation groups without
      // changing buffer contents, versions or the shared Undo transaction.
      const origin = snapshots[0].document.positionAt(0);
      edit.replace(
        vscode.Uri.file(renamedPath(snapshots[0].document.uri.fsPath, moved)),
        new vscode.Range(origin, origin),
        '',
        metadata,
      );
    }
    for (const rename of group) {
      edit.renameFile(
        vscode.Uri.file(rename.from),
        vscode.Uri.file(rename.to),
        { overwrite: false, ignoreIfExists: false },
        metadata,
      );
      moved.push(rename);
    }
  }
  // Text belongs to the final working copies. Applying it before moving the
  // resource leaves the text undo entries attached to retired intermediate URIs.
  for (const replacement of replacements)
    edit.replace(
      replacement.uri,
      replacement.range,
      replacement.text,
      metadata,
    );
  if (groups.length > 1) {
    // Directory moves register the directory itself with Undo, not every open
    // descendant. Include moved buffers in the final multi-document text group
    // so Undo from an otherwise unmodified GML editor reaches the whole edit.
    const included = new Set(
      replacements.map((item) => resourcePathKey(item.uri.fsPath)),
    );
    for (const document of vscode.workspace.textDocuments) {
      if (document.isClosed || document.uri.scheme !== 'file') continue;
      const from = document.uri.fsPath.replaceAll('\\', '/');
      const to = renamedPath(from, batch.renames),
        key = resourcePathKey(to);
      if (to === from || included.has(key)) continue;
      const origin = document.positionAt(0);
      edit.replace(
        vscode.Uri.file(to),
        new vscode.Range(origin, origin),
        '',
        metadata,
      );
      included.add(key);
    }
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
