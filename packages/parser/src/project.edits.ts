import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface ProjectTextEdit {
  readonly start: number;
  /** Exclusive UTF-16 offset in expectedText. */
  readonly end: number;
  readonly text: string;
}
export interface ProjectDocumentEdit {
  readonly filePath: string;
  readonly expectedText: string;
  readonly edits: readonly ProjectTextEdit[];
}
export interface ProjectEditBatch {
  readonly label: string;
  /** All edits refer to pre-rename physical paths. */
  readonly documents: readonly ProjectDocumentEdit[];
  /** Ordered moves, performed after the document edits. */
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  /** Call after asynchronous preflight and immediately before applying edits. */
  readonly validate: () => void;
}

export class ProjectEditError extends Error {
  constructor(
    message: string,
    readonly affectedPaths: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`${message}\nAffected paths:\n${affectedPaths.join('\n')}`, options);
    this.name = 'ProjectEditError';
  }
}

export function editedText(document: ProjectDocumentEdit): string {
  const edits = [...document.edits].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let cursor = 0,
    output = '';
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < cursor ||
      edit.end < edit.start ||
      edit.end > document.expectedText.length
    )
      throw new Error(
        `Invalid or overlapping text edits: ${document.filePath}`,
      );
    output += document.expectedText.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + document.expectedText.slice(cursor);
}

function pathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase()
    : normalized;
}
export function renamedPath(
  path: string,
  renames: ProjectEditBatch['renames'],
): string {
  let current = path.replaceAll('\\', '/');
  for (const move of renames) {
    const from = move.from.replaceAll('\\', '/').replace(/\/$/, '');
    const to = move.to.replaceAll('\\', '/').replace(/\/$/, '');
    if (pathKey(current) === pathKey(from)) current = to;
    else if (pathKey(current).startsWith(`${pathKey(from)}/`))
      current = to + current.slice(from.length);
  }
  return current;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code || '',
      )
    )
      return false;
    throw error;
  }
}

/** Validate all paths before a host or disk writer begins changing anything. */
export async function validateRenames(
  renames: ProjectEditBatch['renames'],
): Promise<void> {
  const targets = new Set<string>();
  for (const move of renames) {
    if (!(await pathExists(move.from)))
      throw new Error(`Rename source is missing: ${move.from}`);
    const key = pathKey(move.to);
    if (targets.has(key))
      throw new Error(`Duplicate rename destination: ${move.to}`);
    targets.add(key);
    if (key !== pathKey(move.from) && (await pathExists(move.to)))
      throw new Error(`Rename destination already exists: ${move.to}`);
  }
}

async function replaceExpected(
  path: string,
  expected: string,
  replacement: string,
  validate?: () => void,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.stitch-${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const attributes = await lstat(path);
    if (!attributes.isFile() || attributes.isSymbolicLink())
      throw new Error(`Text edits require a regular file: ${path}`);
    await writeFile(temporary, replacement, { encoding: 'utf8', flag: 'wx' });
    created = true;
    await chmod(temporary, attributes.mode);
    if ((await readFile(path, 'utf8')) !== expected)
      throw new Error(`The file changed during edit preparation: ${path}`);
    validate?.();
    await rename(temporary, path);
    created = false;
  } finally {
    if (created) await unlink(temporary);
  }
}

/** A disk-only batch is preflighted in full and has verified, non-clobbering rollback.
 * This does not promise a cross-file filesystem transaction against other writers.
 */
export async function applyDiskEdits(batch: ProjectEditBatch): Promise<void> {
  const paths = [
    ...new Set([
      ...batch.documents.map((document) => document.filePath),
      ...batch.renames.flatMap((move) => [move.from, move.to]),
    ]),
  ];
  const documents = batch.documents.map((document) => ({
    ...document,
    output: editedText(document),
  }));
  const unique = new Set<string>();
  for (const document of documents) {
    if (unique.has(pathKey(document.filePath)))
      throw new ProjectEditError('Duplicate document edit', paths);
    unique.add(pathKey(document.filePath));
    const attributes = await lstat(document.filePath);
    if (!attributes.isFile() || attributes.isSymbolicLink())
      throw new ProjectEditError('Text edits require regular files', paths);
    await access(document.filePath, constants.R_OK | constants.W_OK);
    await access(dirname(document.filePath), constants.W_OK);
    if ((await readFile(document.filePath, 'utf8')) !== document.expectedText)
      throw new ProjectEditError(
        'A file changed before the edit batch was applied',
        paths,
      );
  }
  await validateRenames(batch.renames);
  for (const move of batch.renames) {
    await access(dirname(move.from), constants.W_OK);
    await access(dirname(move.to), constants.W_OK);
  }
  batch.validate();
  const written: typeof documents = [];
  const moved: ProjectEditBatch['renames'][number][] = [];
  try {
    for (const document of documents) {
      if (document.output === document.expectedText) continue;
      await replaceExpected(
        document.filePath,
        document.expectedText,
        document.output,
        batch.validate,
      );
      written.push(document);
    }
    for (const move of batch.renames) {
      if (
        pathKey(move.from) !== pathKey(move.to) &&
        (await pathExists(move.to))
      )
        throw new Error(
          `Rename destination appeared during application: ${move.to}`,
        );
      batch.validate();
      await rename(move.from, move.to);
      moved.push(move);
    }
  } catch (cause) {
    const failures: unknown[] = [];
    for (const move of [...moved].reverse()) {
      try {
        if (
          pathKey(move.from) !== pathKey(move.to) &&
          (await pathExists(move.from))
        )
          throw new Error(`Rollback destination is occupied: ${move.from}`);
        await rename(move.to, move.from);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const document of [...written].reverse()) {
      try {
        await replaceExpected(
          document.filePath,
          document.output,
          document.expectedText,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    throw new ProjectEditError(
      failures.length
        ? 'Edit application failed and rollback was incomplete; changed external content was not overwritten.'
        : 'Edit application failed; the completed disk operations were rolled back.',
      paths,
      {
        cause: failures.length
          ? new AggregateError([cause, ...failures])
          : cause,
      },
    );
  }
}
