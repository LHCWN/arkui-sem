// R4 wiring: text inputs whose field no input shows (input-unbound) or nothing reads (input-never-read).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFiles, FACTS, formatForAgent } from '../../src/engine.js';
import type { SystemOneBackend } from '../../src/judge.js';
import { found, put, tempDir } from '../helpers.js';

/** R4 kinds are decided by the facts. */
const noJudge = {
  name: 'none',
  systemOne: async () => {
    throw new Error('the judge was called');
  },
} as unknown as SystemOneBackend;

/** An edit dialog: the edit button prefills the field the unbound input types into. */
function editDialog({
  field = '@State name: string = ""',
  options = "{ placeholder: 'Name' }",
  prefill = 'this.name = item.name',
  extra = '',
  input = 'TextInput',
  decorator = '@Component',
} = {}): string {
  return `interface Item { id: number; name: string }
${decorator}
struct Editor {
  ${field}
  @State items: Item[] = []
  @State editing: boolean = false
  edit(item: Item) {
    ${prefill}
    this.editing = true
  }
  save() {
    this.items = this.items.map((i) => ({ id: i.id, name: this.name }))
  }
  ${extra}
  build() {
    Column() {
      if (this.editing) {
        ${input}(${options})
          .onChange((value: string) => {
            this.name = value
          })
        Button('Save').onClick(() => this.save())
      }
    }
  }
}`;
}

/** A search box whose query the given code reads, or nothing. */
function searchBox({ field = "@State query: string = ''", extra = '', build = '' } = {}): string {
  return `@Component
struct Market {
  ${field}
  @State products: string[] = []
  ${extra}
  build() {
    Column() {
      TextInput({ placeholder: 'Search' })
        .onChange((value: string) => { this.query = value })
      Button('Clear').onClick(() => { this.query = '' })
      ForEach(this.products, (p: string) => { Text(p) }, (p: string) => p)
      ${build}
    }
  }
}`;
}

const kinds = (src: string) =>
  found(src)
    .filter((c) => c.rule === 'R4')
    .map((c) => `${c.kind} ${c.line}`);

test('input-unbound: an edit action prefills a field the input types into but does not show', () => {
  assert.deepEqual(kinds(editDialog()), ['input-unbound 18']);
  assert.deepEqual(kinds(editDialog({ input: 'TextArea' })), ['input-unbound 18']);
  assert.deepEqual(kinds(editDialog({ input: 'Search', options: "{ placeholder: 'Name' }" })), ['input-unbound 18']);
  // A shorthand option names another option; a shorthand `text` binds a local.
  assert.deepEqual(kinds(editDialog({ options: '{ placeholder }' })), ['input-unbound 18']);
  assert.deepEqual(kinds(editDialog({ options: '{ text }' })), []);
  assert.deepEqual(kinds(editDialog({ options: '{ ...defaults }' })), []);
  // A prefill before the first render still leaves the input empty.
  assert.deepEqual(
    kinds(
      editDialog({ prefill: '', extra: '@Prop initial: string = ""\n  aboutToAppear() { this.name = this.initial }' }),
    ),
    ['input-unbound 19'],
  );
});

test('input-unbound: an input shown the field, a reset, or a rendered field is not asked about', () => {
  assert.deepEqual(kinds(editDialog({ options: "{ text: this.name, placeholder: 'Name' }" })), []);
  assert.deepEqual(kinds(editDialog({ options: '{ text: $$this.name }' })), []);
  assert.deepEqual(kinds(editDialog({ options: 'this.nameOptions()', extra: 'nameOptions() { return {} }' })), []);
  assert.deepEqual(kinds(editDialog({ prefill: "this.name = ''" })), []);
  assert.deepEqual(kinds(editDialog({ prefill: 'this.name = this.name.trim()' })), []);
  // Shown as a heading, the value is on screen.
  assert.deepEqual(kinds(editDialog({ extra: '@Builder title() { Text(this.name) }' })), []);
});

test('input-unbound: another input that shows the field leaves it alone (an add form beside an edit form)', () => {
  const src = editDialog().replace(
    "Button('Save')",
    `TextInput({ text: this.name }).onChange((value: string) => { this.name = value })
        Button('Save')`,
  );
  assert.deepEqual(kinds(src), []);
});

test('input-unbound: a value derived from the text is not the text, so the input is not meant to show it', () => {
  // `valid` is set from the typed text and from code, and never drawn: binding the input to it would be wrong advice.
  const src = editDialog({
    extra: '@State valid: boolean = false',
    prefill: 'this.name = item.name\n    this.valid = item.name.length > 0',
  }).replace('this.name = value', 'this.name = value.trim()\n            this.valid = value.length > 0');
  assert.deepEqual(
    found(src)
      .filter((c) => c.rule === 'R4')
      .map((c) => `${c.kind} ${'field' in c ? c.field.name : ''}`),
    ['input-unbound name'],
  );
});

test('input-unbound: a setter handed a value derived from the text is not joined as storing the text', () => {
  const src = editDialog({
    extra: '@State valid: boolean = false\n  setValid(v: boolean) { this.valid = v }',
    prefill: 'this.name = item.name\n    this.valid = item.name.length > 0',
  }).replace('this.name = value', 'this.name = value\n            this.setValid(value.length > 0)');
  assert.deepEqual(
    found(src)
      .filter((c) => c.rule === 'R4')
      .map((c) => `${c.kind} ${'field' in c ? c.field.name : ''}`),
    ['input-unbound name'],
  );
});

test('R4 asks only about owned V1 state without @Watch, and honours disable comments', () => {
  assert.deepEqual(kinds(editDialog({ field: '@Link name: string' })), []);
  assert.deepEqual(kinds(editDialog({ field: "@State @Watch('onName') name: string = ''", extra: 'onName() {}' })), []);
  assert.deepEqual(kinds(editDialog({ field: 'name: string = ""' })), []);
  assert.deepEqual(kinds(editDialog({ decorator: '@ComponentV2', field: '@Local name: string = ""' })), []);
  assert.deepEqual(
    kinds(editDialog({ field: '// arkui-sem-disable-next-line R4 -- draft\n  @State name: string = ""' })),
    [],
  );
  const aboveInput = editDialog().replace(
    '        TextInput(',
    '        // arkui-sem-disable-next-line R4 -- typed only\n        TextInput(',
  );
  assert.deepEqual(kinds(aboveInput), []);
});

test('input-never-read: a search box whose query nothing reads', () => {
  assert.deepEqual(kinds(searchBox()), ['input-never-read 3']);
  assert.deepEqual(kinds(searchBox({ extra: 'aboutToAppear() { this.query = "" }' })), ['input-never-read 3']);
  // An expression body in parentheses stores the text and does nothing else.
  const parenthesized = searchBox().replace(
    '(value: string) => { this.query = value }',
    '(value: string) => (this.query = value)',
  );
  assert.deepEqual(kinds(parenthesized), ['input-never-read 3']);
});

test('input-never-read: a handler method two inputs share keeps the note that other code only resets it', async () => {
  const dir = tempDir();
  const file = join(dir, 'Market.ets');
  const shared = searchBox({
    extra: 'setQuery(value: string) { this.query = value }',
    build: 'Search().onChange(this.setQuery)',
  }).replace('(value: string) => { this.query = value }', 'this.setQuery');
  put(file, shared);
  const { findings } = await checkFiles([file], { backend: noJudge });
  const [neverRead] = findings.filter((f) => f.kind === 'input-never-read');
  assert.match(neverRead?.evidence ?? '', /TextInput and Search at lines \d+ and \d+ .*other code only resets it/);
});

test('input-never-read: a read anywhere, a two-way pass or this handed on keeps it quiet', () => {
  assert.deepEqual(kinds(searchBox({ extra: 'search() { console.info(this.query) }' })), []);
  assert.deepEqual(kinds(searchBox({ extra: 'get trimmed(): string { return this.query.trim() }' })), []);
  assert.deepEqual(kinds(searchBox({ build: 'Text(this.query)' })), []);
  assert.deepEqual(kinds(searchBox({ extra: 'shown: string = this.query' })), []);
  assert.deepEqual(kinds(searchBox({ extra: 'save() { store(this) }' })), []);
  assert.deepEqual(kinds(searchBox({ extra: 'save() { const { query } = this }' })), []);
  const child = `${searchBox({ build: 'Filter({ query: $query })' })}
@Component
struct Filter {
  @Link query: string
  build() { Text(this.query) }
}`;
  assert.deepEqual(kinds(child), []);
  // Another value set by code: typing isn't the only writer, and the input never shows that value.
  assert.deepEqual(kinds(searchBox({ extra: 'load(q: string) { this.query = q }' })), ['input-unbound 8']);
});

test('input-never-read: only fields that store the typed text, and only when typing does nothing else', () => {
  // A clear on empty text stores nothing typed; the search runs elsewhere.
  const clearOnEmpty = searchBox().replace(
    '.onChange((value: string) => { this.query = value })',
    ".onChange((value: string) => { if (value == '') { this.query = '' } })",
  );
  assert.deepEqual(kinds(clearOnEmpty), []);
  // The text also feeds another field that is shown: typing has an effect, the unread copy is a harmless dead store.
  const feedsOther = searchBox({ extra: '@State length: number = 0', build: 'Text(this.length.toString())' }).replace(
    'this.query = value })',
    'this.query = value; this.length = value.length })',
  );
  assert.deepEqual(kinds(feedsOther), []);
  const logs = searchBox().replace('this.query = value })', 'this.query = value; console.info(value) })');
  assert.deepEqual(kinds(logs), ['input-never-read 3']);
  // A setter only the input calls, in a closure or passed: the same input.
  const setter = (handler: string) =>
    kinds(
      searchBox({ extra: 'setQuery(value: string) { this.query = value }' }).replace(
        '.onChange((value: string) => { this.query = value })',
        `.onChange(${handler})`,
      ),
    );
  assert.deepEqual(setter('(value: string) => this.setQuery(value)'), ['input-never-read 3']);
  assert.deepEqual(setter('(value: string) => { this.setQuery(value) }'), ['input-never-read 3']);
  assert.deepEqual(setter('this.setQuery'), ['input-never-read 3']);
});

test('input-never-read: a setter that hands the text on, or a write to a @Link or @Watch field, is an effect', () => {
  const onChange = (handler: string, extra: string) =>
    kinds(searchBox({ extra }).replace('(value: string) => { this.query = value }', handler));
  // applyQuery stores the query and refreshes the shown list from the text.
  const applies =
    'applyQuery(v: string) { this.query = v; this.refreshResults(v) }\n  refreshResults(v: string) { this.products = this.products.filter((p) => p.includes(v)) }';
  assert.deepEqual(onChange('(v: string) => this.applyQuery(v)', applies), []);
  // The parent gets the text, or a @Watch callback runs.
  const both = '(value: string) => { this.query = value; this.liveQuery = value }';
  assert.deepEqual(onChange(both, '@Link liveQuery: string'), []);
  assert.deepEqual(onChange(both, "@State @Watch('onLive') liveQuery: string = ''\n  onLive() {}"), []);
});

test('input-never-read: a Swiper or Tabs onChange is not an input', () => {
  const src = `@Component
struct Banner {
  @State current: number = 0
  build() {
    Swiper() { Text('a') }.onChange((index: number) => { this.current = index })
  }
}`;
  assert.deepEqual(kinds(src), []);
});

test('the engine reports input-unbound as a finding and input-never-read as a question, from the facts', async () => {
  const dir = tempDir();
  const file = join(dir, 'Editor.ets');
  put(file, editDialog());
  const market = join(dir, 'Market.ets');
  put(market, searchBox());
  const { findings, errors } = await checkFiles([file, market], { backend: noJudge });
  assert.deepEqual(errors, []);
  const r4 = findings.filter((f) => f.rule === 'R4');
  assert.deepEqual(
    r4.map((f) => [f.kind, f.band, f.backend, f.p, f.subject]),
    [
      ['input-unbound', 'finding', FACTS, null, 'Editor.name'],
      ['input-never-read', 'question', FACTS, null, 'Market.query'],
    ],
  );
  const [unbound, neverRead] = r4;
  assert.match(unbound.evidence, /TextInput at line 18 writes this\.name on change but has no text option/);
  assert.match(unbound.evidence, /edit\(\) also sets this\.name \(line 8\)/);
  assert.deepEqual(unbound.related, [{ file: unbound.file, line: 8 }]);
  assert.match(unbound.fix, /TextInput\(\{ text: this\.name, … \}\)/);
  assert.match(unbound.fix, /\$\$this\.name \}\) in place of the onChange/);
  assert.match(neverRead.evidence, /TextInput at line 8 writes this\.query on every change, other code only resets it/);
  const text = formatForAgent(r4, dir);
  assert.match(
    text,
    /\[R4 input-unbound\] Editor\.ets:18 Editor\.name \(facts\)\n {2}why: .*\n {2}at: Editor\.ets:8\n/,
  );
  assert.match(text, /\[R4\?\] Market\.ets:3 Market\.query \(facts\)/);
  assert.match(text, /disable-next-line R4 -- <reason>` above the field's decorators, or above the input/);
});

test('input-unbound: the $$ fix is offered only when the onChange does nothing but store the text', async () => {
  const dir = tempDir();
  const file = join(dir, 'Editor.ets');
  // The onChange also marks the draft dirty: `$$` alone would drop that.
  put(
    file,
    editDialog({ extra: '@State dirty: boolean = false' }).replace(
      'this.name = value',
      'this.name = value\n            this.dirty = true',
    ),
  );
  const { findings } = await checkFiles([file], { backend: noJudge });
  const [unbound] = findings.filter((f) => f.kind === 'input-unbound');
  assert.match(unbound.fix, /keep the onChange\.$/);
  assert.doesNotMatch(unbound.fix, /\$\$/);
  // The onChange trims the text, here or through a handler method: `$$` would store it untrimmed.
  for (const store of ['this.name = value.trim()', 'this.setName(value.trim())']) {
    put(
      file,
      editDialog({ extra: 'setName(v: string) {\n    this.name = v\n  }' }).replace('this.name = value', store),
    );
    const [trimmed] = (await checkFiles([file], { backend: noJudge })).findings.filter(
      (f) => f.kind === 'input-unbound',
    );
    assert.match(trimmed.fix, /keep the onChange\.$/, store);
  }
});
