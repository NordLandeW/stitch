import {
  Breakpoint,
  ContinuedEvent,
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import net from 'node:net';
import path from 'node:path';
import {
  GameMakerBreakpointLocation,
  GameMakerDebugScript,
  GameMakerProtocolClient,
  GameMakerSourceFile,
  GameMakerStoppedState,
} from './gameMakerProtocol.mjs';

const THREAD_ID = 1;

export interface GameMakerLaunchRequestArguments
  extends DebugProtocol.LaunchRequestArguments {
  type: 'gamemaker';
  request: 'launch';
  name: string;
  project: string;
  config?: string;
  debuggerPort?: number;
}

export interface GameMakerDebugSessionHost {
  launch(
    args: GameMakerLaunchRequestArguments,
    debuggerPort: number,
  ): Promise<void>;
  stop(args: GameMakerLaunchRequestArguments): Promise<void>;
  loadSources(
    args: GameMakerLaunchRequestArguments,
  ): Promise<GameMakerSourceFile[]>;
}

function canonicalSource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error('Could not allocate a GameMaker debugger port.');
  return port;
}

export class GameMakerDebugSession extends LoggingDebugSession {
  private readonly protocol = new GameMakerProtocolClient();
  private readonly requestedBreakpoints = new Map<
    string,
    GameMakerBreakpointLocation[]
  >();
  private readonly sentBreakpointAddresses = new Set<string>();
  private readonly sourceReferences = new Map<number, GameMakerDebugScript>();
  private readonly scriptReferences = new Map<GameMakerDebugScript, number>();

  private launchArgs?: GameMakerLaunchRequestArguments;
  private stoppedState?: GameMakerStoppedState;
  private configured = false;
  private ending = false;
  private nextSourceReference = 1;

  constructor(private readonly host: GameMakerDebugSessionHost) {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.protocol.on('stopped', (state) => {
      this.stoppedState = state;
      this.sendEvent(new StoppedEvent(state.reason, THREAD_ID));
    });
    this.protocol.on('continued', () => {
      this.stoppedState = undefined;
      this.sendEvent(new ContinuedEvent(THREAD_ID, true));
    });
    this.protocol.on('terminated', (error) => {
      if (error) {
        this.sendEvent(new OutputEvent(`${error.message}\n`, 'stderr'));
      }
      if (!this.ending) this.sendEvent(new TerminatedEvent());
    });
  }

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ) {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsRestartRequest = true;
    response.body.supportsTerminateRequest = true;
    response.body.supportTerminateDebuggee = true;
    response.body.supportsConditionalBreakpoints = false;
    response.body.supportsFunctionBreakpoints = false;
    response.body.supportsEvaluateForHovers = false;
    this.sendResponse(response);
  }

  protected override async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: GameMakerLaunchRequestArguments,
  ) {
    this.launchArgs = args;
    try {
      const port = args.debuggerPort ?? (await findAvailablePort());
      this.sendEvent(
        new OutputEvent(
          `Starting GameMaker VM debugger on 127.0.0.1:${port}...\n`,
          'console',
        ),
      );
      await this.host.launch(args, port);
      await this.protocol.connect('127.0.0.1', port);
      const metadata = this.protocol.metadata;
      if (!metadata)
        throw new Error('GameMaker debugger metadata was not loaded.');
      metadata.mapSources(await this.host.loadSources(args));
      this.sendEvent(
        new OutputEvent(
          `Connected to GameMaker debugger protocol ${metadata.version}.\n`,
          'console',
        ),
      );
      this.sendEvent(new InitializedEvent());
      this.sendResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.endSession();
      this.sendErrorResponse(response, 1001, message);
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected override async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ) {
    const sourcePath = args.source.path;
    const metadata = this.protocol.metadata;
    if (!sourcePath || !metadata) {
      response.body = {
        breakpoints: (args.breakpoints ?? []).map(
          (requested) => new Breakpoint(false, requested.line),
        ),
      };
      this.sendResponse(response);
      return;
    }

    const locations: GameMakerBreakpointLocation[] = [];
    const breakpoints = (args.breakpoints ?? []).map((requested) => {
      const location = metadata.breakpointForSource(sourcePath, requested.line);
      if (!location) return new Breakpoint(false, requested.line);
      locations.push(location);
      return new Breakpoint(
        true,
        location.line,
        undefined,
        this.asSource(location.script),
      );
    });
    const key = canonicalSource(sourcePath);
    this.requestedBreakpoints.set(key, locations);

    try {
      if (this.configured) {
        await this.syncBreakpoints();
      }
    } catch (error) {
      this.sendControlError(response, error);
      return;
    }

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected override async configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ) {
    try {
      // GameMaker's own debugger sends an initial breakpoint packet even when
      // it is empty, before allowing the target to start.
      await this.syncBreakpoints(true);
      this.configured = true;
      await this.protocol.start();
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1002,
        error instanceof Error ? error.message : String(error),
      );
      await this.endSession();
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse) {
    response.body = { threads: [new Thread(THREAD_ID, 'GameMaker Runner')] };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ) {
    const frames = this.stoppedState?.frames ?? [];
    const start = args.startFrame ?? 0;
    const end =
      args.levels && args.levels > 0
        ? Math.min(frames.length, start + args.levels)
        : frames.length;
    response.body = {
      stackFrames: frames.slice(start, end).map((frame, index) => {
        const source = frame.script ? this.asSource(frame.script) : undefined;
        return new StackFrame(
          start + index + 1,
          frame.name,
          source,
          frame.line,
          1,
        );
      }),
      totalFrames: frames.length,
    };
    this.sendResponse(response);
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse) {
    response.body = { scopes: [] };
    this.sendResponse(response);
  }

  protected override sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments,
  ) {
    const script = this.sourceReferences.get(args.sourceReference);
    if (!script) {
      this.sendErrorResponse(
        response,
        1003,
        'Unknown GameMaker source reference.',
      );
      return;
    }
    response.body = { content: script.text, mimeType: 'text/x-gml' };
    this.sendResponse(response);
  }

  protected override async continueRequest(
    response: DebugProtocol.ContinueResponse,
  ) {
    try {
      await this.protocol.continue();
      response.body = { allThreadsContinued: true };
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async pauseRequest(response: DebugProtocol.PauseResponse) {
    try {
      await this.protocol.pause();
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async nextRequest(response: DebugProtocol.NextResponse) {
    await this.step(response, 'over');
  }

  protected override async stepInRequest(
    response: DebugProtocol.StepInResponse,
  ) {
    await this.step(response, 'into');
  }

  protected override async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
  ) {
    await this.step(response, 'out');
  }

  private async step(
    response:
      | DebugProtocol.NextResponse
      | DebugProtocol.StepInResponse
      | DebugProtocol.StepOutResponse,
    kind: 'into' | 'over' | 'out',
  ) {
    try {
      await this.protocol.step(kind);
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async restartRequest(
    response: DebugProtocol.RestartResponse,
  ) {
    try {
      await this.protocol.restart();
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async terminateRequest(
    response: DebugProtocol.TerminateResponse,
  ) {
    await this.endSession();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  protected override async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
  ) {
    await this.endSession(args.terminateDebuggee !== false);
    this.sendResponse(response);
    if (args.terminateDebuggee !== false) this.sendEvent(new TerminatedEvent());
  }

  private sendControlError(response: DebugProtocol.Response, error: unknown) {
    this.sendErrorResponse(
      response,
      1004,
      error instanceof Error ? error.message : String(error),
    );
  }

  private async syncBreakpoints(force = false) {
    const desired = new Map<string, bigint>();
    for (const location of this.requestedBreakpoints.values()) {
      for (const breakpoint of location) {
        desired.set(breakpoint.address.toString(), breakpoint.address);
      }
    }
    const updates = [
      ...[...this.sentBreakpointAddresses]
        .filter((address) => !desired.has(address))
        .map((address) => ({ address: BigInt(address), enabled: false })),
      ...[...desired]
        .filter(([address]) => !this.sentBreakpointAddresses.has(address))
        .map(([, address]) => ({ address, enabled: true })),
    ];
    if (force || updates.length) {
      await this.protocol.setBreakpoints(updates);
    }
    this.sentBreakpointAddresses.clear();
    for (const address of desired.keys()) {
      this.sentBreakpointAddresses.add(address);
    }
  }

  private asSource(script: GameMakerDebugScript) {
    if (script.sourcePath) {
      return new Source(
        path.basename(script.sourcePath),
        script.sourcePath,
        0,
        'GameMaker',
      );
    }
    let reference = this.scriptReferences.get(script);
    if (!reference) {
      reference = this.nextSourceReference++;
      this.scriptReferences.set(script, reference);
      this.sourceReferences.set(reference, script);
    }
    return new Source(
      script.displayName || script.name,
      undefined,
      reference,
      'GameMaker',
    );
  }

  private async endSession(terminateDebuggee = true) {
    if (this.ending) return;
    this.ending = true;
    try {
      await this.protocol.close();
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `${error instanceof Error ? error.message : String(error)}\n`,
          'stderr',
        ),
      );
    }
    if (terminateDebuggee && this.launchArgs) {
      try {
        await this.host.stop(this.launchArgs);
      } catch (error) {
        this.sendEvent(
          new OutputEvent(
            `${error instanceof Error ? error.message : String(error)}\n`,
            'stderr',
          ),
        );
      }
    }
  }
}
