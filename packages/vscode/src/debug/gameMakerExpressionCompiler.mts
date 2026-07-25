import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

interface CompilerResponse {
  Ok: boolean;
  Id?: number | null;
  Bytes?: string | null;
  Errors?: number;
  Message?: string | null;
  Log?: string | null;
}

interface PendingCompile {
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface GameMakerExpressionCompilerOptions {
  assetCompilerPath: string;
  projectPath: string;
  prefabsPath: string;
  startupHookPath?: string;
}

export class GameMakerExpressionCompileError extends Error {
  constructor(
    message: string,
    readonly errorCount = 1,
  ) {
    super(message);
  }
}

export class GameMakerExpressionCompiler {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCompile>();
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private nextId = 1;
  private stderr = '';
  private closed = false;

  constructor(private readonly options: GameMakerExpressionCompilerOptions) {}

  compileExpression(
    expression: string,
    locals: string[],
    globals: string[],
    name?: string,
  ) {
    return this.compile('expression', expression, locals, globals, name);
  }

  compileStatement(
    statement: string,
    locals: string[],
    globals: string[],
    name?: string,
  ) {
    return this.compile('statement', statement, locals, globals, name);
  }

  private async compile(
    kind: 'expression' | 'statement',
    code: string,
    locals: string[],
    globals: string[],
    name?: string,
  ) {
    await this.ensureStarted();
    const process = this.process;
    if (!process || !process.stdin.writable) {
      throw new Error('GameMaker expression compiler is not running.');
    }
    const id = this.nextId++;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out compiling the GameMaker expression.'));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      process.stdin.write(
        `${JSON.stringify({
          Id: id,
          Kind: kind,
          Name: name ?? `gml_Script_vscode_debug_${id}`,
          Code: code,
          Locals: locals,
          Globals: globals,
        })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        },
      );
    });
  }

  private ensureStarted() {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const startupHookPath =
      this.options.startupHookPath ??
      path.join(__dirname, 'GameMakerExpressionHook.dll');
    const process = spawn(this.options.assetCompilerPath, [], {
      cwd: path.dirname(this.options.assetCompilerPath),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...globalThis.process.env,
        DOTNET_STARTUP_HOOKS: startupHookPath,
      },
    });
    this.process = process;
    readline.createInterface({ input: process.stdout }).on('line', (line) => {
      this.handleLine(line);
    });
    process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384);
    });
    process.once('error', (error) => this.fail(error));
    process.once('close', (code) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      this.fail(
        new Error(
          `GameMaker expression compiler exited with code ${code}.${detail ? ` ${detail}` : ''}`,
        ),
      );
    });
    process.stdin.write(
      `${JSON.stringify({
        Project: this.options.projectPath,
        Prefabs: this.options.prefabsPath,
      })}\n`,
    );
    return this.ready;
  }

  private handleLine(line: string) {
    let response: CompilerResponse;
    try {
      response = JSON.parse(line) as CompilerResponse;
    } catch {
      this.fail(
        new Error(
          `Invalid response from GameMaker expression compiler: ${line}`,
        ),
      );
      return;
    }
    if (response.Id == null) {
      if (response.Ok) {
        this.readyResolve?.();
      } else {
        this.readyReject?.(this.responseError(response));
      }
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(response.Id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.Id);
    if (!response.Ok) {
      pending.reject(this.responseError(response));
      return;
    }
    pending.resolve(Buffer.from(response.Bytes ?? '', 'base64'));
  }

  private responseError(response: CompilerResponse) {
    const message =
      response.Message?.trim() ||
      response.Log?.trim() ||
      'GameMaker could not compile the expression.';
    return new GameMakerExpressionCompileError(message, response.Errors ?? 1);
  }

  private fail(error: Error) {
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const process = this.process;
    if (!process) return;
    process.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        process.kill();
        resolve();
      }, 2_000);
      process.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
