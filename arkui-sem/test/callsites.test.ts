// Call-site edges: component uses in one file, then resolved across the project on test/fixtures/project.

import assert from 'node:assert/strict';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { etsFiles, type FactExtractor, type FileFacts } from '../src/analysis.js';
import { EtsExtractor } from '../src/ets/extract.js';
import { ProjectIndex } from '../src/project.js';
import { extract, FIXTURE, project, put, tempDir, touch } from './helpers.js';

const COMPONENTS = join('entry', 'src', 'main', 'ets', 'components');
const PAGES = join('entry', 'src', 'main', 'ets', 'pages');
const FIXTURE_FILES = etsFiles(FIXTURE).length;

const child = '@Component\nexport struct Child {\n  @Prop n: number = 0\n  build() {}\n}\n';

function edges(index: ProjectIndex, ...args: Parameters<ProjectIndex['callSites']>) {
  const found = index.callSites(...args);
  assert.ok(found);
  return found;
}

/** The call sites of struct `name` declared in `file`, as "<parent>:<child as written>". */
function usedFrom(index: ProjectIndex, file: string, name: string) {
  const { sites, unscanned } = edges(index, { facts: index.facts(file), name });
  return { parents: sites.map((s) => `${s.parent}:${s.child}`).sort(), unscanned };
}

const page = (name: string, imports: string, body: string) =>
  `${imports}\n@Component\nstruct ${name} {\n  @State n: number = 0\n  build() {\n    ${body}\n  }\n}\n`;

test('every argument form', () => {
  const facts = extract(`
import { Child } from './Child'
@Component
struct P {
  @State x: number = 0
  @State o: Info = new Info()
  handler = () => {}
  m() {}
  build() {
    Child({
      a: this.x, b: this.x!!, c: $x, d: this.o.y, e: this.o[0], f: 'a', g: 1, h: true, i: null, j: \`t\`,
      k: () => {}, l: this.m, m: this.handler, n: this.m.bind(this), o: item, p: new Foo(), q: (this.x as number),
      r: -1, s: \`a\${1}\`, t: $$this.x, u: undefined, v: [1], w: $$x, x: this.o.m(), y() {}, z
    })
  }
}`);
  const [use] = facts.componentUses;
  assert.deepEqual(Object.fromEntries(use.args.map((a) => [a.field, a.form])), {
    a: 'this.x',
    b: 'this.x',
    c: '$x',
    d: 'this.x.y',
    e: 'this.x.y',
    f: 'literal',
    g: 'literal',
    h: 'literal',
    i: 'literal',
    j: 'literal',
    k: 'callback',
    l: 'callback',
    m: 'callback',
    n: 'callback',
    o: 'other',
    p: 'other',
    q: 'this.x',
    r: 'literal',
    s: 'other',
    t: 'this.x',
    u: 'other',
    v: 'other',
    w: 'other',
    x: 'other',
    y: 'callback',
    z: 'other',
  });
  assert.equal(use.args.find((a) => a.field === 'b')?.text, 'this.x!!');
  assert.equal(use.opaqueArgs, undefined);
});

test('uses in ForEach, if, @Builder, @LocalBuilder, a trailing closure and a file-level @Builder', () => {
  const facts = extract(`
import { Child } from './Child'
@Builder
function top() {
  Child({ n: 2 })
}
@Component
struct P {
  @Builder header() {
    Child({ n: 1 })
  }
  @LocalBuilder local() {
    Child()
  }
  build() {
    Column() {
      ForEach(this.l, (i: number) => {
        Child({ n: i })
      })
      if (this.l.length > 0) {
        Child() {
          Child({ n: 3 })
        }
      }
      Text('system components are not recorded')
    }
  }
  helper() {
    Child({ n: 4 })
  }
}`);
  assert.deepEqual(
    facts.componentUses.map((u) => [u.parent, u.method, u.line]),
    [
      [undefined, '@Builder top', 5],
      ['P', 'header', 10],
      ['P', 'local', 13],
      ['P', 'build', 18],
      ['P', 'build', 21],
      ['P', 'build', 22],
    ],
  );
});

test('Child() has no arguments; Child(opts) and a spread are opaque; a trailing closure is no argument', () => {
  const [none, opts, spread, closure] = extract(`
import { Child } from './Child'
@Component
struct P {
  build() {
    Child()
    Child(opts)
    Child({ ...opts, n: 1 })
    Child() {
      Text('body')
    }
  }
}`).componentUses;
  assert.deepEqual([none.args, none.opaqueArgs], [[], undefined]);
  assert.deepEqual([opts.args, opts.opaqueArgs], [[], true]);
  assert.deepEqual([spread.args.map((a) => a.field), spread.opaqueArgs], [['n'], true]);
  assert.deepEqual([closure.args, closure.opaqueArgs], [[], undefined]);
});

test('a struct used from two parents, in ForEach bodies', () => {
  const index = new ProjectIndex();
  const row = join(FIXTURE, COMPONENTS, 'ItemRow.ets');
  assert.deepEqual(usedFrom(index, row, 'ItemRow'), {
    parents: ['ItemGrid:ItemRow', 'ItemList:ItemRow'],
    unscanned: 0,
  });
  const { sites } = edges(index, { facts: index.facts(row), name: 'ItemRow' });
  assert.deepEqual(sites[0].args[0], { field: 'item', line: sites[0].line, form: 'other', text: 'item' });
  assert.ok(sites.every((s) => s.method === 'build' && s.file.endsWith('.ets')));
});

test('a package import through Index.ets, an alias and a default import reach the struct', () => {
  const root = project();
  const tag = put(join(root, 'common', 'src', 'main', 'ets', 'Tag.ets'), child.replaceAll('Child', 'Tag'));
  put(join(root, 'common', 'Index.ets'), "export { Tag } from './src/main/ets/Tag';\n");
  const main = put(join(root, COMPONENTS, 'Main.ets'), '@Component\nexport default struct Main {\n  build() {}\n}\n');
  put(join(root, PAGES, 'A.ets'), page('A', "import { Tag } from 'common'", 'Tag({ n: this.n })'));
  put(join(root, PAGES, 'B.ets'), page('B', "import { Tag as Label } from 'common'", 'Label({ n: 1 })'));
  put(join(root, PAGES, 'C.ets'), page('C', "import Primary from '../components/Main'", 'Primary()'));
  const index = new ProjectIndex();
  assert.deepEqual(usedFrom(index, tag, 'Tag').parents, ['A:Tag', 'B:Label']);
  assert.deepEqual(usedFrom(index, main, 'Main').parents, ['C:Primary']);
});

test('same-named structs in different modules stay separate; unresolved callees fall away', () => {
  const root = project();
  const a = put(join(root, COMPONENTS, 'a', 'Cell.ets'), child.replaceAll('Child', 'Cell'));
  const b = put(join(root, COMPONENTS, 'b', 'Cell.ets'), child.replaceAll('Child', 'Cell'));
  put(join(root, PAGES, 'A.ets'), page('A', "import { Cell } from '../components/a/Cell'", 'Cell()'));
  put(join(root, PAGES, 'B.ets'), page('B', "import { Cell } from '../components/b/Cell'", 'Cell()'));
  put(join(root, PAGES, 'Lost.ets'), page('Lost', "import { Cell } from '../components/missing/Cell'", 'Cell()'));
  const index = new ProjectIndex();
  assert.deepEqual(usedFrom(index, a, 'Cell').parents, ['A:Cell']);
  assert.deepEqual(usedFrom(index, b, 'Cell').parents, ['B:Cell']);
});

test('the budget stops the scan and reports the rest as unscanned, with one clock per check', () => {
  const index = new ProjectIndex();
  const facts = index.facts(join(FIXTURE, COMPONENTS, 'ItemRow.ets'));
  const decl = { facts, name: 'ItemRow' };
  assert.deepEqual(edges(index, decl, { budgetMs: 0 }), { sites: [], unscanned: FIXTURE_FILES });
  assert.deepEqual(edges(index, decl), { sites: [], unscanned: FIXTURE_FILES });
  index.refresh();
  const full = edges(index, decl);
  assert.equal(full.unscanned, 0);
  assert.equal(full.sites.length, 2);
});

test('a file with syntax errors keeps its sites and counts as unscanned; edges are still reused', () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  put(
    join(root, PAGES, 'Broken.ets'),
    page('Broken', "import { ItemRow } from '../components/ItemRow'", "ItemRow() { Text('a') }.width(1)"),
  );
  const index = new ProjectIndex();
  assert.deepEqual(usedFrom(index, row, 'ItemRow'), {
    parents: ['Broken:ItemRow', 'ItemGrid:ItemRow', 'ItemList:ItemRow'],
    unscanned: 1,
  });
  const first = edges(index, { facts: index.facts(row), name: 'ItemRow' }).sites;
  index.refresh();
  assert.equal(edges(index, { facts: index.facts(row), name: 'ItemRow' }).sites, first);
});

test('edges are reused until a file changes', () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  const list = join(root, PAGES, 'ItemList.ets');
  const index = new ProjectIndex();
  const sites = () => edges(index, { facts: index.facts(row), name: 'ItemRow' }).sites;
  const first = sites();
  index.refresh();
  assert.equal(sites(), first);

  put(list, page('ItemList', "import { ItemRow } from '../components/ItemRow'", 'ItemRow()\n    ItemRow()'));
  touch(list, 5);
  index.refresh();
  assert.equal(sites().length, 3);

  const added = put(
    join(root, PAGES, 'New.ets'),
    page('New', "import { ItemRow } from '../components/ItemRow'", 'ItemRow()'),
  );
  index.refresh();
  assert.equal(sites().length, 4);

  rmSync(added);
  index.refresh();
  assert.equal(sites().length, 3);
});

test('a dependency change rebuilds the edges', () => {
  const root = project();
  const tag = put(join(root, 'common', 'src', 'main', 'ets', 'Tag.ets'), child.replaceAll('Child', 'Tag'));
  put(join(root, 'common', 'Index.ets'), "export { Tag } from './src/main/ets/Tag';\n");
  put(join(root, PAGES, 'A.ets'), page('A', "import { Tag } from 'common'", 'Tag()'));
  const index = new ProjectIndex();
  assert.deepEqual(usedFrom(index, tag, 'Tag').parents, ['A:Tag']);
  put(join(root, 'entry', 'oh-package.json5'), { name: 'entry', dependencies: {} });
  touch(join(root, 'entry', 'oh-package.json5'), 5);
  put(join(root, 'build-profile.json5'), { modules: [{ name: 'entry', srcPath: './entry' }] });
  touch(join(root, 'build-profile.json5'), 5);
  index.refresh();
  assert.deepEqual(usedFrom(index, tag, 'Tag').parents, []);
});

test('a file with no word-bounded struct or @Builder is not parsed for the scan', () => {
  const root = project();
  const helper = put(join(root, 'entry', 'Helper.ets'), 'export class Helper {\n  constructor() {}\n}\n');
  const parsed: string[] = [];
  const inner = new EtsExtractor();
  const counting: FactExtractor = {
    name: inner.name,
    extract(file, text): FileFacts {
      parsed.push(file);
      return inner.extract(file, text);
    },
  };
  const index = new ProjectIndex(counting);
  assert.equal(usedFrom(index, join(root, COMPONENTS, 'ItemRow.ets'), 'ItemRow').unscanned, 0);
  assert.ok(!parsed.includes(helper));
});

test('a project without a build profile is the closest oh-package.json5 directory', () => {
  const root = tempDir();
  put(join(root, 'a', 'oh-package.json5'), {});
  put(join(root, 'b', 'oh-package.json5'), {});
  const declared = put(join(root, 'a', 'Child.ets'), child);
  put(join(root, 'a', 'P.ets'), page('P', "import { Child } from './Child'", 'Child()'));
  put(join(root, 'b', 'Q.ets'), page('Q', "import { Child } from '../a/Child'", 'Child()'));
  assert.deepEqual(usedFrom(new ProjectIndex(), declared, 'Child').parents, ['P:Child']);
});

test('directory link cycles end the listing', () => {
  const root = tempDir();
  const inA = put(join(root, 'a', 'A.ets'), '');
  const inB = put(join(root, 'b', 'B.ets'), '');
  symlinkSync(root, join(root, 'a', 'back'), 'junction');
  symlinkSync(join(root, 'b'), join(root, 'a', 'toB'), 'junction');
  symlinkSync(join(root, 'a'), join(root, 'b', 'toA'), 'junction');
  const found = etsFiles(root);
  assert.ok(found.includes(inA) && found.includes(inB));
});
