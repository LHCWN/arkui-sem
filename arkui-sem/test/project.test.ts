// The project index on test/fixtures/project: package lookup, re-exports, file cache.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { classesWith, etsFiles, etsFilesIn, type FileFacts } from '../src/analysis.js';
import { checkFiles } from '../src/engine.js';
import type { SystemOneBackend } from '../src/judge.js';
import { ProjectIndex } from '../src/project.js';
import { put, ROOT, tempDir } from './helpers.js';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'project');
const PAGES = join('entry', 'src', 'main', 'ets', 'pages');

const observed = (facts: FileFacts | undefined) => facts && classesWith(facts, '@Observed');

/** A copy of the fixture in a temp dir, so tests can edit it. */
function project(): string {
  const dir = tempDir();
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
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

test('a package import resolves through the dependency Index.ets', () => {
  const index = new ProjectIndex();
  assert.equal(
    index.resolveImport('common', join(FIXTURE, PAGES, 'ItemList.ets')),
    resolve(FIXTURE, 'common', 'Index.ets'),
  );
  assert.equal(declared(index, FIXTURE, 'ItemList.ets', 'Item'), ITEM);
});

test('a dependency given as a plain relative path (no file: prefix) resolves', () => {
  const root = project();
  const pkg = join(root, 'entry', 'oh-package.json5');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"file:../common"', '"../common"'));
  const profile = join(root, 'build-profile.json5');
  writeFileSync(profile, readFileSync(profile, 'utf8').replace("{ name: 'common', srcPath: './common', },", ''));
  assert.equal(declared(new ProjectIndex(), root, 'ItemList.ets', 'Item'), ITEM);
});

test('a project module that is not a file: dependency resolves through build-profile.json5', () => {
  const root = project();
  const pkg = join(root, 'entry', 'oh-package.json5');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"common": "file:../common"', ''));
  assert.equal(declared(new ProjectIndex(), root, 'ItemList.ets', 'Item'), ITEM);
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
  assert.deepEqual(observed(index.facts(item)), ['Item']);
  writeFileSync(item, readFileSync(item, 'utf8').replace(/@Observed\r?\n/, ''));
  touch(item, 60);
  assert.deepEqual(observed(index.facts(item)), ['Item'], 'same check: the first read stands');
  index.refresh();
  assert.deepEqual(observed(index.facts(item)), []);
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
  writeFileSync(item, readFileSync(item, 'utf8').replace(/@Observed\r?\n/, ''));
  touch(item, 60);
  assert.equal(await nested(), true);
});

test('a check sharing the index with an overlapping check sees the files as they were when it started', async () => {
  const root = project();
  const shared = new ProjectIndex();
  let release = () => {};
  const paused = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const slow = {
    name: 'slow',
    systemOne: async () => {
      if (calls++ === 0) {
        await paused;
      }
      return bug.systemOne({} as never, {} as never);
    },
  } as unknown as SystemOneBackend;

  // The first check waits on the judge for NotePage while ItemList is still to come.
  const first = checkFiles([join(root, PAGES, 'NotePage.ets'), join(root, PAGES, 'ItemList.ets')], {
    backend: slow,
    project: shared,
  });
  const item = join(root, 'common', 'src', 'main', 'ets', 'model', 'Item.ets');
  writeFileSync(item, readFileSync(item, 'utf8').replace(/@Observed\r?\n/, ''));
  touch(item, 60);
  await checkFiles([join(root, PAGES, 'ItemList.ets')], { backend: bug, project: shared });
  release();

  const nested = (await first).findings.filter((f) => f.kind === 'nested-write-unobserved').map((f) => f.component);
  assert.deepEqual(nested, ['NotePage']);
});

test('etsFiles finds sources, skips output and dot directories, and follows directory links', () => {
  const root = tempDir();
  const page = put(join(root, 'a', 'b', 'Page.ets'), '');
  const note = put(join(root, 'a', 'note.txt'), '');
  for (const skipped of ['build', 'dist', 'oh_modules', 'node_modules', '.hvigor']) {
    put(join(root, skipped, 'Out.ets'), '');
  }
  const outside = tempDir();
  put(join(outside, 'Linked.ets'), '');
  symlinkSync(outside, join(root, 'linked'), 'junction');
  symlinkSync(join(root, 'gone'), join(root, 'broken'), 'junction');

  const found = etsFiles(root).map((f) => relative(root, f).replace(/\\/g, '/'));
  assert.deepEqual(found.sort(), ['a/b/Page.ets', 'linked/Linked.ets']);
  assert.deepEqual(etsFiles(page), [page]);
  assert.deepEqual(etsFiles(note), []);
  assert.deepEqual(etsFiles(join(root, 'missing')), []);
});

test('a directory that has gone since its parent was listed yields no files', () => {
  const root = tempDir();
  const file = put(join(root, 'Page.ets'), '');
  assert.deepEqual(etsFilesIn(join(root, 'deleted')), []);
  assert.deepEqual(etsFilesIn(file), []);
});

test('a file added after a lookup is found only after refresh', () => {
  const root = project();
  const from = join(root, PAGES, 'ItemList.ets');
  const index = new ProjectIndex();
  assert.equal(index.resolveImport('./Added', from), undefined);
  const added = put(join(root, PAGES, 'Added.ets'), 'export class Added {}');
  assert.equal(index.resolveImport('./Added', from), undefined);
  index.refresh();
  assert.equal(index.resolveImport('./Added', from), resolve(added));
});

test('a file takes the package dependencies of its innermost module', () => {
  const root = tempDir();
  put(join(root, 'build-profile.json5'), {
    modules: [
      { name: 'outer', srcPath: './outer' },
      { name: 'inner', srcPath: './outer/inner' },
    ],
  });
  put(join(root, 'outer', 'oh-package.json5'), { name: 'outer', dependencies: { dep: 'file:../a' } });
  put(join(root, 'outer', 'inner', 'oh-package.json5'), { name: 'inner', dependencies: { dep: 'file:../../b' } });
  for (const pkg of ['a', 'b']) {
    put(join(root, pkg, 'oh-package.json5'), { name: pkg });
    put(join(root, pkg, 'Index.ets'), '');
  }
  const index = new ProjectIndex();
  assert.equal(index.resolveImport('dep', join(root, 'outer', 'src', 'P.ets')), resolve(root, 'a', 'Index.ets'));
  assert.equal(
    index.resolveImport('dep', join(root, 'outer', 'inner', 'src', 'P.ets')),
    resolve(root, 'b', 'Index.ets'),
  );
});

test('without a build profile, a file takes the closest oh-package.json5, and a missing target stays undefined', () => {
  const root = tempDir();
  put(join(root, 'app', 'oh-package.json5'), {
    name: 'app',
    dependencies: { dep: 'file:../dep', gone: 'file:../gone' },
  });
  put(join(root, 'dep', 'oh-package.json5'), { name: 'dep' });
  put(join(root, 'dep', 'Index.ets'), '');
  const from = join(root, 'app', 'src', 'main', 'P.ets');
  const index = new ProjectIndex();
  assert.equal(index.resolveImport('dep', from), resolve(root, 'dep', 'Index.ets'));
  assert.equal(index.resolveImport('gone', from), undefined);
  assert.equal(index.resolveImport('./Missing', from), undefined);
});

test('on Windows, a file finds its module whatever the case of its path', {
  skip: process.platform !== 'win32',
}, () => {
  const root = tempDir();
  put(join(root, 'build-profile.json5'), { modules: [{ name: 'app', srcPath: './App' }] });
  put(join(root, 'App', 'oh-package.json5'), { name: 'app', dependencies: { dep: 'file:../module-dep' } });
  // Closer to the file than the module's own package: wins only if the module isn't recognized.
  put(join(root, 'App', 'src', 'oh-package.json5'), { name: 'src', dependencies: { dep: 'file:../../closest-dep' } });
  for (const pkg of ['module-dep', 'closest-dep']) {
    put(join(root, pkg, 'oh-package.json5'), { name: pkg });
    put(join(root, pkg, 'Index.ets'), '');
  }
  const from = join(root, 'app', 'src', 'P.ets');
  assert.equal(new ProjectIndex().resolveImport('dep', from), resolve(root, 'module-dep', 'Index.ets'));
});
