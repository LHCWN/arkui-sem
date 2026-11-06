// A component (an @Component / @ComponentV2 struct): its fields, where build() reads them, where methods write them.
import type { BuildRead, ComponentFact, FieldFact, PathSegment, WriteContext, WriteFact } from '../analysis.js';
import { LIFECYCLE } from './lifecycle.js';
import { ts } from './parse.js';
import { resources } from './resources.js';
import type { FileScan } from './scan.js';
import {
  argumentOf,
  calleeName,
  decoratorNames,
  expressionName,
  isAssignment,
  isFunction,
  memberName,
  onComponent,
  thisMember,
  unwrap,
} from './syntax.js';
import { declaredType, objectLiteral } from './types.js';

const MUTATING_CALLS = new Set([
  'push',
  'pop',
  'splice',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'fill',
  'set',
  'delete',
  'clear',
]);
/** Calls whose function arguments run later, after the calling code has returned. */
const DEFERRING_CALLS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'on', 'subscribe']);
const CLOCKS = new Set(['Date.now', 'performance.now']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const LOOPS = new Set(['ForEach', 'LazyForEach', 'Repeat']);

/** Code the component runs: a method, or a field holding a function (a handler, `onTap = () => { … }`). */
export interface Method {
  kind: 'method' | 'handler';
  name: string;
  decorators: string[];
  /** The method's block, or the handler's function. */
  body: ts.Node;
}

/** What one walk over a method's body found. */
export interface MethodScan {
  method: Method;
  /** `this.<m>` for each method or handler m of the component, other than the method itself; called: `this.m(…)`. */
  uses: { name: string; called: boolean }[];
  /** Every call, in source order. */
  calls: ts.CallExpression[];
}

export function component(s: ts.StructDeclaration, scan: FileScan): ComponentFact | undefined {
  const decorators = decoratorNames(s);
  if (!s.name || (!decorators.includes('@Component') && !decorators.includes('@ComponentV2'))) {
    return undefined;
  }
  const fields: FieldFact[] = [];
  const methods: Method[] = [];
  for (const m of s.members) {
    const name = memberName(m.name);
    if (name === undefined) {
      continue;
    }
    if (ts.isPropertyDeclaration(m)) {
      fields.push(fieldFact(m, name, scan));
      const init = m.initializer && unwrap(m.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        methods.push({ kind: 'handler', name, decorators: [], body: init });
      }
    } else if (ts.isMethodDeclaration(m) && m.body) {
      methods.push({ kind: 'method', name, decorators: decoratorNames(m), body: m.body });
    }
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  const names = new Set(methods.map((m) => m.name));
  const scans = methods.map((m) => scanMethod(m, byName, names, scan));
  const external = externalMethods(scans);
  for (const f of fields) {
    for (const w of f.writes) {
      w.external = external.has(w.method);
    }
  }
  return {
    name: s.name.text,
    file: scan.file,
    line: scan.line(s.name),
    version: decorators.includes('@ComponentV2') ? 'V2' : 'V1',
    fields,
    resources: resources(scans, scan),
  };
}

function fieldFact(m: ts.PropertyDeclaration, name: string, scan: FileScan): FieldFact {
  const line = scan.line(m.name);
  return {
    name,
    line,
    decorators: decoratorNames(m),
    ...declaredType(m.type, m.initializer, scan.sf),
    hasInitializer: m.initializer !== undefined,
    literal: objectLiteral(m.initializer),
    buildReads: [],
    writes: [],
    invoked: false,
    timeValue: timeValue(m.initializer),
    // The disable comment may sit above the decorators or directly above the field name.
    disabledRules: [...new Set([...scan.disabledAt(line), ...scan.disabledAt(scan.line(m))])],
  };
}

/** One walk over a method's body: its uses of the component's methods, its calls, its awaits, and every access to a
 *  field, which becomes a read or a write of that field. */
function scanMethod(m: Method, fields: Map<string, FieldFact>, names: Set<string>, scan: FileScan): MethodScan {
  const out: MethodScan = { method: m, uses: [], calls: [] };
  const awaits = new Map<ts.Node, number[]>(); // function → end of each await directly in it
  const accesses: ts.PropertyAccessExpression[] = [];
  const scopes: ts.Node[] = [m.body];
  const visit = (n: ts.Node) => {
    const opens = n !== m.body && isFunction(n);
    if (opens) {
      scopes.push(n);
    }
    if (ts.isCallExpression(n)) {
      out.calls.push(n);
    } else if (ts.isAwaitExpression(n)) {
      const scope = scopes[scopes.length - 1];
      awaits.set(scope, [...(awaits.get(scope) ?? []), n.end]);
    }
    const member = thisMember(n);
    if (member !== undefined && ts.isPropertyAccessExpression(n)) {
      if (names.has(member) && member !== m.name) {
        out.uses.push({ name: member, called: ts.isCallExpression(n.parent) && n.parent.expression === n });
      }
      if (fields.has(member)) {
        accesses.push(n);
      }
    }
    ts.forEachChild(n, visit);
    if (opens) {
      scopes.pop();
    }
  };
  visit(m.body);
  const context = { method: m, awaits, scan, isBuild: m.name === 'build' || m.decorators.includes('@Builder') };
  for (const base of accesses) {
    const field = fields.get(base.name.text);
    if (field) {
      access(base, field, context);
    }
  }
  return out;
}

interface AccessContext {
  method: Method;
  awaits: Map<ts.Node, number[]>;
  scan: FileScan;
  isBuild: boolean;
}

/** One `this.<field>…` access: the path below the field, then whether it writes (assignment, update, mutating call). */
function access(base: ts.PropertyAccessExpression, field: FieldFact, ctx: AccessContext) {
  const segments: PathSegment[] = [];
  let top: ts.Expression = base;
  for (;;) {
    const p = top.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === top) {
      segments.push(p.questionDotToken ? { prop: p.name.text, optional: true } : { prop: p.name.text });
    } else if (ts.isElementAccessExpression(p) && p.expression === top) {
      const index = ctx.scan.text(p.argumentExpression);
      segments.push(p.questionDotToken ? { index, optional: true } : { index });
    } else if (!(ts.isNonNullExpression(p) && p.expression === top)) {
      break;
    }
    top = p;
  }
  const parent = top.parent;
  const last = segments.at(-1);
  const called = ts.isCallExpression(parent) && parent.expression === top;
  const mutatingCall = called && last !== undefined && 'prop' in last && MUTATING_CALLS.has(last.prop);
  const assignment =
    ts.isBinaryExpression(parent) && parent.left === top && isAssignment(parent.operatorToken.kind)
      ? parent
      : undefined;
  const updated =
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
  const line = ctx.scan.line(base);
  if (segments.length === 0 && called) {
    field.invoked = true;
  }
  const assignedTime = assignment && timeValue(assignment.right);
  if (assignedTime && field.timeValue !== 'timer') {
    field.timeValue = assignedTime;
  }
  const where = climb(base, ctx.method.body);
  if (!mutatingCall && !assignment && !updated) {
    if (ctx.isBuild) {
      field.buildReads.push({ line, path: segments, attribute: where.attribute, inForEach: where.inForEach });
    }
    return;
  }
  // The write lands when the whole assignment, update or call is done: after any await in its own value or arguments.
  const deferred =
    where.deferringCall ||
    [ctx.method.body, ...where.functions].some((f) => (ctx.awaits.get(f) ?? []).some((end) => end <= parent.end));
  const context: WriteContext = deferred
    ? 'async-callback'
    : ctx.isBuild
      ? 'build-closure'
      : LIFECYCLE.has(ctx.method.name)
        ? 'lifecycle'
        : 'method';
  // A mutating call changes the container below its receiver: `[]` with no index stands for it.
  const path: PathSegment[] = mutatingCall ? [...segments.slice(0, -1), { index: '' }] : segments;
  const write: WriteFact = {
    line,
    context,
    method: ctx.method.name,
    path: path.length ? path : undefined,
    value: mutatingCall ? undefined : assignedValue(assignment),
    disabledRules: ctx.scan.disabledAt(line),
  };
  field.writes.push(write);
}

/** What lies between an access and its method's body: the functions holding it (innermost first), whether one of them is
 *  passed to a deferring call, the nearest attribute call holding it (not through a callback such as an event handler),
 *  and whether a loop holds it. */
function climb(
  node: ts.Node,
  body: ts.Node,
): Pick<BuildRead, 'attribute' | 'inForEach'> & { functions: ts.Node[]; deferringCall: boolean } {
  const functions: ts.Node[] = [];
  let deferringCall = false;
  let attribute: string | undefined;
  let inForEach = false;
  for (let n: ts.Node = node; n !== body && n.parent; n = n.parent) {
    const call = argumentOf(n);
    if (isFunction(n)) {
      functions.push(n);
      deferringCall ||= call !== undefined && ts.isCallExpression(call) && DEFERRING_CALLS.has(calleeName(call) ?? '');
    }
    if (!call) {
      continue;
    }
    const callee = call.expression;
    if (
      attribute === undefined &&
      functions.length === 0 &&
      ts.isPropertyAccessExpression(callee) &&
      onComponent(callee)
    ) {
      attribute = callee.name.text;
    }
    if (ts.isIdentifier(callee) && LOOPS.has(callee.text)) {
      inForEach = true;
    }
  }
  return { functions, deferringCall, attribute, inForEach };
}

/** What an assignment assigns: an object literal, a `new` instance, or anything else (compound and update writes too). */
function assignedValue(assignment: ts.BinaryExpression | undefined): WriteFact['value'] {
  if (assignment?.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return 'other';
  }
  const value = unwrap(assignment.right);
  return ts.isObjectLiteralExpression(value) ? 'object-literal' : ts.isNewExpression(value) ? 'new' : 'other';
}

/** What time value an initializer or assigned value holds (see FieldFact.timeValue). */
function timeValue(e: ts.Expression | undefined): FieldFact['timeValue'] {
  if (!e) {
    return undefined;
  }
  const v = unwrap(e);
  if (ts.isCallExpression(v) && TIMERS.has(expressionName(v.expression) ?? '')) {
    return 'timer';
  }
  return readsTime(v) ? 'clock' : undefined;
}

function readsTime(e: ts.Node): boolean {
  if (ts.isCallExpression(e)) {
    const name = expressionName(e.expression);
    if (name !== undefined && (CLOCKS.has(name) || TIMERS.has(name))) {
      return true;
    }
  }
  if (ts.isNewExpression(e) && expressionName(e.expression) === 'Date') {
    return true;
  }
  return ts.forEachChild(e, (c) => readsTime(c) || undefined) ?? false;
}

/**
 * Methods no code in the component reaches from build()/@Builder (calls or `this.m` references, e.g. `.onClick(this.m)`)
 * or from lifecycle hooks (calls): entry points for listeners, callbacks and other classes.
 */
function externalMethods(scans: MethodScan[]): Set<string> {
  const edges = new Map(
    scans.map((s) => [
      s.method.name,
      {
        calls: new Set(s.uses.filter((u) => u.called).map((u) => u.name)),
        refs: new Set(s.uses.filter((u) => !u.called).map((u) => u.name)),
      },
    ]),
  );
  function reach(roots: string[], viaRefs: boolean) {
    const seen = new Set(roots);
    const todo = [...roots];
    for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
      const e = edges.get(m);
      if (!e) {
        continue;
      }
      for (const n of [...e.calls, ...(viaRefs ? e.refs : [])]) {
        if (!seen.has(n) && !LIFECYCLE.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  }
  const roots = (f: (m: Method) => boolean) =>
    scans
      .map((s) => s.method)
      .filter(f)
      .map((m) => m.name);
  const fromBuild = reach(
    roots((m) => m.name === 'build' || m.decorators.includes('@Builder')),
    true,
  );
  const fromLifecycle = reach(
    roots((m) => LIFECYCLE.has(m.name)),
    false,
  );
  return new Set(
    scans.map((s) => s.method.name).filter((n) => !LIFECYCLE.has(n) && !fromBuild.has(n) && !fromLifecycle.has(n)),
  );
}
