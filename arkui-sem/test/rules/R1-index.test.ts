// R1 foreach-index-key: a ForEach keyed by position whose items at a position change after the first render.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are ArkTS sources, whose key generators are templates
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkFiles, type Finding } from '../../src/engine.js';
import type { CandidateOf } from '../../src/rules/candidate.js';
import { found, put, tempDir } from '../helpers.js';

const MODEL = `interface Trip { id: number; name: string; tags: string[] }`;
const INDEX_KEY = '(t: string, i: number) => `${i}`';

/** A V1 page with `members` and a build() body. */
const page = (members: string, body: string) => `${MODEL}
@Entry
@Component
struct Trips {
  @State trips: Trip[] = []
  @State sel: number = 0
  @State names: string[] = []
${members}
  build() {
    Column() {
${body}
    }
  }
}`;

/** A ForEach over `source` keyed by its index, whose row renders the item. */
const loop = (source: string, row = 'Text(t)') => `      ForEach(${source}, (t: string) => { ${row} }, ${INDEX_KEY})`;

const tabs = "      Button('next').onClick(() => { this.sel++ })";

const indexKeyed = (src: string) =>
  found(src).filter((c): c is CandidateOf<'foreach-index-key'> => c.kind === 'foreach-index-key');

describe('foreach-index-key fires', () => {
  test('a tabbed detail view: the source picks the items by a selection a handler changes', () => {
    const src = page('', `${tabs}\n${loop('this.trips[this.sel].tags')}`);
    const [c, ...rest] = indexKeyed(src);
    assert.equal(rest.length, 0);
    assert.equal(c.line, src.split('\n').findIndex((l) => l.includes('ForEach(')) + 1);
    assert.equal(c.field.name, 'sel');
    assert.deepEqual(
      c.shifts.map((s) => [s.field.name, s.how, s.write.method]),
      [['sel', 'select', 'build']],
    );
    assert.equal(c.methodMovesOnly, false);
    assert.equal(c.fingerprint, 'T.ets#Trips.trips#R1-foreach-index@this.trips[this.sel].tags');
  });

  test('a filter through a helper that reads the selection', () => {
    const helper = '  visible(): string[] {\n    return this.names.filter((n: string) => n.length > this.sel)\n  }';
    const [c] = indexKeyed(page(helper, `${tabs}\n${loop('this.visible()')}`));
    assert.deepEqual(
      c.shifts.map((s) => [s.field.name, s.how]),
      [['sel', 'select']],
    );
  });

  test('a refresh that reassigns or reorders the list from a handler', () => {
    for (const write of [
      'this.names = fetchNames()',
      'this.names.sort()',
      'this.names.splice(0, 1)',
      'this.names[0] = "x"',
    ]) {
      const [c] = indexKeyed(page('', `      Button('r').onClick(() => { ${write} })\n${loop('this.names')}`));
      assert.equal(c?.shifts[0].how, 'move', write);
      assert.equal(c.methodMovesOnly, false, write);
    }
  });

  test('a key that reads only the index, and the row in a @Builder', () => {
    const builder = '  @Builder Tag(t: string) {\n    Text(t)\n  }';
    const src = page(
      builder,
      `${tabs}\n${loop('this.trips[this.sel].tags', 'this.Tag(t)').replace(INDEX_KEY, '(_t: string, i: number) => i.toString()')}`,
    );
    assert.equal(indexKeyed(src).length, 1);
  });

  test('writes after the first render from hooks, timers and a method both a hook and a handler call', () => {
    const cases = [
      page('  onPageShow() {\n    this.names = fetchNames()\n  }', loop('this.names')),
      page('  aboutToReuse() {\n    this.names = fetchNames()\n  }', loop('this.names')),
      page('  aboutToAppear() {\n    setInterval(() => { this.names.reverse() }, 1000)\n  }', loop('this.names')),
      page(
        '  aboutToAppear() {\n    this.refresh()\n  }\n  refresh() {\n    this.names = fetchNames()\n  }',
        `      Button('r').onClick(() => { this.refresh() })\n${loop('this.names')}`,
      ),
    ];
    for (const src of cases) {
      assert.equal(indexKeyed(src).length, 1, src);
    }
  });

  test('shift, unshift and a getter source whose array is reassigned', () => {
    for (const write of ['this.names.shift()', 'this.names.unshift("x")']) {
      assert.equal(
        indexKeyed(page('', `      Button('a').onClick(() => { ${write} })\n${loop('this.names')}`)).length,
        1,
        write,
      );
    }
    const getter = '  get visible(): string[] {\n    return this.names.filter((n: string) => n.length > 2)\n  }';
    const src = page(getter, `      Button('r').onClick(() => { this.names = fetchNames() })\n${loop('this.visible')}`);
    assert.equal(indexKeyed(src)[0]?.fingerprint, 'T.ets#Trips.names#R1-foreach-index@this.visible');
  });
});

describe('foreach-index-key does not fire', () => {
  test('a source never written after the first render', () => {
    const cases = [
      page('', loop('this.names')),
      page('  aboutToAppear() {\n    this.names = loadNames()\n  }', loop('this.names')),
      page(
        '  aboutToAppear() {\n    this.load()\n  }\n  async load() {\n    this.names = await fetchNames()\n  }',
        loop('this.names'),
      ),
      page('  aboutToAppear() {\n    fetchNames().then((n: string[]) => { this.names = n })\n  }', loop('this.names')),
    ];
    for (const src of cases) {
      assert.deepEqual(indexKeyed(src), []);
    }
  });

  test('a getter source whose array only grows, and a loop foreach-key-stale reports', () => {
    const getter = '  get visible(): string[] {\n    return this.names.filter((n: string) => n.length > 2)\n  }';
    const push = page(getter, `      Button('a').onClick(() => { this.names.push('x') })\n${loop('this.visible')}`);
    assert.deepEqual(indexKeyed(push), []);
    const rebuilt = `      Button('t').onClick(() => { this.trips = this.trips.map((t: Trip) => ({ id: t.id, name: '-', tags: t.tags })) })
      ForEach(this.trips, (t: Trip) => { Text(t.name) }, (t: Trip, i: number) => \`\${i}\`)`;
    const kinds = found(page('', rebuilt)).map((c) => c.kind);
    assert.ok(kinds.includes('foreach-key-stale'));
    assert.ok(!kinds.includes('foreach-index-key'));
  });

  test('appends, clears and cuts from the end', () => {
    for (const write of [
      'this.names.push("x")',
      'this.names.pop()',
      'this.names = [...this.names, "x"]',
      'this.names = this.names.concat(["x"])',
      'this.names = []',
      'this.names = this.names.slice(0, 2)',
    ]) {
      assert.deepEqual(
        indexKeyed(page('', `      Button('a').onClick(() => { ${write} })\n${loop('this.names')}`)),
        [],
        write,
      );
    }
  });

  test('a key that holds the item, the default key, rows that render only the index', () => {
    const write = "      Button('r').onClick(() => { this.names = fetchNames() })";
    for (const key of ['(t: string) => t', '(t: string, i: number) => `${i}-${t}`']) {
      assert.deepEqual(indexKeyed(page('', `${write}\n${loop('this.names').replace(INDEX_KEY, key)}`)), [], key);
    }
    assert.deepEqual(indexKeyed(page('', `${write}\n      ForEach(this.names, (t: string) => { Text(t) })`)), []);
    const indexOnly = `      ForEach(this.names, (t: string, i: number) => { Text(\`\${i}\`) }, ${INDEX_KEY})`;
    assert.deepEqual(indexKeyed(page('', `${write}\n${indexOnly}`)), []);
  });

  test('a detail view in the other arm of the if that holds the list', () => {
    const body = `      if (this.sel < 0) {
${loop('this.trips[0].tags')}
      } else {
        Button('back').onClick(() => { this.sel = -1 })
      }`;
    const other = body.replace('this.trips[0].tags', 'this.trips[this.sel + 1].tags');
    assert.deepEqual(indexKeyed(page('', other)), []);
    const same = other
      .replace("      } else {\n        Button('back')", "        Button('back')")
      .replace('-1 })\n      }', '-1 })\n      } else {\n      }');
    assert.equal(indexKeyed(page('', same)).length, 1);
  });

  test('a nested ForEach over the outer item when the outer source is static', () => {
    const body = `      ForEach(this.trips, (trip: Trip) => {
        ForEach(trip.tags, (t: string) => { Text(t) }, ${INDEX_KEY})
      }, (trip: Trip) => \`\${trip.id}\`)`;
    assert.deepEqual(indexKeyed(page('', body)), []);
  });

  test('a disable comment above the ForEach call', () => {
    const src = page('', `${tabs}\n      // arkui-sem-disable-next-line R1\n${loop('this.trips[this.sel].tags')}`);
    assert.deepEqual(indexKeyed(src), []);
  });
});

async function findingsOf(src: string): Promise<Finding[]> {
  const path = put(join(tempDir(), 'Trips.ets'), src);
  const none = { judge: async () => assert.fail('no judge call') };
  const { findings } = await checkFiles([path], { backend: none });
  return findings.filter((f) => f.kind === 'foreach-index-key');
}

describe('foreach-index-key findings', () => {
  test('a finding decided by the facts, with the writes as evidence and related lines', async () => {
    const src = page('', `${tabs}\n${loop('this.trips[this.sel].tags')}`);
    const [f] = await findingsOf(src);
    assert.equal(f.band, 'finding');
    assert.equal(f.p, null);
    assert.match(f.evidence, /^ForEach keys its rows by position \(\(t: string, i: number\) => `\$\{i\}`, line \d+\)/);
    assert.match(f.evidence, /this\.sel = … in build\(\) line \d+/);
    assert.equal(f.related?.length, 1);
    assert.match(f.fix, /^key the rows by the item instead of its position, e\.g\. \(t\) => t\.id/);
  });

  test('moves of the list in a method only make a question', async () => {
    const src = page('  refresh() {\n    this.names = fetchNames()\n  }', loop('this.names'));
    const [f] = await findingsOf(src);
    assert.equal(f.band, 'question');
    assert.match(f.evidence, /this\.names = … in refresh\(\) line \d+/);
  });
});
