import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  GameMakerDebugSession,
  gameMakerDebugSessionInternals,
} from './gameMakerDebugSession.mjs';
import {
  GameMakerBinaryReader,
  GameMakerDebugMetadata,
  GameMakerProtocolClient,
  gameMakerProtocolInternals,
} from './gameMakerProtocol.mjs';

const {
  command,
  makeBatch,
  makeBreakpointCommand,
  makeCommand,
  normalizeSource,
  readStoppedSupplementalData,
  stepType,
} = gameMakerProtocolInternals;

function debuggerString(value: string) {
  const bytes = Buffer.from(value, 'latin1');
  const result = Buffer.alloc(4 + bytes.length + 1);
  result.writeUInt32LE(bytes.length + 1);
  bytes.copy(result, 4);
  return result;
}

test('encodes fixed-size GameMaker debugger commands', () => {
  const packet = makeCommand(command.singleStepLine, [stepType.over]);

  assert.equal(packet.length, 44);
  assert.equal(packet.readUInt32LE(0), 0xbe11c0de);
  assert.equal(packet.readUInt32LE(4), 44);
  assert.equal(packet.readUInt32LE(8), 44);
  assert.equal(packet.readUInt32LE(12), command.singleStepLine);
  assert.equal(packet.readUInt32LE(16), stepType.over);
});

test('encodes batch requests with their actual packet size', () => {
  const packet = makeBatch(command.ping, [17, 0]);

  assert.equal(packet.length, 32);
  assert.equal(packet.readUInt32LE(4), 44);
  assert.equal(packet.readUInt32LE(8), 32);
  assert.equal(packet.readUInt32LE(12), command.batch);
  assert.equal(packet.readUInt32LE(16), 1);
  assert.equal(packet.readUInt32LE(20), command.ping);
  assert.equal(packet.readUInt32LE(24), 17);
  assert.equal(packet.readUInt32LE(28), 0);
});

test('encodes enabled and disabled 64-bit breakpoint addresses', () => {
  const condition = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const packet = makeBreakpointCommand([
    {
      address: 0x1234_5678_9abcn,
      enabled: true,
      condition,
    },
    { address: 0xfedc_ba98_7654n, enabled: false },
  ]);

  assert.equal(packet.length, 56);
  assert.equal(packet.readUInt32LE(8), 56);
  assert.equal(packet.readUInt32LE(12), command.startBreakpoint);
  assert.equal(packet.readUInt32LE(16), 2);
  assert.equal(packet.readBigUInt64LE(20), 0x1234_5678_9abcn);
  assert.equal(packet.readUInt32LE(28), 1);
  assert.equal(packet.readUInt32LE(32), condition.length);
  assert.deepEqual(packet.subarray(36, 40), condition);
  assert.equal(packet.readBigUInt64LE(40), 0xfedc_ba98_7654n);
  assert.equal(packet.readUInt32LE(48), 0);
  assert.equal(packet.readUInt32LE(52), 0);
});

test('maps compiled scripts to workspace sources and resolves line breakpoints', () => {
  const metadata = new GameMakerDebugMetadata();
  metadata.scripts.push({
    index: 0,
    name: 'gml_Object_debug_object_Step_0',
    displayName: 'debug_object.Step',
    resourceName: 'debug_object',
    text: 'counter += 1;\nshow_debug_message(counter);',
    baseAddress: 0x1000n,
    offsetAddress: 0x1000n,
    vmSize: 32n,
    debugInfo: {
      text: 'counter += 1;\nshow_debug_message(counter);',
      vmAddresses: [
        { address: 0, sourceOffset: 0 },
        { address: 12, sourceOffset: 14 },
      ],
      lineStarts: [0, 14],
      lineEnds: [13, 42],
    },
  });
  const sourcePath = 'C:/project/objects/debug_object/Step_0.gml';
  metadata.mapSources([
    {
      path: sourcePath,
      text: '\uFEFFcounter += 1;\r\nshow_debug_message(counter);\r\n',
    },
  ]);

  assert.equal(metadata.scriptsForSource(sourcePath).length, 1);
  const breakpoint = metadata.breakpointForSource(sourcePath, 2);
  assert.equal(breakpoint?.line, 2);
  assert.equal(breakpoint?.address, 0x100cn);
  assert.equal(normalizeSource('\uFEFFa\r\nb\r\n'), 'a\nb');
});

test('advertises the DAP controls implemented by the GameMaker session', async () => {
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {},
    async loadSources() {
      return [];
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  session.start(input, output);

  const response = new Promise<any>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timeout = setTimeout(
      () => reject(new Error('Timed out reading the DAP initialize response.')),
      2_000,
    );
    output.on('data', (data) => {
      received = Buffer.concat([received, Buffer.from(data)]);
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = received.subarray(0, headerEnd).toString('ascii');
      const size = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      const bodyStart = headerEnd + 4;
      if (!size || received.length < bodyStart + size) return;
      clearTimeout(timeout);
      resolve(
        JSON.parse(
          received.subarray(bodyStart, bodyStart + size).toString('utf8'),
        ),
      );
    });
  });
  const request = JSON.stringify({
    seq: 1,
    type: 'request',
    command: 'initialize',
    arguments: {
      adapterID: 'gamemaker',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
    },
  });
  input.write(
    `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
  );

  const initialize = await response;
  assert.equal(initialize.success, true);
  assert.equal(initialize.body.supportsConfigurationDoneRequest, true);
  assert.equal(initialize.body.supportsRestartRequest, true);
  assert.equal(initialize.body.supportsTerminateRequest, true);
  assert.equal(initialize.body.supportTerminateDebuggee, true);
  assert.equal(initialize.body.supportsConditionalBreakpoints, true);
  assert.equal(initialize.body.supportsExceptionInfoRequest, true);
  assert.equal(initialize.body.supportsEvaluateForHovers, false);
  assert.equal(initialize.body.supportsSetVariable, true);
  input.destroy();
  output.destroy();
});

test('arms the window focus guard before continuing GameMaker', async () => {
  const calls: string[] = [];
  let cancellations = 0;
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {},
    async loadSources() {
      return [];
    },
    armContinueFocusGuard() {
      calls.push('guard');
      return () => cancellations++;
    },
  });
  const internals = session as any;
  internals.protocol.continue = async () => calls.push('continue');
  internals.sendResponse = () => calls.push('response');

  await internals.continueRequest({});

  assert.deepEqual(calls, ['guard', 'continue', 'response']);
  internals.clearContinueFocusGuard();
  assert.equal(cancellations, 1);
});

test('reads GameMaker exception details from the end of a stopped update', async () => {
  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const u64 = (value: bigint) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return buffer;
  };
  const body = Buffer.concat([
    u32(command.batch),
    u32(1),
    u32(command.getUpdate),
    u32(1),
    u32(0),
    u64(0n),
    u64(0xffff_ffff_ffff_ffffn),
    u32(0),
    debuggerString('Runner debug output'),
    ...Array.from({ length: 6 }, () => u32(0)),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    debuggerString(
      'Variable obj_player.health not set before reading it.',
    ),
  ]);
  const client = new GameMakerProtocolClient();
  const internals = client as any;
  internals.metadata = { version: 17 };
  internals.request = async () => body;

  const state = await internals.readStoppedState();

  assert.equal(state.reason, 'exception');
  assert.equal(
    state.exceptionMessage,
    'Variable obj_player.health not set before reading it.',
  );
  assert.deepEqual(state.frames, []);
  assert.deepEqual(state.globals, []);

  const supplementalBuffer = Buffer.concat([
    debuggerString('output'),
    ...Array.from({ length: 6 }, () => u32(0)),
    u32(2),
    Buffer.alloc(16),
    u32(3),
    Buffer.alloc(12),
    u32(2),
    u32(1),
    Buffer.alloc(8),
    Buffer.alloc(8),
    debuggerString('error'),
  ]);
  const supplementalReader = new GameMakerBinaryReader(supplementalBuffer);
  assert.deepEqual(readStoppedSupplementalData(supplementalReader, 17), {
    debugOutput: 'output',
    exceptionMessage: 'error',
  });
  assert.equal(supplementalReader.remaining, 0);
});

test('reports a stopped GameMaker exception through DAP', () => {
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {},
    async loadSources() {
      return [];
    },
  });
  const internals = session as any;
  const events: any[] = [];
  let responseBody: any;
  internals.sendEvent = (event: any) => events.push(event);
  internals.sendResponse = (response: any) => {
    responseBody = response.body;
  };
  internals.protocol.emit('stopped', {
    reason: 'exception',
    frames: [],
    globals: [],
    exceptionMessage: 'GameMaker runtime error details',
  });

  const stopped = events[0];
  assert.equal(stopped.event, 'stopped');
  assert.equal(stopped.body.reason, 'exception');
  assert.equal(stopped.body.description, 'Paused on GameMaker exception');
  assert.equal(stopped.body.text, 'GameMaker runtime error details');

  internals.exceptionInfoRequest(
    {
      seq: 0,
      type: 'response',
      request_seq: 1,
      command: 'exceptionInfo',
      success: true,
    },
    { threadId: 1 },
  );
  assert.deepEqual(responseBody, {
    exceptionId: 'GameMaker Runtime Error',
    description: 'GameMaker runtime error details',
    breakMode: 'always',
    details: {
      message: 'GameMaker runtime error details',
      typeName: 'GameMaker Runtime Error',
    },
  });
});

test('compiles watched project functions through the GameMaker global instance', async () => {
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {},
    async loadSources() {
      return [];
    },
  });
  const internals = session as any;
  let compilerExpression: string | undefined;
  let compilerGlobals: string[] | undefined;
  let compilerLocals: string[] | undefined;
  let responseBody: any;
  internals.stoppedState = {
    reason: 'pause',
    frames: [
      {
        name: 'debug_object.Step',
        line: 1,
        address: 0,
        locals: [
          {
            name: 'current_execution_frame_local',
            value: { kind: 'real', rawKind: 0, value: 1 },
          },
        ],
        self: { kind: 'undefined', rawKind: 5 },
        other: { kind: 'undefined', rawKind: 5 },
      },
      {
        name: 'debug_object.Step',
        line: 1,
        address: 0,
        locals: [
          {
            name: 'caller_frame_local',
            value: { kind: 'real', rawKind: 0, value: 2 },
          },
        ],
        self: { kind: 'undefined', rawKind: 5 },
        other: { kind: 'undefined', rawKind: 5 },
      },
    ],
    globals: [],
  };
  internals.protocol.metadata = new GameMakerDebugMetadata();
  internals.protocol.metadata.scripts.push({
    name: 'gml_Script_player_exists',
    displayName: 'player_exists',
  });
  internals.expressionCompiler = {
    async compileExpression(
      expression: string,
      locals: string[],
      globals: string[],
    ) {
      compilerExpression = expression;
      compilerLocals = locals;
      compilerGlobals = globals;
      return Buffer.from([1]);
    },
  };
  internals.protocol.evaluate = async () => ({
    kind: 'bool',
    rawKind: 13,
    value: true,
  });
  internals.sendResponse = (response: any) => {
    responseBody = response.body;
  };

  await internals.evaluateRequest(
    {
      seq: 0,
      type: 'response',
      request_seq: 1,
      command: 'evaluate',
      success: true,
    },
    {
      expression: 'player_exists()',
      frameId: 2,
      context: 'watch',
    },
  );

  assert.deepEqual(compilerLocals, ['current_execution_frame_local']);
  assert.equal(compilerExpression, 'global.player_exists()');
  assert.deepEqual(compilerGlobals, []);
  assert.equal(responseBody.result, 'true');
});

test('scans every safe GameMaker debugger port from a random start', () => {
  const ports = gameMakerDebugSessionInternals.debugPortCandidates(0.5);

  assert.equal(ports.length, 1_000);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(ports[0], 7_009);
  assert.equal(ports.at(-1), 7_008);
  assert.equal(Math.min(...ports), 6_509);
  assert.equal(Math.max(...ports), 7_508);
});

test('cancels an in-flight GameMaker debugger handshake immediately', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  const client = new GameMakerProtocolClient();
  const connecting = client.connect('127.0.0.1', address.port, 10_000);
  const [socket] = (await once(server, 'connection')) as [net.Socket];
  const socketClosed = once(socket, 'close');
  const started = Date.now();
  await client.close();
  await socketClosed;

  await assert.rejects(connecting, /cancelled/i);
  assert(Date.now() - started < 1_000);
  server.close();
  await once(server, 'close');
});

test('disposing an inline GameMaker adapter stops a pending launch', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {
      stopResolve?.();
    },
    async loadSources() {
      return [];
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  session.start(input, output);
  const launch = JSON.stringify({
    seq: 1,
    type: 'request',
    command: 'launch',
    arguments: {
      type: 'gamemaker',
      request: 'launch',
      name: 'Dispose test',
      project: 'test.yyp',
      debuggerPort: address.port,
    },
  });
  input.write(`Content-Length: ${Buffer.byteLength(launch)}\r\n\r\n${launch}`);
  const [socket] = (await once(server, 'connection')) as [net.Socket];
  const socketClosed = once(socket, 'close');

  session.dispose();
  await Promise.all([stopped, socketClosed]);
  input.destroy();
  output.destroy();
  server.close();
  await once(server, 'close');
});

test('reports stale stack frames in the Debug Console without a popup', async () => {
  const session = new GameMakerDebugSession({
    async launch() {},
    async stop() {},
    async loadSources() {
      return [];
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  session.start(input, output);

  let received = Buffer.alloc(0);
  const messages: any[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out reading stale-frame responses.')),
      2_000,
    );
    output.on('data', (data) => {
      received = Buffer.concat([received, Buffer.from(data)]);
      for (;;) {
        const headerEnd = received.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = received.subarray(0, headerEnd).toString('ascii');
        const size = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
        const bodyStart = headerEnd + 4;
        if (!size || received.length < bodyStart + size) break;
        messages.push(
          JSON.parse(
            received.subarray(bodyStart, bodyStart + size).toString('utf8'),
          ),
        );
        received = received.subarray(bodyStart + size);
      }
      if (messages.length < 2) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  const scopes = JSON.stringify({
    seq: 1,
    type: 'request',
    command: 'scopes',
    arguments: { frameId: 99 },
  });
  input.write(`Content-Length: ${Buffer.byteLength(scopes)}\r\n\r\n${scopes}`);

  await completed;
  const response = messages.find(
    (message) => message.type === 'response' && message.command === 'scopes',
  );
  const outputEvent = messages.find(
    (message) => message.type === 'event' && message.event === 'output',
  );
  assert.equal(response.success, false);
  assert.equal(response.body.error.showUser, undefined);
  assert.match(outputEvent.body.output, /stale GameMaker stack-frame/);
  assert.equal(outputEvent.body.category, 'console');
  session.dispose();
  input.destroy();
  output.destroy();
});
