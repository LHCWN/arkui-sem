// Input facts (src/ets/inputs.ts) and the facts R4 reads beside them: reads in any method, constant writes, `this`
// used as a value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComponentFact } from '../src/facts.js';
import { extract } from './helpers.js';

/** The one component of a V1 struct with the given members and build() body. */
function component(members: string, build: string): ComponentFact {
  const [c] = extract(`@Component
struct C {
${members}
  build() {
    Column() {
${build}
    }
  }
}`).components;
  assert.ok(c);
  return c;
}

const FIELDS = `  @State name: string = ''
  @State other: string = ''`;

test('the text option: absent, a field (one- or two-way), anything else', () => {
  const c = component(
    FIELDS,
    `      TextInput({ placeholder: 'Name' })
      TextInput({ text: this.name })
      TextArea({ text: $$this.name })
      Search({ value: this.name!! })
      Search({ placeholder: this.name })
      TextInput({ text: this.name.trim() })
      TextInput(this.options())
      TextInput()`,
  );
  assert.deepEqual(
    c.inputs.map((i) => [i.kind, i.binding]),
    [
      ['TextInput', { kind: 'none' }],
      ['TextInput', { kind: 'field', field: 'name', twoWay: false }],
      ['TextArea', { kind: 'field', field: 'name', twoWay: true }],
      ['Search', { kind: 'field', field: 'name', twoWay: true }],
      ['Search', { kind: 'none' }],
      ['TextInput', { kind: 'other' }],
      ['TextInput', { kind: 'other' }],
      ['TextInput', { kind: 'none' }],
    ],
  );
});

test('onChange writes: the typed text stored whole, in the closure and in a method only inputs use', () => {
  const c = component(
    `${FIELDS}
  @State form: Record<string, string> = {}
  setName(value: string) { this.name = value }
  setOther(value: string) { this.other = value }
  prefill() { this.setOther('x') }`,
    `      TextInput().onChange((value: string) => {
        this.name = value
        this.form.name = value
      })
      TextInput().width(10).onChange(this.setName)
      TextInput().onChange((value: string) => this.setOther(value))
      TextInput().onChange((value: string) => { if (value === '') { this.name = '' } else { this.other = value.trim() } })
      Text(this.name).onClick(() => { this.other = 'y' })`,
  );
  const writes = c.inputs.map((i) => i.writes.map((w) => `${w.field}:${w.line}`));
  // setOther is also called by prefill(), so its write is not the input's alone; `this.name = ''` stores no text.
  assert.deepEqual(writes, [['name:12'], ['name:6'], [], ['other:17']]);
  // A path write, a call of a shared method and a branch are more than storing the text.
  assert.deepEqual(
    c.inputs.map((i) => i.effects),
    [true, false, true, true],
  );
});

test('onChange effects: only typed writes and console calls do nothing else', () => {
  const effects = (handler: string) => component(FIELDS, `      TextInput().onChange(${handler})`).inputs[0].effects;
  assert.equal(effects('(value: string) => { this.name = value }'), false);
  assert.equal(effects('(value: string) => this.name = value'), false);
  assert.equal(effects('(value: string) => { this.name = value; console.info(value) }'), false);
  assert.equal(effects('(value: string) => { this.name = value; this.other = value }'), false);
  assert.equal(effects('(value: string) => { this.name = value; this.other = "" }'), true);
  assert.equal(effects('handleChange'), true);
});

test('inputs in handlers are not drawn; disable comments above an input are kept', () => {
  const c = component(
    FIELDS,
    `      Button('x').onClick(() => { TextInput() })
      // arkui-sem-disable-next-line R4 -- a scratch field
      TextInput().onChange((value: string) => { this.name = value })`,
  );
  assert.deepEqual(
    c.inputs.map((i) => i.disabledRules),
    [['R4']],
  );
});

test('reads in any method, field initializers and two-way bindings; build reads unchanged', () => {
  const c = component(
    `  @State query: string = ''
  @State a: string = ''
  @State b: string = ''
  @State c: string = ''
  label: string = this.c
  save() { console.info(this.query) }`,
    `      TextInput({ text: $$this.a })
      Button('x').onClick(() => { this.b = 'x' })`,
  );
  const reads = (name: string) => c.fields.find((f) => f.name === name)?.reads.map((r) => r.method);
  assert.deepEqual(reads('query'), ['save']);
  assert.deepEqual(reads('a'), ['build']);
  assert.deepEqual(reads('b'), []);
  assert.deepEqual(reads('c'), ['label']);
  assert.equal(c.fields.find((f) => f.name === 'query')?.buildReads.length, 0);
});

test('constant writes: literals, -1, null and undefined; anything else is not', () => {
  const c = component(
    `  @State v: string | number | boolean | null | undefined = ''
  reset() {
    this.v = ''
    this.v = \`\`
    this.v = 0
    this.v = -1
    this.v = false
    this.v = null
    this.v = undefined
    this.v = \`\${1}\`
    this.v = String(1)
  }`,
    '',
  );
  assert.deepEqual(
    c.fields[0].writes.map((w) => w.value),
    ['constant', 'constant', 'constant', 'constant', 'constant', 'constant', 'constant', 'other', 'other'],
  );
});

test('this used as a value escapes; member access, getContext(this) and bind(this) do not', () => {
  const escapes = (code: string) => component(`  @State q: string = ''\n  run() { ${code} }`, '').thisEscapes ?? false;
  assert.equal(escapes('this.q.trim()'), false);
  assert.equal(escapes('getContext(this)'), false);
  assert.equal(escapes('setTimeout(this.run.bind(this), 10)'), false);
  assert.equal(escapes('save(this)'), true);
  assert.equal(escapes('const { q } = this'), true);
  assert.equal(escapes("console.info(this['q'])"), true);
  assert.equal(component(`  @State q: string = ''\n  saver: Saver = new Saver(this)`, '').thisEscapes, true);
});
