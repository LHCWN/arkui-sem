// R2 event unwired: a callback a component calls and its call sites don't pass, on inline sources and a temp project.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { unsetCallback } from '../../src/analysis.js';
import { checkFiles, FACTS, formatForAgent } from '../../src/engine.js';
import type { SystemOneBackend } from '../../src/judge.js';
import { ArkuiSemPlugin } from '../../src/opencode.js';
import { extract, project, put, tempDir } from '../helpers.js';

const PAGES = join('entry', 'src', 'main', 'ets', 'pages');

/** No rule under test asks the judge. */
const noJudge = {
  name: 'none',
  systemOne: async () => {
    throw new Error('the judge was called');
  },
} as unknown as SystemOneBackend;

/** What an unpassed `cb` does in a component with the given field declaration and call. */
function unset(decorator: '@Component' | '@ComponentV2', field: string, body = 'this.cb()') {
  const [c] = extract(`${decorator}
struct C {
  ${field}
  aboutToAppear() { this.init() }
  init() {}
  build() {
    Button('x').onClick(() => { ${body} })
  }
}`).components;
  const cb = c.fields.find((f) => f.name === 'cb');
  assert.ok(cb);
  return unsetCallback(cb, c.version);
}

test('V2: an @Event without a default does nothing when unset; one with a default is not asked about', () => {
  assert.equal(unset('@ComponentV2', '@Event cb: () => void'), 'nothing');
  assert.equal(unset('@ComponentV2', '@Event cb: () => void = () => {}'), undefined);
  assert.equal(unset('@ComponentV2', "@Event cb: () => void = () => { console.log('x') }"), undefined);
  assert.equal(unset('@ComponentV2', '@Require @Event cb: () => void'), undefined);
  assert.equal(unset('@ComponentV2', '@Event cb: () => void', ''), undefined);
  assert.equal(unset('@ComponentV2', '@Param cb: () => void = () => {}'), undefined);
  assert.equal(unset('@ComponentV2', '@Event cb?: () => void'), undefined);
  assert.equal(unset('@ComponentV2', '@Event cb: (() => void) | undefined'), undefined);
  assert.equal(unset('@ComponentV2', '@Event cb: () => void', 'this.cb?.()'), undefined);
});

test('V1: a callback without a default throws when called unchecked; an optional one is not asked about', () => {
  assert.equal(unset('@Component', 'cb: () => void'), 'throws');
  assert.equal(unset('@Component', 'cb: () => void', 'this.cb?.()'), undefined);
  assert.equal(unset('@Component', 'cb: () => void', 'if (this.cb) { this.cb() }'), undefined);
  assert.equal(unset('@Component', 'cb?: () => void'), undefined);
  assert.equal(unset('@Component', 'cb: (() => void) | undefined'), undefined);
  assert.equal(unset('@Component', 'cb: () => void = () => {}'), undefined);
  assert.equal(unset('@Component', 'cb: () => void = () => { router.back() }'), undefined);
  assert.equal(unset('@Component', 'cb: () => void', 'this.cb = () => {}; this.cb()'), undefined);
  assert.equal(unset('@Component', '@BuilderParam cb: () => void'), undefined);
});

const STEPPER = `@ComponentV2
export struct Stepper {
  @Param count: number = 0
  @Event changeCount: (n: number) => void
  build() {
    Button('+').onClick(() => { this.changeCount(this.count + 1) })
  }
}
`;

const page = (name: string, child: string, args: string) => `import { ${child} } from './${child}';
@Entry
@ComponentV2
struct ${name} {
  @Local count: number = 0
  build() {
    Column() {
      ${child}(${args})
    }
  }
}
`;

/** A project with one child and the pages that create it; returns a check of the given files. */
function setup(child: string, source: string, pages: Record<string, string>) {
  const root = project();
  const path = (name: string) => join(root, PAGES, `${name}.ets`);
  put(path(child), source);
  for (const [name, args] of Object.entries(pages)) {
    put(path(name), page(name, child, args));
  }
  const check = async (...names: string[]) => {
    const { findings, errors } = await checkFiles(names.map(path), { backend: noJudge, workspace: root });
    assert.deepEqual(errors, []);
    return findings.filter((f) => f.rule === 'R2');
  };
  return { root, path, check };
}

test('an @Event no call site passes is a finding, from the child or from a parent', async () => {
  const { path, check, root } = setup('Stepper', STEPPER, { A: '{ count: this.count }', B: '{ count: 1 }' });
  const [fromChild, ...rest] = await check('Stepper');
  assert.deepEqual(rest, []);
  assert.equal(fromChild.kind, 'event-unwired');
  assert.equal(fromChild.band, 'finding');
  assert.equal(fromChild.backend, FACTS);
  assert.equal(fromChild.subject, 'Stepper.changeCount');
  assert.equal(fromChild.line, 4);
  assert.deepEqual(fromChild.related, [
    { file: path('A'), line: 8 },
    { file: path('B'), line: 8 },
  ]);
  assert.match(
    fromChild.evidence,
    /@Event changeCount is called \(line 6\), but none of the 2 call sites of Stepper pass it/,
  );

  const fromParent = await check('A');
  assert.deepEqual(
    fromParent.map((f) => f.fingerprint),
    [fromChild.fingerprint],
  );
  assert.equal((await check('A', 'B', 'Stepper')).length, 1);

  const text = formatForAgent([fromChild], root);
  assert.match(text, /\[R2 event-unwired\] .*Stepper\.ets:4 Stepper\.changeCount \(facts\)/);
  assert.match(text, / {2}at: .*A\.ets:8, .*B\.ets:8/);
});

test('no finding when a site passes the event, may pass it, or can not be read', async () => {
  const passed = setup('Stepper', STEPPER, {
    A: '{ count: this.count }',
    B: '{ count: this.count, changeCount: (n: number) => { this.count = n } }',
  });
  assert.deepEqual(await passed.check('Stepper', 'A'), []);

  const opaque = setup('Stepper', STEPPER, { A: '{ count: this.count }', B: 'this.options()' });
  assert.deepEqual(await opaque.check('Stepper'), []);

  const broken = setup('Stepper', STEPPER, { A: '{ count: this.count }' });
  put(broken.path('Broken'), "import { Stepper } from './Stepper';\n@ComponentV2\nstruct Broken {\n  build() {\n");
  assert.deepEqual(await broken.check('Stepper'), []);

  const unused = setup('Stepper', STEPPER, {});
  assert.deepEqual(await unused.check('Stepper'), []);
});

test('a disable comment above the event', async () => {
  const disabled = STEPPER.replace(
    '  @Event',
    '  // arkui-sem-disable-next-line R2 -- wired by the host app\n  @Event',
  );
  assert.deepEqual(await setup('Stepper', disabled, { A: '{ count: 1 }' }).check('Stepper', 'A'), []);
});

test('an optional callback no call site passes is not reported', async () => {
  const picker = `@Component
export struct Picker {
  @Prop value: number = 0
  onPick?: (n: number) => void
  build() {
    Button('pick').onClick(() => { this.onPick?.(this.value) })
  }
}
`;
  const { check } = setup('Picker', picker, { A: '{ value: this.count }' });
  assert.deepEqual(await check('A', 'Picker'), []);
  const withDefault = STEPPER.replace('=> void', '=> void = () => {}');
  assert.deepEqual(await setup('Stepper', withDefault, { A: '{ count: 1 }' }).check('A', 'Stepper'), []);
});

test('a V1 callback that throws is reported for the sites that omit it, even when another passes it', async () => {
  const dialog = `@Component
export struct Confirm {
  onConfirm: () => void
  build() {
    Button('ok').onClick(() => { this.onConfirm() })
  }
}
`;
  const { path, check } = setup('Confirm', dialog, { A: '{ onConfirm: () => { this.count++ } }', B: '' });
  const [finding] = await check('Confirm');
  assert.equal(finding.band, 'finding');
  assert.deepEqual(finding.related, [{ file: path('B'), line: 8 }]);
  assert.match(
    finding.evidence,
    /called without a check \(line 5\), but 1 of 2 call sites of Confirm doesn't pass it:/,
  );

  const opaque = setup('Confirm', dialog, { A: '{ onConfirm: () => { this.count++ } }', B: '', C: 'this.options()' });
  const [withOpaque] = await opaque.check('Confirm');
  assert.deepEqual(withOpaque.related, [{ file: opaque.path('B'), line: 8 }]);
  assert.match(
    withOpaque.evidence,
    /but 1 of 3 call sites of Confirm doesn't pass it \(the arguments of 1 can't be read\):/,
  );
});

test('many structs to look up: the whole-project scan gives the same findings as the searches', async () => {
  const root = project();
  const names = Array.from({ length: 10 }, (_, i) => `Step${i}`);
  const files = names.flatMap((name, i) => [
    put(join(root, PAGES, `${name}.ets`), STEPPER.replace('Stepper', name)),
    put(join(root, PAGES, `P${i}.ets`), page(`P${i}`, name, i % 2 ? '{ count: 1 }' : '{ changeCount: () => {} }')),
  ]);
  const subjects = async (checked: string[]) =>
    (await checkFiles(checked, { backend: noJudge, workspace: root })).findings.map((f) => f.subject).sort();
  const scanned = await subjects(files);
  assert.deepEqual(
    scanned,
    names.filter((_, i) => i % 2).map((name) => `${name}.changeCount`),
  );
  assert.deepEqual(
    (await Promise.all(names.map((name) => subjects([join(root, PAGES, `${name}.ets`)])))).flat(),
    scanned,
  );

  // A file the scan can't use holds back only the struct it mentions.
  put(
    join(root, PAGES, 'Broken.ets'),
    "import { Step1 } from './Step1';\n@ComponentV2\nstruct Broken {\n  build() {\n",
  );
  assert.deepEqual(
    await subjects(files),
    scanned.filter((subject) => subject !== 'Step1.changeCount'),
  );
});

test('the plugin reports an unwired event after an edit of the parent, and again at the idle gate', async () => {
  const { root, path } = setup('Stepper', STEPPER, { A: '{ count: this.count }' });
  process.env.ARKUI_SEM_DATA_DIR = tempDir();
  process.env.ARKUI_SEM_BACKEND = 'heuristic';
  process.env.ARKUI_SEM_CONFIG = join(root, 'no-user-config.json');
  const prompts: { body: { parts: { text: string }[] } }[] = [];
  const client = {
    app: { log: async () => {} },
    session: { promptAsync: async (prompt: (typeof prompts)[number]) => prompts.push(prompt) },
  };
  const hooks = await ArkuiSemPlugin({ client, directory: root, worktree: root } as never);
  const output = { title: '', output: 'ok', metadata: {} };
  await hooks['tool.execute.after']?.(
    { tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: path('A') } },
    output,
  );
  assert.match(output.output, /\[R2 event-unwired\] .*Stepper\.ets:4 Stepper\.changeCount \(facts\)/);
  await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 's' } } } as never);
  assert.match(prompts[0].body.parts[0].text, /Stepper\.changeCount/);
});
