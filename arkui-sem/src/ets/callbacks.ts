// When a function in a component method runs (later, on an event, or while build() describes the UI), and where an
// access sits (climb). A denylist: a function no rule here names counts as running while the UI is described.
import type { BuildRead } from '../facts.js';
import { ts } from './parse.js';
import { argumentOf, calleeName, isFunction, memberName, onComponent, thisMember } from './syntax.js';

/** The names a component's code can call as builders: its builder methods (`this.B(…)`), the file's builder functions,
 *  and imported names, which may be builders (`B(…)`). */
export interface BuilderNames {
  methods: Set<string>;
  functions: Set<string>;
  imports: Set<string>;
}

/** Calls whose function arguments run later, after the calling code has returned. */
const DEFERRING_CALLS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'on', 'subscribe']);
const PROMISE_CALLS = new Set(['then', 'catch', 'finally']);
/** Calls whose function arguments animate a change: they run once, not while the UI is described. */
const ANIMATIONS = new Set(['animateTo', 'animateToImmediately']);
/** Event callbacks: `.onClick(…)`, `PanGesture().onActionStart(…)`, `ctrl.onReady(…)`. */
const EVENT_NAME = /^on[A-Z]/;
/** Event callbacks that return UI: `onDragStart` may return the builder of the drag preview. */
const DRAWING_EVENTS = new Set(['onDragStart']);
const LOOPS = new Set(['ForEach', 'LazyForEach', 'Repeat']);
const BUILTIN_FUNCTIONS = new Set([
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Symbol',
  'BigInt',
  'Date',
  'Error',
]);

/** fn is passed to a deferring call: `setTimeout(fn)`, `p.then(fn)`, `emitter.on('e', fn)`. */
export function defers(fn: ts.Node): boolean {
  return DEFERRING_CALLS.has(callName(fn));
}

/** fn is a promise continuation: `p.then(fn)`, `.catch(fn)`, `.finally(fn)`. */
export function continues(fn: ts.Node): boolean {
  return PROMISE_CALLS.has(callName(fn));
}

/** fn runs on an event or later and draws nothing: a deferred callback, an event callback, an animation body. names:
 *  the component's builders, whose calls draw. */
export function isHandler(fn: ts.Node, names: BuilderNames): boolean {
  const name = callName(fn);
  return DEFERRING_CALLS.has(name) || ANIMATIONS.has(name) || isEvent(name) || isCallbackProperty(fn, names);
}

/** The name of the call fn is an argument of, or ''. */
function callName(fn: ts.Node): string {
  const call = argumentOf(fn);
  return call !== undefined && ts.isCallExpression(call) ? (calleeName(call) ?? '') : '';
}

export function isEvent(name: string): boolean {
  return EVENT_NAME.test(name) && !DRAWING_EVENTS.has(name);
}

/** fn is a callback given as an option property and describes no UI: an `on…` property anywhere
 *  (`.bindSheet(show, panel, { onWillDismiss: … })`), or any property of an object passed to a child component
 *  (`Child({ sliderChangeCallback: … })`) or to a constructor (`new CustomDialogController({ cancel: … })`). A property
 *  that creates UI draws: `Child({ content: () => { Text(…) } })` (a @BuilderParam), `{ builder: () => { … } }`, and so
 *  does one other than an event that calls a builder: `Child({ content: () => { this.Row(item) } })`. */
function isCallbackProperty(fn: ts.Node, names: BuilderNames): boolean {
  const prop = fn.parent;
  if (!ts.isPropertyAssignment(prop) || prop.initializer !== fn || describesUi(fn)) {
    return false;
  }
  if (isEvent(memberName(prop.name) ?? '')) {
    return true;
  }
  if (callsBuilder(fn, names)) {
    return false;
  }
  const options = prop.parent;
  const owner = options.parent;
  if (ts.isNewExpression(owner)) {
    return owner.arguments?.some((a) => a === options) ?? false;
  }
  const call = argumentOf(options);
  return call !== undefined && isComponentName(call.expression);
}

/** fn's body creates a component: `Text(…)`, `Column() { … }`. */
function describesUi(fn: ts.Node): boolean {
  const visit = (n: ts.Node): boolean =>
    ((ts.isEtsComponentExpression(n) || ts.isCallExpression(n)) && isComponentName(n.expression)) ||
    ts.forEachChild(n, visit) === true;
  return ts.forEachChild(fn, visit) === true;
}

/** fn's body calls a builder method or a builder function of the file. Imported names are left to describesUi, which
 *  counts the capitalized ones: a lowercase import is more often a plain helper (`save(…)`). */
function callsBuilder(fn: ts.Node, names: BuilderNames): boolean {
  const local = { ...names, imports: new Set<string>() };
  const visit = (node: ts.Node): boolean =>
    ((ts.isCallExpression(node) || ts.isEtsComponentExpression(node)) && isBuilderCall(node, local)) ||
    ts.forEachChild(node, visit) === true;
  return ts.forEachChild(fn, visit) === true;
}

/** `this.B(…)` with B a builder method, or `B(…)` with B a builder function or an imported name. */
export function isBuilderCall(call: ts.CallExpression | ts.EtsComponentExpression, names: BuilderNames): boolean {
  const method = thisMember(call.expression);
  if (method !== undefined) {
    return names.methods.has(method);
  }
  return (
    ts.isIdentifier(call.expression) &&
    (names.functions.has(call.expression.text) || names.imports.has(call.expression.text))
  );
}

/** Components are capitalized by ArkUI convention; the JS built-ins called as functions are not components. */
function isComponentName(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && /^[A-Z]/.test(e.text) && !BUILTIN_FUNCTIONS.has(e.text);
}

/** What lies between an access and its method's body: the functions holding it (innermost first), whether one of them is
 *  passed to a deferring call, the nearest attribute call holding it (not through a callback such as an event handler),
 *  whether a loop holds it, and whether one of the functions is a handler (isHandler, with the component's builders). */
export function climb(
  node: ts.Node,
  body: ts.Node,
  names: BuilderNames,
): Pick<BuildRead, 'attribute' | 'inForEach' | 'inHandler'> & { functions: ts.Node[]; deferringCall: boolean } {
  const functions: ts.Node[] = [];
  let deferringCall = false;
  let inHandler = false;
  let attribute: string | undefined;
  let inForEach = false;
  for (let n: ts.Node = node; n !== body && n.parent; n = n.parent) {
    const call = argumentOf(n);
    if (isFunction(n)) {
      functions.push(n);
      deferringCall ||= defers(n);
      inHandler ||= isHandler(n, names);
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
  return { functions, deferringCall, attribute, inForEach, inHandler };
}
