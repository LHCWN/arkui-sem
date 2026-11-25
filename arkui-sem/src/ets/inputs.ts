// Text inputs (TextInput, TextArea, Search) in a drawing method: what their text option binds and what their onChange
// writes.
import type { InputFact } from '../facts.js';
import { type BuilderNames, climb } from './callbacks.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { isDollarThis, isDoubleBang, isFunction, memberName, skipParentheses, thisMember, unwrap } from './syntax.js';

/** The option that sets the shown text, by component (OpenHarmony TextInputOptions, TextAreaOptions, SearchOptions). */
const TEXT_OPTION: Record<InputFact['kind'], string> = { TextInput: 'text', TextArea: 'text', Search: 'value' };

/** An input, with the component methods its onChange calls or passes; their typing joins the input's when nothing
 *  else uses them. */
export interface FoundInput {
  fact: InputFact;
  handlers: string[];
}

/** String methods whose result is still the typed text, normalized. */
const NORMALIZERS = new Set([
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'replace',
  'replaceAll',
  'slice',
  'substring',
  'normalize',
]);

/** What a change handler does with the typed text, its first parameter. */
export interface Typing {
  /** Whole-field assignments of the text itself, possibly normalized (`this.f = value`, `this.f = value.trim()`),
   *  anywhere in it; a value derived from it (`value.length > 0`) is not the text. */
  writes: InputFact['writes'];
  /** It does more than store the text: a statement other than those writes, calls that hand the text to a component
   *  method (whose own typing is joined) and `console` calls. */
  effects: boolean;
  /** The component methods it hands the text to (`this.setQuery(value)`); their first parameter is the text. */
  calls: string[];
  /** A write or a call stores or hands on the text normalized (`value.trim()`), not as typed. */
  normalizes: boolean;
}

type Handler = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

export function typing(fn: Handler, scan: FileScan, members: { fields: Set<string>; methods: Set<string> }): Typing {
  const [first] = fn.parameters;
  const text = first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  const typed = (n: ts.Node): string | undefined => {
    const field = assignedField(n);
    const storesText = text !== undefined && ts.isBinaryExpression(n) && isText(n.right, text);
    return field !== undefined && members.fields.has(field) && storesText ? field : undefined;
  };
  // The component method of `this.m(text)`: the text, possibly normalized, as the first argument.
  const handsText = (n: ts.Node): string | undefined => {
    const called = calledMethod(n);
    const [arg] = ts.isCallExpression(n) ? n.arguments : [];
    const passesText = text !== undefined && arg !== undefined && isText(arg, text);
    return called !== undefined && members.methods.has(called) && passesText ? called : undefined;
  };
  const out: Typing = { writes: [], effects: false, calls: [], normalizes: false };
  const visit = (n: ts.Node) => {
    const field = typed(n);
    if (field !== undefined) {
      out.writes.push({ field, line: scan.line(n) });
      out.normalizes ||= ts.isBinaryExpression(n) && !ts.isIdentifier(unwrap(n.right));
    }
    const called = handsText(n);
    if (called !== undefined) {
      out.calls.push(called);
      out.normalizes ||= ts.isCallExpression(n) && !ts.isIdentifier(unwrap(n.arguments[0]));
    }
    ts.forEachChild(n, visit);
  };
  const body = fn.body;
  if (body === undefined) {
    return out;
  }
  visit(body);
  const statements = ts.isBlock(body) ? [...body.statements] : [body];
  out.effects = statements.some((statement) => {
    // An expression body may sit in parentheses: `(v) => (this.name = v)`.
    const e = ts.isExpressionStatement(statement) ? statement.expression : ts.isBlock(body) ? statement : unwrap(body);
    return typed(e) === undefined && handsText(e) === undefined && !isConsoleCall(e);
  });
  return out;
}

/** The expression is the text itself, possibly normalized (`value`, `value.trim().toLowerCase()`). */
function isText(e: ts.Expression, text: string): boolean {
  const value = unwrap(e);
  if (ts.isIdentifier(value)) {
    return value.text === text;
  }
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    NORMALIZERS.has(value.expression.name.text) &&
    isText(value.expression.expression, text)
  );
}

function isConsoleCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'console'
  );
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
  let effects = false;
  let normalizes = false;
  for (const handler of attributeArguments(call, 'onChange')) {
    const fn = unwrap(handler);
    const passed = isFunction(fn) ? undefined : boundMethod(fn);
    if (isFunction(fn)) {
      const found = typing(fn, scan, members);
      writes.push(...found.writes);
      effects ||= found.effects;
      normalizes ||= found.normalizes;
      for (const name of found.calls) {
        handlers.add(name);
      }
    } else if (passed !== undefined && members.methods.has(passed)) {
      handlers.add(passed);
    } else {
      effects = true;
    }
  }
  return {
    fact: {
      kind,
      line: scan.line(call),
      method,
      binding: binding(call.arguments[0], TEXT_OPTION[kind], members.fields),
      writes,
      effects,
      normalizes,
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
  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some(ts.isSpreadAssignment)) {
    return { kind: 'other' };
  }
  // `{ placeholder }` is another option; `{ text }` binds a local.
  const text = literal.properties.find((p) => p.name !== undefined && memberName(p.name) === option);
  if (!text) {
    return { kind: 'none' };
  }
  if (!ts.isPropertyAssignment(text)) {
    return { kind: 'other' };
  }
  const value = unwrap(text.initializer);
  const field = thisMember(value);
  if (field === undefined || !fields.has(field)) {
    return { kind: 'other' };
  }
  const twoWay =
    (ts.isPropertyAccessExpression(value) && isDollarThis(value.expression)) || isDoubleBang(text.initializer);
  return { kind: 'field', field, twoWay };
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
