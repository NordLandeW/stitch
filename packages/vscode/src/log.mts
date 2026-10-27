import vscode from 'vscode';
import { emitLog, formatLogArgument, writeLogLine } from './log.core.mjs';

export { getErrorMessage } from './log.core.mjs';

export async function showErrorMessage<T extends string>(
  message: string | Error,
  ...items: T[]
) {
  return await vscode.window.showErrorMessage(
    typeof message === 'string' ? message : message.message,
    ...items,
  );
}

/**
 * Create a drop-in replacement for `console` that will
 * write to both STDI/O and to a VSCode output channel.
 */
export class Logger {
  static outputChannels = new Map<string, vscode.OutputChannel>();
  private static active = true;

  // Allocate channels only inside the guarded output path. Construction and
  // prefix creation must remain safe if the editor output API is unavailable.
  constructor(
    readonly channel: string,
    readonly prefix?: string,
  ) {}

  static resume(): void {
    this.active = true;
  }

  withPrefix(prefix: string) {
    return new Logger(this.channel, prefix);
  }

  get output() {
    if (!Logger.active) throw new Error('Output-channel logging is inactive');
    let output = Logger.outputChannels.get(this.channel);
    if (!output) {
      output = vscode.window.createOutputChannel(this.channel, 'stitch-logs');
      Logger.outputChannels.set(this.channel, output);
    }
    return output;
  }

  static disposeAll(): void {
    this.active = false;
    const channels = [...this.outputChannels.values()];
    this.outputChannels.clear();
    for (const output of channels) {
      try {
        output.dispose();
      } catch {
        /* A failed channel cannot retain its peers. */
      }
    }
  }

  protected emit(type: 'debug' | 'info' | 'warn' | 'error', ...args: any[]) {
    emitLog(
      {
        workspaceFolders: () => vscode.workspace.workspaceFolders,
        appendLine: (line) => this.output.appendLine(line),
        console: (level, ...components) => console[level](...components),
      },
      type,
      this.channel,
      this.prefix,
      args,
    );
  }

  log(...args: any[]) {
    this.emit('info', ...args);
  }

  debug(...args: any[]) {
    this.emit('debug', ...args);
  }

  info(...args: any[]) {
    this.emit('info', ...args);
  }

  warn(...args: any[]) {
    this.emit('warn', ...args);
  }

  error(...args: any[]) {
    this.emit('error', ...args);
  }

  dir(obj: any, options?: any) {
    writeLogLine(
      formatLogArgument(obj, () => vscode.workspace.workspaceFolders, 2),
      (line) => this.output.appendLine(line),
      () => console.dir(obj, options),
    );
  }
}

export const logger = new Logger('Stitch');

export function info(...args: any[]) {
  logger.info(...args);
}

export function warn(...args: any[]) {
  logger.warn(...args);
}

export class Timer {
  start = Date.now();
  restart() {
    this.start = Date.now();
  }
  millis(message: string) {
    info(message, Date.now() - this.start, 'millis');
  }
  seconds(message: string) {
    info(message, (Date.now() - this.start) / 1000, 'seconds');
  }

  static start() {
    const timer = new Timer();
    return timer;
  }
}
