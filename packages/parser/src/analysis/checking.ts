import type {
  BoundUnit,
  Expression,
  SemanticDiagnostic,
  Statement,
  UnitEvaluation,
} from './model.js';

/** Legality is a separate result phase; it never changes symbols or types. */
export function checkUnit(
  bound: BoundUnit,
  result: UnitEvaluation,
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const add = (
    origin: SemanticDiagnostic['origin'],
    message: string,
    severity: SemanticDiagnostic['severity'] = 'error',
    collection: SemanticDiagnostic['collection'] = 'INVALID_OPERATION',
  ) => diagnostics.push({ origin, message, severity, collection });
  for (const call of result.calls) {
    const fn = call.type;
    if (call.kind === 'new' && !fn.isConstructor)
      add(call.origin, 'The new operator requires a constructor function.');
    if (call.kind === 'call' && fn.isConstructor)
      add(call.origin, 'Constructor functions must be called with new.');
    const native = fn.callKind === 'native' || !!fn.signifier?.native;
    if (native && fn.signifier?.name === 'static_get') {
      const accepted = fn.getParameter(0)?.type.type || [];
      const allowsFunction = accepted.some((type) =>
        ['Function', 'Asset.GMScript', 'Any', 'Unknown', 'Mixed'].includes(
          type.kind,
        ),
      );
      if (
        accepted.length &&
        !allowsFunction &&
        call.arguments[0]?.type.type.some((type) => type.kind === 'Function')
      )
        add(
          call.arguments[0].origin,
          'The selected native specification does not support static_get on functions.',
        );
    }
    if (!native && !bound.context.strictUserArity) continue;
    const parameters = fn.listParameters();
    const arguments_ =
      call.arguments.length === 1 && !call.arguments[0].hasExpression
        ? []
        : call.arguments;
    const missing = parameters.findIndex(
      (parameter, index) =>
        parameter && !parameter.optional && !arguments_[index]?.hasExpression,
    );
    if (missing >= 0)
      add(
        arguments_[missing]?.origin || call.origin,
        `Missing required argument \`${parameters[missing]!.name}\` for function \`${fn.name || ''}\`.`,
        native ? 'error' : 'warning',
        'MISSING_REQUIRED_ARGUMENT',
      );
    if (parameters.at(-1)?.name !== '...') {
      for (const argument of arguments_.slice(parameters.length))
        add(
          argument.origin,
          `Extra argument for function \`${fn.name || ''}\`.`,
          'warning',
          'TOO_MANY_ARGUMENTS',
        );
    }
  }
  function expression(node: Expression) {
    if (node.kind === 'function') {
      if (bound.context.language.supports('functions') === false)
        add(
          node.origin,
          'Function expressions are unavailable in the selected language version.',
        );
      if (
        node.constructor &&
        bound.context.language.supports('constructors') === false
      )
        add(
          node.origin,
          'Constructors are unavailable in the selected language version.',
        );
      node.parameters.forEach((parameter) => {
        if (parameter.value) expression(parameter.value);
      });
      node.base?.arguments.forEach((argument) => {
        if (argument.value) expression(argument.value);
      });
      statement(node.body, 0, 0, false, true);
    } else if (node.kind === 'struct') {
      if (bound.context.language.supports('structs') === false)
        add(
          node.origin,
          'Struct literals are unavailable in the selected language version.',
        );
      node.entries.forEach((entry) => {
        if (entry.value) expression(entry.value);
      });
    } else if (node.kind === 'array' || node.kind === 'template') {
      if (
        node.kind === 'template' &&
        bound.context.language.supports('templateStrings') === false
      )
        add(
          node.origin,
          'Template strings are unavailable in the selected language version.',
        );
      node.values.forEach(expression);
    } else if (node.kind === 'binary') {
      if (
        node.operator === '??' &&
        bound.context.language.supports('nullish') === false
      )
        add(
          node.origin,
          'Nullish operators are unavailable in the selected language version.',
        );
      expression(node.left);
      expression(node.right);
    } else if (node.kind === 'conditional') {
      expression(node.condition);
      expression(node.yes);
      expression(node.no);
    } else if (node.kind === 'assign') {
      if (
        node.operator === '??=' &&
        bound.context.language.supports('nullish') === false
      )
        add(
          node.origin,
          'Nullish operators are unavailable in the selected language version.',
        );
      expression(node.target);
      expression(node.value);
    } else if (node.kind === 'unary') {
      if (
        node.operator === 'delete' &&
        bound.context.language.supports('delete') === false
      )
        add(
          node.origin,
          'The delete operator is unavailable in the selected language version.',
        );
      expression(node.operand);
    } else if (node.kind === 'member') expression(node.target);
    else if (node.kind === 'index') {
      if (
        node.target.kind === 'index' &&
        !node.target.grouped &&
        bound.context.language.supports('chainedAccessors') === false
      )
        add(
          node.origin,
          'Chained accessors are unavailable in the selected language version.',
        );
      expression(node.target);
      node.indices.forEach(expression);
    } else if (node.kind === 'call') {
      expression(node.target);
      node.arguments.forEach((argument) => {
        if (argument.value) expression(argument.value);
      });
    } else if (node.kind === 'unknown') node.children.forEach(expression);
  }
  function statement(
    node: Statement,
    loops: number,
    switches: number,
    finally_: boolean,
    inFunction: boolean,
  ) {
    if (finally_ && ['return', 'exit', 'break', 'continue'].includes(node.kind))
      add(
        node.origin,
        `The ${node.kind} statement is not permitted inside finally.`,
      );
    if (node.kind === 'break' && !loops && !switches)
      add(node.origin, 'break requires an enclosing loop or switch.');
    if (node.kind === 'continue' && !loops)
      add(node.origin, 'continue requires an enclosing loop.');
    switch (node.kind) {
      case 'block':
        node.statements.forEach((child) =>
          statement(child, loops, switches, finally_, inFunction),
        );
        break;
      case 'declarations':
        if (node.storage === 'static') {
          if (!inFunction)
            add(
              node.origin,
              'Static variables can only be declared inside functions.',
            );
          if (bound.context.language.supports('functions') === false)
            add(
              node.origin,
              'Static variables are unavailable in the selected language version.',
            );
        }
        node.declarations.forEach((declaration) => {
          if (declaration.value) expression(declaration.value);
        });
        break;
      case 'expression':
      case 'function':
        expression(node.expression);
        break;
      case 'enum':
        node.members.forEach((member) => {
          if (member.value) expression(member.value);
        });
        break;
      case 'if':
        expression(node.condition);
        statement(node.yes, loops, switches, finally_, inFunction);
        if (node.no) statement(node.no, loops, switches, finally_, inFunction);
        break;
      case 'loop':
        if (node.initializer)
          statement(node.initializer, loops, switches, finally_, inFunction);
        if (node.condition) expression(node.condition);
        if (node.update) expression(node.update);
        statement(node.body, loops + 1, switches, finally_, inFunction);
        break;
      case 'switch':
        expression(node.expression);
        node.cases.forEach((entry) => {
          if (entry.test) expression(entry.test);
          statement(entry.body, loops, switches + 1, finally_, inFunction);
        });
        break;
      case 'with':
        expression(node.expression);
        statement(node.body, loops + 1, switches, finally_, inFunction);
        break;
      case 'try':
        if (bound.context.language.supports('exceptions') === false)
          add(
            node.origin,
            'Exception statements are unavailable in the selected language version.',
          );
        statement(node.body, loops, switches, finally_, inFunction);
        if (node.catchBody)
          statement(node.catchBody, loops, switches, finally_, inFunction);
        if (node.finallyBody)
          statement(node.finallyBody, loops, switches, true, inFunction);
        break;
      case 'throw':
        if (bound.context.language.supports('exceptions') === false)
          add(
            node.origin,
            'Exception statements are unavailable in the selected language version.',
          );
        if (node.value) expression(node.value);
        break;
      case 'return':
        if (node.value) expression(node.value);
        break;
    }
  }
  statement(
    bound.syntax.root,
    0,
    0,
    false,
    bound.context.language.scriptSemantics === 'legacy-callable',
  );
  return diagnostics;
}
