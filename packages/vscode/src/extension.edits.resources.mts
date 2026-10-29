import type { ProjectEditBatch } from '@bscotch/gml-parser';

type Move = ProjectEditBatch['renames'][number];
function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}
export function resourcePathKey(value: string): string {
  const path = normalized(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
function overlaps(left: string, right: string): boolean {
  const a = resourcePathKey(left),
    b = resourcePathKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Adjacent VS Code moves capture the same original working-copy paths.
 * Keep dependent moves in separate groups, preserving whole-directory Undo.
 */
export function prepareResourceMoves(
  renames: ProjectEditBatch['renames'],
): Move[][] {
  const groups: Move[][] = [];
  for (const move of renames) {
    if (
      resourcePathKey(move.from) === resourcePathKey(move.to) &&
      normalized(move.from) !== normalized(move.to)
    ) {
      // VS Code canonicalizes both endpoints before executing the batch.
      // A temporary name in this same batch cannot preserve the new casing.
      throw new Error(
        'VS Code cannot safely apply a case-only resource rename through a workspace edit.',
      );
    }
    let current = groups.at(-1);
    if (
      !current ||
      current.some(
        (previous) =>
          overlaps(previous.from, move.from) ||
          overlaps(previous.to, move.from) ||
          overlaps(previous.from, move.to) ||
          overlaps(previous.to, move.to),
      )
    ) {
      groups.push((current = []));
    }
    current.push(move);
  }
  return groups;
}
