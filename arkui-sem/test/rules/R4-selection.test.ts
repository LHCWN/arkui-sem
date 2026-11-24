// R4 selection-never-written: rows compare a field with their item or index, and nothing sets it.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFiles, FACTS } from '../../src/engine.js';
import type { SystemOneBackend } from '../../src/judge.js';
import { extract, found, put, tempDir } from '../helpers.js';

/** R4 kinds are decided by the facts. */
const noJudge = {
  name: 'none',
  systemOne: async () => {
    throw new Error('the judge was called');
  },
} as unknown as SystemOneBackend;

/** A category grid whose cells highlight the selected one; `cell` adds attributes to each cell. */
function grid({
  field = '@State selected: number = 0',
  compare = 'this.selected === index',
  cell = '',
  extra = '',
  above = '',
} = {}): string {
  return `interface Category { id: number; name: string }
@Entry
@Component
struct Market {
  ${field}
  @State categories: Category[] = [{ id: 1, name: 'Fruit' }, { id: 2, name: 'Dairy' }]
  ${extra}
  build() {
    Column() {
      ${above}
      Grid() {
        ForEach(this.categories, (item: Category, index: number) => {
          GridItem() {
            Text(item.name)
              .backgroundColor(${compare} ? '#f00' : '#fff')
          }
          ${cell}
        }, (item: Category) => item.id.toString())
      }
    }
  }
}`;
}

const kinds = (src: string) => found(src).map((c) => `${c.kind} ${c.line}`);
const FIRES = ['selection-never-written 5'];

test('selection-never-written: grid cells highlight a selection nothing sets', () => {
  assert.deepEqual(kinds(grid()), FIRES);
  assert.deepEqual(kinds(grid({ compare: 'index === this.selected' })), FIRES);
  assert.deepEqual(kinds(grid({ compare: 'this.selected !== index' })), FIRES);
  assert.deepEqual(kinds(grid({ compare: 'item.id == this.selected' })), FIRES);
});

test('selection-never-written: a write anywhere keeps it quiet', () => {
  assert.deepEqual(kinds(grid({ cell: '.onClick(() => { this.selected = index })' })), []);
  assert.deepEqual(kinds(grid({ extra: 'aboutToAppear() { this.selected = 1 }' })), []);
  assert.deepEqual(kinds(grid({ extra: 'pick(i: number) { this.selected = i }' })), []);
});

test('selection-never-written: a two-way binding or a child that may write it keeps it quiet', () => {
  assert.deepEqual(kinds(grid({ above: 'Tabs({ index: $$this.selected }) {}' })), []);
  assert.deepEqual(kinds(grid({ above: 'Swiper() {}.index($$this.selected)' })), []);
  assert.deepEqual(kinds(grid({ above: 'Picker({ value: this.selected!! })' })), []);
  const child = (decorator: string, arg: string) =>
    `${grid({ above: `Tabbar({ current: ${arg} })` })}
@Component
struct Tabbar {
  ${decorator} current: number
  build() { Text('') }
}`;
  assert.deepEqual(kinds(child('@Link', '$selected')), []);
  assert.deepEqual(kinds(child('@Link', 'this.selected')), []);
  // A @Prop child only reads it: the positive control.
  assert.deepEqual(kinds(child('@Prop', 'this.selected')), FIRES);
  // A child that can't be found may hold a @Link.
  const imported = `import { Tabbar } from './Tabbar'
${grid({ above: 'Tabbar({ current: this.selected })' })}`;
  assert.deepEqual(kinds(imported), []);
});

test('selection-never-written: only owned V1 state without @Watch, compared in the row, not disabled', () => {
  assert.deepEqual(kinds(grid({ field: '@Prop selected: number = 0' })), []);
  assert.deepEqual(kinds(grid({ field: '@Link selected: number' })), []);
  assert.deepEqual(kinds(grid({ field: "@StorageLink('sel') selected: number = 0" })), []);
  assert.deepEqual(kinds(grid({ field: "@State @Watch('changed') selected: number = 0", extra: 'changed() {}' })), []);
  assert.deepEqual(
    kinds(grid({ field: '// arkui-sem-disable-next-line R4 -- fixed highlight\n  @State selected: number = 0' })),
    [],
  );
  // Static data the rows don't compare against.
  assert.deepEqual(kinds(grid({ compare: 'item.id === 1' })), []);
  // A comparison in a handler draws nothing.
  assert.deepEqual(
    kinds(grid({ compare: 'false', cell: '.onClick(() => { if (this.selected === index) { return } })' })),
    [],
  );
});

test('comparisons: the row fact keeps the field, side and text; shadowed parameters and other values do not count', () => {
  const src = grid({
    compare: 'this.selected === index && item.id !== this.selected',
    cell: `.onAppear(() => {})
          ForEach(this.categories, (index: Category) => {
            Text(this.selected === index.id ? 'x' : '')
          })`,
  });
  const [market] = extract(src).components;
  assert.deepEqual(
    market.loops[0].comparisons.map(({ field, with: side, operand, line }) => [field, side, operand, line]),
    [
      ['selected', 'index', 'index', 15],
      ['selected', 'item', 'item.id', 15],
    ],
  );
  // In the inner loop, `index` names the item: `index.id` is a path below it.
  assert.deepEqual(
    market.loops[1].comparisons.map((cmp) => [cmp.with, cmp.text]),
    [['item', 'this.selected === index.id']],
  );
});

test('boundTwoWay: $$this.f and this.f!! are recorded, plain reads are not', () => {
  const src = grid({
    above:
      'Tabs({ index: $$this.selected }) {}\n      Picker({ value: this.selected!! })\n      Text(String(this.selected))',
  });
  const selected = extract(src).components[0].fields.find((f) => f.name === 'selected');
  assert.deepEqual(selected?.boundTwoWay, [10, 11]);
  assert.deepEqual(selected?.writes, []);
});

test('selection-never-written: a question from the facts, with the comparison and a fix', async () => {
  const file = put(join(tempDir(), 'Market.ets'), grid());
  const { findings, errors } = await checkFiles([file], { backend: noJudge });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.band, f.backend, f.p, f.subject, f.line]),
    [['selection-never-written', 'question', FACTS, null, 'Market.selected', 5]],
  );
  const [finding] = findings;
  assert.match(
    finding.evidence,
    /rows compare `this\.selected === index` \((line 15)\), but nothing ever sets this\.selected/,
  );
  assert.match(finding.fix, /\.onClick\(\(\) => \{ this\.selected = index \}\)/);
  assert.deepEqual(finding.related, [{ file: finding.file, line: 15 }]);
  assert.match(finding.fingerprint, /Market\.ets#Market\.selected#R4-selection-never-written$/);
});
