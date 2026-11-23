// When a function in a component method runs (later, on an event, or while build() describes the UI), and where an
// access sits (climb). A denylist: a function no rule here names counts as running while the UI is described.
import type { BuildRead } from '../facts.js';
import { ts } from './parse.js';
import { argumentOf, calleeName, isFunction, memberName, onComponent } from './syntax.js';

/** Calls whose function arguments run later, after the calling code has returned. */
const DEFERRING_CALLS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'on', 'subscribe']);
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

/** fn runs on an event or later and draws nothing: a deferred callback, an event callback, an animation body. */
export function isHandler(fn: ts.Node): boolean {
  const name = callName(fn);
  return DEFERRING_CALLS.has(name) || ANIMATIONS.has(name) || isEvent(name) || isCallbackProperty(fn);
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
 *  that creates UI draws: `Child({ content: () => { Text(…) } })` (a @BuilderParam), `{ builder: () => { … } }`. */
function isCallbackProperty(fn: ts.Node): boolean {
  const prop = fn.parent;
  if (!ts.isPropertyAssignment(prop) || prop.initializer !== fn || describesUi(fn)) {
    return false;
  }
  if (isEvent(memberName(prop.name) ?? '')) {
    return true;
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

/** Components are capitalized by ArkUI convention; the JS built-ins called as functions are not components. */
function isComponentName(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && /^[A-Z]/.test(e.text) && !BUILTIN_FUNCTIONS.has(e.text);
}

/** What lies between an access and its method's body: the functions holding it (innermost first), whether one of them is
 *  passed to a deferring call, the nearest attribute call holding it (not through a callback such as an event handler),
 *  whether a loop holds it, and whether one of the functions is a handler. */
export function climb(
  node: ts.Node,
  body: ts.Node,
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
      inHandler ||= isHandler(n);
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
