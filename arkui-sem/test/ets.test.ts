// The ArkTS parser: struct syntax and component trees with attribute chains.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import BUNDLED from '../src/ets/options.json' with { type: 'json' };
import { EtsParser, ts } from '../src/ets/parse.js';
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
