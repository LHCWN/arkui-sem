// R3 lifecycle leak (a listener, subscription or timer acquired without a release) on inline ArkTS sources.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, found } from '../helpers.js';

const leaks = (src: string) =>
  found(src)
    .filter((c) => c.rule === 'R3')
    .map((c) => c.resource.key)
    .sort();

test('constant-event listeners, register/subscribe pairs and helper-called releases', () => {
  const src = (teardown: string) => `@Component
struct R {
  aboutToAppear() {
    this.bus.on(Events.CHANGE, this.onChange)
    Mgr.getInstance().registerFoo(this.cb)
    this.setup()
  }
  setup() {
    commonEvent.subscribe(this.sub, this.cb)
  }
  aboutToDisappear() {
${teardown}
  }
  build() {}
}`;
  assert.deepEqual(leaks(src('')), [
    'Mgr.getInstance().registerFoo',
    'commonEvent.subscribe',
    'this.bus.on:Events.CHANGE',
  ]);
  assert.deepEqual(
    leaks(
      src(
        '    this.bus.off(Events.CHANGE, this.onChange)\n    this.teardown()\n  }\n  teardown() {\n    Mgr.getInstance().unregisterFoo(this.cb)\n    commonEvent.unsubscribe(this.sub)',
      ),
    ),
    [],
  );
});

test('a disable comment above the acquire line', () => {
  const src = (comment: string) =>
    `@Component\nstruct R {\n  aboutToAppear() {\n    ${comment}\n    this.bus.on('refresh', this.h)\n  }\n  build() {}\n}`;
  assert.equal(leaks(src('')).length, 1);
  assert.equal(leaks(src('// arkui-sem-disable-next-line R3 -- app-lifetime bus')).length, 0);
});

test('listener targets across lines, optional chains, chained calls and `this.x` event names', () => {
  const src = (teardown: string) => `@Component
struct R {
  aboutToAppear() {
    this.ctx?.eventHub.on(this.eventId, this.onEvent)
    this.bus.on(A, this.a).on(B, this.b)
    SessionManager.getInstance()
      .registerScreenCallback(this.cb)
  }
  aboutToDisappear() {
${teardown}
  }
  build() {}
}`;
  assert.deepEqual(leaks(src('')), [
    'SessionManager.getInstance().registerScreenCallback',
    'this.bus.on:A',
    'this.bus.on:B',
    'this.ctx?.eventHub.on:this.eventId',
  ]);
  assert.deepEqual(
    leaks(
      src(
        '    this.ctx?.eventHub.off(this.eventId)\n    this.bus.off(A).off(B)\n    SessionManager.getInstance().unregisterScreenCallback(this.cb)',
      ),
    ),
    [],
  );
});

test('a timer id stored through a cast is released by clearInterval of the same field', () => {
  const src = (teardown: string) => `@Component
struct R {
  timer: number = -1
  aboutToAppear() {
    this.timer = setInterval(() => {}, 1000) as number
  }
  aboutToDisappear() {
${teardown}
  }
  build() {}
}`;
  assert.deepEqual(leaks(src('')), ['timer:this.timer']);
  assert.deepEqual(leaks(src('    clearInterval(this.timer as number)')), []);
});

test('each call in a listener chain reports its own line, so a disable comment above it applies', () => {
  const facts = extract(`@Component
struct R {
  aboutToAppear() {
    this.bus
      .on('a', this.a)
      // arkui-sem-disable-next-line R3
      .on('b', this.b)
  }
  build() {}
}`);
  const resources = facts.components[0].resources;
  assert.deepEqual(
    resources.map((r) => [r.key, r.acquireLine]),
    [
      ['this.bus.on:a', 5],
      ['this.bus.on:b', 7],
    ],
  );
  assert.deepEqual(leaks(facts.lines.join('\n')), ['this.bus.on:a']);
});
