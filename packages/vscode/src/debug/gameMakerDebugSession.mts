import {
  Breakpoint,
  ContinuedEvent,
  ErrorDestination,
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  Variable,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import net from 'node:net';
import path from 'node:path';
import {
  GameMakerExpressionCompiler,
  GameMakerExpressionCompilerOptions,
} from './gameMakerExpressionCompiler.mjs';
import {
  GameMakerBreakpointLocation,
  GameMakerDebugScript,
  GameMakerProtocolClient,
  GameMakerSourceFile,
  GameMakerStoppedState,
  GameMakerValue,
  GameMakerVariable,
} from './gameMakerProtocol.mjs';

const THREAD_ID = 1;
const NULL_INSTANCE_ID = 0xffff_ffff;
const GAMEMAKER_DEBUG_PORT_FIRST = 6509;
const GAMEMAKER_DEBUG_PORT_LAST = 7508;

interface RegisteredVariable {
  variable: GameMakerVariable;
  evaluateName?: string;
  writable?: boolean;
}

interface VariableContainer {
  variables?: RegisteredVariable[];
  load?: () => Promise<RegisteredVariable[]>;
}

interface ResolvedBreakpoint extends GameMakerBreakpointLocation {
  condition?: string;
  conditionBytes?: Buffer;
}

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
  expressionCompilerOptions?(
    args: GameMakerLaunchRequestArguments,
  ): Promise<GameMakerExpressionCompilerOptions>;
}

function canonicalSource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function findAvailablePort() {
  for (const port of debugPortCandidates()) {
    const server = net.createServer();
    const available = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!available) continue;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
  }
  throw new Error(
    `Could not allocate a GameMaker debugger port in the supported range ${GAMEMAKER_DEBUG_PORT_FIRST}-${GAMEMAKER_DEBUG_PORT_LAST}.`,
  );
}

function debugPortCandidates(randomValue = Math.random()) {
  const count = GAMEMAKER_DEBUG_PORT_LAST - GAMEMAKER_DEBUG_PORT_FIRST + 1;
  const normalized = Math.max(0, Math.min(0.999_999_999_999, randomValue));
  const start = Math.floor(normalized * count);
  return Array.from(
    { length: count },
    (_, offset) => GAMEMAKER_DEBUG_PORT_FIRST + ((start + offset) % count),
  );
}

export class GameMakerDebugSession extends LoggingDebugSession {
  private readonly protocol = new GameMakerProtocolClient();
  private readonly requestedBreakpoints = new Map<
    string,
    ResolvedBreakpoint[]
  >();
  private readonly sentBreakpoints = new Map<string, string>();
  private readonly sourceReferences = new Map<number, GameMakerDebugScript>();
  private readonly scriptReferences = new Map<GameMakerDebugScript, number>();
  private readonly variableContainers = new Map<number, VariableContainer>();

  private launchArgs?: GameMakerLaunchRequestArguments;
  private expressionCompiler?: GameMakerExpressionCompiler;
  private stoppedState?: GameMakerStoppedState;
  private configured = false;
  private ending = false;
  private disposed = false;
  private nextSourceReference = 1;
  private nextVariableReference = 1;
  private nextEvaluateId = 1;
  private readonly staleReferenceWarnings = new Set<number>();

  constructor(private readonly host: GameMakerDebugSessionHost) {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.protocol.on('stopped', (state) => {
      if (this.disposed) return;
      this.stoppedState = state;
      this.resetVariableReferences();
      this.sendEvent(new StoppedEvent(state.reason, THREAD_ID));
    });
    this.protocol.on('continued', () => {
      if (this.disposed) return;
      this.stoppedState = undefined;
      this.resetVariableReferences();
      this.sendEvent(new ContinuedEvent(THREAD_ID, true));
    });
    this.protocol.on('terminated', (error) => {
      if (this.disposed) return;
      if (error) {
        this.sendEvent(new OutputEvent(`${error.message}\n`, 'stderr'));
      }
      if (!this.ending) this.sendEvent(new TerminatedEvent());
    });
  }

  override dispose() {
    this.disposed = true;
    void this.endSession();
    super.dispose();
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
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsFunctionBreakpoints = false;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSetVariable = true;
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
      if (this.ending) {
        await this.host.stop(args);
        return;
      }
      await this.protocol.connect('127.0.0.1', port);
      if (this.ending) return;
      const metadata = this.protocol.metadata;
      if (!metadata)
        throw new Error('GameMaker debugger metadata was not loaded.');
      metadata.mapSources(await this.host.loadSources(args));
      if (this.ending) return;
      if (this.host.expressionCompilerOptions) {
        const compilerOptions = await this.host.expressionCompilerOptions(args);
        if (this.ending) return;
        this.expressionCompiler = new GameMakerExpressionCompiler(
          compilerOptions,
        );
      }
      this.sendEvent(
        new OutputEvent(
          `Connected to GameMaker debugger protocol ${metadata.version}.\n`,
          'console',
        ),
      );
      this.sendEvent(new InitializedEvent());
      this.sendResponse(response);
    } catch (error) {
      if (this.ending) return;
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

    const locations: ResolvedBreakpoint[] = [];
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    for (const requested of args.breakpoints ?? []) {
      const location = metadata.breakpointForSource(sourcePath, requested.line);
      if (!location) {
        breakpoints.push(new Breakpoint(false, requested.line));
        continue;
      }
      let conditionBytes: Buffer | undefined;
      if (requested.condition) {
        try {
          if (!this.expressionCompiler) {
            throw new Error('GameMaker expression compiler is not available.');
          }
          conditionBytes = await this.expressionCompiler.compileExpression(
            requested.condition,
            [
              ...(location.script.argumentNames ?? []),
              ...(location.script.localNames ?? []),
            ],
            [],
            'gml_Script_bp',
          );
        } catch (error) {
          const breakpoint: DebugProtocol.Breakpoint = new Breakpoint(
            false,
            location.line,
            undefined,
            this.asSource(location.script),
          );
          breakpoint.message =
            error instanceof Error ? error.message : String(error);
          breakpoints.push(breakpoint);
          continue;
        }
      }
      locations.push({
        ...location,
        condition: requested.condition,
        conditionBytes,
      });
      breakpoints.push(
        new Breakpoint(
          true,
          location.line,
          undefined,
          this.asSource(location.script),
        ),
      );
    }
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

  protected override scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ) {
    const frame = this.stoppedState?.frames[args.frameId - 1];
    if (!frame || !this.stoppedState) {
      this.sendStaleReferenceError(
        response,
        1005,
        'Ignored a stale GameMaker stack-frame request after execution resumed.',
      );
      return;
    }

    const localReference = this.registerVariables(
      frame.locals.map((variable) => ({
        variable,
        evaluateName: variable.name,
        writable: args.frameId === 1,
      })),
    );
    const globalReference = this.registerVariables(
      this.stoppedState.globals.map((variable) => ({
        variable,
        evaluateName: `global.${variable.name}`,
        writable: args.frameId === 1,
      })),
    );
    const selfReference =
      args.frameId === 1 && this.stoppedState.selfInstance
        ? this.registerVariables(
            this.stoppedState.selfInstance.map((variable) => ({
              variable,
              evaluateName: `self.${variable.name}`,
              writable: true,
            })),
          )
        : this.registerValueChildren(frame.self, 'self', args.frameId === 1);
    const otherReference = this.registerValueChildren(
      frame.other,
      'other',
      args.frameId === 1,
    );

    const scopes = [
      new Scope('Locals', localReference, false),
      new Scope('Self', selfReference, false),
      new Scope('Globals', globalReference, true),
    ];
    if (
      frame.other.kind !== 'undefined' &&
      frame.other.kind !== 'null' &&
      frame.other.instanceId !== NULL_INSTANCE_ID
    ) {
      scopes.push(new Scope('Other', otherReference, false));
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected override async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ) {
    const container = this.variableContainers.get(args.variablesReference);
    if (!container || !this.stoppedState) {
      this.sendStaleReferenceError(
        response,
        1006,
        'Ignored a stale GameMaker variable request after execution resumed.',
      );
      return;
    }
    try {
      if (!container.variables && container.load) {
        container.variables = await container.load();
      }
      const start = args.start ?? 0;
      const variables = container.variables ?? [];
      const end =
        args.count && args.count > 0
          ? Math.min(variables.length, start + args.count)
          : variables.length;
      response.body = {
        variables: variables
          .slice(start, end)
          .map(({ variable, evaluateName, writable }) =>
            this.asVariable(variable, evaluateName, writable),
          ),
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ) {
    const state = this.stoppedState;
    const frameId = args.frameId ?? 1;
    const frame = state?.frames[frameId - 1];
    if (!state || !frame || frameId !== 1 || !this.expressionCompiler) {
      this.sendErrorResponse(
        response,
        1007,
        'GameMaker expressions can only be evaluated in the current top frame while paused.',
      );
      return;
    }
    try {
      const expression = this.prepareExpression(args.expression, frame, state);
      const vmBytes = await this.expressionCompiler.compileExpression(
        expression,
        frame.locals.map((variable) => variable.name),
        [],
      );
      const value = await this.protocol.evaluate(
        vmBytes,
        this.nextEvaluateId++,
      );
      const formatted = this.formatValue(value);
      const load = this.childLoader(value, args.expression);
      response.body = {
        result: formatted.value,
        type: formatted.type,
        variablesReference: load ? this.registerLoader(load) : 0,
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ) {
    const state = this.stoppedState;
    const frame = state?.frames[0];
    const container = this.variableContainers.get(args.variablesReference);
    const registered = container?.variables?.find(
      (candidate) => candidate.variable.name === args.name,
    );
    if (
      !state ||
      !frame ||
      !registered?.writable ||
      !registered.evaluateName ||
      !this.expressionCompiler
    ) {
      this.sendErrorResponse(
        response,
        1008,
        'This GameMaker variable cannot be changed in the current frame.',
      );
      return;
    }
    try {
      const statement = this.prepareExpression(
        `${registered.evaluateName} = ${args.value}; return ${registered.evaluateName};`,
        frame,
        state,
      );
      const vmBytes = await this.expressionCompiler.compileStatement(
        statement,
        frame.locals.map((variable) => variable.name),
        [],
      );
      const value = await this.protocol.evaluate(
        vmBytes,
        this.nextEvaluateId++,
      );
      registered.variable.value = value;
      const formatted = this.formatValue(value);
      const load = this.childLoader(value, registered.evaluateName);
      response.body = {
        value: formatted.value,
        type: formatted.type,
        variablesReference: load ? this.registerLoader(load) : 0,
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendControlError(response, error);
    }
  }

  protected override sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments,
  ) {
    const script = this.sourceReferences.get(args.sourceReference);
    if (!script) {
      this.sendStaleReferenceError(
        response,
        1003,
        `Ignored a stale GameMaker source request (reference ${args.sourceReference}).`,
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

  private sendStaleReferenceError(
    response: DebugProtocol.Response,
    id: number,
    message: string,
  ) {
    this.sendErrorResponse(
      response,
      id,
      message,
      undefined,
      0 as ErrorDestination,
    );
    if (this.staleReferenceWarnings.has(id) || this.disposed) return;
    this.staleReferenceWarnings.add(id);
    this.sendEvent(new OutputEvent(`${message}\n`, 'console'));
  }

  private async syncBreakpoints(force = false) {
    const desired = new Map<string, ResolvedBreakpoint>();
    for (const location of this.requestedBreakpoints.values()) {
      for (const breakpoint of location) {
        desired.set(breakpoint.address.toString(), breakpoint);
      }
    }
    const updates = [
      ...[...this.sentBreakpoints.keys()]
        .filter((address) => !desired.has(address))
        .map((address) => ({ address: BigInt(address), enabled: false })),
      ...[...desired]
        .filter(
          ([address, breakpoint]) =>
            this.sentBreakpoints.get(address) !==
            (breakpoint.conditionBytes?.toString('base64') ?? ''),
        )
        .map(([, breakpoint]) => ({
          address: breakpoint.address,
          enabled: true,
          condition: breakpoint.conditionBytes,
        })),
    ];
    if (force || updates.length) {
      await this.protocol.setBreakpoints(updates);
    }
    this.sentBreakpoints.clear();
    for (const [address, breakpoint] of desired) {
      this.sentBreakpoints.set(
        address,
        breakpoint.conditionBytes?.toString('base64') ?? '',
      );
    }
  }

  private resetVariableReferences() {
    this.variableContainers.clear();
    this.nextVariableReference = 1;
  }

  private registerVariables(variables: RegisteredVariable[]) {
    const reference = this.nextVariableReference++;
    this.variableContainers.set(reference, { variables });
    return reference;
  }

  private registerLoader(load: () => Promise<RegisteredVariable[]>) {
    const reference = this.nextVariableReference++;
    this.variableContainers.set(reference, { load });
    return reference;
  }

  private registerValueChildren(
    value: GameMakerValue,
    evaluateName?: string,
    writable = false,
  ) {
    const load = this.childLoader(value, evaluateName, undefined, writable);
    return load ? this.registerLoader(load) : this.registerVariables([]);
  }

  private childLoader(
    value: GameMakerValue,
    evaluateName?: string,
    explicitChildren?: GameMakerVariable[],
    writable = false,
  ) {
    if (explicitChildren) {
      return async () =>
        explicitChildren.map((variable) => ({
          variable,
          evaluateName: this.childEvaluateName(evaluateName, variable.name),
          writable,
        }));
    }
    if (value.kind === 'array' && value.reference !== undefined) {
      return async () =>
        (await this.protocol.fetchArray(value.reference!)).map((variable) => ({
          variable,
          evaluateName: this.childEvaluateName(evaluateName, variable.name),
          writable,
        }));
    }
    if (
      value.kind === 'object' &&
      value.objectKind !== 3 &&
      value.reference !== undefined
    ) {
      return async () =>
        (await this.protocol.fetchObject(value.reference!)).map((variable) => ({
          variable,
          evaluateName: this.childEvaluateName(evaluateName, variable.name),
          writable,
        }));
    }
    const instanceId = this.instanceId(value);
    if (instanceId !== undefined) {
      return async () =>
        (await this.protocol.fetchInstance(instanceId)).map((variable) => ({
          variable,
          evaluateName: this.childEvaluateName(evaluateName, variable.name),
          writable,
        }));
    }
    return undefined;
  }

  private instanceId(value: GameMakerValue) {
    if (value.instanceId !== undefined && value.instanceId < 0x8000_0000) {
      return value.instanceId;
    }
    if (
      (value.kind === 'ref' || value.kind === 'int64') &&
      value.reference !== undefined &&
      Number(value.reference >> 32n) === 67_108_865
    ) {
      const id = Number(value.reference & 0xffff_ffffn);
      return id < 0x8000_0000 ? id : undefined;
    }
    return undefined;
  }

  private asVariable(
    variable: GameMakerVariable,
    evaluateName?: string,
    writable = false,
  ): DebugProtocol.Variable {
    const formatted = this.formatValue(variable.value);
    const load = this.childLoader(
      variable.value,
      evaluateName,
      variable.children,
      writable,
    );
    const variablesReference = load ? this.registerLoader(load) : 0;
    const result: DebugProtocol.Variable = new Variable(
      variable.name,
      formatted.value,
      variablesReference,
    );
    result.type = formatted.type;
    result.evaluateName = evaluateName;
    if (!writable) {
      result.presentationHint = { attributes: ['readOnly'] };
    }
    if (variable.children) {
      result.namedVariables = variable.children.length;
    }
    return result;
  }

  private formatValue(value: GameMakerValue) {
    const reference = value.reference;
    switch (value.kind) {
      case 'real':
        return { value: String(value.value), type: 'real' };
      case 'string':
        return { value: JSON.stringify(value.value ?? ''), type: 'string' };
      case 'array':
        return {
          value: `${reference?.toString(16).toUpperCase() ?? '0'} <array>`,
          type: 'array',
        };
      case 'pointer':
        return {
          value: `0x${reference?.toString(16).toUpperCase() ?? '0'}`,
          type: 'pointer',
        };
      case 'undefined':
        return { value: '<undefined>', type: 'undefined' };
      case 'object':
        return {
          value:
            value.objectKind === 3
              ? `${reference?.toString(16).toUpperCase() ?? '0'} <function>`
              : `${reference?.toString(16).toUpperCase() ?? ''} <struct>`.trim(),
          type: value.objectKind === 3 ? 'function' : 'struct',
        };
      case 'int32':
        return { value: String(value.value), type: 'int32' };
      case 'int64':
        return {
          value: String(
            BigInt.asIntN(64, (value.value as bigint | undefined) ?? 0n),
          ),
          type: 'int64',
        };
      case 'null':
        return { value: 'null', type: 'null' };
      case 'bool':
        return { value: value.value ? 'true' : 'false', type: 'bool' };
      case 'ref': {
        const instanceId = this.instanceId(value);
        if (instanceId !== undefined) {
          return { value: `${instanceId} <instance>`, type: 'instance' };
        }
        const raw = reference ?? 0n;
        return {
          value: `${Number(raw & 0xffff_ffffn)} <ref>`,
          type: 'ref',
        };
      }
      default:
        return { value: '<invalid>', type: 'invalid' };
    }
  }

  private childEvaluateName(parent: string | undefined, name: string) {
    if (!parent) return undefined;
    if (/^\[\d+\]$/.test(name)) return `${parent}${name}`;
    if (/^[A-Za-z_]\w*$/.test(name)) return `${parent}.${name}`;
    return undefined;
  }

  private prepareExpression(
    expression: string,
    frame: GameMakerStoppedState['frames'][number],
    state: GameMakerStoppedState,
  ) {
    let prepared = expression;
    const trimmed = prepared.trim();
    if (
      /^[A-Za-z_]\w*$/.test(trimmed) &&
      !frame.locals.some((variable) => variable.name === trimmed) &&
      state.globals.some((variable) => variable.name === trimmed)
    ) {
      prepared = prepared.replace(trimmed, `global.${trimmed}`);
    }
    for (const [index, name] of (frame.script?.argumentNames ?? []).entries()) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      prepared = prepared.replace(
        new RegExp(`\\b${escaped}\\b`),
        `argument${index}`,
      );
    }
    return prepared;
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
    try {
      await this.expressionCompiler?.close();
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

export const gameMakerDebugSessionInternals = {
  debugPortCandidates,
  findAvailablePort,
};
