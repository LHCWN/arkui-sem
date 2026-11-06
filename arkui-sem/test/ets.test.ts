// The ArkTS parser: struct syntax and component trees with attribute chains.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import BUNDLED from '../src/ets/options.json' with { type: 'json' };
import { parseEts, ts } from '../src/ets/parse.js';

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
  const sf = parseEts('Feed.ets', PAGE);
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
