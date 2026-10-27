import { Pathy } from '@bscotch/pathy';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogWorkspaceFolder {
  readonly uri: { readonly fsPath: string };
}

export interface LogHost {
  workspaceFolders(): readonly LogWorkspaceFolder[] | undefined;
  appendLine(line: string): void;
  console(type: LogLevel, ...args: string[]): void;
}

function fallbackString(value: unknown): string {
  try {
    // Do not run user-defined inspection hooks or getters in the fallback.
    return inspect(value, { customInspect: false, getters: false, depth: 3 });
  } catch {
    return '[Unformattable log value]';
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorField(
  error: Error,
  field: 'message' | 'stack' | 'cause',
): unknown {
  try {
    return error[field];
  } catch {
    return `[Unreadable error ${field}]`;
  }
}

/** Preserve error stacks and causes without recursing through cyclic causes. */
export function stringifyError(error: Error, includeStack = false): string {
  const lines: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined) {
    const indentation = '  '.repeat(depth);
    const label = depth === 0 ? 'ERROR' : 'CAUSE';
    if (!isError(current)) {
      lines.push(`${indentation}${label}: ${formatLogArgument(current)}`);
      break;
    }
    if (seen.has(current)) {
      lines.push(`${indentation}${label}: [Circular error cause]`);
      break;
    }
    seen.add(current);
    const message = errorField(current, 'message');
    lines.push(
      `${indentation}${label}: ${typeof message === 'string' ? message : fallbackString(message)}`,
    );
    const stack = includeStack ? errorField(current, 'stack') : undefined;
    if (typeof stack === 'string' && stack) {
      lines.push(
        ...stack.split(/\r?\n/).map((line) => `${indentation}${line}`),
      );
    }
    current = errorField(current, 'cause');
    depth++;
  }
  return lines.join('\n');
}

/** A failed conversion of one argument must not discard the other arguments. */
export function formatLogArgument(
  value: unknown,
  workspaceFolders?: () => readonly LogWorkspaceFolder[] | undefined,
  jsonIndent?: number,
): string {
  try {
    if (isError(value)) return stringifyError(value, true);
    if (value instanceof Pathy) {
      try {
        const root = workspaceFolders?.()?.[0]?.uri.fsPath;
        return root ? value.relativeFrom(root) : value.absolute;
      } catch {
        return value.absolute;
      }
    }
    if (value && typeof value === 'object') {
      if ('uri' in value && value.uri && typeof value.uri === 'object') {
        // Text documents are logged as their URI, rather than their contents.
        value = value.uri;
      }
      if (value && typeof value === 'object' && 'fsPath' in value) {
        return String(value.fsPath);
      }
      if (String(value) === '[object Object]') {
        return JSON.stringify(value, undefined, jsonIndent) ?? String(value);
      }
    }
    return String(value);
  } catch {
    return fallbackString(value);
  }
}

/** Each sink is best-effort and independent; never log a logging failure. */
export function writeLogLine(
  line: string,
  appendLine: (line: string) => void,
  echo: () => void,
): void {
  try {
    appendLine(line);
  } catch {}
  try {
    echo();
  } catch {}
}

export function emitLog(
  host: LogHost,
  type: LogLevel,
  channel: string,
  prefix: string | undefined,
  args: readonly unknown[],
): void {
  const timestamp = new Date().toISOString().replace(/^.*T(.*)Z$/, '$1');
  const components = [type.toUpperCase(), timestamp];
  if (prefix) components.push(`[${prefix}]`);
  for (const arg of args) {
    components.push(formatLogArgument(arg, () => host.workspaceFolders()));
  }
  writeLogLine(
    components.join(' '),
    (line) => host.appendLine(line),
    () => host.console(type, channel, ...components),
  );
}

export function getErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  while (isError(error) && !seen.has(error)) {
    seen.add(error);
    const message = errorField(error, 'message');
    if (typeof message === 'string' && message) messages.push(message);
    error = errorField(error, 'cause');
  }
  return messages.join(' ← ');
}
