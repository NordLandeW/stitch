import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { copyToClipboard } from './lib.mjs';

export function createCopyAsTypeCallback(provider: StitchWorkspace) {
  return async (file: vscode.Uri) => {
    const type = await uriToType(provider, file);
    if (type) {
      copyToClipboard(type);
    }
  };
}

export function createCopyAsJsdocSelfCallback(provider: StitchWorkspace) {
  return async (file: vscode.Uri) => {
    const type = await uriToType(provider, file);
    if (type && type.match(/^(Struct|Id.Instance|Asset.GMObject)/)) {
      copyToClipboard(`/// @self ${type}`);
    } else if (type) {
      // Notify the user that this type is not a self-type
      vscode.window.showInformationMessage(
        `Type "${type}" cannot be used as a context type.`,
      );
    }
  };
}

export function createCopyAsJsdocTypeCallback(provider: StitchWorkspace) {
  return async (file: vscode.Uri) => {
    const type = await uriToType(provider, file);
    if (type) {
      copyToClipboard(`/// @type {${type}}`);
    }
  };
}

async function uriToType(provider: StitchWorkspace, file: vscode.Uri) {
  const document = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === file.toString(),
  );
  const editor = vscode.window.activeTextEditor;
  const position = editor?.selection.active;
  if (!document || !editor || editor.document !== document || !position) return;
  const code = await provider.ensureDocumentCurrent(document);
  if (
    !code ||
    vscode.window.activeTextEditor !== editor ||
    !editor.selection.active.isEqual(position)
  )
    return;
  const ref = code.getReferenceAt(document.offsetAt(position));
  if (!ref) {
    return;
  }
  const type = ref.evaluatedType || ref.item.type;
  const isConstructor = type.constructs.length > 0;
  if (isConstructor) {
    return `Struct.${ref.item.name}`;
  }
  return type.toFeatherString();
}
