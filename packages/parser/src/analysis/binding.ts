import type {
  BindingScope,
  BoundFunction,
  BoundUnit,
  Declaration,
  DeclarationRole,
  Expression,
  FunctionExpression,
  Name,
  Statement,
  SyntaxNode,
  SyntaxUnit,
  UnitContext,
} from './model.js';
import { globalKey, globalOwner, memberKey } from './model.js';

interface MutableScope extends BindingScope {
  declarations: Map<string, string>;
}

/** Bind storage and syntax roles without observing the mutable project graph. */
export function bindUnit(syntax: SyntaxUnit, context: UnitContext): BoundUnit {
  const declarations: Declaration[] = [];
  const scopes = new Map<string, MutableScope>();
  const nodeScopes = new Map<string, string>();
  const declarationSites = new Map<string, Declaration>();
  const functions = new Map<string, BoundFunction>();
  const prepared = new Set<string>();
  const rootKey = `${context.unitId}:root`;
  const root: MutableScope = {
    key: rootKey,
    localOwner: `${context.unitId}:locals`,
    selfOwner: context.selfOwner || globalOwner,
    declarations: new Map(),
  };
  scopes.set(root.key, root);

  function declare(
    name: Name,
    node: SyntaxNode,
    scope: MutableScope,
    role: DeclarationRole,
    options: Partial<Declaration> = {},
  ): Declaration {
    const prior = declarationSites.get(name.id);
    if (prior?.role === role) return prior;
    const global =
      role === 'global' ||
      role === 'enum' ||
      role === 'legacy-script' ||
      role === 'extension-function' ||
      (role === 'function' &&
        scope === root &&
        context.kind === 'script' &&
        context.language.scriptSemantics !== 'legacy-callable');
    const owner =
      options.owner ||
      (global
        ? globalOwner
        : role === 'local' || role === 'parameter'
          ? scope.localOwner
          : role === 'static'
            ? scope.staticOwner || scope.selfOwner
            : scope.selfOwner);
    const key =
      options.key ||
      (owner === globalOwner
        ? globalKey(name.text)
        : memberKey(owner, name.text));
    const declaration: Declaration = {
      id: `${context.unitId}:${name.id}:${role}`,
      key,
      owner,
      name: name.text,
      scope: scope.key,
      role,
      origin: name.origin,
      declaration: node.origin,
      node,
      bare: role !== 'global' || options.bare === true,
      exported:
        owner === globalOwner ||
        (owner === context.selfOwner && role !== 'local'),
      ...options,
    };
    declarations.push(declaration);
    declarationSites.set(name.id, declaration);
    if (role === 'local' || role === 'parameter' || role === 'static')
      scope.declarations.set(name.text, key);
    return declaration;
  }
  function local(name: string, scope: MutableScope): string | undefined {
    let current: MutableScope | undefined = scope;
    while (current) {
      const found = current.declarations.get(name);
      if (found) return found;
      const parent: MutableScope | undefined = current.parent
        ? scopes.get(current.parent)
        : undefined;
      if (parent?.functionId !== scope.functionId) break;
      current = parent;
    }
    return;
  }
  function stamp(node: SyntaxNode, scope: MutableScope) {
    nodeScopes.set(node.id, scope.key);
  }
  function prepare(statement: Statement, scope: MutableScope) {
    const id = `${scope.key}:${statement.id}`;
    if (prepared.has(id)) return;
    prepared.add(id);
    if (statement.kind === 'declarations') {
      for (const declaration of statement.declarations) {
        declare(declaration.name, declaration, scope, statement.storage, {
          docs: declaration.docs,
          bare: true,
          exported: statement.storage === 'global',
        });
      }
    } else if (statement.kind === 'function') {
      const node = statement.expression;
      if (node.name) {
        if (node.extension) {
          const exports =
            context.extensionFunctions?.filter(
              (binding) => binding.sourceName === node.name!.text,
            ) || [];
          const first = exports[0];
          const primary = declare(
            { ...node.name, text: first?.name || node.name.text },
            node,
            scope,
            'extension-function',
            {
              docs: node.docs,
              extensionModule: context.assetName,
              extensionSignature: first?.signatureKey,
              hidden: first?.hidden ?? true,
            },
          );
          for (const alias of exports.slice(1))
            declare(
              {
                ...node.name,
                id: `${node.name.id}:${alias.name}`,
                text: alias.name,
              },
              node,
              scope,
              'extension-function',
              {
                docs: node.docs,
                extensionModule: context.assetName,
                extensionSignature: alias.signatureKey,
                extensionTarget: `function:${primary.key}`,
                hidden: alias.hidden,
              },
            );
          // A definition may use a raw external name different from its public
          // metadata aliases. Internal calls still address that implementation.
          if (
            first &&
            !exports.some((binding) => binding.name === node.name!.text)
          )
            declare(
              { ...node.name, id: `${node.name.id}:implementation` },
              node,
              scope,
              'extension-function',
              {
                docs: node.docs,
                extensionModule: context.assetName,
                extensionTarget: `function:${primary.key}`,
                hidden: true,
              },
            );
        } else declare(node.name, node, scope, 'function', { docs: node.docs });
      }
    } else if (statement.kind === 'block')
      statement.statements.forEach((child) => prepare(child, scope));
    else if (statement.kind === 'if') {
      prepare(statement.yes, scope);
      if (statement.no) prepare(statement.no, scope);
    } else if (statement.kind === 'loop') {
      if (statement.initializer) prepare(statement.initializer, scope);
      prepare(statement.body, scope);
    } else if (statement.kind === 'switch')
      statement.cases.forEach((entry) => prepare(entry.body, scope));
    else if (statement.kind === 'try') {
      prepare(statement.body, scope);
      if (statement.finallyBody) prepare(statement.finallyBody, scope);
    }
    // with/catch introduce self/local context; their bodies are prepared on entry.
  }
  function functionNode(
    node: FunctionExpression,
    outer: MutableScope,
    assigned?: Declaration,
    selfHint?: string,
  ) {
    const existing = functions.get(node.id);
    if (existing) return;
    const declaration =
      assigned || (node.name && declarationSites.get(node.name.id));
    const key = declaration?.key || `${context.unitId}:function:${node.id}`;
    const declaredFunction =
      declaration?.role === 'function' ||
      declaration?.role === 'legacy-script' ||
      declaration?.role === 'extension-function';
    const typeKey = declaredFunction
      ? `function:${key}`
      : `function:${node.id}`;
    const localOwner = `${typeKey}:locals`;
    const staticOwner = `${typeKey}:statics`;
    const selfOwner = node.constructor
      ? `struct:${declaredFunction ? key : node.id}`
      : selfHint ||
        ((declaration?.role === 'function' ||
          declaration?.role === 'extension-function') &&
        outer.selfOwner === globalOwner
          ? `${typeKey}:caller-self`
          : outer.selfOwner);
    const scope: MutableScope = {
      key: `${typeKey}:scope`,
      parent: outer.key,
      localOwner,
      selfOwner,
      staticOwner,
      functionId: node.id,
      declarations: new Map(),
    };
    scopes.set(scope.key, scope);
    functions.set(node.id, {
      node,
      key,
      typeKey,
      localOwner,
      staticOwner,
      selfOwner,
      scope: scope.key,
      declaration,
    });
    stamp(node, outer);
    node.parameters.forEach((parameter, index) => {
      stamp(parameter, scope);
      declare(parameter.name, parameter, scope, 'parameter', {
        parameterIndex: index,
        optional: !!parameter.value,
        exported: false,
      });
      if (parameter.value) expression(parameter.value, scope);
    });
    if (node.base) {
      stamp(node.base.name, scope);
      node.base.arguments.forEach((arg) => {
        stamp(arg, scope);
        if (arg.value) expression(arg.value, scope);
      });
    }
    prepare(node.body, scope);
    statement(node.body, scope);
  }
  function assignment(
    target: Expression,
    node: SyntaxNode,
    scope: MutableScope,
    docs?: Declaration['docs'],
  ): Declaration | undefined {
    if (target.kind === 'name') {
      const key = local(target.name.text, scope);
      if (key)
        return declarations.find((declaration) => declaration.key === key);
      const topGlobal =
        scope === root &&
        context.kind === 'script' &&
        context.language.scriptSemantics !== 'legacy-callable';
      return declare(target.name, node, scope, topGlobal ? 'global' : 'field', {
        docs,
        bare: !topGlobal,
      });
    }
    if (
      target.kind === 'member' &&
      target.target.kind === 'name' &&
      target.target.name.text === 'global'
    ) {
      return declare(target.name, node, scope, 'global', {
        docs,
        bare: false,
        explicitGlobal: true,
      });
    }
    if (
      target.kind === 'member' &&
      target.target.kind === 'name' &&
      target.target.name.text === 'self'
    ) {
      return declare(target.name, node, scope, 'field', {
        docs,
        explicitGlobal: scope.selfOwner === globalOwner,
      });
    }
    return;
  }
  function expression(
    node: Expression,
    scope: MutableScope,
    assigned?: Declaration,
    selfHint?: string,
  ) {
    stamp(node, scope);
    switch (node.kind) {
      case 'name':
        stamp(node.name, scope);
        break;
      case 'function':
        functionNode(node, scope, assigned, selfHint);
        break;
      case 'assign': {
        const declaration = assignment(
          node.target,
          node,
          scope,
          assigned?.docs,
        );
        expression(node.target, scope);
        expression(node.value, scope, declaration, selfHint || scope.selfOwner);
        break;
      }
      case 'struct': {
        const owner = `struct:${node.id}`;
        for (const entry of node.entries) {
          stamp(entry, scope);
          stamp(entry.name, scope);
          const declaration = declare(entry.name, entry, scope, 'field', {
            owner,
            key: memberKey(owner, entry.name.text),
            exported: false,
            docs: entry.docs,
          });
          if (entry.value) expression(entry.value, scope, declaration, owner);
        }
        break;
      }
      case 'array':
        node.values.forEach((child) => expression(child, scope));
        break;
      case 'binary':
        expression(node.left, scope);
        expression(node.right, scope);
        break;
      case 'conditional':
        expression(node.condition, scope);
        expression(node.yes, scope);
        expression(node.no, scope);
        break;
      case 'unary':
        expression(node.operand, scope);
        break;
      case 'member':
        expression(node.target, scope);
        stamp(node.name, scope);
        break;
      case 'index':
        expression(node.target, scope);
        node.indices.forEach((child) => expression(child, scope));
        break;
      case 'call':
        expression(node.target, scope);
        node.arguments.forEach((arg) => {
          stamp(arg, scope);
          if (arg.value) expression(arg.value, scope);
        });
        break;
      case 'template':
        node.values.forEach((child) => expression(child, scope));
        break;
      case 'unknown':
        node.children.forEach((child) => expression(child, scope));
        break;
    }
  }
  function statement(node: Statement, scope: MutableScope) {
    stamp(node, scope);
    switch (node.kind) {
      case 'block':
        node.statements.forEach((child) => statement(child, scope));
        break;
      case 'declarations':
        node.declarations.forEach((declaration) => {
          stamp(declaration, scope);
          stamp(declaration.name, scope);
          if (declaration.value)
            expression(
              declaration.value,
              scope,
              declarationSites.get(declaration.name.id),
            );
        });
        break;
      case 'function':
        functionNode(node.expression, scope);
        break;
      case 'expression': {
        let assigned: Declaration | undefined;
        if (node.expression.kind === 'assign')
          assigned = assignment(
            node.expression.target,
            node.expression,
            scope,
            node.docs,
          );
        expression(node.expression, scope, assigned);
        break;
      }
      case 'enum': {
        const declaration = declare(node.name, node, scope, 'enum', {
          docs: node.docs,
          bare: true,
        });
        const owner = `enum:${declaration.key}`;
        for (const entry of node.members) {
          declare(entry.name, entry, scope, 'enum-member', {
            owner,
            key: memberKey(owner, entry.name.text),
            exported: true,
          });
          if (entry.value) expression(entry.value, scope);
        }
        break;
      }
      case 'if':
        expression(node.condition, scope);
        statement(node.yes, scope);
        if (node.no) statement(node.no, scope);
        break;
      case 'loop':
        if (node.initializer) statement(node.initializer, scope);
        if (node.condition) expression(node.condition, scope);
        statement(node.body, scope);
        if (node.update) expression(node.update, scope);
        break;
      case 'switch':
        expression(node.expression, scope);
        node.cases.forEach((entry) => {
          if (entry.test) expression(entry.test, scope);
          statement(entry.body, scope);
        });
        break;
      case 'with': {
        expression(node.expression, scope);
        const inner: MutableScope = {
          ...scope,
          key: `${node.id}:with`,
          parent: scope.key,
          selfOwner: `with:${node.id}`,
          declarations: new Map(scope.declarations),
        };
        scopes.set(inner.key, inner);
        prepare(node.body, inner);
        statement(node.body, inner);
        break;
      }
      case 'try': {
        statement(node.body, scope);
        if (node.catchBody) {
          const inner: MutableScope = {
            ...scope,
            key: `${node.id}:catch`,
            parent: scope.key,
            localOwner: `${node.id}:catch-locals`,
            declarations: new Map(),
          };
          scopes.set(inner.key, inner);
          if (node.catchName)
            declare(node.catchName, node.catchName, inner, 'local', {
              exported: false,
            });
          prepare(node.catchBody, inner);
          statement(node.catchBody, inner);
        }
        if (node.finallyBody) statement(node.finallyBody, scope);
        break;
      }
      case 'return':
      case 'throw':
        if (node.value) expression(node.value, scope);
        break;
      case 'doc': {
        const docs = node.docs;
        if (
          ['globalvar', 'instancevar', 'localvar'].includes(docs.kind) &&
          docs.name
        ) {
          const name: Name = {
            ...node,
            id: `${node.id}:name`,
            text: docs.name.content,
            origin: syntax.input.origin(
              docs.name.start.offset,
              docs.name.end.offset,
            ),
          };
          declare(
            name,
            node,
            scope,
            docs.kind === 'globalvar'
              ? 'global'
              : docs.kind === 'localvar'
                ? 'local'
                : 'field',
            { docs, bare: docs.kind === 'globalvar' },
          );
        }
        break;
      }
    }
  }
  if (
    context.kind === 'script' &&
    context.language.scriptSemantics === 'legacy-callable'
  ) {
    const name: Name = {
      ...syntax.root,
      id: `${root.key}:name`,
      text: context.assetName,
    };
    const expression: FunctionExpression = {
      ...syntax.root,
      id: `${root.key}:legacy`,
      kind: 'function',
      name,
      parameters: [],
      constructor: false,
      body: syntax.root,
    };
    const declaration = declare(name, expression, root, 'legacy-script', {
      bare: true,
      exported: true,
    });
    functionNode(
      expression,
      root,
      declaration,
      context.selfOwner && context.selfOwner !== globalOwner
        ? context.selfOwner
        : `${context.unitId}:caller-self`,
    );
  } else {
    prepare(syntax.root, root);
    statement(syntax.root, root);
  }
  return {
    unitId: context.unitId,
    context,
    syntax,
    declarations,
    scopes,
    nodeScopes,
    declarationSites,
    functions,
    diagnostics: syntax.diagnostics,
  };
}
