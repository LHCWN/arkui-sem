// The project index on test/fixtures/project: package lookup (dependency map or parser), re-exports, file cache.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ProjectIndex, parseJson5 } from '../src/project.js';
import { put, ROOT, tempDir } from './helpers.js';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'project');
const PAGES = join('entry', 'src', 'main', 'ets', 'pages');
const MODULES = ['entry', 'common'];

/** A copy of the fixture in a temp dir, so tests can edit it and write a dependency map. */
function project(): string {
  const dir = tempDir();
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Writes `.hvigor/dependencyMap` as DevEco 6.x sync does: verbatim oh-package.json5 copies and a map file. */
function sync(root: string, modules = MODULES) {
  const mapDir = join(root, '.hvigor', 'dependencyMap');
  const mapFile = join(mapDir, 'dependencyMap.json5');
  put(join(mapDir, 'oh-package.json5'), readFileSync(join(root, 'oh-package.json5'), 'utf8'));
  for (const m of modules) {
    put(join(mapDir, m, 'oh-package.json5'), readFileSync(join(root, m, 'oh-package.json5'), 'utf8'));
  }
  put(mapFile, {
    basePath: mapFile,
    rootDependency: './oh-package.json5',
    dependencyMap: Object.fromEntries(modules.map((m) => [m, `./${m}/oh-package.json5`])),
    modules: modules.map((name) => ({ name, srcPath: `..\\..\\..\\${name}` })),
  });
  return mapFile;
}

/** Sets a file's mtime `seconds` from now. */
function touch(path: string, seconds: number) {
  const t = Date.now() / 1000 + seconds;
  utimesSync(path, t, t);
}

/** Where `name`, as used in the page, is declared: "<file relative to root>#<name>". */
function declared(index: ProjectIndex, root: string, page: string, name: string) {
  const facts = index.facts(join(root, PAGES, page));
  assert.ok(facts);
  const d = index.declaration(name, facts);
  return d && `${d.facts.file.slice(resolve(root).length + 1).replace(/\\/g, '/')}#${d.name}`;
}

const ITEM = 'common/src/main/ets/model/Item.ets#Item';

test('parseJson5 reads comments, unquoted keys, single quotes and trailing commas', () => {
  const text = "{\n  // c\n  a: 'it\\'s \"x\"', /* b */ list: [1, 2,],\n  'q': { url: 'http://h' },\n}";
  assert.deepEqual(parseJson5(text), { a: 'it\'s "x"', list: [1, 2], q: { url: 'http://h' } });
});

test('without a dependency map, the parser resolves a package import through Index.ets', () => {
  const index = new ProjectIndex();
  assert.equal(index.packageSource(join(FIXTURE, PAGES, 'ItemList.ets')), 'parser');
  assert.equal(
    index.resolveImport('common', join(FIXTURE, PAGES, 'ItemList.ets')),
    resolve(FIXTURE, 'common', 'Index.ets'),
  );
  assert.equal(declared(index, FIXTURE, 'ItemList.ets', 'Item'), ITEM);
});

test('a fresh dependency map gives the module list, with the same resolution', () => {
  const root = project();
  sync(root);
  const index = new ProjectIndex();
  assert.equal(index.packageSource(join(root, PAGES, 'ItemList.ets')), 'map');
  assert.equal(declared(index, root, 'ItemList.ets', 'Item'), ITEM);
});

test('a source touched after sync with unchanged content keeps the map', () => {
  const root = project();
  sync(root);
  touch(join(root, 'entry', 'oh-package.json5'), 60);
  assert.equal(new ProjectIndex().packageSource(join(root, PAGES, 'ItemList.ets')), 'map');
});

test('a stale map loses to the parser', async (t) => {
  const stale: [string, (root: string) => void][] = [
    [
      'an oh-package.json5 changed after sync',
      (root) => {
        const pkg = join(root, 'entry', 'oh-package.json5');
        writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
        touch(pkg, 60);
      },
    ],
    [
      'a module added to build-profile.json5',
      (root) => {
        const profile = join(root, 'build-profile.json5');
        writeFileSync(
          profile,
          readFileSync(profile, 'utf8').replace('modules: [', "modules: [\n    { name: 'extra', srcPath: './extra' },"),
        );
      },
    ],
    [
      'a module removed from build-profile.json5',
      (root) => {
        const profile = join(root, 'build-profile.json5');
        writeFileSync(profile, readFileSync(profile, 'utf8').replace("{ name: 'common', srcPath: './common', },", ''));
      },
    ],
    [
      'a map synced elsewhere (basePath)',
      (root) =>
        put(join(root, '.hvigor', 'dependencyMap', 'dependencyMap.json5'), {
          ...JSON.parse(readFileSync(join(root, '.hvigor', 'dependencyMap', 'dependencyMap.json5'), 'utf8')),
          basePath: join(root, 'moved', 'dependencyMap.json5'),
        }),
    ],
  ];
  for (const [name, change] of stale) {
    await t.test(name, () => {
      const root = project();
      sync(root);
      const index = new ProjectIndex();
      assert.equal(index.packageSource(join(root, PAGES, 'ItemList.ets')), 'map');
      change(root);
      assert.equal(index.packageSource(join(root, PAGES, 'ItemList.ets')), 'parser');
      assert.equal(declared(index, root, 'ItemList.ets', 'Item'), ITEM);
    });
  }
});

test('re-exports: export *, aliases, default imports; cycles end', () => {
  const index = new ProjectIndex();
  assert.equal(declared(index, FIXTURE, 'NotePage.ets', 'Note'), 'common/src/main/ets/model/Note.ets#Note');
  assert.equal(declared(index, FIXTURE, 'CardPage.ets', 'Card'), 'common/src/main/ets/model/Card.ets#Card');

  const root = project();
  put(join(root, PAGES, 'Alias.ets'), "import Row from '../components/Row';\nimport { Item as It } from 'common';\n");
  put(
    join(root, 'entry', 'src', 'main', 'ets', 'components', 'Row.ets'),
    '@Component\nexport default struct Row {\n}\n',
  );
  put(join(root, PAGES, 'A.ets'), "export * from './B';\n");
  put(join(root, PAGES, 'B.ets'), "export * from './A';\n");
  assert.equal(declared(index, root, 'Alias.ets', 'Row'), 'entry/src/main/ets/components/Row.ets#Row');
  assert.equal(declared(index, root, 'Alias.ets', 'It'), ITEM);
  assert.equal(declared(index, root, 'A.ets', 'Missing'), undefined);
});

test('the file cache re-parses a file when its mtime changes', () => {
  const root = project();
  const index = new ProjectIndex();
  const item = join(root, 'common', 'src', 'main', 'ets', 'model', 'Item.ets');
  assert.deepEqual(index.facts(item)?.observedClasses, ['Item']);
  writeFileSync(item, readFileSync(item, 'utf8').replace('@Observed\n', ''));
  touch(item, 60);
  assert.deepEqual(index.facts(item)?.observedClasses, []);
});
