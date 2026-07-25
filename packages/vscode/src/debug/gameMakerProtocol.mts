import { EventEmitter } from 'node:events';
import net from 'node:net';
import path from 'node:path';

const PACKET_SIGNATURE = 0xbe11c0de;
const LOGIN_SIGNATURE_1 = 0xcafebabe;
const LOGIN_SIGNATURE_2 = 0xdeadb00b;
const LOGIN_GAME_ID = 296_824_970;
const LOGIN_RESPONSE_SIGNATURE_1 = 3_736_059_565;
const LOGIN_RESPONSE_SIGNATURE_2 = 4_027_432_683;
const NETWORK_PACKET_SIZE = 44;
const NULL_POINTER = 0xffff_ffff_ffff_ffffn;
const NULL_U32 = 0xffff_ffff;

const command = {
  ping: 1,
  getGameData: 2,
  stopTarget: 3,
  startTarget: 4,
  singleStepLine: 6,
  getInstanceData: 7,
  getJsInstanceData: 8,
  startBreakpoint: 9,
  getWatches: 10,
  getUpdate: 11,
  getArrays: 12,
  getStructures: 13,
  restartTarget: 14,
  batch: 19,
  quitDebugger: 20,
  getYyDebug: 21,
} as const;

const requestFlag = {
  globals: 0x08,
  locals: 0x10,
  selfInstance: 0x20,
  callStack: 0x40,
} as const;

const stoppedRequestFlags =
  requestFlag.globals |
  requestFlag.locals |
  requestFlag.selfInstance |
  requestFlag.callStack;

const stepType = {
  into: 0,
  over: 1,
  out: 2,
} as const;

type StepType = (typeof stepType)[keyof typeof stepType];

export interface GameMakerSourceFile {
  path: string;
  text: string;
}

interface VmDebugEntry {
  address: number;
  sourceOffset: number;
}

interface DebugInfo {
  text: string;
  vmAddresses: VmDebugEntry[];
  lineStarts: number[];
  lineEnds: number[];
}

export interface GameMakerDebugScript {
  index: number;
  name: string;
  displayName: string;
  resourceName: string;
  text: string;
  baseAddress: bigint;
  offsetAddress: bigint;
  vmSize: bigint;
  sourcePath?: string;
  debugInfo?: DebugInfo;
  argumentNames?: string[];
  localNames?: string[];
}

export interface GameMakerBreakpointLocation {
  address: bigint;
  line: number;
  script: GameMakerDebugScript;
}

export type GameMakerValueKind =
  | 'real'
  | 'string'
  | 'array'
  | 'pointer'
  | 'undefined'
  | 'object'
  | 'int32'
  | 'int64'
  | 'null'
  | 'bool'
  | 'ref'
  | 'invalid';

export interface GameMakerValue {
  kind: GameMakerValueKind;
  rawKind: number;
  value?: number | string | bigint | boolean;
  reference?: bigint;
  objectKind?: number;
  instanceId?: number;
}

export interface GameMakerVariable {
  name: string;
  value: GameMakerValue;
  children?: GameMakerVariable[];
}

export interface GameMakerStackFrame {
  name: string;
  line: number;
  script?: GameMakerDebugScript;
  address: number;
  locals: GameMakerVariable[];
  self: GameMakerValue;
  other: GameMakerValue;
}

export interface GameMakerStoppedState {
  reason: 'breakpoint' | 'pause' | 'step';
  frames: GameMakerStackFrame[];
  globals: GameMakerVariable[];
  selfInstance?: GameMakerVariable[];
}

function fourCc(value: string) {
  return Buffer.from(value, 'ascii').readUInt32LE(0);
}

function gameLayoutChunk(value: string) {
  return Buffer.from(value, 'ascii').readUInt32BE(0);
}

function normalizeSource(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimEnd();
}

function sourceKey(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function lineOffsets(text: string) {
  const starts = [0];
  const ends: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') continue;
    ends.push(index);
    if (char === '\r' && text[index + 1] === '\n') index++;
    starts.push(index + 1);
  }
  if (ends.length < starts.length) ends.push(text.length);
  return { starts, ends };
}

export class GameMakerBinaryReader {
  position = 0;

  constructor(
    readonly buffer: Buffer,
    position = 0,
  ) {
    this.position = position;
  }

  get remaining() {
    return this.buffer.length - this.position;
  }

  seek(position: number) {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > this.buffer.length
    ) {
      throw new Error(`Invalid debugger data offset ${position}.`);
    }
    this.position = position;
    return this;
  }

  private require(size: number) {
    if (size < 0 || this.position + size > this.buffer.length) {
      throw new Error(
        `Truncated debugger data at ${this.position}; need ${size} bytes, have ${this.remaining}.`,
      );
    }
  }

  readU8() {
    this.require(1);
    return this.buffer[this.position++]!;
  }

  readU32() {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  readI32() {
    this.require(4);
    const value = this.buffer.readInt32LE(this.position);
    this.position += 4;
    return value;
  }

  readU64() {
    this.require(8);
    const value = this.buffer.readBigUInt64LE(this.position);
    this.position += 8;
    return value;
  }

  readF64() {
    this.require(8);
    const value = this.buffer.readDoubleLE(this.position);
    this.position += 8;
    return value;
  }

  readF32() {
    this.require(4);
    const value = this.buffer.readFloatLE(this.position);
    this.position += 4;
    return value;
  }

  readBytes(size: number) {
    this.require(size);
    const value = this.buffer.subarray(this.position, this.position + size);
    this.position += size;
    return value;
  }

  readString() {
    const size = this.readU32();
    if (!size) return '';
    const bytes = this.readBytes(size);
    return bytes.subarray(0, Math.max(0, size - 1)).toString('latin1');
  }

  readUtf8String() {
    const size = this.readU32();
    if (!size) return '';
    const bytes = this.readBytes(size);
    return bytes.subarray(0, Math.max(0, size - 1)).toString('utf8');
  }

  readCStringAt(position: number) {
    if (position < 0 || position >= this.buffer.length) {
      throw new Error(`Invalid debugger string offset ${position}.`);
    }
    let end = position;
    while (end < this.buffer.length && this.buffer[end] !== 0) end++;
    if (end === this.buffer.length) {
      throw new Error(`Unterminated debugger string at ${position}.`);
    }
    return this.buffer.subarray(position, end).toString('utf8');
  }
}

function makeScript(index: number, text = ''): GameMakerDebugScript {
  return {
    index,
    name: 'unknown',
    displayName: 'unknown',
    resourceName: '',
    text,
    baseAddress: 0n,
    offsetAddress: NULL_POINTER,
    vmSize: 0n,
    argumentNames: [],
  };
}

export class GameMakerDebugMetadata {
  readonly scripts: GameMakerDebugScript[] = [];
  version = 0;
  platform = -1;

  private readonly scriptsBySource = new Map<string, GameMakerDebugScript[]>();
  private readonly variableNames = new Map<number, string>();

  static fromYyDebug(buffer: Buffer) {
    const metadata = new GameMakerDebugMetadata();
    metadata.parseYyDebug(buffer);
    return metadata;
  }

  private parseYyDebug(buffer: Buffer) {
    const reader = new GameMakerBinaryReader(buffer);
    if (reader.readU32() !== fourCc('FORM')) {
      throw new Error('Runner returned an invalid .yydebug header.');
    }
    const declaredSize = reader.readU32();
    if (declaredSize > buffer.length - 8) {
      throw new Error(
        `Runner returned a truncated .yydebug file (${declaredSize + 8} expected, ${buffer.length} received).`,
      );
    }

    const chunks = new Map<number, { start: number; size: number }>();
    while (reader.position + 8 <= buffer.length) {
      const id = reader.readU32();
      const size = reader.readU32();
      const start = reader.position;
      if (start + size > buffer.length) {
        throw new Error(`Truncated .yydebug chunk 0x${id.toString(16)}.`);
      }
      chunks.set(id, { start, size });
      reader.seek(start + size);
    }

    const scriptChunk = chunks.get(fourCc('SCPT'));
    const debugChunk = chunks.get(fourCc('DBGI'));
    if (!scriptChunk || !debugChunk) {
      throw new Error('The .yydebug file is missing SCPT or DBGI data.');
    }

    reader.seek(scriptChunk.start);
    const scriptCount = reader.readU32();
    const scriptPointers: number[] = [];
    for (let index = 0; index < scriptCount; index++) {
      scriptPointers.push(reader.readU32());
    }
    for (let index = 0; index < scriptPointers.length; index++) {
      const struct = new GameMakerBinaryReader(buffer, scriptPointers[index]);
      const stringPointer = struct.readU32();
      this.scripts.push(makeScript(index, reader.readCStringAt(stringPointer)));
    }

    reader.seek(debugChunk.start);
    const debugMapCount = reader.readU32();
    const scriptToDebugInfo: number[] = [];
    for (let index = 0; index < debugMapCount; index++) {
      scriptToDebugInfo.push(reader.readI32());
    }
    const debugInfoCount = reader.readU32();
    const debugPointers: number[] = [];
    for (let index = 0; index < debugInfoCount; index++) {
      debugPointers.push(reader.readU32());
    }

    const debugInfos: DebugInfo[] = [];
    for (let index = 0; index < debugPointers.length; index++) {
      const infoReader = new GameMakerBinaryReader(
        buffer,
        debugPointers[index],
      );
      const pairWordCount = infoReader.readI32();
      const vmAddresses: VmDebugEntry[] = [];
      for (let pair = 0; pair < Math.floor(pairWordCount / 2); pair++) {
        vmAddresses.push({
          address: infoReader.readU32(),
          sourceOffset: infoReader.readI32(),
        });
      }
      const scriptIndex = scriptToDebugInfo.indexOf(index);
      const text = this.scripts[scriptIndex]?.text ?? '';
      const offsets = lineOffsets(text);
      debugInfos.push({
        text,
        vmAddresses,
        lineStarts: offsets.starts,
        lineEnds: offsets.ends,
      });
    }

    for (let index = 0; index < this.scripts.length; index++) {
      const debugIndex = scriptToDebugInfo[index];
      const info = debugInfos[debugIndex];
      if (!info) continue;
      const text = this.scripts[index]!.text;
      const offsets = lineOffsets(text);
      this.scripts[index]!.debugInfo = {
        ...info,
        text,
        lineStarts: offsets.starts,
        lineEnds: offsets.ends,
      };
    }

    const functionChunk = chunks.get(fourCc('DFNC'));
    if (functionChunk) this.parseFunctionChunk(buffer, functionChunk.start);
  }

  private parseFunctionChunk(buffer: Buffer, start: number) {
    const reader = new GameMakerBinaryReader(buffer, start);
    const version = reader.readI32();
    if (version !== 1) return;
    const count = reader.readU32();
    const pointers: number[] = [];
    for (let index = 0; index < count; index++) pointers.push(reader.readU32());
    for (const pointer of pointers) {
      if (!pointer) continue;
      const item = new GameMakerBinaryReader(buffer, pointer);
      const scriptIndex = item.readI32();
      const displayNamePointer = item.readU32();
      const vmSize = item.readI32();
      const argumentCount = item.readI32();
      const argumentNamePointers: number[] = [];
      for (let index = 0; index < argumentCount; index++) {
        argumentNamePointers.push(item.readU32());
      }
      const localCount = item.readI32();
      const localNamePointers: number[] = [];
      for (let index = 0; index < localCount; index++) {
        localNamePointers.push(item.readU32());
      }
      const script = this.scripts[scriptIndex];
      if (!script) continue;
      script.displayName = reader.readCStringAt(displayNamePointer);
      script.vmSize = BigInt(Math.max(0, vmSize));
      script.argumentNames = argumentNamePointers.map((pointer, index) =>
        pointer ? reader.readCStringAt(pointer) : `argument${index}`,
      );
      script.localNames = localNamePointers
        .filter(Boolean)
        .map((pointer) => reader.readCStringAt(pointer));
    }
  }

  applyGameLayout(buffer: Buffer) {
    const reader = new GameMakerBinaryReader(buffer);
    if (reader.readU32() !== command.getGameData) {
      throw new Error('Runner returned an invalid GameLayout command.');
    }
    reader.readU32();
    this.version = reader.readU32();
    this.platform = reader.readU32();
    if (this.version < 12 || this.version > 22) {
      throw new Error(
        `Unsupported GameMaker debugger protocol ${this.version}; supported versions are 12 through 22.`,
      );
    }

    this.expectChunk(reader, 'CODE');
    this.readVmCode(reader);
    this.expectChunk(reader, 'OBJ_');
    this.readObjects(reader);
    this.expectChunk(reader, 'SCRT');
    this.readScripts(reader);
    this.expectChunk(reader, 'FUNC');
    this.readFunctions(reader);
    this.expectChunk(reader, 'CCOD');
    this.readCreationCode(reader);
    let next = reader.readU32();
    if (next === gameLayoutChunk('UICC')) {
      this.readUiCreationCode(reader);
      next = reader.readU32();
    }
    if (next !== gameLayoutChunk('TMLN')) {
      throw new Error(
        `Invalid GameLayout chunk; expected TMLN, got 0x${next.toString(16)}.`,
      );
    }
    this.readTimelines(reader);
  }

  private expectChunk(reader: GameMakerBinaryReader, id: string) {
    const actual = reader.readU32();
    const expected = gameLayoutChunk(id);
    if (actual !== expected) {
      throw new Error(
        `Invalid GameLayout chunk; expected ${id}, got 0x${actual.toString(16)}.`,
      );
    }
  }

  private readVmCode(reader: GameMakerBinaryReader) {
    const count = reader.readU32();
    for (let index = 0; index < count; index++) {
      const script = this.scripts[reader.readI32()];
      const name = reader.readString();
      if (script) script.name = name;
    }
  }

  private readObjects(reader: GameMakerBinaryReader) {
    const objectCount = reader.readU32();
    for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
      reader.readU32();
      reader.readU32();
      reader.readU32();
      reader.readU32();
      reader.readU32();
      reader.readU32();
      const objectName = reader.readString();
      for (let eventId = 0; eventId < 15; eventId++) {
        const eventCount = reader.readU32();
        for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
          reader.readU32();
          const scriptIndex = reader.readI32();
          const baseAddress = reader.readU64();
          const scriptName = reader.readString();
          const script = this.scripts[scriptIndex];
          if (!script) continue;
          script.name = scriptName;
          script.resourceName = objectName;
          script.displayName =
            script.displayName === 'unknown' ? scriptName : script.displayName;
          script.baseAddress = baseAddress;
          script.offsetAddress = baseAddress;
        }
      }
    }
  }

  private readScripts(reader: GameMakerBinaryReader) {
    const count = reader.readU32();
    for (let index = 0; index < count; index++) {
      const scriptIndex = reader.readI32();
      if (scriptIndex === -1) {
        reader.readString();
        continue;
      }
      const baseAddress = reader.readU64();
      const offsetAddress = reader.readU64();
      const displayName = reader.readString();
      const script = this.scripts[scriptIndex];
      if (!script) continue;
      script.baseAddress = baseAddress;
      script.offsetAddress = offsetAddress;
      script.displayName =
        script.displayName === 'unknown' ? displayName : script.displayName;
      script.resourceName = displayName;
    }
  }

  private readFunctions(reader: GameMakerBinaryReader) {
    const functionCount = reader.readU32();
    for (let index = 0; index < functionCount; index++) reader.readString();
    const variableCount = reader.readU32();
    for (let index = 0; index < variableCount; index++) {
      this.variableNames.set(reader.readI32(), reader.readString());
    }
    if (this.version >= 10 && this.version < 15) {
      const stringCount = reader.readU32();
      for (let index = 0; index < stringCount; index++) reader.readString();
    }
  }

  private readCreationCode(reader: GameMakerBinaryReader) {
    const roomCount = reader.readU32();
    for (let roomIndex = 0; roomIndex < roomCount; roomIndex++) {
      const roomName = reader.readString();
      const roomScriptIndex = reader.readU32();
      if (roomScriptIndex !== NULL_U32) {
        const script = this.scripts[roomScriptIndex];
        const baseAddress = reader.readU64();
        if (script) {
          script.baseAddress = baseAddress;
          script.offsetAddress = baseAddress;
          script.name = `gml_Room_${roomName}_Create`;
          script.displayName = `${roomName}.Creation code`;
          script.resourceName = roomName;
        }
      }
      const instanceCount = reader.readU32();
      for (let index = 0; index < instanceCount; index++) {
        const scriptIndex = reader.readU32();
        const baseAddress = reader.readU64();
        const name = reader.readString();
        reader.readU32();
        const script = this.scripts[scriptIndex];
        if (script) {
          script.baseAddress = baseAddress;
          script.offsetAddress = baseAddress;
          script.name = name;
          script.resourceName = roomName;
        }
      }
    }
  }

  private readUiCreationCode(reader: GameMakerBinaryReader) {
    const count = reader.readU32();
    for (let index = 0; index < count; index++) {
      const scriptIndex = reader.readU32();
      const baseAddress = reader.readU64();
      const name = reader.readString();
      reader.readU32();
      const script = this.scripts[scriptIndex];
      if (script) {
        script.baseAddress = baseAddress;
        script.offsetAddress = baseAddress;
        script.name = name;
      }
    }
  }

  private readTimelines(reader: GameMakerBinaryReader) {
    const count = reader.readU32();
    for (let index = 0; index < count; index++) {
      const timelineName = reader.readString();
      const momentCount = reader.readU32();
      for (let moment = 0; moment < momentCount; moment++) {
        const step = reader.readI32();
        const scriptIndex = reader.readI32();
        const baseAddress = reader.readU64();
        const script = this.scripts[scriptIndex];
        if (script) {
          script.baseAddress = baseAddress;
          script.offsetAddress = baseAddress;
          script.name = `Step ${step}`;
          script.resourceName = timelineName;
        }
      }
    }
  }

  mapSources(files: GameMakerSourceFile[]) {
    this.scriptsBySource.clear();
    const byContent = new Map<string, GameMakerSourceFile[]>();
    const byBasename = new Map<string, GameMakerSourceFile[]>();
    for (const file of files) {
      const normalized = normalizeSource(file.text);
      const contentMatches = byContent.get(normalized) ?? [];
      contentMatches.push(file);
      byContent.set(normalized, contentMatches);
      const basename = path
        .basename(file.path, path.extname(file.path))
        .toLowerCase();
      const nameMatches = byBasename.get(basename) ?? [];
      nameMatches.push(file);
      byBasename.set(basename, nameMatches);
    }

    for (const script of this.scripts) {
      let matches = byContent.get(normalizeSource(script.text)) ?? [];
      if (!matches.length) {
        const candidates = [
          script.resourceName,
          script.displayName,
          script.name.replace(/^gml_Script_/, ''),
        ]
          .filter(Boolean)
          .map((value) => value.toLowerCase());
        matches = candidates.flatMap(
          (candidate) => byBasename.get(candidate) ?? [],
        );
      }
      if (!matches.length) continue;
      const preferred =
        matches.find((file) =>
          file.path.toLowerCase().includes(script.resourceName.toLowerCase()),
        ) ?? matches[0]!;
      script.sourcePath = path.resolve(preferred.path);
      const key = sourceKey(script.sourcePath);
      const scripts = this.scriptsBySource.get(key) ?? [];
      scripts.push(script);
      this.scriptsBySource.set(key, scripts);
    }
  }

  scriptsForSource(sourcePath: string) {
    return this.scriptsBySource.get(sourceKey(sourcePath)) ?? [];
  }

  breakpointForSource(
    sourcePath: string,
    requestedLine: number,
  ): GameMakerBreakpointLocation | undefined {
    const candidates = this.scriptsForSource(sourcePath)
      .filter(
        (script) => script.debugInfo?.vmAddresses.length && script.baseAddress,
      )
      .sort((left, right) => {
        const leftRoot = left.baseAddress === left.offsetAddress ? 0 : 1;
        const rightRoot = right.baseAddress === right.offsetAddress ? 0 : 1;
        return leftRoot - rightRoot || left.index - right.index;
      });
    for (const script of candidates) {
      const info = script.debugInfo!;
      const startLine = Math.min(
        Math.max(0, requestedLine - 1),
        Math.max(0, info.lineStarts.length - 1),
      );
      const lineOrder: number[] = [];
      for (let line = startLine; line < info.lineStarts.length; line++) {
        lineOrder.push(line);
      }
      for (let line = startLine - 1; line >= 0; line--) lineOrder.push(line);
      for (const line of lineOrder) {
        const start = info.lineStarts[line]!;
        const end = info.lineEnds[line] ?? start;
        const addresses = info.vmAddresses.filter(
          (entry) => entry.sourceOffset >= start && entry.sourceOffset <= end,
        );
        if (!addresses.length) continue;
        const relativeAddress = Math.min(
          ...addresses.map((entry) => entry.address),
        );
        return {
          address: script.baseAddress + BigInt(relativeAddress),
          line: line + 1,
          script,
        };
      }
    }
    return undefined;
  }

  scriptForAddress(baseAddress: bigint, offset: number) {
    const scripts = this.scripts.filter(
      (script) => script.baseAddress === baseAddress && script.debugInfo,
    );
    if (scripts.length <= 1) return scripts[0];
    const absolute = baseAddress + BigInt(offset);
    return (
      scripts.find(
        (script, index) =>
          index > 0 &&
          absolute >= script.offsetAddress &&
          absolute <= script.offsetAddress + script.vmSize,
      ) ?? scripts[0]
    );
  }

  lineForAddress(script: GameMakerDebugScript | undefined, address: number) {
    const info = script?.debugInfo;
    if (!info?.vmAddresses.length) return 1;
    let entry = info.vmAddresses[0]!;
    for (const candidate of info.vmAddresses) {
      if (candidate.address > address) break;
      entry = candidate;
    }
    let line = 0;
    while (
      line + 1 < info.lineStarts.length &&
      info.lineStarts[line + 1]! <= entry.sourceOffset
    ) {
      line++;
    }
    return line + 1;
  }

  variableName(id: number) {
    return this.variableNames.get(id);
  }
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private endedError?: Error;
  private pending?: {
    size: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (data) => {
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.isBuffer(data) ? data : Buffer.from(data),
      ]);
      this.drain();
    });
    socket.on('error', (error) => this.end(error));
    socket.on('close', () =>
      this.end(new Error('GameMaker debugger connection closed.')),
    );
  }

  readExactly(size: number, timeout = 30_000) {
    if (this.pending) {
      return Promise.reject(
        new Error('Concurrent reads from the GameMaker debugger.'),
      );
    }
    if (this.endedError) return Promise.reject(this.endedError);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = undefined;
        reject(new Error(`Timed out reading ${size} bytes from GameMaker.`));
      }, timeout);
      this.pending = { size, resolve, reject, timer };
      this.drain();
    });
  }

  private drain() {
    if (!this.pending || this.buffer.length < this.pending.size) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    const value = this.buffer.subarray(0, pending.size);
    this.buffer = this.buffer.subarray(pending.size);
    pending.resolve(value);
  }

  private end(error: Error) {
    this.endedError = error;
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

class GameMakerDebuggerUnavailableError extends Error {}
class GameMakerDebuggerClosedError extends Error {}

function waitForDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function makeCommand(commandId: number, args: number[] = []) {
  const buffer = Buffer.alloc(NETWORK_PACKET_SIZE);
  buffer.writeUInt32LE(PACKET_SIGNATURE, 0);
  buffer.writeUInt32LE(NETWORK_PACKET_SIZE, 4);
  buffer.writeUInt32LE(NETWORK_PACKET_SIZE, 8);
  buffer.writeUInt32LE(commandId, 12);
  for (let index = 0; index < Math.min(args.length, 7); index++) {
    buffer.writeUInt32LE(args[index]! >>> 0, 16 + index * 4);
  }
  return buffer;
}

function makeBatch(subcommand: number, values: number[]) {
  const size = 20 + 4 + values.length * 4;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(PACKET_SIGNATURE, 0);
  buffer.writeUInt32LE(NETWORK_PACKET_SIZE, 4);
  buffer.writeUInt32LE(size, 8);
  buffer.writeUInt32LE(command.batch, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(subcommand, 20);
  for (let index = 0; index < values.length; index++) {
    buffer.writeUInt32LE(values[index]! >>> 0, 24 + index * 4);
  }
  return buffer;
}

function makeBatchPayload(subcommand: number, payload: Buffer) {
  const size = 24 + payload.length;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(PACKET_SIGNATURE, 0);
  buffer.writeUInt32LE(NETWORK_PACKET_SIZE, 4);
  buffer.writeUInt32LE(size, 8);
  buffer.writeUInt32LE(command.batch, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(subcommand, 20);
  payload.copy(buffer, 24);
  return buffer;
}

function makeBreakpointCommand(
  breakpoints: {
    address: bigint;
    enabled: boolean;
    condition?: Buffer;
  }[],
) {
  const size =
    20 +
    breakpoints.reduce(
      (total, breakpoint) => total + 16 + (breakpoint.condition?.length ?? 0),
      0,
    );
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(PACKET_SIGNATURE, 0);
  buffer.writeUInt32LE(NETWORK_PACKET_SIZE, 4);
  buffer.writeUInt32LE(size, 8);
  buffer.writeUInt32LE(command.startBreakpoint, 12);
  buffer.writeUInt32LE(breakpoints.length, 16);
  let offset = 20;
  for (const breakpoint of breakpoints) {
    buffer.writeBigUInt64LE(breakpoint.address, offset);
    buffer.writeUInt32LE(breakpoint.enabled ? 1 : 0, offset + 8);
    const condition = breakpoint.condition ?? Buffer.alloc(0);
    buffer.writeUInt32LE(condition.length, offset + 12);
    condition.copy(buffer, offset + 16);
    offset += 16 + condition.length;
  }
  return buffer;
}

function readRValue(reader: GameMakerBinaryReader): GameMakerValue {
  const rawKind = reader.readU32();
  const kind = rawKind & 0x0fff_ffff;
  switch (kind) {
    case 0:
      return { kind: 'real', rawKind, value: reader.readF64() };
    case 1:
      return { kind: 'string', rawKind, value: reader.readUtf8String() };
    case 2: {
      const reference = reader.readU64();
      return { kind: 'array', rawKind, reference, value: reference };
    }
    case 3: {
      const reference = reader.readU64();
      return { kind: 'pointer', rawKind, reference, value: reference };
    }
    case 5:
      return { kind: 'undefined', rawKind };
    case 6: {
      const reference = reader.readU64();
      return {
        kind: 'object',
        rawKind,
        reference,
        value: reference,
        objectKind: reader.readI32(),
      };
    }
    case 7:
      return { kind: 'int32', rawKind, value: reader.readI32() };
    case 10:
      return { kind: 'int64', rawKind, value: reader.readU64() };
    case 12:
      return { kind: 'null', rawKind };
    case 13:
      return { kind: 'bool', rawKind, value: reader.readF64() !== 0 };
    case 15: {
      const reference = reader.readU64();
      return { kind: 'ref', rawKind, reference, value: reference };
    }
    default:
      return { kind: 'invalid', rawKind };
  }
}

function readInstanceValue(reader: GameMakerBinaryReader, version: number) {
  const id = reader.readU32();
  if (version >= 13 && id === NULL_U32) return readRValue(reader);
  return {
    kind: 'ref',
    rawKind: 15,
    value: BigInt(id),
    reference: BigInt(id),
    instanceId: id,
  } satisfies GameMakerValue;
}

function readVariableName(
  reader: GameMakerBinaryReader,
  version: number,
  metadata: GameMakerDebugMetadata,
  inlineVersion: number,
) {
  const nameId = reader.readI32();
  if (nameId === -1 && version >= inlineVersion) return reader.readString();
  return metadata.variableName(nameId) ?? '<unknown>';
}

function readLocalVariable(
  reader: GameMakerBinaryReader,
  version: number,
  metadata: GameMakerDebugMetadata,
): GameMakerVariable {
  return {
    name: readVariableName(reader, version, metadata, 19),
    value: readRValue(reader),
  };
}

function readGlobalVariable(
  reader: GameMakerBinaryReader,
  version: number,
  metadata: GameMakerDebugMetadata,
): GameMakerVariable {
  const nameId = reader.readI32();
  let name: string;
  if (nameId === -1 && version >= 18) {
    name = reader.readString();
  } else {
    const lookupId = nameId < 100_000 ? nameId + 100_000 : nameId;
    name =
      metadata.variableName(lookupId) ??
      metadata.variableName(nameId) ??
      '<unknown>';
  }
  return { name, value: readRValue(reader) };
}

function scalarValue(
  kind: 'real' | 'int32' | 'bool',
  value: number | boolean,
): GameMakerValue {
  return {
    kind,
    rawKind: kind === 'real' ? 0 : kind === 'int32' ? 7 : 13,
    value,
  };
}

function readInstance(
  reader: GameMakerBinaryReader,
  version: number,
  metadata: GameMakerDebugMetadata,
  includeBuiltins: boolean,
) {
  const variables: GameMakerVariable[] = [];
  if (!includeBuiltins) {
    const count = reader.readU32();
    for (let index = 0; index < count; index++) {
      variables.push({
        name: reader.readString(),
        value: readRValue(reader),
      });
    }
    return { variables };
  }

  const id = reader.readU32();
  const builtins: GameMakerVariable[] = [];
  const addReal = (name: string, value: number) =>
    builtins.push({ name, value: scalarValue('real', value) });
  const addInt = (name: string, value: number) =>
    builtins.push({ name, value: scalarValue('int32', value) });
  const addBool = (name: string, value: boolean) =>
    builtins.push({ name, value: scalarValue('bool', value) });
  const addValue = (name: string, value: GameMakerValue) =>
    builtins.push({ name, value });

  const objectIndex = reader.readU32();
  const x = reader.readF32();
  const y = reader.readF32();
  const direction = reader.readF32();
  const friction = reader.readF32();
  const gravity = reader.readF32();
  const gravityDirection = reader.readF32();
  const hspeed = reader.readF32();
  const vspeed = reader.readF32();
  const speed = reader.readF32();
  const xprevious = reader.readF32();
  const yprevious = reader.readF32();
  const spriteIndex = reader.readI32();
  const imageAlpha = reader.readF32();
  const imageAngle = reader.readF32();
  const imageBlend = reader.readU32();
  const imageIndex = reader.readF32();
  const imageNumber = reader.readI32();
  const imageSpeed = reader.readF32();
  const imageXscale = reader.readF32();
  const imageYscale = reader.readF32();
  const alarms = Array.from({ length: 12 }, () => reader.readI32());
  const pathIndex = reader.readI32();
  const pathPosition = reader.readF32();
  const pathPositionPrevious = reader.readF32();
  const pathEndAction = reader.readF32();
  const pathScale = reader.readF32();
  const pathSpeed = reader.readF32();
  const pathOrientation = reader.readF32();
  const xstart = reader.readF32();
  const ystart = reader.readF32();
  const persistent = reader.readU32() !== 0;
  const depth = reader.readF32();
  const visible = reader.readU32() !== 0;
  const maskIndex = reader.readI32();
  const solid = reader.readU32() !== 0;
  const bboxTop = reader.readF32();
  const bboxBottom = reader.readF32();
  const bboxLeft = reader.readF32();
  const bboxRight = reader.readF32();
  const spriteWidth = reader.readF32();
  const spriteHeight = reader.readF32();
  const spriteXoffset = reader.readF32();
  const spriteYoffset = reader.readF32();
  const phyActive = reader.readU32() !== 0;
  const phyFixedRotation = reader.readU32() !== 0;
  const phyAngularVelocity = reader.readF32();
  const phyLinearVelocityX = reader.readF32();
  const phyLinearVelocityY = reader.readF32();
  const phySpeedX = reader.readF32();
  const phySpeedY = reader.readF32();
  const phyPositionX = reader.readF32();
  const phyPositionY = reader.readF32();
  const phyRotation = reader.readF32();
  const phyBullet = reader.readU32() !== 0;
  const phyComX = reader.readF32();
  const phyComY = reader.readF32();
  const phyDynamic = reader.readU32() !== 0;
  const phyKinematic = reader.readU32() !== 0;
  const phyInertia = reader.readF32();
  const phyMass = reader.readF32();
  const phySleeping = reader.readU32() !== 0;
  const timelineIndex = reader.readI32();
  const timelineRunning = reader.readU32() !== 0;
  const timelineSpeed = reader.readF32();
  const timelinePosition = reader.readF32();
  const timelineLoop = reader.readU32() !== 0;
  let layer: GameMakerValue | undefined;
  if (version >= 21) layer = readRValue(reader);
  else if (version >= 5) layer = scalarValue('real', reader.readF32());
  const sequenceInstance = version >= 16 ? readRValue(reader) : undefined;
  const onUiLayer = version >= 22 ? reader.readU32() !== 0 : undefined;
  const collisionSpace = version >= 22 ? reader.readU32() : undefined;

  addInt('id', id);
  addInt('object_index', objectIndex);
  addReal('x', x);
  addReal('y', y);
  addReal('direction', direction);
  addReal('friction', friction);
  addReal('gravity', gravity);
  addReal('gravity_direction', gravityDirection);
  addReal('hspeed', hspeed);
  addReal('vspeed', vspeed);
  addReal('speed', speed);
  addReal('xstart', xstart);
  addReal('ystart', ystart);
  addReal('xprevious', xprevious);
  addReal('yprevious', yprevious);
  addReal('bbox_top', bboxTop);
  addReal('bbox_bottom', bboxBottom);
  addReal('bbox_left', bboxLeft);
  addReal('bbox_right', bboxRight);
  addInt('sprite_index', spriteIndex);
  addInt('mask_index', maskIndex);
  addReal('image_alpha', imageAlpha);
  addReal('image_angle', imageAngle);
  addInt('image_blend', imageBlend);
  addReal('image_index', imageIndex);
  addInt('image_number', imageNumber);
  addReal('image_speed', imageSpeed);
  addReal('image_xscale', imageXscale);
  addReal('image_yscale', imageYscale);
  addReal('sprite_width', spriteWidth);
  addReal('sprite_height', spriteHeight);
  addReal('sprite_xoffset', spriteXoffset);
  addReal('sprite_yoffset', spriteYoffset);
  addReal('depth', depth);
  if (layer) addValue('layer', layer);
  addBool('persistent', persistent);
  addBool('solid', solid);
  addBool('visible', visible);
  alarms.forEach((value, index) => addInt(`alarm[${index}]`, value));
  addInt('path_index', pathIndex);
  addReal('path_position', pathPosition);
  addReal('path_positionprevious', pathPositionPrevious);
  addReal('path_endaction', pathEndAction);
  addReal('path_scale', pathScale);
  addReal('path_speed', pathSpeed);
  addReal('path_orientation', pathOrientation);
  addBool('phy_active', phyActive);
  addBool('phy_fixed_rotation', phyFixedRotation);
  addReal('phy_angular_velocity', phyAngularVelocity);
  addReal('phy_linear_velocity_x', phyLinearVelocityX);
  addReal('phy_linear_velocity_y', phyLinearVelocityY);
  addReal('phy_speed_x', phySpeedX);
  addReal('phy_speed_y', phySpeedY);
  addReal('phy_position_x', phyPositionX);
  addReal('phy_position_y', phyPositionY);
  addReal('phy_rotation', phyRotation);
  addBool('phy_bullet', phyBullet);
  addReal('phy_com_x', phyComX);
  addReal('phy_com_y', phyComY);
  addBool('phy_dynamic', phyDynamic);
  addBool('phy_kinematic', phyKinematic);
  addReal('phy_inertia', phyInertia);
  addReal('phy_mass', phyMass);
  addBool('phy_sleeping', phySleeping);
  addInt('timeline_index', timelineIndex);
  addBool('timeline_running', timelineRunning);
  addReal('timeline_speed', timelineSpeed);
  addReal('timeline_position', timelinePosition);
  addBool('timeline_loop', timelineLoop);
  if (sequenceInstance) addValue('sequence_instance', sequenceInstance);
  if (onUiLayer !== undefined) addBool('on_ui_layer', onUiLayer);
  if (collisionSpace !== undefined) addInt('collision_space', collisionSpace);

  variables.push({
    name: 'Built-In Variables',
    value: { kind: 'object', rawKind: 6, objectKind: -1 },
    children: builtins,
  });
  const userCount = reader.readU32();
  for (let index = 0; index < userCount; index++) {
    variables.push({
      name: readVariableName(reader, version, metadata, 17),
      value: readRValue(reader),
    });
  }
  return { variables, builtins, id };
}

function unwrapSingleBatch(
  buffer: Buffer,
  expectedCommand: number,
): GameMakerBinaryReader {
  const reader = new GameMakerBinaryReader(buffer);
  const responseCommand = reader.readU32();
  if (responseCommand === command.batch) {
    const count = reader.readI32();
    if (count !== 1) {
      throw new Error(`Expected one debugger response, received ${count}.`);
    }
    const actual = reader.readU32();
    if (actual !== expectedCommand) {
      throw new Error(
        `Expected debugger command ${expectedCommand}, received ${actual}.`,
      );
    }
    return reader;
  }
  if (responseCommand !== expectedCommand) {
    throw new Error(
      `Expected debugger command ${expectedCommand}, received ${responseCommand}.`,
    );
  }
  return reader;
}

export interface GameMakerProtocolEvents {
  stopped: [state: GameMakerStoppedState];
  continued: [];
  terminated: [error?: Error];
}

export class GameMakerProtocolClient extends EventEmitter<GameMakerProtocolEvents> {
  metadata?: GameMakerDebugMetadata;

  private socket?: net.Socket;
  private reader?: SocketReader;
  private operation: Promise<unknown> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private pingId = 0;
  private running = false;
  private closed = false;
  private readonly closeController = new AbortController();
  private expectedStopReason: GameMakerStoppedState['reason'] = 'breakpoint';

  async connect(host: string, port: number, timeout = 180_000) {
    const deadline = Date.now() + timeout;
    let lastError: Error | undefined;
    while (Date.now() < deadline && !this.closed) {
      try {
        await this.connectOnce(host, port);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.socket?.destroy();
        this.socket = undefined;
        this.reader = undefined;
        if (this.closed) {
          throw new GameMakerDebuggerClosedError(
            'GameMaker debugger connection was cancelled.',
          );
        }
        if (!(lastError instanceof GameMakerDebuggerUnavailableError)) {
          throw lastError;
        }
        await waitForDelay(250, this.closeController.signal);
      }
    }
    if (this.closed) {
      throw new GameMakerDebuggerClosedError(
        'GameMaker debugger connection was cancelled.',
      );
    }
    throw new Error(
      `Could not connect to the GameMaker debugger on ${host}:${port}: ${lastError?.message ?? 'timed out'}`,
    );
  }

  private async connectOnce(host: string, port: number) {
    const socket = new net.Socket();
    const reader = new SocketReader(socket);
    this.socket = socket;
    this.reader = reader;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        finish(
          new GameMakerDebuggerUnavailableError(
            'Connection attempt timed out.',
          ),
        );
      }, 1_000);
      const onError = (error: Error) =>
        finish(new GameMakerDebuggerUnavailableError(error.message));
      const onClose = () =>
        finish(
          new GameMakerDebuggerUnavailableError(
            'Debugger connection attempt was closed.',
          ),
        );
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.connect(port, host, () => {
        finish();
      });
    });
    socket.setNoDelay(true);

    const greeting = await reader.readExactly(
      Buffer.byteLength('GM:Studio-Connect') + 1,
      5_000,
    );
    if (greeting.subarray(0, -1).toString('ascii') !== 'GM:Studio-Connect') {
      throw new Error('Runner returned an invalid debugger greeting.');
    }

    const login = Buffer.alloc(16);
    login.writeUInt32LE(LOGIN_SIGNATURE_1, 0);
    login.writeUInt32LE(LOGIN_SIGNATURE_2, 4);
    login.writeInt32LE(login.length, 8);
    login.writeInt32LE(LOGIN_GAME_ID, 12);
    await this.write(login);
    const response = await reader.readExactly(12, 5_000);
    if (
      response.readUInt32LE(0) !== LOGIN_RESPONSE_SIGNATURE_1 ||
      response.readUInt32LE(4) !== LOGIN_RESPONSE_SIGNATURE_2 ||
      response.readInt32LE(8) !== response.length
    ) {
      throw new Error('Runner rejected the debugger login.');
    }

    await this.write(makeCommand(command.getYyDebug));
    const yyDebug = await this.readFrame(30_000);
    const metadata = GameMakerDebugMetadata.fromYyDebug(yyDebug);
    await this.write(makeCommand(command.getGameData));
    metadata.applyGameLayout(await this.readFrame(30_000));
    this.metadata = metadata;

    socket.once('close', () => {
      if (!this.closed)
        this.emit('terminated', new Error('GameMaker Runner exited.'));
    });
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async write(buffer: Buffer) {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('GameMaker debugger is not connected.');
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }

  private async readFrame(timeout = 15_000) {
    const reader = this.reader;
    if (!reader) throw new Error('GameMaker debugger is not connected.');
    const header = await reader.readExactly(8, timeout);
    if (header.readUInt32LE(0) !== PACKET_SIGNATURE) {
      throw new Error('Runner returned an invalid debugger packet signature.');
    }
    const size = header.readUInt32LE(4);
    if (size < 8 || size > 128 * 1024 * 1024) {
      throw new Error(
        `Runner returned an invalid debugger packet size ${size}.`,
      );
    }
    return reader.readExactly(size - 8, timeout);
  }

  private request(buffer: Buffer, timeout = 15_000) {
    return this.enqueue(async () => {
      await this.write(buffer);
      return this.readFrame(timeout);
    });
  }

  private send(buffer: Buffer) {
    return this.enqueue(() => this.write(buffer));
  }

  async setBreakpoints(
    breakpoints: {
      address: bigint;
      enabled: boolean;
      condition?: Buffer;
    }[],
  ) {
    await this.send(makeBreakpointCommand(breakpoints));
  }

  async fetchArray(arrayId: bigint, startIndex = -1) {
    const payload = Buffer.alloc(16);
    payload.writeUInt32LE(1, 0);
    payload.writeBigUInt64LE(arrayId, 4);
    payload.writeInt32LE(startIndex, 12);
    const body = await this.request(
      makeBatchPayload(command.getArrays, payload),
    );
    const reader = unwrapSingleBatch(body, command.getArrays);
    const responseCount = reader.readI32();
    if (responseCount < 1) return [];
    const returnedId = reader.readU64();
    reader.readI32();
    reader.readI32();
    const count = reader.readI32();
    const variables: GameMakerVariable[] = [];
    for (let index = 0; index < count; index++) {
      variables.push({ name: `[${index}]`, value: readRValue(reader) });
    }
    if (returnedId !== arrayId) {
      throw new Error('Runner returned data for a different GameMaker array.');
    }
    return variables;
  }

  async fetchObject(objectId: bigint) {
    const payload = Buffer.alloc(12);
    payload.writeUInt32LE(1, 0);
    payload.writeBigUInt64LE(objectId, 4);
    const body = await this.request(
      makeBatchPayload(command.getJsInstanceData, payload),
    );
    const reader = unwrapSingleBatch(body, command.getJsInstanceData);
    if (reader.readI32() < 1) return [];
    const returnedId = reader.readU64();
    const exists = reader.readU32() !== 0;
    if (returnedId !== objectId) {
      throw new Error('Runner returned data for a different GameMaker struct.');
    }
    if (!exists) return [];
    return readInstance(reader, this.metadata!.version, this.metadata!, false)
      .variables;
  }

  async fetchInstance(instanceId: number) {
    const payload = Buffer.alloc(8);
    payload.writeUInt32LE(1, 0);
    payload.writeUInt32LE(instanceId >>> 0, 4);
    const body = await this.request(
      makeBatchPayload(command.getInstanceData, payload),
    );
    const reader = unwrapSingleBatch(body, command.getInstanceData);
    if (reader.readI32() < 1) return [];
    const returnedId = reader.readU32();
    const exists = reader.readU32() !== 0;
    if (returnedId !== instanceId >>> 0) {
      throw new Error(
        'Runner returned data for a different GameMaker instance.',
      );
    }
    if (!exists) return [];
    return readInstance(reader, this.metadata!.version, this.metadata!, true)
      .variables;
  }

  async evaluate(vmBytes: Buffer, fetchId: number) {
    const payload = Buffer.alloc(8 + vmBytes.length);
    payload.writeUInt32LE(1, 0);
    payload.writeUInt32LE(fetchId >>> 0, 4);
    vmBytes.copy(payload, 8);
    const body = await this.request(
      makeBatchPayload(command.getWatches, payload),
    );
    const reader = unwrapSingleBatch(body, command.getWatches);
    if (reader.readI32() < 1) {
      throw new Error('GameMaker did not return an evaluation result.');
    }
    const returnedId = reader.readU32();
    if (returnedId !== fetchId >>> 0) {
      throw new Error('GameMaker returned a mismatched evaluation result.');
    }
    return readRValue(reader);
  }

  async start() {
    this.expectedStopReason = 'breakpoint';
    await this.send(makeCommand(command.startTarget));
    this.running = true;
    this.emit('continued');
    this.schedulePoll(0);
  }

  async pause() {
    this.expectedStopReason = 'pause';
    await this.send(makeCommand(command.stopTarget));
    await this.send(makeCommand(command.singleStepLine, [stepType.into]));
    this.schedulePoll(0);
  }

  async continue() {
    this.expectedStopReason = 'breakpoint';
    await this.send(makeCommand(command.startTarget));
    this.running = true;
    this.emit('continued');
    this.schedulePoll(0);
  }

  async step(kind: 'into' | 'over' | 'out') {
    this.expectedStopReason = 'step';
    const value: StepType = stepType[kind];
    await this.send(makeCommand(command.singleStepLine, [value]));
    this.running = true;
    this.emit('continued');
    this.schedulePoll(0);
  }

  async restart() {
    this.expectedStopReason = 'breakpoint';
    await this.send(makeCommand(command.restartTarget));
    this.running = true;
    this.emit('continued');
    this.schedulePoll(0);
  }

  private schedulePoll(delay = 250) {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    if (this.closed || !this.running) return;
    try {
      const id = ++this.pingId;
      const body = await this.request(makeBatch(command.ping, [id, 0]));
      const reader = unwrapSingleBatch(body, command.ping);
      const stopped = reader.readU32() !== 0;
      reader.readU32();
      if (!stopped) {
        this.schedulePoll();
        return;
      }
      this.running = false;
      const state = await this.readStoppedState();
      this.emit('stopped', state);
    } catch (error) {
      if (!this.closed) {
        this.emit(
          'terminated',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private async readStoppedState(): Promise<GameMakerStoppedState> {
    const body = await this.request(
      makeBatch(command.getUpdate, [stoppedRequestFlags]),
    );
    const reader = unwrapSingleBatch(body, command.getUpdate);
    const isStopped = reader.readU32() !== 0;
    if (!isStopped) {
      throw new Error('Runner resumed before its stopped state could be read.');
    }
    reader.readU32();
    reader.readU64();
    const baseAddress = reader.readU64();
    const frames: GameMakerStackFrame[] = [];
    if (baseAddress === NULL_POINTER) {
      const globals = this.readGlobals(reader);
      return { reason: this.expectedStopReason, frames, globals };
    }

    const address = reader.readU32();
    const self = readInstanceValue(reader, this.metadata!.version);
    const other = readInstanceValue(reader, this.metadata!.version);
    const currentScript = this.metadata!.scriptForAddress(baseAddress, address);

    const localCount = reader.readU32();
    const currentLocals: GameMakerVariable[] = [];
    for (let index = 0; index < localCount; index++) {
      currentLocals.push(
        readLocalVariable(reader, this.metadata!.version, this.metadata!),
      );
    }
    const includesSelf = reader.readU32() !== 0;
    const selfInstance = includesSelf
      ? readInstance(reader, this.metadata!.version, this.metadata!, true)
          .variables
      : undefined;

    const currentArgumentCount = reader.readU32();
    if (currentArgumentCount === NULL_U32) {
      if (currentScript) {
        frames.push({
          name: currentScript.displayName || currentScript.name,
          line: this.metadata!.lineForAddress(currentScript, address),
          script: currentScript,
          address,
          locals: currentLocals,
          self,
          other,
        });
      }
      const globals = this.readGlobals(reader);
      return {
        reason: this.expectedStopReason,
        frames,
        globals,
        selfInstance,
      };
    }
    for (let index = 0; index < currentArgumentCount; index++) {
      currentLocals.push({
        name: currentScript?.argumentNames?.[index] ?? `argument${index}`,
        value: readRValue(reader),
      });
    }
    if (currentScript) {
      frames.push({
        name: currentScript.displayName || currentScript.name,
        line: this.metadata!.lineForAddress(currentScript, address),
        script: currentScript,
        address,
        locals: currentLocals,
        self,
        other,
      });
    }

    const frameCount = reader.readU32();
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const frameBase = reader.readU64();
      const frameAddress = reader.readU32();
      const frameSelf = readInstanceValue(reader, this.metadata!.version);
      const frameOther = readInstanceValue(reader, this.metadata!.version);
      const argumentCount = reader.readU32();
      const argumentValues: GameMakerValue[] = [];
      for (let index = 0; index < argumentCount; index++) {
        argumentValues.push(readRValue(reader));
      }
      const frameLocalCount = reader.readU32();
      const frameLocals: GameMakerVariable[] = [];
      for (let index = 0; index < frameLocalCount; index++) {
        frameLocals.push(
          readLocalVariable(reader, this.metadata!.version, this.metadata!),
        );
      }
      const script = this.metadata!.scriptForAddress(frameBase, frameAddress);
      if (!script) continue;
      for (let index = 0; index < argumentValues.length; index++) {
        frameLocals.push({
          name: script.argumentNames?.[index] ?? `argument${index}`,
          value: argumentValues[index]!,
        });
      }
      frames.push({
        name: script.displayName || script.name,
        line: this.metadata!.lineForAddress(script, frameAddress),
        script,
        address: frameAddress,
        locals: frameLocals,
        self: frameSelf,
        other: frameOther,
      });
    }
    const globals = this.readGlobals(reader);
    return {
      reason: this.expectedStopReason,
      frames,
      globals,
      selfInstance,
    };
  }

  private readGlobals(reader: GameMakerBinaryReader) {
    const count = reader.readU32();
    const globals: GameMakerVariable[] = [];
    for (let index = 0; index < count; index++) {
      globals.push(
        readGlobalVariable(reader, this.metadata!.version, this.metadata!),
      );
    }
    return globals;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.metadata) {
      try {
        // Do not enqueue shutdown behind an in-flight poll. A disconnected or
        // wedged Runner can otherwise keep Debug: Stop waiting indefinitely.
        await this.write(makeCommand(command.quitDebugger));
      } catch {
        // The Runner may already have closed its socket.
      }
    }
    this.socket?.destroy();
    this.socket = undefined;
    this.reader = undefined;
  }
}

export const gameMakerProtocolInternals = {
  command,
  makeBatch,
  makeBreakpointCommand,
  makeCommand,
  normalizeSource,
  stepType,
};
