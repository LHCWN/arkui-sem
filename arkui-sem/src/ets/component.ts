// A component (an @Component / @ComponentV2 / @CustomDialog struct): its fields, where build() reads them, where methods
// write them.
import type {
  Branch,
  BuildRead,
  CallbackCall,
  ComponentFact,
  FieldFact,
  InputFact,
  PathSegment,
  WriteContext,
  WriteFact,
} from '../facts.js';
import { type BuilderNames, climb, continues } from './callbacks.js';
import { type FoundInput, inputsIn, type Typing, typing } from './inputs.js';
import { LIFECYCLE } from './lifecycle.js';
import { builderFact, loopsIn, type Members } from './loops.js';
import { ts } from './parse.js';
import { rebuiltElements } from './rebuilt.js';
import { resources } from './resources.js';
import type { FileScan } from './scan.js';
import {
  armsOf,
  branchesOf,
  calleeName,
  decoratorNames,
  expressionName,
  hasModifier,
  isAssignment,
  isFunction,
  isZero,
  memberName,
  pathBelow,
  thisMember,
  unwrap,
} from './syntax.js';
import { declaredType, objectLiteral } from './types.js';

/** A dialog is usually declared with @CustomDialog alone. */
const COMPONENT_DECORATORS = ['@Component', '@ComponentV2', '@CustomDialog'];

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
const CLOCKS = new Set(['Date.now', 'performance.now']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const UI_BUILDERS = new Set(['@Builder', '@LocalBuilder']);
/** Calls that take `this` without reading the component's fields: the UI context, and binding a method to it. */
const THIS_TAKERS = new Set(['getContext', 'bind', 'call', 'apply']);

/** Code the component runs: a method, a getter, or a field holding a function (a handler, `onTap = () => { … }`). */
export interface Method {
  kind: 'method' | 'getter' | 'handler';
  name: string;
  decorators: string[];
  /** The method's block, or the handler's function. */
  body: ts.Node;
}

/** What one walk over a method's body found. */
export interface MethodScan {
  method: Method;
  /** `this.<m>` for each method, getter or handler m of the component, other than the method itself; called:
   *  `this.m(…)`; where it sits (climb): in a handler (callbacks.ts), in a loop, in an attribute call. */
  uses: ({ name: string; called: boolean; branches: Branch[] } & Pick<
    BuildRead,
    'inHandler' | 'inForEach' | 'attribute'
  >)[];
  /** Every call, in source order. */
  calls: ts.CallExpression[];
}

/** fileNames: the file's builder functions and imported names, which a row may call as builders. */
export function component(
  s: ts.StructDeclaration,
  scan: FileScan,
  fileNames: Omit<BuilderNames, 'methods'>,
): ComponentFact | undefined {
  const decorators = decoratorNames(s);
  if (!s.name || !COMPONENT_DECORATORS.some((d) => decorators.includes(d))) {
    return undefined;
  }
  const fields = s.members.flatMap((m) => {
    const name = memberName(m.name);
    return ts.isPropertyDeclaration(m) && name !== undefined ? [fieldFact(m, name, scan)] : [];
  });
  const methods = methodsOf(s);
  const builderMethods = s.members.filter(
    (m): m is ts.MethodDeclaration & { name: ts.PropertyName } =>
      ts.isMethodDeclaration(m) && decoratorNames(m).some((d) => UI_BUILDERS.has(d)),
  );
  const builderNames: BuilderNames = {
    ...fileNames,
    methods: new Set(builderMethods.flatMap((m) => memberName(m.name) ?? [])),
  };
  const byName = new Map(fields.map((f) => [f.name, f]));
  const names = new Set(methods.map((m) => m.name));
  const scans = methods.map((m) => scanMethod(m, byName, names, builderNames));
  const drawing = drawingMethods(scans);
  const renderOnly = renderOnlyMethods(scans, drawing);
  const loads = new Set<WriteFact>();
  const { arms, repeated } = methodArms(scans);
  const initCalls = initializerCalls(s, scan);
  for (const s of scans) {
    recordAccesses(s, byName, scan, builderNames, {
      drawn: drawing.get(s.method),
      renderOnly: renderOnly.has(s.method),
      arms: arms.get(s.method.name),
      ownArms: !repeated.has(s.method.name),
      loads,
      initCalls,
    });
  }
  const external = externalMethods(scans);
  const setup = setupMethods(scans, false);
  const loading = setupMethods(scans, true);
  for (const f of fields) {
    for (const w of f.writes) {
      w.external = external.has(w.method);
      if (loading.has(w.method) && loads.has(w)) {
        w.initialLoad = true;
      }
      if (w.context !== 'async-callback' && setup.has(w.method)) {
        w.beforeFirstRender = true;
      }
    }
  }
  const members = membersOf(scans, byName, builderNames);
  const initializers = initializerAccesses(s, byName, scan);
  const found = methods
    .filter((m) => drawing.has(m))
    .flatMap((m) => inputsIn(m.name, m.body, scan, builderNames, { fields: members.fields, methods: names }));
  return {
    name: s.name.text,
    file: scan.file,
    line: scan.line(s.name),
    ...(hasModifier(s, ts.SyntaxKind.ExportKeyword) ? { exported: true as const } : {}),
    version: decorators.includes('@ComponentV2') ? 'V2' : 'V1',
    fields,
    resources: resources(scans, scan),
    loops: methods
      .filter((m) => drawing.has(m))
      .flatMap((m) =>
        loopsIn(m.name, m.body, arms.get(m.name) ?? [], !repeated.has(m.name), scan, builderNames, members),
      ),
    builders: builderMethods.flatMap((m) => {
      const name = memberName(m.name);
      return name === undefined ? [] : [builderFact(name, m, scan, builderNames)];
    }),
    inputs: inputFacts(found, scans, scan, { fields: members.fields, methods: names }),
    ...(initializers.escapes || scans.some((walk) => walk.escapes) ? { thisEscapes: true as const } : {}),
  };
}

/** The inputs, with the typing of each handler method only inputs use joined to theirs; a handler used elsewhere too,
 *  or one that hands the text on to further methods, counts as an effect. */
function inputFacts(
  found: FoundInput[],
  scans: MethodScan[],
  scan: FileScan,
  members: { fields: Set<string>; methods: Set<string> },
): InputFact[] {
  const references = new Map<string, number>();
  for (const name of found.flatMap((input) => input.handlers)) {
    references.set(name, (references.get(name) ?? 0) + 1);
  }
  const uses = (name: string) => scans.reduce((n, s) => n + s.uses.filter((use) => use.name === name).length, 0);
  const typingOf = new Map<string, Typing>();
  for (const { method } of scans) {
    const fn = method.kind === 'handler' ? method.body : method.body.parent;
    const handler = fn && (isFunction(fn) || ts.isMethodDeclaration(fn)) ? fn : undefined;
    if (handler && references.get(method.name) === uses(method.name)) {
      typingOf.set(method.name, typing(handler, scan, members));
    }
  }
  return found.map(({ fact, handlers }) => {
    const joined = handlers.flatMap((name) => typingOf.get(name) ?? []);
    return {
      ...fact,
      writes: [...fact.writes, ...joined.flatMap((t) => t.writes)],
      effects:
        fact.effects ||
        joined.some((t) => t.effects || t.calls.length > 0) ||
        handlers.some((name) => !typingOf.has(name)),
      normalizes: fact.normalizes || joined.some((t) => t.normalizes),
    };
  });
}

/** Reads of fields in other fields' initializers (`@State shown = this.all.slice(0, 5)`), recorded on the fields, and
 *  whether an initializer uses `this` as a value. Initializers that are functions are handlers, scanned as methods. */
function initializerAccesses(
  s: ts.StructDeclaration,
  fields: Map<string, FieldFact>,
  scan: FileScan,
): { escapes: boolean } {
  let escapes = false;
  for (const m of s.members) {
    const owner = memberName(m.name);
    const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(m.initializer) : undefined;
    if (owner === undefined || init === undefined || isFunction(init)) {
      continue;
    }
    const visit = (n: ts.Node) => {
      const field = fields.get(thisMember(n) ?? '');
      if (field) {
        field.reads.push({ line: scan.line(n), method: owner });
      }
      escapes ||= thisEscapes(n);
      ts.forEachChild(n, visit);
    };
    visit(init);
  }
  return { escapes };
}

/** `this` used as a value rather than to access a member (see ComponentFact.thisEscapes). */
function thisEscapes(n: ts.Node): boolean {
  if (n.kind !== ts.SyntaxKind.ThisKeyword) {
    return false;
  }
  const parent = n.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === n) {
    return false;
  }
  return !(ts.isCallExpression(parent) && THIS_TAKERS.has(calleeName(parent) ?? ''));
}

/** The component's fields and helpers, and the fields each helper reads through the helpers it uses. */
function membersOf(scans: MethodWalk[], fields: Map<string, FieldFact>, builders: BuilderNames): Members {
  const byName = new Map(scans.map((s) => [s.method.name, s]));
  const isHelper = (name: string, called: boolean) => byName.get(name)?.method.kind === (called ? 'method' : 'getter');
  const fieldsOf = (name: string): string[] => {
    const out = new Set<string>();
    const seen = new Set([name]);
    const todo = [name];
    for (let method = todo.pop(); method !== undefined; method = todo.pop()) {
      const walk = byName.get(method);
      for (const access of walk?.accesses ?? []) {
        if (walk && !climb(access, walk.method.body, builders).inHandler) {
          out.add(access.name.text);
        }
      }
      for (const use of walk?.uses ?? []) {
        if (!use.inHandler && isHelper(use.name, use.called) && !seen.has(use.name)) {
          seen.add(use.name);
          todo.push(use.name);
        }
      }
    }
    return [...out];
  };
  const returned = (name: string): ts.Expression[] => {
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n)) {
        if (n.expression) {
          out.push(...armsOf(n.expression));
        }
      } else if (!isFunction(n)) {
        ts.forEachChild(n, visit);
      }
    };
    const helper = byName.get(name)?.method.body;
    if (helper) {
      ts.forEachChild(helper, visit);
    }
    return out;
  };
  const returnsField = (name: string): string | undefined => {
    const values = new Set(returned(name).map((e) => thisMember(unwrap(e))));
    const [value] = values.size === 1 ? values : [];
    return value !== undefined && fields.has(value) ? value : undefined;
  };
  const body = (name: string) => byName.get(name)?.method.body;
  return { fields: new Set(fields.keys()), isHelper, fieldsOf, returned, returnsField, body };
}

export function methodsOf(s: ts.StructDeclaration): Method[] {
  return s.members.flatMap((m): Method[] => {
    const name = memberName(m.name);
    if (name === undefined) {
      return [];
    }
    if (ts.isMethodDeclaration(m) && m.body) {
      return [{ kind: 'method', name, decorators: decoratorNames(m), body: m.body }];
    }
    if (ts.isGetAccessorDeclaration(m) && m.body) {
      return [{ kind: 'getter', name, decorators: [], body: m.body }];
    }
    const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(m.initializer) : undefined;
    return init && isFunction(init) ? [{ kind: 'handler', name, decorators: [], body: init }] : [];
  });
}

export function rendersUi(m: Method): boolean {
  return m.name === 'build' || m.decorators.some((d) => UI_BUILDERS.has(d));
}

function fieldFact(m: ts.PropertyDeclaration, name: string, scan: FileScan): FieldFact {
  const line = scan.line(m.name);
  return {
    name,
    line,
    decorators: decoratorNames(m),
    ...declaredType(m.type, m.initializer, scan.sf),
    hasInitializer: m.initializer !== undefined,
    ...(m.questionToken ? { optional: true as const } : {}),
    literal: objectLiteral(m.initializer),
    buildReads: [],
    reads: [],
    writes: [],
    calls: [],
    timeValue: timeValue(m.initializer),
    // The disable comment may sit above the decorators or directly above the field name.
    disabledRules: [...new Set([...scan.disabledAt(line), ...scan.disabledAt(scan.line(m))])],
  };
}

/** A method's scan with what recordAccesses needs: its accesses to fields and its awaits. */
interface MethodWalk extends MethodScan {
  accesses: ts.PropertyAccessExpression[];
  /** function → end of each await directly in it */
  awaits: Map<ts.Node, number[]>;
  /** The uses an await may delay: an await ends before the use in the method's body or in a function holding the use. */
  delayed: Set<MethodScan['uses'][number]>;
  /** It uses `this` as a value (ComponentFact.thisEscapes). */
  escapes: boolean;
}

/** One walk over a method's body: its uses of the component's methods, its calls, its awaits, and its accesses to
 *  fields. */
function scanMethod(m: Method, fields: Map<string, FieldFact>, names: Set<string>, builders: BuilderNames): MethodWalk {
  const out: MethodWalk = {
    method: m,
    uses: [],
    calls: [],
    accesses: [],
    awaits: new Map(),
    delayed: new Set(),
    escapes: false,
  };
  const scopes: ts.Node[] = [m.body];
  const visit = (n: ts.Node) => {
    const opens = n !== m.body && isFunction(n);
    if (opens) {
      scopes.push(n);
    }
    out.escapes ||= thisEscapes(n);
    if (ts.isCallExpression(n)) {
      out.calls.push(n);
    } else if (ts.isAwaitExpression(n)) {
      const scope = scopes[scopes.length - 1];
      out.awaits.set(scope, [...(out.awaits.get(scope) ?? []), n.end]);
    }
    const member = thisMember(n);
    if (member !== undefined && ts.isPropertyAccessExpression(n)) {
      if (names.has(member) && member !== m.name) {
        const { inHandler, inForEach, attribute } = climb(n, m.body, builders);
        const use = {
          name: member,
          called: ts.isCallExpression(n.parent) && n.parent.expression === n,
          inHandler,
          inForEach,
          ...(attribute === undefined ? {} : { attribute }),
          branches: branchesOf(n, m.body, n.getSourceFile()),
        };
        out.uses.push(use);
        // The walk is in source order, so every await that ends before n is already recorded.
        if (scopes.some((scope) => (out.awaits.get(scope) ?? []).some((end) => end <= n.getStart()))) {
          out.delayed.add(use);
        }
      }
      if (fields.has(member)) {
        out.accesses.push(n);
      }
    }
    ts.forEachChild(n, visit);
    if (opens) {
      scopes.pop();
    }
  };
  visit(m.body);
  return out;
}

/** Where build() uses a drawing method: in a loop, through an attribute call (`.width(this.calc())`). */
type DrawSite = Pick<BuildRead, 'inForEach' | 'attribute'>;

/** The methods whose reads draw the UI, with where build() uses them: build() and the @Builders, then the methods they
 *  call and the getters they read outside handlers (`.width(this.calcWidth())`, `Text(this.label)` with `get label()`),
 *  transitively. A helper used at several sites is in a loop if any site is, through the first attribute found. */
function drawingMethods(scans: MethodScan[]): Map<Method, DrawSite> {
  const byName = new Map(scans.map((s) => [s.method.name, s]));
  const sites = new Map<MethodScan, DrawSite>(
    scans.filter((s) => rendersUi(s.method)).map((s) => [s, { inForEach: false }]),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const [s, site] of [...sites]) {
      for (const use of s.uses) {
        const next = byName.get(use.name);
        const helper = use.called ? next?.method.kind === 'method' : next?.method.kind === 'getter';
        if (!next || !helper || use.inHandler || rendersUi(next.method) || LIFECYCLE.has(use.name)) {
          continue;
        }
        const old = sites.get(next);
        const inForEach = (old?.inForEach ?? false) || site.inForEach || use.inForEach;
        const attribute = old?.attribute ?? use.attribute ?? site.attribute;
        if (!old || old.inForEach !== inForEach || old.attribute !== attribute) {
          sites.set(next, { inForEach, ...(attribute === undefined ? {} : { attribute }) });
          changed = true;
        }
      }
    }
  }
  return new Map([...sites].map(([s, site]) => [s.method, site]));
}

/** The drawing methods that run only while build() draws: build(), the @Builders, and helpers whose every use is a call
 *  (or a getter read) outside handlers in another such method. */
function renderOnlyMethods(scans: MethodScan[], drawing: Map<Method, DrawSite>): Set<Method> {
  const only = new Set(drawing.keys());
  const usedOnlyWhileDrawing = (m: Method) =>
    scans.every((s) =>
      s.uses.every(
        (u) => u.name !== m.name || (only.has(s.method) && !u.inHandler && (u.called || m.kind === 'getter')),
      ),
    );
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of only) {
      if (!rendersUi(m) && !usedOnlyWhileDrawing(m)) {
        only.delete(m);
        changed = true;
      }
    }
  }
  return only;
}

/** Turns a method's accesses to fields into reads and writes of those fields. drawn: where build() uses the method, if
 *  it draws the UI (drawingMethods), so its reads are build reads; renderOnly: it runs only while drawing
 *  (renderOnlyMethods). */
function recordAccesses(
  walk: MethodWalk,
  fields: Map<string, FieldFact>,
  scan: FileScan,
  builders: BuilderNames,
  {
    drawn,
    renderOnly,
    arms,
    ownArms,
    loads,
    initCalls,
  }: {
    drawn: DrawSite | undefined;
    renderOnly: boolean;
    arms: Branch[] | undefined;
    ownArms: boolean;
    loads: Set<WriteFact>;
    initCalls: Map<string, string>;
  },
) {
  const m = walk.method;
  const context: AccessContext = {
    method: m,
    awaits: walk.awaits,
    scan,
    builders,
    isBuild: rendersUi(m),
    drawn,
    renderOnly,
    via: drawn && !rendersUi(m) ? (m.kind === 'getter' ? `this.${m.name}` : `this.${m.name}()`) : undefined,
    calls: [],
    tested: new Set(),
    arms,
    ownArms,
    loads,
    initCalls,
  };
  for (const base of walk.accesses) {
    const field = fields.get(base.name.text);
    if (field) {
      access(base, field, context);
    }
  }
  for (const { field, call } of context.calls) {
    field.calls.push({ ...call, checked: call.checked || context.tested.has(field) });
  }
}

interface AccessContext {
  method: Method;
  awaits: Map<ts.Node, number[]>;
  scan: FileScan;
  builders: BuilderNames;
  /** build() or a @Builder: its writes in handlers are build-closure writes. */
  isBuild: boolean;
  /** Where build() uses the method, if it draws the UI (drawingMethods): its reads are build reads, in that loop or
   *  attribute when the read itself sits in none. */
  drawn: DrawSite | undefined;
  /** The method runs only while drawing (renderOnlyMethods): its writes outside handlers are render writes. */
  renderOnly: boolean;
  /** For a drawing helper, how build() reaches it (BuildRead.via). */
  via?: string;
  /** The method's calls of fields, and the fields it reads without calling or writing them. */
  calls: { field: FieldFact; call: CallbackCall }[];
  tested: Set<FieldFact>;
  /** The `if` arms of build() the method runs in (methodArms); undefined when not known. */
  arms: Branch[] | undefined;
  /** The `if` arms in the method's own body count too: false when it may run several times at once (methodArms). */
  ownArms: boolean;
  /** Writes outside callbacks or in promise continuations only (`.then`): run once if their method is. */
  loads: Set<WriteFact>;
  /** Each field whose initializer is a call, with that call's text. */
  initCalls: Map<string, string>;
}

/** One `this.<field>…` access: the path below the field, then whether it writes (assignment, update, mutating call). */
function access(base: ts.PropertyAccessExpression, field: FieldFact, ctx: AccessContext) {
  const { top, path: segments } = pathBelow(base, ctx.scan.sf, ts.isNonNullExpression);
  const parent = top.parent;
  const last = segments.at(-1);
  const called = ts.isCallExpression(parent) && parent.expression === top;
  const callName =
    called && last !== undefined && 'prop' in last && MUTATING_CALLS.has(last.prop) ? last.prop : undefined;
  const mutatingCall = callName !== undefined;
  const assignment =
    ts.isBinaryExpression(parent) && parent.left === top && isAssignment(parent.operatorToken.kind)
      ? parent
      : undefined;
  const updated =
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
  const line = ctx.scan.line(base);
  if (segments.length === 0 && called) {
    ctx.calls.push({ field, call: { line, checked: parent.questionDotToken !== undefined } });
  } else if (segments.length === 0 && !assignment) {
    ctx.tested.add(field);
  }
  const assignedTime = assignment && timeValue(assignment.right);
  if (assignedTime && field.timeValue !== 'timer') {
    field.timeValue = assignedTime;
  }
  const where = climb(base, ctx.method.body, ctx.builders);
  if (!mutatingCall && !assignment && !updated) {
    field.reads.push({ line, method: ctx.method.name });
    if (ctx.drawn) {
      field.buildReads.push({
        line,
        path: segments,
        attribute: where.attribute ?? ctx.drawn.attribute,
        inForEach: where.inForEach || ctx.drawn.inForEach,
        inHandler: where.inHandler,
        ...(ctx.via ? { via: ctx.via } : {}),
      });
    }
    return;
  }
  // The write lands when the whole assignment, update or call is done: after any await in its own value or arguments.
  const deferred =
    where.deferringCall ||
    [ctx.method.body, ...where.functions].some((f) => (ctx.awaits.get(f) ?? []).some((end) => end <= parent.end));
  const context: WriteContext = deferred
    ? 'async-callback'
    : ctx.renderOnly && !where.inHandler
      ? 'render'
      : ctx.isBuild
        ? 'build-closure'
        : LIFECYCLE.has(ctx.method.name)
          ? 'lifecycle'
          : 'method';
  // A mutating call changes the container below its receiver: `[]` with no index stands for it.
  const path: PathSegment[] = mutatingCall ? [...segments.slice(0, -1), { index: '' }] : segments;
  const rebuilt = segments.length <= 1 ? rebuiltElements(field.name, top, ctx.scan) : [];
  const write: WriteFact = {
    line,
    context,
    method: ctx.method.name,
    path: path.length ? path : undefined,
    value: mutatingCall ? undefined : assignedValue(assignment),
    ...(mutatingCall || updated || (assignment && accumulates(assignment, field.name)) ? { accumulates: true } : {}),
    ...(callName === undefined ? {} : { call: callName }),
    ...(assignment && segments.length === 0 && keepsPositions(assignment, field.name) ? { keepsPositions: true } : {}),
    ...(assignment && segments.length === 0 && keepsItems(assignment, field.name) ? { keepsItems: true } : {}),
    ...(ctx.arms
      ? { branches: [...ctx.arms, ...(ctx.ownArms ? branchesOf(base, ctx.method.body, ctx.scan.sf) : [])] }
      : {}),
    ...(rebuilt.length ? { rebuilt } : {}),
    ...(assignment && segments.length === 0 && repeatsInitializer(assignment, ctx.initCalls.get(field.name), ctx.scan)
      ? { repeatsInitializer: true }
      : {}),
    disabledRules: ctx.scan.disabledAt(line),
  };
  field.writes.push(write);
  if (where.functions.every(continues)) {
    ctx.loads.add(write);
  }
}

/** The assignment's new value depends on the field's old one: `+=` and the like, or `this.f = g(this.f)`. */
function accumulates(assignment: ts.BinaryExpression, field: string): boolean {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return true;
  }
  const reads = (n: ts.Node): boolean => thisMember(n) === field || ts.forEachChild(n, reads) === true;
  return reads(assignment.right);
}

/** `this.F = [...this.F, x]`, `this.F.concat(x)`, `[]`, `this.F.slice()` or `this.F.slice(0, n)`: no other item at an
 *  old position. */
function keepsPositions(assignment: ts.BinaryExpression, field: string): boolean {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const value = unwrap(assignment.right);
  if (ts.isArrayLiteralExpression(value)) {
    const [first] = value.elements;
    return first === undefined || (ts.isSpreadElement(first) && thisMember(unwrap(first.expression)) === field);
  }
  if (!(ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression))) {
    return false;
  }
  const method = value.expression.name.text;
  const [start] = value.arguments;
  const fromStart = method === 'slice' && (start === undefined || isZero(start));
  return (method === 'concat' || fromStart) && thisMember(unwrap(value.expression.expression)) === field;
}

/** `this.F = []`, `[...this.F]`, `this.F.slice()`, `this.F.slice(0)`, `this.F.slice(0, 0)` or `this.F.concat()`: the
 *  same items or none. */
function keepsItems(assignment: ts.BinaryExpression, field: string): boolean {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const value = unwrap(assignment.right);
  if (ts.isArrayLiteralExpression(value)) {
    const [first, ...rest] = value.elements;
    return (
      first === undefined ||
      (rest.length === 0 && ts.isSpreadElement(first) && thisMember(unwrap(first.expression)) === field)
    );
  }
  if (!(ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression))) {
    return false;
  }
  const method = value.expression.name.text;
  const args = value.arguments;
  const copy =
    (method === 'concat' && args.length === 0) ||
    (method === 'slice' && (args.length === 0 || (isZero(args[0]) && (args.length === 1 || isZero(args[1])))));
  return copy && thisMember(unwrap(value.expression.expression)) === field;
}

/** The fields whose initializer is a call, with its tokens, so that formatting doesn't tell two calls apart; a `new`
 *  expression is no call, so it never matches. */
function initializerCalls(s: ts.StructDeclaration, scan: FileScan): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.members) {
    const name = memberName(m.name);
    const init = ts.isPropertyDeclaration(m) && m.initializer ? unwrap(m.initializer) : undefined;
    if (name !== undefined && init && ts.isCallExpression(init)) {
      out.set(name, tokens(init, scan.sf));
    }
  }
  return out;
}

function repeatsInitializer(assignment: ts.BinaryExpression, init: string | undefined, scan: FileScan): boolean {
  const value = unwrap(assignment.right);
  return (
    init !== undefined &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isCallExpression(value) &&
    tokens(value, scan.sf) === init
  );
}

/** The tokens of an expression, one space apart: the leaves of its syntax tree, so whitespace and comments between them
 *  drop out while a string, template part or regex keeps its text as written. */
function tokens(node: ts.Node, sf: ts.SourceFile): string {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const children = n.getChildren(sf).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) {
      out.push(n.getText(sf));
    }
    children.forEach(visit);
  };
  visit(node);
  return out.join(' ');
}

/** What an assignment assigns: an object literal, a `new` instance, a constant, or anything else (compound and update
 *  writes too). */
function assignedValue(assignment: ts.BinaryExpression | undefined): WriteFact['value'] {
  if (assignment?.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return 'other';
  }
  const value = unwrap(assignment.right);
  if (isConstant(value)) {
    return 'constant';
  }
  return ts.isObjectLiteralExpression(value) ? 'object-literal' : ts.isNewExpression(value) ? 'new' : 'other';
}

/** A string, number or boolean literal (`-1` included), `null` or `undefined`. */
function isConstant(e: ts.Expression): boolean {
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(e.operand);
  }
  return (
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined')
  );
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

/** The methods that run only before the first build(): aboutToAppear, and helpers whose every use is a call outside
 *  handlers in such a method, with no await before it in its scope. Code after an await may run after the first
 *  build(); an await in another callback (`setTimeout(async () => …)`) doesn't delay the call. afterAwait: also calls
 *  after an await, i.e. the methods that run once, from aboutToAppear. */
function setupMethods(scans: MethodWalk[], afterAwait: boolean): Set<string> {
  const first = scans.find((scan) => scan.method.name === 'aboutToAppear');
  if (!first) {
    return new Set();
  }
  const setup = new Set([first.method.name]);
  const onlyFrom = (name: string) =>
    scans.every((scan) =>
      scan.uses.every(
        (use) =>
          use.name !== name ||
          (setup.has(scan.method.name) && (afterAwait || !scan.delayed.has(use)) && use.called && !use.inHandler),
      ),
    );
  for (let changed = true; changed; ) {
    changed = false;
    for (const scan of scans) {
      const name = scan.method.name;
      if (
        !setup.has(name) &&
        scan.method.kind === 'method' &&
        scans.some((other) => other.uses.some((use) => use.name === name)) &&
        onlyFrom(name)
      ) {
        setup.add(name);
        changed = true;
      }
    }
  }
  return setup;
}

/**
 * The `if` arms of build() each method runs in: none for build() itself; for another method, the arms every use of it
 * shares, each use's arms in its own body after those of the method holding it. A @Builder that only one arm calls, or
 * a method only a handler in that arm calls, runs only while the arm is shown. A method with a use in a lifecycle hook,
 * or with no use in the component (other code calls it), has none known.
 *
 * repeated: the methods that may run several times at once, whose own `if` arms then don't exclude each other (one
 * run may take one arm, another the other): a use in a loop row or in a repeated method, or uses not all in exclusive
 * arms of one method. They keep only the arms they inherit.
 */
function methodArms(scans: MethodScan[]): { arms: Map<string, Branch[]>; repeated: Set<string> } {
  const arms = new Map<string, Branch[]>([['build', []]]);
  const uses = new Map<string, { caller: string; branches: Branch[]; inForEach: boolean }[]>();
  for (const scan of scans) {
    for (const use of scan.uses) {
      const site = { caller: scan.method.name, branches: use.branches, inForEach: use.inForEach };
      uses.set(use.name, [...(uses.get(use.name) ?? []), site]);
    }
  }
  const repeated = new Set<string>();
  // Two uses in different arms of one `if` of the same method (queries.exclusiveArms) never run at once.
  const apart = (a: { caller: string; branches: Branch[] }, b: { caller: string; branches: Branch[] }) =>
    a.caller === b.caller && a.branches.some((x) => b.branches.some((y) => x.at === y.at && x.arm !== y.arm));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, sites] of uses) {
      const several = sites.some((a, i) => sites.slice(0, i).some((b) => !apart(a, b)));
      if (
        !repeated.has(name) &&
        name !== 'build' &&
        (several || sites.some((site) => site.inForEach || repeated.has(site.caller)))
      ) {
        repeated.add(name);
        changed = true;
      }
    }
  }
  const own = (site: { caller: string; branches: Branch[] }) => (repeated.has(site.caller) ? [] : site.branches);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, sites] of uses) {
      if (arms.has(name) || name === 'build' || !sites.every((site) => arms.has(site.caller))) {
        continue;
      }
      const [first, ...rest] = sites.map((site) => [...(arms.get(site.caller) ?? []), ...own(site)]);
      arms.set(
        name,
        first.filter((arm) => rest.every((other) => other.some((b) => b.at === arm.at && b.arm === arm.arm))),
      );
      changed = true;
    }
  }
  return { arms, repeated };
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
  const fromBuild = reach(roots(rendersUi), true);
  const fromLifecycle = reach(
    roots((m) => LIFECYCLE.has(m.name)),
    false,
  );
  return new Set(
    scans.map((s) => s.method.name).filter((n) => !LIFECYCLE.has(n) && !fromBuild.has(n) && !fromLifecycle.has(n)),
  );
}
