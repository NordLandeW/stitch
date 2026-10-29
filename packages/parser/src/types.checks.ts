import { arrayWrapped, isArray } from '@bscotch/utility';
import type { Signifier } from './signifiers.js';
import { KnownTypesMap } from './types.feather.js';
import { Type, TypeStore } from './types.js';
import { PrimitiveName } from './types.primitives.js';

export function isTypeOfKind<T extends PrimitiveName>(
  item: any,
  kind: T,
): item is Type<T> {
  return isTypeInstance(item) && item.kind === kind;
}

export function isTypeStoreOfKind<T extends PrimitiveName>(
  item: any,
  kind: T,
): item is TypeStore<T> {
  return isTypeStore(item) && item.kind === kind;
}

export function isTypeOrStoreOfKind<T extends PrimitiveName>(
  item: any,
  kind: T,
): item is Type<T> | TypeStore<T> {
  return isTypeOfKind(item, kind) || isTypeStoreOfKind(item, kind);
}

/**
 * Given some kind of type collection, find the first one matching
 * a given kind.
 */
export function getTypeOfKind<T extends PrimitiveName>(
  from: undefined | Signifier | Type | TypeStore | (Type | TypeStore)[],
  kind: T | ReadonlyArray<T>,
): { [Kind in T]: Type<Kind> }[T] | undefined {
  if (!from) return undefined;
  const types = getTypes(from);
  const kinds = arrayWrapped(kind) as T[];
  return types.find((t) => kinds.includes(t.kind as any)) as
    | Type<T>
    | undefined;
}

export function getTypesOfKind<T extends PrimitiveName>(
  from: undefined | Signifier | Type | TypeStore | (Type | TypeStore)[],
  kind: T | ReadonlyArray<T>,
): { [Kind in T]: Type<Kind> }[T][] {
  if (!from) return [];
  const types = getTypes(from);
  const kinds = arrayWrapped(kind) as T[];
  return types.filter((t) => kinds.includes(t.kind as any)) as any;
}

/** Get the typestore of item, if present. Else get the type on item. */
export function getTypeStoreOrType(
  item: Signifier | Type | TypeStore | Type[],
): TypeStore | Type[] {
  if (isArray(item)) {
    return item;
  }
  if (item.$tag === 'Sym') {
    return item.type;
  } else if (item.$tag === 'TypeStore') {
    return item;
  }
  return arrayWrapped(item);
}

/** Things that can be converted into an array of types */
export type Typeable = Signifier | Type | TypeStore | (Type | TypeStore)[];

export function getTypes(items: Typeable | undefined): Type[] {
  const types: Type[] = [];
  if (!items) {
    return types;
  }
  for (const item of arrayWrapped(items)) {
    if (item.$tag === 'Sym') {
      for (const type of item.type.type) types.push(type);
    } else if (item.$tag === 'TypeStore') {
      for (const type of item.type) types.push(type);
    } else {
      types.push(item);
    }
  }
  return types;
}

export function isTypeInstance(item: any): item is Type {
  return item && '$tag' in item && item.$tag === 'Type';
}

export function isTypeStore(item: any): item is TypeStore {
  return item && '$tag' in item && item.$tag === 'TypeStore';
}

/**
 * Returns `true` if `narrowed` is a subtype of `type`,
 * meaning that it is a subset/narrowed/compatible/same type
 * compared to otherType.
 *
 * Identical types also return `true`.
 */
export function narrows(
  narrowType: Type | TypeStore | Type[],
  broadType: Type | TypeStore | Type[],
): boolean {
  return narrowsWithPath(narrowType, broadType, new Map());
}

type NarrowingPath = Map<Type, Set<Type>>;

function narrowsWithPath(
  narrowType: Type | TypeStore | Type[],
  broadType: Type | TypeStore | Type[],
  path: NarrowingPath,
): boolean {
  const narrowTypes = getTypes(narrowType);
  const broadTypes = getTypes(broadType);
  return narrowTypes.every((narrow) =>
    broadTypes.some((broad) => narrowsType(narrow, broad, path)),
  );
}

/**
 * Returns `true` if `narrowed` is a subtype of `type`,
 * meaning that it is a subset/narrowed/compatible/same type
 * compared to otherType.
 *
 * Identical types also return `true`.
 */
function narrowsType(
  narrowType: Type,
  broadType: Type,
  path: NarrowingPath = new Map(),
): boolean {
  if (narrowType === broadType) {
    return true;
  }

  if (
    ['Mixed', 'Any', 'Unknown'].includes(broadType.kind) ||
    ['Mixed', 'Any'].includes(narrowType.kind)
  ) {
    // Then everyone is satisfied all of the time
    return true;
  }

  if (broadType.kind !== narrowType.kind) {
    return false;
  }

  let compared = path.get(narrowType);
  if (compared?.has(broadType)) return true;
  if (!compared) path.set(narrowType, (compared = new Set()));
  compared.add(broadType);
  try {
    // The subtype must have all of the same members, though it could also have others
    for (const member of broadType.listMembers()) {
      const matching = narrowType.getMember(member.name);
      if (!matching) {
        return false;
      }
    }
    // Similarly, the subtype must have the same params (though it could have others)
    for (const param of broadType.listParameters()) {
      const matching = !param || narrowType.getParameter(param.idx!);
      if (!matching) {
        return false;
      }
    }
    // Check return type
    if (
      broadType.returns &&
      (!narrowType.returns ||
        !narrowsWithPath(narrowType.returns, broadType.returns, path))
    ) {
      return false;
    }
    // Check the constructs type
    if (
      broadType.isConstructor &&
      (!narrowType.isConstructor ||
        !narrowsWithPath(narrowType.self!, broadType.self!, path))
    ) {
      return false;
    }

    return true;
  } finally {
    compared.delete(broadType);
  }
}

/**
 * For types inferred from expressions, normalize away utility
 * types like `InstanceType` and `ObjectType`, and perform any
 * other type-normalization tasks. Returns a new TypeStore, so
 * if maintaining reference links is essential this function should
 * not be used.
 */
export function normalizeType(
  inferred: Typeable,
  knownTypes: KnownTypesMap,
): TypeStore {
  const normalized = new TypeStore();
  type: for (const type of getTypes(inferred)) {
    if (type.kind === 'EnumMember') {
      normalized.addType(type.signifier?.parent || type);
      continue;
    } else {
      for (const [utilityKind, defaultItemKind] of [
        ['InstanceType', 'Id.Instance'],
        ['ObjectType', 'Asset.GMObject'],
        ['StaticType', 'Struct'],
      ] as const) {
        if (type.kind !== utilityKind) continue;
        if (!type.items?.type.length) {
          normalized.addType(
            knownTypes.get(defaultItemKind) || new Type(defaultItemKind),
          );
        }
        for (const itemType of getTypes(type.items || [])) {
          // Try to convert the type.
          const name = itemType.name
            ? `${defaultItemKind}.${itemType.name}`
            : defaultItemKind;
          let type =
            knownTypes.get(name) ||
            knownTypes.get(defaultItemKind) ||
            new Type(defaultItemKind);
          if (itemType.isGeneric) {
            // Then extend the type to allow having a generic without mutating the original
            type = type.deriveDetached().genericize().named(itemType.name);
          }
          if (utilityKind === 'StaticType') {
            const statics =
              itemType.statics ||
              itemType.signifier?.getTypeByKind('Function')?.statics;
            type = statics || Type.Struct;
            if (!statics) {
              for (const member of itemType.listMembers()) {
                if (member.static) type.setOwnMember(member);
              }
            }
          }
          normalized.addType(type);
        }
        continue type; // so that the fall-through only happens if we didn't find a match
      }
    }
    normalized.addType(type);
  }
  return normalized;
}

/**
 * Given an expected type that might include generics, and an inferred
 * type that should map onto it, update a generics map linking generics
 * to inferred types by name.
 */
export function updateGenericsMap(
  expected: Typeable,
  inferred: Typeable,
  knownTypes: KnownTypesMap,
  /** Map of generics by name to their *inferred type* */
  generics: Map<string, TypeStore> = new Map(),
  /** Observe item values consulted while inferring dependent results. */
  onItems?: (container: Type) => void,
) {
  const frame = (left: Typeable, right: Typeable) => ({
    expected: getTypes(left).flatMap(
      (type) => normalizeType(type, knownTypes).type,
    ),
    inferred: getTypes(right).flatMap(
      (type) => normalizeType(type, knownTypes).type,
    ),
    expectedIndex: 0,
    inferredIndex: 0,
  });
  const pending = [frame(expected, inferred)];
  const visited = new Map<Type, Set<Type>>();
  while (pending.length) {
    const current = pending[pending.length - 1];
    if (current.expectedIndex === current.expected.length) {
      pending.pop();
      continue;
    }
    const expectedType = current.expected[current.expectedIndex];
    let generic: TypeStore | undefined;
    if (expectedType.isGeneric) {
      const name = expectedType.name!;
      generic = generics.get(name) || new TypeStore();
      generics.set(name, generic);
    }
    if (current.inferredIndex === current.inferred.length) {
      current.expectedIndex++;
      current.inferredIndex = 0;
      continue;
    }
    const inferredType = current.inferred[current.inferredIndex++];
    let compared = visited.get(expectedType);
    if (!compared) visited.set(expectedType, (compared = new Set()));
    if (compared.has(inferredType)) continue;
    compared.add(inferredType);
    if (!narrowsType(inferredType, expectedType)) continue;
    if (generic) generic.addType(inferredType);
    // Resume the parent after its child, preserving generic alternative order.
    if (expectedType.items?.hasTypes) {
      onItems?.(inferredType);
      // An observed empty item store is inference-bottom, not an unbound
      // generic. Preserve it so dependent results can grow with later inputs.
      if (inferredType.items)
        pending.push(frame(expectedType.items, inferredType.items));
    }
  }
  return generics;
}

export function replaceGenerics(
  startingType: Typeable,
  knownTypes: KnownTypesMap,
  generics: Map<string, TypeStore>,
): TypeStore {
  const startingTypes = getTypes(startingType);
  if (!generics.size) {
    const unchanged = new TypeStore();
    unchanged.type = startingTypes;
    return unchanged;
  }
  // Clone each input node once, reserving its identity before following items.
  // Generic substitution preserves finite cycles and shared container aliases.
  const copies = new Map<Type, Type>();
  const pending: { source: Type; target: Type }[] = [];
  const replace = (input: Typeable): TypeStore => {
    const values: Type[] = [];
    for (const starting of getTypes(input)) {
      const replacements =
        starting.isGeneric && generics.has(starting.name!)
          ? generics.get(starting.name!)!.type
          : [starting];
      for (const source of replacements) {
        let target = copies.get(source);
        if (!target) {
          target = source.deriveDetached();
          copies.set(source, target);
          if (source.items) pending.push({ source, target });
        }
        values.push(target);
      }
    }
    const result = new TypeStore();
    result.type = values.some((type) => type.kind !== 'Any')
      ? values.filter((type) => type.kind !== 'Any')
      : values;
    return result;
  };
  const result = replace(startingType);
  for (let index = 0; index < pending.length; index++) {
    const { source, target } = pending[index];
    target.items = replace(source.items!);
  }
  return result;
}
