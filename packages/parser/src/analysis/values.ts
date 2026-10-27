import { createHash } from 'node:crypto';
import { getTypes } from '../types.checks.js';
import { Type, TypeStore } from '../types.js';
import type { PrimitiveName } from '../types.primitives.js';

export type Value = TypeStore;
export function value(...types: (Type | TypeStore | undefined)[]): Value {
  const result = new TypeStore();
  const seen = new Map<string | Type, number>();
  const normalized: Type[] = [];
  for (const type of types.flatMap((entry) => getTypes(entry))) {
    // Distinct allocation sites and enum declarations must retain identity.
    const structured = [
      'Struct',
      'Function',
      'Array',
      'Enum',
      'EnumMember',
    ].includes(type.kind);
    const identity =
      type.semanticKey ||
      (structured
        ? type
        : `${type.kind}:${type.name || ''}:${String(type.nullPointer)}`);
    const priorIndex = seen.get(identity);
    if (priorIndex !== undefined) {
      const prior = normalized[priorIndex];
      if (
        !structured &&
        !type.semanticKey &&
        prior.literalValue !== type.literalValue
      ) {
        const widened = new Type(type.kind);
        widened.name = type.name;
        widened.isGeneric = type.isGeneric;
        widened.nullPointer = type.nullPointer;
        normalized[priorIndex] = widened;
      }
      continue;
    }
    seen.set(identity, normalized.length);
    normalized.push(type);
  }
  result.type = normalized;
  return result;
}
export function primitive(kind: PrimitiveName): Value {
  return value(new Type(kind));
}
export function join(...values: Value[]): Value {
  return value(...values);
}
export function unknown(): Value {
  return primitive('Any');
}
/** Empty is inference-pending, not runtime Undefined or unreachable Never. */
export function pending(): Value {
  return value();
}
export function knownConstant(
  input: Value,
): string | number | boolean | undefined {
  const types = input.type;
  if (!types.length || types[0].literalValue === undefined) return;
  const first = types[0].literalValue;
  return types.every((type) => type.literalValue === first) ? first : undefined;
}

/** GML's numeric boolean conversion is > 0.5, not JavaScript truthiness.
 * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Data_Types.htm
 */
export function constantTruth(input: Value): boolean | undefined {
  const constant = knownConstant(input);
  if (typeof constant === 'boolean') return constant;
  if (typeof constant === 'number' && Number.isFinite(constant))
    return constant > 0.5;
  if (
    input.hasTypes &&
    input.type.every(
      (type) =>
        type.kind === 'Undefined' ||
        (type.kind === 'Pointer' && type.nullPointer === true),
    )
  )
    return false;
  return;
}

/** Exact finite-number facts only. Unknown target/precision cases remain unfolded.
 * GML div converts both operands to integers before division; bitwise results
 * are signed int64 even when their inputs were ordinary numbers.
 * https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Overview/Expressions_And_Operators.htm
 */
export function foldNumeric(
  operator: string,
  a: number,
  b: number,
): number | undefined {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  const arithmetic: Record<string, () => number> = {
    '+': () => a + b,
    '-': () => a - b,
    '*': () => a * b,
    '/': () => a / b,
    '%': () => a % b,
    mod: () => a % b,
    div: () =>
      Math.trunc(b) >= 1 ? Math.trunc(Math.trunc(a) / Math.trunc(b)) : NaN,
  };
  if (arithmetic[operator]) {
    const result = arithmetic[operator]();
    return Number.isFinite(result) ? result : undefined;
  }
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return;
  const left = BigInt.asIntN(64, BigInt(a)),
    right = BigInt.asIntN(64, BigInt(b));
  const result =
    operator === '&'
      ? left & right
      : operator === '|'
        ? left | right
        : operator === '^'
          ? left ^ right
          : operator === '<<' && b >= 0 && b < 64
            ? left << right
            : operator === '>>' && b >= 0 && b < 64
              ? left >> right
              : undefined;
  if (result === undefined) return;
  const narrowed = Number(BigInt.asIntN(64, result));
  return Number.isSafeInteger(narrowed) ? narrowed : undefined;
}
export function foldBitwiseNot(input: number): number | undefined {
  if (!Number.isSafeInteger(input)) return;
  const result = Number(BigInt.asIntN(64, ~BigInt(input)));
  return Number.isSafeInteger(result) ? result : undefined;
}

export function withoutUndefined(input: Value): Value {
  return value(...input.type.filter((type) => type.kind !== 'Undefined'));
}
export function nullishPaths(input: Value): {
  present: Value;
  mayRun: boolean;
  maySkip: boolean;
} {
  let mayRun = !input.hasTypes,
    maySkip = !input.hasTypes;
  const retained: Type[] = [];
  for (const type of input.type) {
    if (type.kind === 'Never') {
      retained.push(type);
      continue;
    }
    if (
      type.kind === 'Undefined' ||
      (type.kind === 'Pointer' && type.nullPointer === true)
    )
      mayRun = true;
    else {
      maySkip = true;
      if (type.kind === 'Pointer' && type.nullPointer === undefined) {
        mayRun = true;
        const present = type.deriveDetached();
        present.nullPointer = false;
        retained.push(present);
      } else {
        retained.push(type);
        if (['Any', 'Unknown', 'Mixed'].includes(type.kind)) mayRun = true;
      }
    }
  }
  return { present: value(...retained), mayRun, maySkip };
}
export function nullishResult(left: Value, right: Value): Value {
  const paths = nullishPaths(left);
  return value(paths.present, paths.mayRun ? right : undefined);
}
// Hash each node before embedding it in its parent. Embedding serialized child
// strings recursively doubles JSON escaping with depth, even for a simple chain.
function digest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
export function fingerprint(
  input: Type | TypeStore,
  active = new Set<string | Type>(),
): string {
  if (input.$tag === 'TypeStore')
    return digest([
      'union',
      [...new Set(input.type.map((type) => fingerprint(type, active)))].sort(),
    ]);
  const type = input;
  const identity = type.semanticKey || type;
  if (active.has(identity)) return `recursive:${type.kind}:${type.name || ''}`;
  const next = new Set(active).add(identity);
  const members = type
    .listMembers(true)
    .map(
      (member) =>
        `${member.name}:${fingerprint(member.type, next)}:${member.static ? 's' : ''}:${member.readable ? 'r' : ''}${member.writable ? 'w' : ''}:${member.placeholder ? 'p' : 'd'}:${member.resourceDefinition ? JSON.stringify([member.resourceDefinition.unitId, member.resourceDefinition.uri, member.resourceDefinition.name]) : ''}`,
    )
    .sort();
  const params = type
    .listParameters()
    .map((param) =>
      param
        ? `${param.name}:${param.optional ? '?' : ''}${fingerprint(param.type, next)}`
        : '',
    );
  return digest([
    type.kind,
    type.name,
    type.isConstructor,
    type.callKind,
    members,
    params,
    type.returns && fingerprint(type.returns, next),
    type.items && fingerprint(type.items, next),
    type.self && fingerprint(type.self, next),
    type.statics && fingerprint(type.statics, next),
    type.extends && fingerprint(type.extends, next),
    type.nullPointer,
    type.literalValue,
    type.functionSource?.fingerprint,
    type.methodSource?.semanticKey,
  ]);
}
export function equalValues(left: Value, right: Value): boolean {
  return fingerprint(left) === fingerprint(right);
}
export function dynamic(input: Value): boolean {
  return (
    !input.hasTypes ||
    input.type.some((type) => ['Any', 'Unknown', 'Mixed'].includes(type.kind))
  );
}
