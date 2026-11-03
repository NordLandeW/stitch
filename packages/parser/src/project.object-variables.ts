import {
  YyObjectPropertyVarType,
  type YyObject,
  type YyObjectProperty,
} from '@bscotch/yy';
import type { Asset } from './project.asset.js';
import { Signifier } from './signifiers.js';
import { Type } from './types.js';

type ResourceDefinition = NonNullable<Signifier['resourceDefinition']>;
// An inherited GML declaration can be used by metadata declared only in a
// child. Track those users so removing one resource releases only its share.
const resourceUsers = new WeakMap<
  Signifier,
  Map<ObjectVariables, ResourceDefinition>
>();

function propertyType(property: YyObjectProperty) {
  switch (property.varType) {
    case YyObjectPropertyVarType.Real:
    case YyObjectPropertyVarType.Integer:
    case YyObjectPropertyVarType.Colour:
      return Type.Real;
    case YyObjectPropertyVarType.String:
      return Type.String;
    case YyObjectPropertyVarType.Boolean:
      return Type.Bool;
    case YyObjectPropertyVarType.List:
      if (property.multiselect) return new Type('Array').setItemType(Type.Any);
      return Type.Any;
    default:
      // Expressions and asset selections are declarations even when their
      // values cannot be evaluated statically from the resource metadata.
      return Type.Any;
  }
}

/** Pre-creation variables are inherited independently of event_inherited(). */
export class ObjectVariables {
  private readonly bindings = new Map<
    string,
    { symbol: Signifier; key: string }
  >();

  constructor(private readonly asset: Asset) {}

  /** Resolve this receiver's declaration, independently of shared rename guards. */
  static definitionFor(symbol: Signifier | undefined, receiver: Type) {
    if (!symbol) return;
    while (
      (receiver.kind === 'Id.Instance' || receiver.kind === 'Asset.GMObject') &&
      receiver.extends
    )
      receiver = receiver.extends;
    for (const [owner, definition] of resourceUsers.get(symbol) || []) {
      if (owner.asset.variables === receiver) return definition;
    }
    return;
  }

  private release(name: string) {
    const previous = this.bindings.get(name);
    if (!previous) return;
    const users = resourceUsers.get(previous.symbol);
    users?.delete(this);
    previous.symbol.resourceDefinition = users?.values().next().value;
    for (const ref of previous.symbol.refs)
      this.asset.project.queueSemanticFileUpdate(ref.file);
    this.bindings.delete(name);
  }

  private bind(
    name: string,
    symbol: Signifier,
    key: string,
    definition: ResourceDefinition,
  ) {
    if (this.bindings.get(name)?.symbol !== symbol) this.release(name);
    let users = resourceUsers.get(symbol);
    if (!users) resourceUsers.set(symbol, (users = new Map()));
    users.set(this, definition);
    symbol.resourceDefinition = users.values().next().value;
    this.bindings.set(name, { symbol, key });
  }

  clear() {
    for (const name of [...this.bindings.keys()]) {
      const symbol = this.bindings.get(name)!.symbol;
      this.release(name);
      if (!symbol.resourceDefinition && !symbol.def?.file) symbol.unsetDef();
    }
  }

  refresh(reconcileInheritance = false) {
    const { asset } = this;
    if (!asset.isObject || !asset.yy || !asset.variables) return;
    const ancestry: Asset[] = [];
    const seen = new Set<Asset>();
    let current: Asset | undefined = asset;
    while (current?.isObject && current.yy && !seen.has(current)) {
      seen.add(current);
      ancestry.unshift(current);
      const parent: YyObject['parentObjectId'] = (current.yy as YyObject)
        .parentObjectId;
      current =
        (parent && asset.project.getAssetByName(parent.name)) || undefined;
    }
    const properties = new Map<
      string,
      { property: YyObjectProperty; owner: Asset }
    >();
    for (const owner of ancestry)
      for (const property of (owner.yy as YyObject).properties || [])
        properties.set(property.name, { property, owner });

    for (const name of this.bindings.keys()) {
      if (properties.has(name)) continue;
      // A cached inherited binding belongs to its declaring object. Only retire
      // this object's own metadata contribution, never a shared parent symbol.
      const symbol = this.bindings.get(name)!.symbol;
      this.release(name);
      if (!symbol.resourceDefinition && !symbol.def?.file) symbol.unsetDef();
    }
    for (const [name, { property, owner }] of properties) {
      const key = JSON.stringify([owner.yyPath.absolute, property]);
      const previous = this.bindings.get(name);
      let symbol: Signifier | undefined = asset.variables.getMember(name, true);
      const inherited = asset.variables.extends?.getMember(name);
      const canInherit =
        inherited?.def &&
        (inherited.def.file ||
          (owner !== asset &&
            inherited.resourceDefinition?.path === owner.yyPath.absolute));
      // During reset an own GML definition is temporarily absent. Reconcile
      // fallbacks only after analysis, so an actual child assignment keeps its
      // identity rather than being repeatedly removed and recreated.
      if (
        symbol?.resourceDefinition &&
        !symbol.def?.file &&
        canInherit &&
        reconcileInheritance
      ) {
        asset.variables.removeMember(name);
        symbol.unsetDef();
        for (const ref of symbol.refs)
          asset.project.queueSemanticFileUpdate(ref.file);
        symbol = undefined;
      }
      if (!symbol && canInherit) {
        this.bind(name, inherited!, key, { path: owner.yyPath.absolute, name });
        continue;
      }
      if (!symbol) {
        symbol = new Signifier(asset.variables, name);
        symbol.instance = true;
        symbol.override = true;
        asset.variables.addMember(symbol, { override: true });
      }
      if (symbol.native) continue;
      const changed =
        previous?.key !== key || previous.symbol !== symbol || !symbol.def;
      this.bind(name, symbol, key, { path: owner.yyPath.absolute, name });
      if (changed) {
        if (!symbol.def) symbol.def = {};
        if (!symbol.def?.file) symbol.setType(propertyType(property));
        for (const ref of symbol.refs)
          asset.project.queueSemanticFileUpdate(ref.file);
      }
    }
  }
}
