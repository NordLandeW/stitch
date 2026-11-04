import vscode from 'vscode';
import type { Location, Signature, Span } from './protocol.mjs';

export function displayRange(span: Span): vscode.Range {
  return new vscode.Range(
    new vscode.Position(span.start.line, span.start.character),
    new vscode.Position(span.end.line, span.end.character),
  );
}
export function displayLocation(location: Location): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(location.path),
    displayRange(location),
  );
}
export function displaySignature(signature: Signature): vscode.SignatureHelp {
  const info = new vscode.SignatureInformation(
    signature.label,
    signature.description,
  );
  info.activeParameter = signature.activeParameter;
  info.parameters = signature.parameters.map(
    (param) => new vscode.ParameterInformation(param.name, param.description),
  );
  const help = new vscode.SignatureHelp();
  help.signatures = [info];
  help.activeSignature = 0;
  help.activeParameter = signature.activeParameter;
  return help;
}
