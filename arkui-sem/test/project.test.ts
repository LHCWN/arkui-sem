// The project index on test/fixtures/project: package lookup (dependency map or parser), re-exports, file cache.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkFiles } from '../src/engine.js';
import type { SystemOneBackend } from '../src/judge.js';
import { ProjectIndex } from '../src/project.js';
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
      index.refresh();
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

test('after refresh(), the file cache re-parses a file whose mtime changed', () => {
  const root = project();
  const index = new ProjectIndex();
  const item = join(root, 'common', 'src', 'main', 'ets', 'model', 'Item.ets');
  assert.deepEqual(index.facts(item)?.observedClasses, ['Item']);
  writeFileSync(item, readFileSync(item, 'utf8').replace('@Observed\n', ''));
  touch(item, 60);
  assert.deepEqual(index.facts(item)?.observedClasses, ['Item'], 'same check: the first read stands');
  index.refresh();
  assert.deepEqual(index.facts(item)?.observedClasses, []);
});

test('scoped package names resolve; SDK modules (@ohos.x, @kit.x) are skipped', () => {
  const root = project();
  for (const [file, from, to] of [
    ['common/oh-package.json5', '"name": "common"', '"name": "@ohos/common"'],
    ['entry/oh-package.json5', '"common": "file:../common"', '"@ohos/common": "file:../common"'],
  ]) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  }
  put(
    join(root, PAGES, 'Scoped.ets'),
    "import { Item } from '@ohos/common';\nimport { Item as Direct } from '@ohos/common/src/main/ets/model/Item';\n",
  );
  const index = new ProjectIndex();
  assert.equal(declared(index, root, 'Scoped.ets', 'Item'), ITEM);
  assert.equal(declared(index, root, 'Scoped.ets', 'Direct'), ITEM);
  assert.equal(index.resolveImport('@ohos.router', join(root, PAGES, 'Scoped.ets')), undefined);
});

test('export { X as default } resolves for a default import', () => {
  const root = project();
  put(join(root, PAGES, 'Def.ets'), "import { Item } from 'common';\nexport { Item as default };\n");
  put(join(root, PAGES, 'UsesDef.ets'), "import Thing from './Def';\n");
  assert.equal(declared(new ProjectIndex(), root, 'UsesDef.ets', 'Thing'), ITEM);
});

/** A judge that calls every candidate a bug, so findings mirror candidates. */
const bug = {
  name: 'stub',
  systemOne: async () => ({
    backend: 'stub',
    latencyMs: 0,
    answers: { verdict: { type: 'choice', choice: 'desync_bug', confidence: 1, probabilities: { desync_bug: 1 } } },
  }),
} as unknown as SystemOneBackend;

test('a long-lived index sees an imported file change between two checks', async () => {
  const root = project();
  const project_ = new ProjectIndex();
  const page = join(root, PAGES, 'ItemList.ets');
  const nested = async () =>
    (await checkFiles([page], { backend: bug, project: project_ })).findings.some(
      (f) => f.kind === 'nested-write-unobserved',
    );
  assert.equal(await nested(), false);
  const item = join(root, 'common', 'src', 'main', 'ets', 'model', 'Item.ets');
  writeFileSync(item, readFileSync(item, 'utf8').replace('@Observed\n', ''));
  touch(item, 60);
  assert.equal(await nested(), true);
});
