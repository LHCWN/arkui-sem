// Call-site edges: component uses in one file, then resolved across the project on test/fixtures/project.

import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CallSite, etsFiles, type FactExtractor, type FileFacts } from '../src/analysis.js';
import { EtsExtractor } from '../src/ets/extract.js';
import { ProjectIndex } from '../src/project.js';
import { FileSearch, type TextSearch } from '../src/search.js';
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

const NODE_ONLY = () => new FileSearch([]);

const byPlace = (sites: CallSite[] = []) =>
  sites
    .map((s) => ({ ...s, file: s.file.toLowerCase() }))
    .sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));

/** The search, with ripgrep when the machine has one and from Node, lists the sites the scan found. */
async function assertSearchFinds(sites: CallSite[], file: string, name: string, workspace?: string) {
  for (const search of [new FileSearch(), NODE_ONLY()]) {
    const index = new ProjectIndex(undefined, search);
    const found = await index.searchCallSites({ facts: index.facts(file), name }, { workspace });
    assert.deepEqual(byPlace(found?.sites), byPlace(sites));
  }
}

/** The call sites of struct `name` declared in `file`, as "<parent>:<child as written>"; scan and search agree. */
async function usedFrom(index: ProjectIndex, file: string, name: string) {
  const { sites, unscanned } = edges(index, { facts: index.facts(file), name });
  await assertSearchFinds(sites, file, name);
  return { parents: sites.map((s) => `${s.parent}:${s.child}`).sort(), unscanned };
}

/** An extractor that records the files it parses. */
function counting(parsed: string[]): FactExtractor {
  const inner = new EtsExtractor();
  return {
    name: inner.name,
    extract(file, text): FileFacts {
      parsed.push(file);
      return inner.extract(file, text);
    },
  };
}

const page = (name: string, imports: string, body: string) =>
  `${imports}\n@Component\nstruct ${name} {\n  @State n: number = 0\n  build() {\n    ${body}\n  }\n}\n`;

test('a broken declaring file counts as unscanned in the search too', async () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  put(row, `${readFileSync(row, 'utf8')}\nconst x = ;\n`);
  const index = new ProjectIndex(undefined, NODE_ONLY());
  const decl = { facts: index.facts(row), name: 'ItemRow' };
  const scan = edges(index, decl);
  const found = await index.searchCallSites(decl);
  assert.deepEqual([found?.unscanned, scan.unscanned], [1, 1]);
  assert.deepEqual(byPlace(found?.sites), byPlace(scan.sites));
});

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
    b: 'this.x!!',
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

test('a struct used from two parents, in ForEach bodies', async () => {
  const index = new ProjectIndex();
  const row = join(FIXTURE, COMPONENTS, 'ItemRow.ets');
  assert.deepEqual(await usedFrom(index, row, 'ItemRow'), {
    parents: ['ItemGrid:ItemRow', 'ItemList:ItemRow'],
    unscanned: 0,
  });
  const { sites } = edges(index, { facts: index.facts(row), name: 'ItemRow' });
  assert.deepEqual(sites[0].args[0], { field: 'item', line: sites[0].line, form: 'other', text: 'item' });
  assert.ok(sites.every((s) => s.method === 'build' && s.file.endsWith('.ets')));
});

test('a package import through Index.ets, an alias and a default import reach the struct', async () => {
  const root = project();
  const tag = put(join(root, 'common', 'src', 'main', 'ets', 'Tag.ets'), child.replaceAll('Child', 'Tag'));
  put(join(root, 'common', 'Index.ets'), "export { Tag } from './src/main/ets/Tag';\n");
  const main = put(join(root, COMPONENTS, 'Main.ets'), '@Component\nexport default struct Main {\n  build() {}\n}\n');
  put(join(root, PAGES, 'A.ets'), page('A', "import { Tag } from 'common'", 'Tag({ n: this.n })'));
  put(join(root, PAGES, 'B.ets'), page('B', "import { Tag as Label } from 'common'", 'Label({ n: 1 })'));
  put(join(root, PAGES, 'C.ets'), page('C', "import Primary from '../components/Main'", 'Primary()'));
  const index = new ProjectIndex();
  assert.deepEqual((await usedFrom(index, tag, 'Tag')).parents, ['A:Tag', 'B:Label']);
  assert.deepEqual((await usedFrom(index, main, 'Main')).parents, ['C:Primary']);
});

test('same-named structs in different modules stay separate; unresolved callees fall away', async () => {
  const root = project();
  const a = put(join(root, COMPONENTS, 'a', 'Cell.ets'), child.replaceAll('Child', 'Cell'));
  const b = put(join(root, COMPONENTS, 'b', 'Cell.ets'), child.replaceAll('Child', 'Cell'));
  put(join(root, PAGES, 'A.ets'), page('A', "import { Cell } from '../components/a/Cell'", 'Cell()'));
  put(join(root, PAGES, 'B.ets'), page('B', "import { Cell } from '../components/b/Cell'", 'Cell()'));
  put(join(root, PAGES, 'Lost.ets'), page('Lost', "import { Cell } from '../components/missing/Cell'", 'Cell()'));
  const index = new ProjectIndex();
  assert.deepEqual((await usedFrom(index, a, 'Cell')).parents, ['A:Cell']);
  assert.deepEqual((await usedFrom(index, b, 'Cell')).parents, ['B:Cell']);
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

test('a file with syntax errors keeps its sites and counts as unscanned; edges are still reused', async () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  put(
    join(root, PAGES, 'Broken.ets'),
    page('Broken', "import { ItemRow } from '../components/ItemRow'", "ItemRow() { Text('a') }.width(1)"),
  );
  const index = new ProjectIndex();
  assert.deepEqual(await usedFrom(index, row, 'ItemRow'), {
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

test('a dependency change rebuilds the edges', async () => {
  const root = project();
  const tag = put(join(root, 'common', 'src', 'main', 'ets', 'Tag.ets'), child.replaceAll('Child', 'Tag'));
  put(join(root, 'common', 'Index.ets'), "export { Tag } from './src/main/ets/Tag';\n");
  put(join(root, PAGES, 'A.ets'), page('A', "import { Tag } from 'common'", 'Tag()'));
  const index = new ProjectIndex();
  assert.deepEqual((await usedFrom(index, tag, 'Tag')).parents, ['A:Tag']);
  put(join(root, 'entry', 'oh-package.json5'), { name: 'entry', dependencies: {} });
  touch(join(root, 'entry', 'oh-package.json5'), 5);
  put(join(root, 'build-profile.json5'), { modules: [{ name: 'entry', srcPath: './entry' }] });
  touch(join(root, 'build-profile.json5'), 5);
  index.refresh();
  assert.deepEqual((await usedFrom(index, tag, 'Tag')).parents, []);
});

test('a file with no word-bounded struct or @Builder is not parsed for the scan', async () => {
  const root = project();
  const helper = put(join(root, 'entry', 'Helper.ets'), 'export class Helper {\n  constructor() {}\n}\n');
  const parsed: string[] = [];
  const index = new ProjectIndex(counting(parsed));
  assert.equal((await usedFrom(index, join(root, COMPONENTS, 'ItemRow.ets'), 'ItemRow')).unscanned, 0);
  assert.ok(!parsed.includes(helper));
});

test('a project without a build profile is the closest oh-package.json5 directory', async () => {
  const root = tempDir();
  put(join(root, 'a', 'oh-package.json5'), {});
  put(join(root, 'b', 'oh-package.json5'), {});
  const declared = put(join(root, 'a', 'Child.ets'), child);
  put(join(root, 'a', 'P.ets'), page('P', "import { Child } from './Child'", 'Child()'));
  put(join(root, 'b', 'Q.ets'), page('Q', "import { Child } from '../a/Child'", 'Child()'));
  assert.deepEqual((await usedFrom(new ProjectIndex(), declared, 'Child')).parents, ['P:Child']);
});

test('a module outside the build-profile root finds its callers through the workspace', async () => {
  const root = tempDir();
  const app = join(root, 'app');
  put(join(app, 'build-profile.json5'), {
    modules: [
      { name: 'entry', srcPath: './entry' },
      { name: 'common', srcPath: '../common' },
    ],
  });
  put(join(app, 'entry', 'oh-package.json5'), {});
  put(join(root, 'common', 'oh-package.json5'), {});
  const declared = put(join(root, 'common', 'Child.ets'), child);
  put(join(app, 'entry', 'P.ets'), page('P', "import { Child } from '../../common/Child'", 'Child()'));
  const index = new ProjectIndex();
  const decl = { facts: index.facts(declared), name: 'Child' };
  const { sites } = edges(index, decl, { workspace: app });
  assert.deepEqual(
    sites.map((s) => s.parent),
    ['P'],
  );
  await assertSearchFinds(sites, declared, 'Child', app);
});

test('a use in a field initializer records the field', () => {
  const [use] = extract(`
import { Dlg } from './Dlg'
@Component
struct P {
  ctrl: CustomDialogController = new CustomDialogController({ builder: Dlg({ n: 1 }) })
  build() {}
}`).componentUses;
  assert.deepEqual([use.parent, use.child, use.method, use.args[0].form], ['P', 'Dlg', 'ctrl', 'literal']);
});

test('a dialog builder in a plain method is a use; other calls there are not', () => {
  const uses = extract(`
import { Dlg } from './Dlg'
import { format } from './format'
@Component
struct P {
  ctrl?: CustomDialogController
  aboutToAppear() {
    format(1)
    this.ctrl = new CustomDialogController({ builder: Dlg({ onClose: () => {} }), autoCancel: true })
  }
  build() {}
}`).componentUses;
  assert.deepEqual(
    uses.map((use) => [use.child, use.method, use.args[0]?.form]),
    [['Dlg', 'aboutToAppear', 'callback']],
  );
});

test('a plain @CustomDialog struct, with or without @Component, is found from its controller builder', async () => {
  for (const decorators of ['@CustomDialog', '@CustomDialog\n@Component']) {
    const root = tempDir();
    put(join(root, 'oh-package.json5'), {});
    const dialog = put(join(root, 'Dlg.ets'), `${decorators}\nexport struct Dlg {\n  build() {}\n}`);
    put(
      join(root, 'P.ets'),
      "import { Dlg } from './Dlg'\n@Component\nstruct P {\n  ctrl: CustomDialogController = new CustomDialogController({ builder: Dlg() })\n  build() {}\n}",
    );
    const { parents, unscanned } = await usedFrom(new ProjectIndex(), dialog, 'Dlg');
    assert.deepEqual([parents, unscanned], [['P:Dlg'], 0], decorators);
  }
});

test('two-way !! is its own form, also under parentheses; one ! and a deeper path are not', () => {
  const [use] = extract(`
import { Child } from './Child'
@ComponentV2
struct P {
  @Local x: number = 0
  @Local o: Info = new Info()
  build() {
    Child({ a: this.x!!, b: (this.x!!), c: this.x!, d: this.o.y!! })
  }
}`).componentUses;
  assert.deepEqual(
    use.args.map((a) => [a.field, a.form]),
    [
      ['a', 'this.x!!'],
      ['b', 'this.x!!'],
      ['c', 'this.x'],
      ['d', 'this.x.y'],
    ],
  );
});

test('an unreadable directory is skipped and counted as unscanned; the rest of the project still answers', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('needs a directory the process cannot read');
    return;
  }
  const root = tempDir();
  put(join(root, 'oh-package.json5'), {});
  const declared = put(join(root, 'Child.ets'), child);
  put(join(root, 'P.ets'), page('P', "import { Child } from './Child'", 'Child()'));
  const locked = join(root, 'locked');
  put(join(locked, 'Other.ets'), '');
  chmodSync(locked, 0o000);
  try {
    const index = new ProjectIndex();
    assert.deepEqual(await usedFrom(index, declared, 'Child'), { parents: ['P:Child'], unscanned: 1 });
    assert.throws(() => etsFiles(root), /EACCES/);
  } finally {
    chmodSync(locked, 0o755);
  }
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

test('the search follows export aliases through re-exporting files', async () => {
  const root = project();
  const tag = put(join(root, 'common', 'src', 'main', 'ets', 'Tag.ets'), child.replaceAll('Child', 'Tag'));
  put(join(root, 'common', 'Index.ets'), "export { Tag as Label } from './src/main/ets/Tag';\n");
  put(join(root, COMPONENTS, 'barrel.ets'), "export { Label as Badge } from 'common';\n");
  put(join(root, PAGES, 'A.ets'), page('A', "import { Badge } from '../components/barrel'", 'Badge()'));
  put(join(root, PAGES, 'B.ets'), page('B', "import { Badge as Mark } from '../components/barrel'", 'Mark()'));
  assert.deepEqual((await usedFrom(new ProjectIndex(), tag, 'Tag')).parents, ['A:Badge', 'B:Mark']);
});

test('the search finds default imports by file name, directory, package name and dependency key', async () => {
  const root = project();
  const ets = join(root, 'common', 'src', 'main', 'ets');
  const banner = put(join(ets, 'Top.ets'), '@Component\nexport default struct Banner {\n  build() {}\n}\n');
  put(join(root, 'common', 'Index.ets'), "export { default } from './src/main/ets/Top';\n");
  put(join(root, 'entry', 'oh-package.json5'), { name: 'entry', dependencies: { shared: 'file:../common' } });
  const widgets = join(root, COMPONENTS, 'widgets');
  const gauge = put(join(widgets, 'index.ets'), child.replace('struct Child', 'default struct Gauge'));
  put(join(widgets, 'Near.ets'), page('Near', "import G from '.'", 'G()'));
  put(join(root, PAGES, 'A.ets'), page('A', "import First from '../../../../../common/src/main/ets/Top'", 'First()'));
  put(join(root, PAGES, 'B.ets'), page('B', "import Second from 'common'", 'Second()'));
  put(join(root, PAGES, 'C.ets'), page('C', "import Third from 'shared'", 'Third()'));
  put(join(root, PAGES, 'D.ets'), page('D', "import Dial from '../components/widgets'", 'Dial()'));
  assert.deepEqual((await usedFrom(new ProjectIndex(), banner, 'Banner')).parents, ['A:First', 'B:Second', 'C:Third']);
  assert.deepEqual((await usedFrom(new ProjectIndex(), gauge, 'Gauge')).parents, ['D:Dial', 'Near:G']);
});

test('the search parses only files that mention the struct, and drops a match that is only text', async () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  const mention = put(join(root, PAGES, 'Mention.ets'), page('Mention', '// ItemRow is not used here', "Text('a')"));
  const parsed: string[] = [];
  const index = new ProjectIndex(counting(parsed), NODE_ONLY());
  const found = await index.searchCallSites({ facts: index.facts(row), name: 'ItemRow' });
  assert.deepEqual(found?.sites.map((s) => s.parent).sort(), ['ItemGrid', 'ItemList']);
  assert.equal(found?.unscanned, 0);
  assert.ok(parsed.includes(mention));
  assert.ok(parsed.length < etsFiles(root).length);
});

test('one search per struct and check; the next check sees a new caller', async () => {
  const root = project();
  const row = join(root, COMPONENTS, 'ItemRow.ets');
  const index = new ProjectIndex(undefined, NODE_ONLY());
  const search = () => index.searchCallSites({ facts: index.facts(row), name: 'ItemRow' });
  assert.equal(search(), search());
  assert.equal((await search())?.sites.length, 2);
  put(join(root, PAGES, 'New.ets'), page('New', "import { ItemRow } from '../components/ItemRow'", 'ItemRow()'));
  assert.equal((await search())?.sites.length, 2);
  index.refresh();
  assert.equal((await search())?.sites.length, 3);
});

test('the search budget leaves matching files unparsed and counts them as unscanned', async () => {
  const index = new ProjectIndex(undefined, NODE_ONLY());
  const facts = index.facts(join(FIXTURE, COMPONENTS, 'ItemRow.ets'));
  assert.deepEqual(await index.searchCallSites({ facts, name: 'ItemRow' }, { budgetMs: 0 }), {
    sites: [],
    unscanned: 2,
  });
});

test('the search answers undefined outside a project, and nothing for a name that is no struct', async () => {
  const root = tempDir();
  const lone = put(join(root, 'Child.ets'), child);
  const index = new ProjectIndex(undefined, NODE_ONLY());
  assert.equal(await index.searchCallSites({ facts: index.facts(lone), name: 'Child' }), undefined);
  const row = index.facts(join(FIXTURE, COMPONENTS, 'ItemRow.ets'));
  assert.deepEqual(await index.searchCallSites({ facts: row, name: 'Item' }), { sites: [], unscanned: 0 });
});

test('a struct its file does not export is looked up without a search', async () => {
  const root = tempDir();
  put(join(root, 'oh-package.json5'), {});
  const source = (child: string) =>
    `@Component\n${child} {\n  build() {}\n}\n@Component\nstruct P {\n  build() {\n    Row()\n  }\n}`;
  const page = put(join(root, 'P.ets'), source('struct Row'));
  let searches = 0;
  const counting: TextSearch = {
    search: async () => {
      searches++;
      return { files: [], unreadable: [] };
    },
  };
  const index = new ProjectIndex(new EtsExtractor(), counting);
  const found = await index.searchCallSites({ facts: index.facts(page), name: 'Row' });
  assert.deepEqual([found?.sites.map((s) => s.parent), searches], [['P'], 0]);

  const exporting = put(join(root, 'Q.ets'), source('export struct Row'));
  await index.searchCallSites({ facts: index.facts(exporting), name: 'Row' });
  assert.equal(searches, 1);
});
