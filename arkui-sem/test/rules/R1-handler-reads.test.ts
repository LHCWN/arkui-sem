// R1: reads inside event handlers, animateTo bodies and deferred callbacks in build() don't count as rendering.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLines, renderingReads } from '../../src/queries.js';
import { extract, found } from '../helpers.js';

const undecorated = (src: string) =>
  found(src)
    .filter((c) => c.kind === 'undecorated-mutated-rendered')
    .map((c) => c.field.name);

/** A component with one plain field `x`, written in a method, read in `body` inside build(). */
const plain = (body: string, extra = '') => `${extra}
@Component
struct P {
  x: number = 0
  @State items: number[] = []
  bump() { this.x++ }
  build() {
    Column() {
      ${body}
    }
  }
}`;

test('a field only event handlers read is not rendered', () => {
  const src = `@Component
struct Drawer {
  @State offsetX: number = 0;
  private startX: number = 0;
  build() {
    Row() {}
      .translate({ x: this.offsetX })
      .gesture(PanGesture()
        .onActionStart(() => { this.startX = this.offsetX; })
        .onActionUpdate((e: GestureEvent) => { this.offsetX = this.startX + e.offsetX; }))
  }
}`;
  assert.deepEqual(undecorated(src), []);
  const startX = extract(src).components[0].fields[1];
  assert.deepEqual(
    startX.buildReads.map((r) => r.inHandler),
    [true],
  );
});

test('reads in onClick, a nested function in it, animateTo and setTimeout are handler reads', () => {
  for (const body of [
    "Button('a').onClick(() => { console.info(String(this.x)) })",
    "Button('a').onClick(() => { [1].forEach(() => { console.info(String(this.x)) }) })",
    "Text('a').onAppear(() => { animateTo({ duration: 100 }, () => { console.info(String(this.x)) }) })",
    "Text('a').width(animateTo({}, () => { console.info(String(this.x)) }) ? 1 : 2)",
    "Text('a').width(setTimeout(() => { console.info(String(this.x)) }, 10) ? 1 : 2)",
    'Child({ onChange: () => { console.info(String(this.x)) } })',
    'Child({ sliderChangeCallback: (v: number) => { console.info(String(this.x + v)) } })',
    'Child({ value: () => this.x })',
    "Text('a').width(this.bus.on('e', () => { console.info(String(this.x)) }) ? 1 : 2)",
    "Text('a').width(new Ctrl().onReady(() => { console.info(String(this.x)) }) ? 1 : 2)",
  ]) {
    assert.deepEqual(undecorated(plain(body)), [], body);
  }
});

test('reads in loops, builders, trailing content and unknown closures still render', () => {
  for (const body of [
    'ForEach(this.items, (i: number) => { Text(String(i + this.x)) })',
    "Text('a').bindMenu(() => { Text(String(this.x)) })",
    "Text('a').bindSheet(true, () => { Text(String(this.x)) })",
    "Text('a').bindPopup(true, { builder: () => { Text(String(this.x)) } })",
    'Child({ content: () => { Text(String(this.x)) } })',
    'Repeat(this.items).each((r: RepeatItem<number>) => { Text(String(r.item + this.x)) })',
    "Repeat(this.items).template('a', (r: RepeatItem<number>) => { Text(String(this.x)) })",
    "Text('a').onDragStart(() => { return { builder: () => { Text(String(this.x)) } } })",
    'Row() { Text(String(this.x)) }',
    'Child({ onEmpty: () => { Text(String(this.x)) } })',
    'Child({ content: () => { Column() { Text(String(this.x)) } } })',
    'Text(this.items.map(() => this.x).join())',
  ]) {
    assert.deepEqual(undecorated(plain(body)), ['x'], body);
  }
});

test('a closure property that calls a builder draws, unless the property is an event', () => {
  const builders = `@Builder function Badge(v: number) { Text(String(v)) }
`;
  const withMethod = (body: string) =>
    plain(body).replace('  build() {', '  @Builder Line(v: number) { Text(String(v)) }\n  build() {');
  for (const src of [
    withMethod('Child({ content: () => { this.Line(this.x) } })'),
    plain('Child({ content: () => { Badge(this.x) } })', builders),
    plain('Child({ content: () => { Shared(this.x) } })', "import { Shared } from './shared'"),
  ]) {
    assert.deepEqual(undecorated(src), ['x'], src);
  }
  for (const src of [
    withMethod('Child({ onShow: () => { this.Line(this.x) } })'),
    plain('Child({ action: () => { save(this.x) } })', "import { save } from './store'"),
    plain('Child({ content: () => { this.bump(); console.info(String(this.x)) } })'),
  ]) {
    assert.deepEqual(undecorated(src), [], src);
  }
});

test('a field read in rendering and in a handler stays a candidate; evidence cites the rendering read', () => {
  const src = plain(`Button('a').onClick(() => { console.info(String(this.x)) })
      Text(String(this.x))`);
  assert.deepEqual(undecorated(src), ['x']);
  const x = extract(src).components[0].fields[0];
  assert.deepEqual(readLines(x), [10]);
});

const nested = (render: string) => `class Inner {
  v: number = 0
}
class Outer {
  inner: Inner = new Inner()
}
@Component
struct P {
  @State o: Outer = new Outer()
  build() {
    Column() {
      ${render}
      Button('w').onClick(() => { this.o.inner.v = 1 })
    }
  }
}`;
const nestedHits = (src: string) =>
  found(src)
    .filter((c) => c.kind === 'nested-write-unobserved')
    .map((c) => c.field.name);

test('a nested write is rendered only through rendering reads of its path', () => {
  assert.deepEqual(nestedHits(nested('Text(String(this.o.inner.v))')), ['o']);
  assert.deepEqual(nestedHits(nested("Button('r').onClick(() => { console.info(String(this.o.inner.v)) })")), []);
});

/** An @ObjectLink child of Inner sees the deep write unless the parent renders the path itself. */
const linked = (render: string) => `@Observed
class Inner {
  v: number = 0
}
@Observed
class Outer {
  inner: Inner = new Inner()
}
@Component
struct V {
  @ObjectLink inner: Inner
  build() {}
}
@Component
struct P {
  @State o: Outer = new Outer()
  build() {
    Column() {
      V({ inner: this.o.inner })
      ${render}
      Button('w').onClick(() => { this.o.inner.v = 1 })
    }
  }
}`;

test('@ObjectLink: a parent that renders the path still flags; one that reads it only in a handler does not', () => {
  assert.deepEqual(nestedHits(linked('Text(String(this.o.inner.v))')), ['o']);
  assert.deepEqual(nestedHits(linked("Button('r').onClick(() => { console.info(String(this.o.inner.v)) })")), []);
});

/** A component with one plain field `x`, written in bump(), a helper `extra` and a build() body. */
const helper = (body: string, extra: string) => `@Component
struct P {
  x: number = 0
  bump() { this.x++ }
  ${extra}
  build() {
    Column() {
      ${body}
    }
  }
}`;

test('a field drawn through a helper method or getter that build() uses is rendered', () => {
  const cases: [string, string, string][] = [
    ["Text('a').width(this.calc())", 'calc(): number { return this.x * 2 }', 'this.calc()'],
    ['Text(this.label)', 'get label(): string { return String(this.x) }', 'this.label'],
    [
      "Text('a').width(this.outer())",
      'outer(): number { return this.inner() }\n  inner(): number { return this.x }',
      'this.inner()',
    ],
  ];
  for (const [body, extra, via] of cases) {
    const src = helper(body, extra);
    assert.deepEqual(undecorated(src), ['x'], body);
    const x = extract(src).components[0].fields[0];
    assert.equal(renderingReads(x)[0].via, via, body);
    assert.ok(
      x.writes.every((w) => w.context === 'method'),
      body,
    );
  }
});

test('a helper build() calls only from a handler, or a handler inside a helper, does not render', () => {
  for (const [body, extra] of [
    ["Button('a').onClick(() => { this.log() })", 'log() { console.info(String(this.x)) }'],
    [
      "Text('a').width(this.later())",
      'later(): number { setTimeout(() => { console.info(String(this.x)) }, 1); return 1 }',
    ],
    ["Text('a')", 'unused(): number { return this.x }'],
  ]) {
    assert.deepEqual(undecorated(helper(body, extra)), [], body);
  }
});

test('evidence prefers a direct read and names the helper otherwise', () => {
  const direct = extract(helper('Text(String(this.x)).width(this.calc())', 'calc(): number { return this.x }'));
  assert.equal(renderingReads(direct.components[0].fields[0])[0].via, undefined);
});

test('a field written only while build() draws (a render counter) is not a candidate', () => {
  const counter = (extra: string) => `@Component
struct P {
  private opacityNum: number = 0.5
  private nextOpacity(): number {
    this.opacityNum = (this.opacityNum + 0.1) % 1
    return this.opacityNum
  }
  ${extra}
  build() {
    Column() {
      Text('a').opacity(this.nextOpacity())
    }
  }
}`;
  assert.deepEqual(undecorated(counter('')), []);
  const [f] = extract(counter('')).components[0].fields;
  assert.deepEqual(
    f.writes.map((w) => w.context),
    ['render'],
  );
  // A later write (a method, a handler) still makes it a candidate.
  assert.deepEqual(undecorated(counter('reset() { this.opacityNum = 0 }')), ['opacityNum']);
});

test('a render-time write that settles, or a counter helper that also runs on an event, stays a candidate', () => {
  const settles = `@Component
struct P {
  private valid: boolean = false
  @Builder item() {
    Text(this.valid ? 'ok' : 'no')
  }
  build() {
    Column() {
      this.item()
      this.mark()
    }
  }
  mark(): number { this.valid = true; return 0 }
}`;
  assert.deepEqual(undecorated(settles), ['valid']);
  const shared = `@Component
struct P {
  private n: number = 0
  next(): number { this.n++; return this.n }
  build() {
    Column() {
      Text('a').opacity(this.next())
      Button('b').onClick(() => { this.next() })
    }
  }
}`;
  assert.deepEqual(undecorated(shared), ['n']);
  assert.deepEqual(
    extract(shared).components[0].fields[0].writes.map((w) => w.context),
    ['method'],
  );
});

test('on… callbacks in option objects and callbacks given to constructors are handlers', () => {
  for (const body of [
    "Text('a').bindPopup(true, { builder: () => { Text('p') }, onStateChange: () => { console.info(String(this.x)) } })",
    "Text('a').width(new Ctrl({ cancel: () => { console.info(String(this.x)) } }) ? 1 : 2)",
  ]) {
    assert.deepEqual(undecorated(plain(body)), [], body);
  }
  // A counter bumped in such a callback is a handler write, not a render counter: the drawn field stays a candidate.
  const sheet = plain(`Text(String(this.x))
      Text('a').bindSheet(true, () => { Text('s') }, { onWillDismiss: () => { this.x++ } })`);
  assert.deepEqual(undecorated(sheet), ['x']);
  assert.ok(extract(sheet).components[0].fields[0].writes.some((w) => w.context === 'build-closure'));
});

test('a read in a helper takes the loop and attribute of the site build() uses it at', () => {
  const src = helper(
    `ForEach([1], (i: number) => { Text(String(this.scaled(i))) })
      Text('a').width(this.calc())`,
    'scaled(i: number): number { return i * this.x }\n  calc(): number { return this.x }',
  );
  const reads = renderingReads(extract(src).components[0].fields[0]);
  assert.deepEqual(
    reads.map((r) => [r.via, r.inForEach, r.attribute]),
    [
      ['this.scaled()', true, undefined],
      ['this.calc()', false, 'width'],
    ],
  );
});
