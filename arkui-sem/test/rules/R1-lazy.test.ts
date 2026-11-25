// R1 lazyforeach-source-rebuilt: a LazyForEach whose data source is created while drawing or reassigned.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkFiles, type Finding } from '../../src/engine.js';
import type { CandidateOf } from '../../src/rules/candidate.js';
import { found, put, tempDir } from '../helpers.js';

const MODEL = `interface Product { id: string; name: string; category: string }
class ProductSource implements IDataSource {
  private listeners: DataChangeListener[] = []
  constructor(private items: Product[]) {}
  totalCount(): number { return this.items.length }
  getData(index: number): Product { return this.items[index] }
  registerDataChangeListener(l: DataChangeListener): void { this.listeners.push(l) }
  unregisterDataChangeListener(l: DataChangeListener): void {}
}`;

/** A V1 product grid with `members` and a build() body. */
const page = (members: string, body: string) => `${MODEL}
@Entry
@Component
struct Shop {
  @State products: Product[] = []
  @State category: string = 'all'
${members}
  build() {
    Grid() {
${body}
    }
  }
}`;

/** A LazyForEach over `source` keyed by the product id. */
const lazy = (source: string) =>
  `      LazyForEach(${source}, (p: Product) => { GridItem() { Text(p.name) } }, (p: Product) => p.id)`;

const filtered = 'new ProductSource(this.products.filter((p: Product) => p.category === this.category))';
const pickCategory = "      Button('phones').onClick(() => { this.category = 'phones' })";
const plainSource = '  source: ProductSource = new ProductSource([])';
const reassignSource = "      Button('reload').onClick(() => { this.source = new ProductSource(loadProducts()) })";

const rebuilt = (src: string) =>
  found(src).filter((c): c is CandidateOf<'lazyforeach-source-rebuilt'> => c.kind === 'lazyforeach-source-rebuilt');

describe('lazyforeach-source-rebuilt fires', () => {
  test('a filtered product grid: build() creates the source from a filter a handler changes', () => {
    const src = page('', `${pickCategory}\n${lazy(filtered)}`);
    const [c, ...rest] = rebuilt(src);
    assert.equal(rest.length, 0);
    assert.equal(c.line, src.split('\n').findIndex((l) => l.includes('LazyForEach(')) + 1);
    assert.equal(c.loop.source.shape, 'new');
    assert.deepEqual(c.reassigns, []);
    assert.deepEqual(
      c.changes.map((change) => [change.field.name, change.write.method]),
      [['category', 'build']],
    );
    assert.equal(c.fingerprint, `T.ets#Shop.products#R1-lazy-source@${filtered}`);
  });

  test('a source created while drawing with no state read, directly or through a getter', () => {
    const getter = '  get catalog(): ProductSource {\n    return new ProductSource(loadProducts())\n  }';
    for (const src of [page('', lazy('new ProductSource(loadProducts())')), page(getter, lazy('this.catalog'))]) {
      const [c] = rebuilt(src);
      assert.deepEqual(c.changes, []);
    }
  });

  test('a source field reassigned from a handler, plain or @State', () => {
    const plain = rebuilt(page(plainSource, `${reassignSource}\n${lazy('this.source')}`));
    assert.deepEqual(
      plain.map((c) => [c.reassigns.map((w) => w.method), c.changes.length]),
      [[['build'], 0]],
    );
    const state = rebuilt(page(`  @State${plainSource}`, `${reassignSource}\n${lazy('this.source')}`));
    assert.deepEqual(
      state.map((c) => [c.holder?.name, c.reassigns.length, c.changes.length]),
      [['source', 1, 0]],
    );
  });

  test('a getter that returns the source field as is counts as that field', () => {
    const getter = '  get shown(): ProductSource {\n    return this.source\n  }';
    assert.deepEqual(rebuilt(page(`${plainSource}\n${getter}`, lazy('this.shown'))), []);
    const [c] = rebuilt(page(`${plainSource}\n${getter}`, `${reassignSource}\n${lazy('this.shown')}`));
    assert.equal(c.holder?.name, 'source');
    // Also after other statements, which may read other fields first; the fingerprint names the field it returns.
    const logged = '  get shown(): ProductSource {\n    console.info(this.category)\n    return this.source\n  }';
    const [d, ...rest] = rebuilt(page(`${plainSource}\n${logged}`, `${reassignSource}\n${lazy('this.shown')}`));
    assert.equal(rest.length, 0);
    assert.equal(d.holder?.name, 'source');
    assert.equal(d.fingerprint, 'T.ets#Shop.source#R1-lazy-source@this.shown');
  });

  test('a reassigned source field is not also undecorated-mutated-rendered: @State would not help', () => {
    const kinds = found(page(plainSource, `${reassignSource}\n${lazy('this.source')}`)).map((c) => c.kind);
    assert.deepEqual(kinds, ['lazyforeach-source-rebuilt']);
    const getter = '  get shown(): ProductSource {\n    return this.source\n  }';
    const viaGetter = found(page(`${plainSource}\n${getter}`, `${reassignSource}\n${lazy('this.shown')}`));
    assert.deepEqual(
      viaGetter.map((c) => c.kind),
      ['lazyforeach-source-rebuilt'],
    );
    // Nor when the call spans lines.
    const multiline = lazy('\n        this.source').replace(', (p: Product)', ',\n        (p: Product)');
    const split = found(page(plainSource, `${reassignSource}\n${multiline}`)).map((c) => c.kind);
    assert.deepEqual(split, ['lazyforeach-source-rebuilt']);
    // Or the source sits in parentheses that open a line before it.
    const wrapped = lazy('(\n        this.source\n      )');
    const parens = found(page(plainSource, `${reassignSource}\n${wrapped}`)).map((c) => c.kind);
    assert.deepEqual(parens, ['lazyforeach-source-rebuilt']);
  });

  test('a reassigned source field build() also draws stays undecorated-mutated-rendered', () => {
    const count = '      Text(this.source.totalCount().toString())';
    const kinds = found(page(plainSource, `${reassignSource}\n${count}\n${lazy('this.source')}`)).map((c) => c.kind);
    assert.deepEqual(kinds.sort(), ['lazyforeach-source-rebuilt', 'undecorated-mutated-rendered']);
  });

  test('two loops over the same source get distinct fingerprints', () => {
    const [a, b] = rebuilt(page('', `${lazy(filtered)}\n${lazy(filtered)}`));
    assert.equal(b.fingerprint, `${a.fingerprint}~2`);
  });
});

describe('lazyforeach-source-rebuilt does not fire', () => {
  const load = (how: string) => page(`${plainSource}\n${how}`, lazy('this.source'));
  const assign = 'this.source = new ProductSource(loadProducts())';

  test('a source field assigned once: its initializer, or the first load before the first render', () => {
    const cases = [
      page(plainSource, lazy('this.source')),
      load(`  aboutToAppear() {\n    ${assign}\n  }`),
      load(`  aboutToAppear() {\n    this.reload()\n  }\n  reload() {\n    ${assign}\n  }`),
    ];
    for (const src of cases) {
      assert.deepEqual(rebuilt(src), []);
    }
    // Controls: the same source reassigned later fires, also by a first load after an await or in a continuation,
    // which lands after the first build.
    assert.equal(rebuilt(page(plainSource, `${reassignSource}\n${lazy('this.source')}`)).length, 1);
    const later = [
      load(`  async aboutToAppear() {\n    await ready()\n    ${assign}\n  }`),
      load(
        '  aboutToAppear() {\n    fetchProducts().then((items: Product[]) => { this.source = new ProductSource(items) })\n  }',
      ),
    ];
    for (const src of later) {
      assert.deepEqual(
        rebuilt(src).map((c) => c.reassigns.map((w) => w.method)),
        [['aboutToAppear']],
      );
    }
  });

  test('a first load after an await under an if: the arm may open only once the load is done', () => {
    const members = `  @State loading: boolean = true\n${plainSource}
  async aboutToAppear() {\n    await ready()\n    this.source = new ProductSource(loadProducts())\n    this.loading = false\n  }`;
    const body = `      if (this.loading) {\n        Text('…')\n      } else {\n${lazy('this.source')}\n      }`;
    assert.deepEqual(found(page(members, body)), []);
    const sharedReload = load(
      `  aboutToAppear() {\n    this.reload()\n  }\n  reload() {\n    ${assign}\n  }\n  onRefresh() {\n    this.reload()\n  }`,
    );
    assert.equal(rebuilt(sharedReload).length, 1);
  });

  test('a filter written only in the other arm of the if that holds the loop makes no finding', () => {
    const arms = (then: string, otherwise: string) =>
      `      if (this.products.length > 0) {\n${then}${lazy(filtered)}\n      } else {\n${otherwise}\n      }`;
    const [quiet] = rebuilt(page('', arms('', pickCategory)));
    assert.deepEqual(quiet.changes, []);
    const [control] = rebuilt(page('', arms(`${pickCategory}\n`, '')));
    assert.equal(control.changes.length, 1);
  });

  test("a source field reassigned to its initializer's call again: a singleton, the same object", () => {
    const singleton = '  source: ProductSource = ProductSource.shared()';
    const again = (value: string) =>
      page(singleton, `      Button('sync').onClick(() => { this.source = ${value} })\n${lazy('this.source')}`);
    assert.deepEqual(found(again('ProductSource.shared()')), []);
    // Formatted otherwise, also over lines.
    assert.deepEqual(found(again('ProductSource.shared( )')), []);
    assert.deepEqual(found(again('ProductSource\n        .shared()')), []);
    // Controls: another call, or a new object.
    assert.equal(rebuilt(again('ProductSource.filtered(this.category)')).length, 1);
    assert.equal(rebuilt(again('new ProductSource([])')).length, 1);
  });

  test('a ForEach over a new source, and a LazyForEach over a model field', () => {
    assert.deepEqual(rebuilt(page('', lazy(filtered).replace('LazyForEach', 'ForEach'))), []);
    const model = '  model: Catalog = new Catalog()';
    assert.deepEqual(rebuilt(page(model, lazy('this.model.source'))), []);
  });

  test('a disable comment above the LazyForEach call', () => {
    const body = (comment: string) => `${pickCategory}\n${comment}${lazy(filtered)}`;
    assert.deepEqual(rebuilt(page('', body('      // arkui-sem-disable-next-line R1\n'))), []);
    assert.equal(rebuilt(page('', body(''))).length, 1);
    // It silences a reassigned plain source too, which @State would not help.
    const reassigned = `${reassignSource}\n      // arkui-sem-disable-next-line R1\n${lazy('this.source')}`;
    assert.deepEqual(found(page(plainSource, reassigned)), []);
  });
});

async function findingsOf(src: string): Promise<Finding[]> {
  const path = put(join(tempDir(), 'Shop.ets'), src);
  const none = { name: 'none', systemOne: async () => assert.fail('no judge call') };
  const { findings } = await checkFiles([path], { backend: none });
  return findings.filter((f) => f.kind === 'lazyforeach-source-rebuilt');
}

describe('lazyforeach-source-rebuilt findings', () => {
  test('a source that reads state written after the first load is a finding decided by the facts', async () => {
    const [f] = await findingsOf(page('', `${pickCategory}\n${lazy(filtered)}`));
    assert.equal(f.band, 'finding');
    assert.equal(f.p, null);
    assert.match(f.evidence, /^LazyForEach's data source is created while drawing \(new ProductSource\(/);
    assert.match(f.evidence, /again on each change of this\.category = … in build\(\) line \d+[;,]/);
    assert.match(f.evidence, /OpenHarmony LazyForEach docs, 使用限制\)$/);
    assert.equal(f.related?.length, 1);
    assert.match(f.fix, /^create the data source once \(a field\)/);
  });

  test('a reassigned plain source field is a question', async () => {
    const [f] = await findingsOf(page(plainSource, `${reassignSource}\n${lazy('this.source')}`));
    assert.equal(f.band, 'question');
    assert.match(
      f.evidence,
      /^LazyForEach's data source this\.source \(line \d+\) is reassigned after the first render \(this\.source = … in build\(\) line \d+\);/,
    );
  });

  test('a reassigned @State source field is a finding', async () => {
    const [f] = await findingsOf(page(`  @State${plainSource}`, `${reassignSource}\n${lazy('this.source')}`));
    assert.equal(f.band, 'finding');
    assert.doesNotMatch(f.evidence, /again on each change/);
  });
});
