// Listeners, subscriptions and timers a component acquires in lifecycle hooks, and whether its teardown releases them.
import type { ResourceFact } from '../analysis.js';
import type { MethodScan } from './component.js';
import { ACQUIRE_HOOKS, LIFECYCLE, RELEASE_HOOKS } from './lifecycle.js';
import { ts } from './parse.js';
import type { FileScan } from './scan.js';
import { calleeName, expressionName, identifiersIn, isThis, isWrapper, unwrap } from './syntax.js';

/** Method names that acquire a subscription; the release is `un<name>` or, for add…, `remove…`. */
const REGISTRATION = /^(?:register\w*|subscribe\w*|add\w*(?:Listener|Observer|Callback))$/;

export function resources(scans: MethodScan[], scan: FileScan): ResourceFact[] {
  // A lifecycle hook plus the same-component helpers it calls directly (one level), e.g. aboutToDisappear → this.unregisterAll().
  const inHooks = (hooks: Set<string>) =>
    scans
      .filter((h) => hooks.has(h.method.name))
      .flatMap((h) => [
        { s: h, via: h.method.name },
        ...[...new Set(h.uses.filter((u) => u.called).map((u) => u.name))]
          .map((n) => scans.find((s) => s.method.name === n && !LIFECYCLE.has(n)))
          .filter((s): s is MethodScan => s !== undefined)
          .map((s) => ({ s, via: `${h.method.name}→${s.method.name}` })),
      ]);
  const releases = inHooks(RELEASE_HOOKS).flatMap(({ s }) => s.calls);
  const out: ResourceFact[] = [];
  const seen = new Set<string>();
  const add = (r: Omit<ResourceFact, 'disabledRules'>) => {
    if (!seen.has(r.key)) {
      seen.add(r.key);
      out.push({ ...r, disabledRules: scan.disabledAt(r.acquireLine) });
    }
  };
  for (const { s, via } of inHooks(ACQUIRE_HOOKS)) {
    for (const call of s.calls) {
      const r = acquisition(call, via, releases, scan);
      if (r) {
        add(r);
      }
    }
  }
  return out.sort((a, b) => a.acquireLine - b.acquireLine);
}

/** The resource a call acquires, if it does. */
function acquisition(
  call: ts.CallExpression,
  via: string,
  releases: ts.CallExpression[],
  scan: FileScan,
): Omit<ResourceFact, 'disabledRules'> | undefined {
  const name = calleeName(call);
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && name !== undefined) {
    // A chained call (`bus\n  .on(a, f)\n  .on(b, g)`) starts where the chain does: take its method name's line.
    const acquireLine = scan.line(callee.name);
    const root = chainRoot(callee.expression);
    const target = scan.text(root);
    if (name === 'on' && call.arguments.length > 0) {
      // Event listeners: target.on('event' | CONST.EVENT, handler) ↔ target.off(same event).
      const event = eventName(call.arguments[0]);
      return event === undefined
        ? undefined
        : {
            kind: 'listener',
            key: `${target}.on:${event}`,
            targetNames: identifiersIn(root),
            acquireLine,
            acquireIn: via,
            released: releases.some(
              (c) => calleeName(c) === 'off' && c.arguments.length > 0 && eventName(c.arguments[0]) === event,
            ),
            release: `${target}.off(${scan.text(call.arguments[0])}, <same handler>)`,
          };
    }
    if (REGISTRATION.test(name)) {
      const undo = name.startsWith('add') ? `remove${name.slice(3)}` : `un${name}`;
      return {
        kind: 'subscription',
        key: `${target}.${name}`,
        targetNames: identifiersIn(root),
        acquireLine,
        acquireIn: via,
        released: releases.some((c) => calleeName(c)?.toLowerCase() === undo.toLowerCase()),
        release: `${target}.${undo}(...)`,
      };
    }
  }
  if (name !== 'setInterval') {
    return undefined;
  }
  const acquireLine = scan.line(call);
  const holder = timerHolder(call);
  return holder
    ? {
        kind: 'timer',
        key: `timer:${holder}`,
        targetNames: ['this', holder.slice('this.'.length)],
        acquireLine,
        acquireIn: via,
        released: releases.some(
          (c) =>
            calleeName(c) === 'clearInterval' && c.arguments.length > 0 && scan.text(unwrap(c.arguments[0])) === holder,
        ),
        release: `clearInterval(${holder})`,
      }
    : {
        kind: 'timer',
        key: `timer:anonymous@${acquireLine}`,
        targetNames: [],
        acquireLine,
        acquireIn: via,
        released: false,
        release: 'clearInterval(<the interval id>)',
      };
}

/** The receiver under chained listener calls: `bus.on(a, f).on(b, g)` registers both on `bus`. */
function chainRoot(e: ts.Expression): ts.Expression {
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    if (name !== 'on' && name !== 'off' && !REGISTRATION.test(name)) {
      break;
    }
    e = e.expression.expression;
  }
  return e;
}

/** The event a listener call names: a string's contents, or a constant as written. */
function eventName(e: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(e) ? e.text : expressionName(e);
}

/** `this.x` when the interval id is assigned to it (`this.x = setInterval(…)`, also through a cast). */
function timerHolder(call: ts.CallExpression): string | undefined {
  let value: ts.Node = call;
  while (isWrapper(value.parent)) {
    value = value.parent;
  }
  const p = value.parent;
  return ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === value &&
    ts.isPropertyAccessExpression(p.left) &&
    isThis(p.left.expression)
    ? `this.${p.left.name.text}`
    : undefined;
}
