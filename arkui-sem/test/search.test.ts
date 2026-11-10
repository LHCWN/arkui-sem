// Text search over .ets files: ripgrep (when the machine has one) and the Node fallback answer alike.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileSearch, type SearchTerms } from '../src/search.js';
import { put, tempDir } from './helpers.js';

const SEARCHES: [string, () => FileSearch][] = [
  ['ripgrep or Node', () => new FileSearch()],
  ['Node', () => new FileSearch([])],
  ['Node after a missing binary', () => new FileSearch([join(tempDir(), 'no-rg')])],
];

async function found(search: FileSearch, root: string, terms: Partial<SearchTerms>) {
  const result = await search.search([root], { words: [], patterns: [], ...terms });
  assert.deepEqual(result.unreadable, []);
  return result.files.map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort();
}

for (const [label, create] of SEARCHES) {
  test(`${label}: words match as whole identifiers`, async () => {
    const root = tempDir();
    put(join(root, 'call.ets'), 'Row({ n: 1 })');
    put(join(root, 'path.ets'), "import X from './Row'");
    put(join(root, 'last.ets'), 'export { Row }');
    put(join(root, 'longer.ets'), 'ItemRow()\nRowView()\nRow2()\n_Row()');
    put(join(root, 'dollar.ets'), '$Row()\nRow$()');
    put(join(root, 'second.ets'), 'Cell()');
    assert.deepEqual(await found(create(), root, { words: ['Row'] }), ['call.ets', 'last.ets', 'path.ets']);
    assert.deepEqual(await found(create(), root, { words: ['$Row', 'Cell'] }), ['dollar.ets', 'second.ets']);
    assert.deepEqual(await found(create(), root, { words: ['Missing'] }), []);
    assert.deepEqual(await found(create(), root, {}), []);
  });

  test(`${label}: the files are those etsFiles lists`, async () => {
    const root = tempDir();
    put(join(root, 'a', 'b', 'Deep.ets'), 'Row()');
    put(join(root, 'Other.ts'), 'Row()');
    put(join(root, '.hidden', 'H.ets'), 'Row()');
    put(join(root, '.Dot.ets'), 'Row()');
    put(join(root, '.gitignore'), 'ignored/\n');
    put(join(root, 'ignored', 'I.ets'), 'Row()');
    for (const skipped of ['node_modules', 'oh_modules', 'build', 'dist']) {
      put(join(root, 'a', skipped, 'S.ets'), 'Row()');
    }
    assert.deepEqual(await found(create(), root, { words: ['Row'] }), ['a/b/Deep.ets', 'ignored/I.ets']);
  });

  test(`${label}: a pattern matches next to the words`, async () => {
    const root = tempDir();
    put(join(root, 'dot.ets'), "import X from '..'");
    put(join(root, 'named.ets'), "import X from '../x'");
    put(join(root, 'word.ets'), 'Row()');
    const pattern = String.raw`['"/]\.\.?/?['"]`;
    assert.deepEqual(await found(create(), root, { patterns: [pattern] }), ['dot.ets']);
    assert.deepEqual(await found(create(), root, { words: ['Row'], patterns: [pattern] }), ['dot.ets', 'word.ets']);
  });
}

test('a directory that is gone is searched as empty', async () => {
  const result = await new FileSearch().search([join(tempDir(), 'gone')], { words: ['Row'], patterns: [] });
  assert.deepEqual(result, { files: [], unreadable: [] });
});
