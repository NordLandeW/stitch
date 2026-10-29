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
    // @self consumes one named receiver; a union is valid for @type, but this
    // annotation cannot express it without silently dropping alternatives.
    if (
      type &&
      /^(Struct|Id\.Instance|Asset\.GMObject)(\.[a-zA-Z_][a-zA-Z_0-9]*)?$/.test(
        type,
      )
    ) {
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
  const refs = code.getReferenceCandidatesAt(document.offsetAt(position));
  if (!refs.length) return;
  try {
    const alternatives = refs.flatMap((ref) => {
      const store = ref.evaluatedType || ref.item.type;
      return store.type.length
        ? store.type.map((type) =>
            (type.isConstructor && type.self
              ? type.self
              : type
            ).toFeatherString({ complete: true }),
          )
        : ['Any'];
    });
    return [...new Set(alternatives)]
      .sort((a, b) => a.localeCompare(b))
      .join('|');
  } catch (error) {
    void vscode.window.showInformationMessage(
      `Cannot copy a complete type annotation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
}
