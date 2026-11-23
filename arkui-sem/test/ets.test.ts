// The ArkTS parser: struct syntax and component trees with attribute chains.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import BUNDLED from '../src/ets/options.json' with { type: 'json' };
import { EtsParser, ts } from '../src/ets/parse.js';
import { FileScan } from '../src/ets/scan.js';
import { put, tempDir } from './helpers.js';

const PAGE = `@Entry
@Component
struct Feed {
  @State title: string = 'Feed'
  build() {
    Column() {
      Text(this.title)
    }
    .onAppear(() => {
      this.title = 'x'
    })
  }
}`;

test('a struct with a component block followed by an attribute chain parses without errors', () => {
  const sf = new EtsParser().parse('Feed.ets', PAGE);
  assert.deepEqual(sf.parseDiagnostics, []);
  const struct = sf.statements[0];
  assert.ok(ts.isStructDeclaration(struct));
  assert.equal(struct.name?.text, 'Feed');
});

test('the bundled options list the components that the SDK and HMS register', () => {
  for (const name of ['Column', 'Text', 'Navigation', 'HdsNavDestination']) {
    assert.ok(BUNDLED.components.includes(name), name);
  }
});

/** A fake SDK root whose OpenHarmony ets-loader tsconfig holds `ets`, and no HMS kit. */
function fakeSdk(ets: unknown): string {
  const sdk = tempDir();
  put(join(sdk, 'default', 'openharmony', 'ets', 'build-tools', 'ets-loader', 'tsconfig.json'), {
    compilerOptions: { ets },
  });
  return sdk;
}

test('an SDK without the HMS kit keeps its own component list', () => {
  const parser = new EtsParser(fakeSdk({ ...BUNDLED, components: ['Column', 'Gadget'] }));
  assert.deepEqual(parser.options.ets?.components, ['Column', 'Gadget']);
});

test('an SDK config without a component list falls back to the bundled options', () => {
  const parser = new EtsParser(fakeSdk({ components: 'Column' }));
  assert.ok(parser.options.ets?.components.includes('HdsNavDestination'));
});

test('a disable comment above a statement covers its arguments but not statements in a callback block, any rule id', () => {
  const source = [
    'function f(items: number[]) {',
    '  // arkui-sem-disable-next-line R4, R12 -- reason',
    '  items.forEach((x) =>',
    '    g(x))',
    '  g(0)',
    '  // arkui-sem-disable-next-line R4',
    '  items.forEach((x) => {',
    '    g(x)',
    '  })',
    '}',
    'function g(x: number) {}',
  ].join('\n');
  const scan = new FileScan('Page.ets', source, new EtsParser());
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'g') {
      calls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scan.sf);
  const [inner, after, inBlock] = calls;
  assert.deepEqual(scan.disabledFor(inner), ['R4', 'R12']);
  assert.deepEqual(scan.disabledAt(scan.line(inner)), []);
  assert.deepEqual(scan.disabledFor(after), []);
  assert.deepEqual(scan.disabledFor(inBlock), []);
});

test('a disable comment covers an else-if condition, an unbraced branch and a field initializer', () => {
  const source = [
    'function f(a: boolean) {',
    '  // arkui-sem-disable-next-line R4',
    '  if (a) {',
    '  } else if (g(1)) {',
    '  }',
    '  // arkui-sem-disable-next-line R4',
    '  if (a)',
    '    g(2)',
    '}',
    '@Component',
    'struct S {',
    '  // arkui-sem-disable-next-line R4',
    '  @State x: number =',
    '    g(3)',
    '  build() {}',
    '}',
    'function g(x: number): number { return x }',
  ].join('\n');
  const scan = new FileScan('Page.ets', source, new EtsParser());
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'g') {
      calls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scan.sf);
  assert.deepEqual(
    calls.map((c) => scan.disabledFor(c)),
    [['R4'], ['R4'], ['R4']],
  );
});
