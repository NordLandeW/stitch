import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GameMakerDebugSession } from './gameMakerDebugSession.mjs';
import {
  GameMakerDebugMetadata,
  gameMakerProtocolInternals,
} from './gameMakerProtocol.mjs';

const {
  command,
  makeBatch,
  makeBreakpointCommand,
  makeCommand,
  normalizeSource,
  stepType,
} = gameMakerProtocolInternals;

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
  assert.equal(initialize.body.supportsEvaluateForHovers, true);
  assert.equal(initialize.body.supportsSetVariable, true);
  input.destroy();
  output.destroy();
});
