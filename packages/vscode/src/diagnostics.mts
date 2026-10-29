import type { DiagnosticsEventPayload } from '@bscotch/gml-parser';
import { assertInternalClaim } from './assert.mjs';
import { rangeFrom } from './lib.mjs';

import vscode from 'vscode';

export const diagnosticCollection =
  vscode.languages.createDiagnosticCollection('gml');

export function normalizeDiagnosticsEvents(
  payload: DiagnosticsEventPayload,
  document?: vscode.TextDocument,
) {
  assertInternalClaim(payload, 'diagnostics must be an array');
  // EOF recovery ranges can be cursor boundaries rather than inclusive tokens.
  // Validate the editor projection, leaving the stored analysis/source ranges intact.
  const lines =
    !document && payload.code && payload.diagnostics.length
      ? payload.code.content.split(/\r\n|\r|\n/)
      : undefined;
  const boundPosition = (point: vscode.Position) => {
    const line = Math.max(0, Math.min(point.line, lines!.length - 1));
    return new vscode.Position(
      line,
      Math.max(0, Math.min(point.character, lines![line].length)),
    );
  };
  const bound = (range: vscode.Range) =>
    document
      ? document.validateRange(range)
      : lines
        ? new vscode.Range(boundPosition(range.start), boundPosition(range.end))
        : range;
  return payload.diagnostics.map((d) => ({
    message: d.message,
    range: bound(rangeFrom(d.location)),
    severity:
      d.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : d.severity === 'info'
          ? vscode.DiagnosticSeverity.Information
          : vscode.DiagnosticSeverity.Warning,
    source: 'stitch',
  }));
}
