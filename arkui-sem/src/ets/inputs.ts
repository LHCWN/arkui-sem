// Text inputs (TextInput, TextArea, Search) in a drawing method: what their text option binds and what their onChange
// writes.
import type { InputFact } from '../facts.js';
import { type BuilderNames, climb } from './callbacks.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { isFunction, memberName, thisMember, unwrap } from './syntax.js';

/** The option that sets the shown text, by component (OpenHarmony TextInputOptions, TextAreaOptions, SearchOptions). */
const TEXT_OPTION: Record<InputFact['kind'], string> = { TextInput: 'text', TextArea: 'text', Search: 'value' };

/** An input, with the component methods its onChange calls or passes; their writes join `writes` when nothing else
 *  uses them. */
export interface FoundInput {
  fact: InputFact;
  handlers: string[];
}

function isInputKind(name: string): name is InputFact['kind'] {
  return Object.hasOwn(TEXT_OPTION, name);
}

export function inputsIn(
  method: string,
  body: ts.Node,
  scan: FileScan,
  names: BuilderNames,
  members: { fields: Set<string>; methods: Set<string> },
): FoundInput[] {
  const out: FoundInput[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && ts.isIdentifier(node.expression)) {
      const kind = node.expression.text;
      if (isInputKind(kind) && !climb(node, body, names).inHandler) {
        out.push(inputFact(node, kind, method, scan, members));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function inputFact(
  call: ts.CallExpression | ts.EtsComponentExpression,
  kind: InputFact['kind'],
  method: string,
  scan: FileScan,
  members: { fields: Set<string>; methods: Set<string> },
): FoundInput {
  const writes: InputFact['writes'] = [];
  const handlers = new Set<string>();
  for (const handler of attributeArguments(call, 'onChange')) {
    const fn = unwrap(handler);
    if (isFunction(fn)) {
      const visit = (n: ts.Node) => {
        const field = assignedField(n);
        if (field !== undefined && members.fields.has(field)) {
          writes.push({ field, line: scan.line(n) });
        }
        const called = calledMethod(n);
        if (called !== undefined && members.methods.has(called)) {
          handlers.add(called);
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
    } else {
      const passed = boundMethod(fn);
      if (passed !== undefined && members.methods.has(passed)) {
        handlers.add(passed);
      }
    }
  }
  return {
    fact: {
      kind,
      line: scan.line(call),
      method,
      binding: binding(call.arguments[0], TEXT_OPTION[kind], members.fields),
      writes,
      disabledRules: scan.disabledFor(call),
    },
    handlers: [...handlers],
  };
}

/** The arguments of each `.name(…)` call chained on the component call. */
function attributeArguments(call: ts.Node, name: string): ts.Expression[] {
  const out: ts.Expression[] = [];
  let node = call;
  for (;;) {
    const access = node.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node) {
      return out;
    }
    const attribute = access.parent;
    if (!ts.isCallExpression(attribute) || attribute.expression !== access) {
      return out;
    }
    if (access.name.text === name) {
      out.push(...attribute.arguments);
    }
    node = attribute;
  }
}

function binding(options: ts.Expression | undefined, option: string, fields: Set<string>): InputFact['binding'] {
  if (options === undefined) {
    return { kind: 'none' };
  }
  const literal = unwrap(options);
  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some((p) => !ts.isPropertyAssignment(p))) {
    return { kind: 'other' };
  }
  const text = literal.properties.find((p) => ts.isPropertyAssignment(p) && memberName(p.name) === option);
  if (!text || !ts.isPropertyAssignment(text)) {
    return { kind: 'none' };
  }
  const value = unwrap(text.initializer);
  const field = thisMember(value);
  if (field === undefined || !fields.has(field)) {
    return { kind: 'other' };
  }
  const twoWay =
    (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) || isDoubleBang(text.initializer);
  return { kind: 'field', field, twoWay };
}

function skipParentheses(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? skipParentheses(e.expression) : e;
}

/** `x!!`: V2 two-way binding sugar. */
function isDoubleBang(e: ts.Expression): boolean {
  return ts.isNonNullExpression(e) && ts.isNonNullExpression(skipParentheses(e.expression));
}

/** The field of `this.f = …` (a whole-field assignment with `=`). */
function assignedField(n: ts.Node): string | undefined {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? thisMember(skipParentheses(n.left))
    : undefined;
}

/** The method of a `this.m(…)` call. */
function calledMethod(n: ts.Node): string | undefined {
  return ts.isCallExpression(n) ? thisMember(n.expression) : undefined;
}

/** `this.m` or `this.m.bind(this)`. */
function boundMethod(e: ts.Expression): string | undefined {
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'bind') {
    return thisMember(e.expression.expression);
  }
  return thisMember(e);
}
