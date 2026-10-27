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
  const position = vscode.window.activeTextEditor?.selection.active;
  if (
    !document ||
    !position ||
    !(await provider.ensureDocumentCurrent(document))
  )
    return;
  const ref = provider.getReference(file, position);
  if (!ref) {
    return;
  }
  const isConstructor = ref.item.type.constructs.length > 0;
  if (isConstructor) {
    return `Struct.${ref.item.name}`;
  }
  return ref.item.type.toFeatherString();
}
