import type { CstNode } from 'chevrotain';
import type { JsdocSummary } from '../jsdoc.js';
import type { LanguageProfile } from '../language/version.js';
import type { Code } from '../project.code.js';
import type {
  DiagnosticCollections,
  DiagnosticCollectionName,
  DiagnosticSeverity,
} from '../project.diagnostics.js';
import type {
  FunctionArgRange,
  Reference,
  Scope,
  StructNewMemberRange,
} from '../project.location.js';
import type { Signifier } from '../signifiers.js';
import type { SourceOrigin, SourceSpan } from '../syntax/source.js';
import type { Type, TypeStore } from '../types.js';

export type { SourceOrigin, SourceSpan } from '../syntax/source.js';
export type SymbolKey = string;
export type TypeKey = string;

/** All generated and physical offsets are inclusive, matching the public range API. */
export interface SyntaxInput {
  readonly unitId: string;
  readonly text: string;
  readonly cst: CstNode;
  readonly origin: (start: number, end: number) => SourceOrigin;
}
export interface SyntaxNode {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly origin: SourceOrigin;
  readonly grouped?: boolean;
}
export interface Name extends SyntaxNode {
  readonly text: string;
}
export interface Argument extends SyntaxNode {
  readonly value?: Expression;
  readonly docs?: JsdocSummary;
}
export interface Parameter extends SyntaxNode {
  readonly name: Name;
  readonly value?: Expression;
}
export interface StructEntry extends SyntaxNode {
  readonly name: Name;
  readonly value?: Expression;
  readonly shorthand: boolean;
  readonly docs?: JsdocSummary;
}
export interface FunctionExpression extends SyntaxNode {
  readonly kind: 'function';
  readonly extension?: boolean;
  readonly name?: Name;
  readonly parameters: readonly Parameter[];
  readonly body: Statement;
  readonly constructor: boolean;
  readonly base?: {
    readonly name: Name;
    readonly arguments: readonly Argument[];
  };
  readonly docs?: JsdocSummary;
}
export type Expression =
  | (SyntaxNode & { readonly kind: 'name'; readonly name: Name })
  | (SyntaxNode & {
      readonly kind: 'literal';
      readonly type: 'Real' | 'String' | 'Bool' | 'Undefined' | 'Pointer';
      readonly value?: string | number | boolean;
      readonly nullPointer?: boolean;
    })
  | (SyntaxNode & {
      readonly kind: 'array';
      readonly values: readonly Expression[];
    })
  | (SyntaxNode & {
      readonly kind: 'struct';
      readonly entries: readonly StructEntry[];
    })
  | FunctionExpression
  | (SyntaxNode & {
      readonly kind: 'unary';
      readonly operator: string;
      readonly operand: Expression;
      readonly postfix: boolean;
    })
  | (SyntaxNode & {
      readonly kind: 'binary';
      readonly operator: string;
      readonly left: Expression;
      readonly right: Expression;
      readonly uncertainGrouping?: boolean;
    })
  | (SyntaxNode & {
      readonly kind: 'conditional';
      readonly condition: Expression;
      readonly yes: Expression;
      readonly no: Expression;
    })
  | (SyntaxNode & {
      readonly kind: 'assign';
      readonly operator: string;
      readonly target: Expression;
      readonly value: Expression;
    })
  | (SyntaxNode & {
      readonly kind: 'member';
      readonly target: Expression;
      readonly name: Name;
      readonly dot: SyntaxNode;
    })
  | (SyntaxNode & {
      readonly kind: 'index';
      readonly target: Expression;
      readonly accessor:
        | 'array'
        | 'array-mutation'
        | 'struct'
        | 'map'
        | 'list'
        | 'grid';
      readonly indices: readonly Expression[];
    })
  | (SyntaxNode & {
      readonly kind: 'call';
      readonly target: Expression;
      readonly arguments: readonly Argument[];
      readonly usesNew: boolean;
    })
  | (SyntaxNode & {
      readonly kind: 'template';
      readonly values: readonly Expression[];
    })
  | (SyntaxNode & {
      readonly kind: 'unknown';
      readonly children: readonly Expression[];
    });

export interface VariableDeclaration extends SyntaxNode {
  readonly name: Name;
  readonly value?: Expression;
  readonly docs?: JsdocSummary;
}
export interface EnumMember extends SyntaxNode {
  readonly name: Name;
  readonly value?: Expression;
}
export type Statement =
  | (SyntaxNode & {
      readonly kind: 'block';
      readonly statements: readonly Statement[];
    })
  | (SyntaxNode & {
      readonly kind: 'declarations';
      readonly storage: 'local' | 'global' | 'static';
      readonly declarations: readonly VariableDeclaration[];
    })
  | (SyntaxNode & {
      readonly kind: 'expression';
      readonly expression: Expression;
      readonly docs?: JsdocSummary;
    })
  | (SyntaxNode & {
      readonly kind: 'function';
      readonly expression: FunctionExpression;
    })
  | (SyntaxNode & {
      readonly kind: 'enum';
      readonly name: Name;
      readonly members: readonly EnumMember[];
      readonly docs?: JsdocSummary;
    })
  | (SyntaxNode & {
      readonly kind: 'if';
      readonly condition: Expression;
      readonly yes: Statement;
      readonly no?: Statement;
    })
  | (SyntaxNode & {
      readonly kind: 'loop';
      readonly loop: 'while' | 'do-until' | 'for' | 'repeat';
      readonly condition?: Expression;
      readonly initializer?: Statement;
      readonly update?: Expression;
      readonly body: Statement;
    })
  | (SyntaxNode & {
      readonly kind: 'switch';
      readonly expression: Expression;
      readonly cases: readonly {
        readonly test?: Expression;
        readonly body: Statement;
      }[];
    })
  | (SyntaxNode & {
      readonly kind: 'with';
      readonly expression: Expression;
      readonly body: Statement;
      readonly docs?: JsdocSummary;
    })
  | (SyntaxNode & {
      readonly kind: 'try';
      readonly body: Statement;
      readonly catchName?: Name;
      readonly catchBody?: Statement;
      readonly finallyBody?: Statement;
    })
  | (SyntaxNode & {
      readonly kind: 'return' | 'throw';
      readonly value?: Expression;
    })
  | (SyntaxNode & { readonly kind: 'break' | 'continue' | 'exit' | 'empty' })
  | (SyntaxNode & { readonly kind: 'doc'; readonly docs: JsdocSummary });

export interface SemanticDiagnostic {
  readonly collection: DiagnosticCollectionName;
  readonly message: string;
  readonly origin: SourceOrigin;
  readonly severity: DiagnosticSeverity;
}
export interface SyntaxUnit {
  readonly input: SyntaxInput;
  readonly root: Statement;
  readonly jsdocs: readonly JsdocSummary[];
  readonly diagnostics: readonly SemanticDiagnostic[];
}
export interface UnitContext {
  readonly unitId: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly kind:
    | 'script'
    | 'object-event'
    | 'room-creation'
    | 'instance-creation'
    | 'timeline'
    | 'extension'
    | 'other';
  readonly dynamicSelf?: boolean;
  readonly extensionFunctions?: readonly {
    sourceName: string;
    name: string;
    hidden: boolean;
    signatureKey: string;
  }[];
  readonly eventName?: string;
  readonly selfOwner?: TypeKey;
  readonly definitiveSelf: boolean;
  readonly language: Pick<LanguageProfile, 'scriptSemantics' | 'supports'> &
    Partial<Pick<LanguageProfile, 'nativeDegraded'>>;
  readonly strictUserArity?: boolean;
  readonly autoDeclareGlobalsPrefixes?: readonly string[];
}
export type DeclarationRole =
  | 'local'
  | 'parameter'
  | 'global'
  | 'function'
  | 'field'
  | 'static'
  | 'enum'
  | 'enum-member'
  | 'annotation'
  | 'legacy-script'
  | 'extension-function';
export interface Declaration {
  readonly id: string;
  readonly key: SymbolKey;
  readonly name: string;
  readonly owner: TypeKey;
  readonly scope: string;
  readonly role: DeclarationRole;
  readonly origin: SourceOrigin;
  readonly declaration: SourceOrigin;
  readonly node: SyntaxNode;
  readonly docs?: JsdocSummary;
  readonly bare: boolean;
  readonly exported: boolean;
  readonly parameterIndex?: number;
  readonly optional?: boolean;
  readonly extensionModule?: string;
  readonly extensionSignature?: string;
  readonly extensionTarget?: string;
  readonly hidden?: boolean;
}
export interface BindingScope {
  readonly key: string;
  readonly parent?: string;
  readonly localOwner: TypeKey;
  readonly selfOwner: TypeKey;
  readonly staticOwner?: TypeKey;
  readonly functionId?: string;
  readonly declarations: ReadonlyMap<string, SymbolKey>;
}
export interface BoundFunction {
  readonly node: FunctionExpression;
  readonly key: SymbolKey;
  readonly typeKey: TypeKey;
  readonly localOwner: TypeKey;
  readonly staticOwner: TypeKey;
  readonly selfOwner: TypeKey;
  readonly scope: string;
  readonly declaration?: Declaration;
}
export interface BoundUnit {
  readonly unitId: string;
  readonly context: UnitContext;
  readonly syntax: SyntaxUnit;
  readonly declarations: readonly Declaration[];
  readonly scopes: ReadonlyMap<string, BindingScope>;
  readonly nodeScopes: ReadonlyMap<string, string>;
  readonly declarationSites: ReadonlyMap<string, Declaration>;
  readonly functions: ReadonlyMap<string, BoundFunction>;
  readonly diagnostics: readonly SemanticDiagnostic[];
}

/** A definite resource field whose source format has no safe rename editor yet. */
export interface ResourceDefinition {
  readonly kind: 'object-variable';
  /** Only this input contribution may establish the current resource ownership. */
  readonly unitId: string;
  readonly uri: string;
  readonly name: string;
}

export type LookupNamespace =
  | 'global'
  | 'member'
  | 'static'
  | 'named-type'
  | 'native'
  | 'resource';
export interface LookupRequest {
  readonly namespace: LookupNamespace;
  readonly owner: string;
  readonly name: string;
}
export interface SymbolView {
  readonly key: SymbolKey;
  readonly item: Signifier;
  readonly origin?: SourceOrigin;
  readonly declaration?: Declaration;
  readonly bare?: boolean;
  readonly constant?: string | number | boolean;
  readonly nullPointer?: boolean;
  /** Input-provided identity and metadata survive conflicting source declarations. */
  readonly intrinsic?: boolean;
}
export interface SemanticDependency {
  readonly kind: 'lookup' | 'missing' | 'type' | 'usage' | 'capability';
  readonly owner: string;
  readonly name?: string;
  readonly target?: string;
  readonly facet?:
    | 'signature'
    | 'returns'
    | 'members'
    | 'base'
    | 'static'
    | 'items'
    | 'annotation';
}
/** Staged declarations and last evaluated summaries; never a mutable Project. */
export interface SemanticEnvironment {
  lookup(request: LookupRequest): SymbolView | undefined;
  type(key: TypeKey): Type | undefined;
  observe(dependency: SemanticDependency): void;
  cancelled(): boolean;
}
export interface SymbolContribution extends SymbolView {
  readonly owner: TypeKey;
  readonly unitId: string;
  readonly exported: boolean;
}
export type ReferenceRole =
  | 'declaration'
  | 'read'
  | 'write'
  | 'read-write'
  | 'type'
  | 'shorthand-value'
  | 'shorthand-property';
export type RenameRecipe =
  | { readonly kind: 'identifier'; readonly property?: boolean }
  | { readonly kind: 'shorthand-value'; readonly property: string }
  | { readonly kind: 'shorthand-property'; readonly value: string }
  | { readonly kind: 'string-key'; readonly quote: string }
  | { readonly kind: 'none' };
export interface SemanticReference {
  readonly unitId: string;
  readonly symbol: SymbolKey;
  readonly origin: SourceOrigin;
  readonly role: ReferenceRole;
  readonly isDefinition: boolean;
  readonly type: TypeStore;
  readonly rename: RenameRecipe;
}
export interface SemanticScope {
  readonly origin: SourceOrigin;
  readonly local: TypeKey;
  readonly self: TypeKey;
  readonly dot: boolean;
  /** Every receiver alternative, including unknown and non-member types. */
  readonly receivers?: TypeStore;
  /** Member values at this query point, independent of later writes. */
  readonly memberTypes?: ReadonlyMap<SymbolKey, TypeStore>;
}
export interface SemanticCall {
  readonly origin: SourceOrigin;
  readonly type: Type<'Function'>;
  readonly arguments: readonly {
    readonly origin: SourceOrigin;
    readonly hasExpression: boolean;
    readonly type: TypeStore;
  }[];
  readonly kind: 'call' | 'new' | 'base-constructor';
}
export interface UnitEvaluation {
  readonly unitId: string;
  readonly bound: BoundUnit;
  readonly status: 'complete' | 'degraded';
  readonly symbols: ReadonlyMap<SymbolKey, SymbolContribution>;
  readonly types: ReadonlyMap<TypeKey, Type>;
  readonly namedTypes: ReadonlyMap<string, TypeKey>;
  readonly references: readonly SemanticReference[];
  readonly scopes: readonly SemanticScope[];
  readonly calls: readonly SemanticCall[];
  readonly structRanges: readonly {
    readonly origin: SourceOrigin;
    readonly type: TypeKey;
  }[];
  readonly callsSuper: boolean;
  readonly diagnostics: readonly SemanticDiagnostic[];
  readonly dependencies: readonly SemanticDependency[];
  /** Order/position independent semantic export description. */
  readonly summary: string;
}
export interface CodeSemanticView {
  readonly refs: readonly Reference[];
  readonly scopes: readonly Scope[];
  readonly jsdocs: readonly JsdocSummary[];
  readonly functionArgRanges: readonly FunctionArgRange[];
  readonly functionCalls: readonly (readonly FunctionArgRange[])[];
  readonly structNewMemberRanges: readonly StructNewMemberRange[];
  readonly callsSuper: boolean;
  readonly diagnostics: Readonly<Partial<DiagnosticCollections>>;
}
export interface MaterializationHost {
  source(
    uri: string,
  ): { readonly file: Code; readonly text: string } | undefined;
  /** Whether this generation has an owning contribution for a keyed symbol. */
  hasSymbol(key: SymbolKey): boolean;
  symbol(key: SymbolKey): Signifier;
  /** The selected definition in this staged generation, before publication. */
  definition?(key: SymbolKey): SourceOrigin | undefined;
  type(key: TypeKey): Type;
  /** Convert a candidate type to its committed, canonical graph. */
  value(type: Type): Type;
}

export class AnalysisCancelled extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'AnalysisCancelled';
  }
}
export const globalOwner = 'global';
export function globalKey(name: string): SymbolKey {
  return `global:${name}`;
}
export function memberKey(owner: string, name: string): SymbolKey {
  return owner === globalOwner ? globalKey(name) : `${owner}/member:${name}`;
}
