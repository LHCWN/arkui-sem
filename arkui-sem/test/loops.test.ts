// Loop facts (src/ets/loops.ts), builder parameter uses, and the rowReads query.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are ArkTS sources, whose key generators are templates
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { FileFacts, LoopFact, PathSegment } from '../src/facts.js';
import { ProjectIndex } from '../src/project.js';
import { pathText, type RowRead, rowReads } from '../src/queries.js';
import { extract, put, tempDir } from './helpers.js';

const MODEL = `interface Song { id: number; title: string; artist: Artist; liked: boolean }
interface Artist { name: string }
const SHELVES: Song[][] = [[], []]`;

/** A V1 page with `members` and a build() body. */
const page = (members: string, body: string, head = MODEL) => `${head}
@Entry
@Component
struct Playlist {
  @State songs: Song[] = []
  @State shelf: number = 0
${members}
  build() {
    Column() {
${body}
    }
  }
}`;

const loopsOf = (src: string): LoopFact[] => extract(src).components[0].loops;
const only = (src: string): LoopFact => {
  const loops = loopsOf(src);
  assert.equal(loops.length, 1);
  return loops[0];
};
const paths = (segments: { path: PathSegment[] }[]) => segments.map((s) => pathText(s.path));

describe('loop source', () => {
  const source = (expr: string, members = '') =>
    only(page(members, `ForEach(${expr}, (s: Song) => { Text(s.title) })`)).source;

  test('a field', () => {
    assert.deepEqual(source('this.songs'), {
      text: 'this.songs',
      shape: 'field',
      root: 'songs',
      itemsOf: 'songs',
      fields: ['songs'],
    });
  });

  test('derived from a field: the field it starts from is the root', () => {
    const s = source('this.songs.filter((x: Song) => x.liked).slice(0, this.shelf)');
    assert.equal(s.shape, 'derived');
    assert.equal(s.root, 'songs');
    assert.equal(s.itemsOf, 'songs');
    assert.deepEqual(s.filteredBy, ['liked']);
    assert.deepEqual(s.fields.sort(), ['shelf', 'songs']);
  });

  test("the items are the root's elements only through calls that keep them", () => {
    assert.equal(source('this.songs.sort((a: Song, b: Song) => a.id - b.id).reverse()').itemsOf, 'songs');
    for (const expr of ['this.songs[this.shelf].artist', 'this.songs.map((x: Song) => x.artist)']) {
      const s = source(expr);
      assert.equal(s.root, 'songs', expr);
      assert.equal(s.itemsOf, undefined, expr);
    }
  });

  test('a constant indexed by a field: derived, without a root', () => {
    const s = source('SHELVES[this.shelf]');
    assert.equal(s.shape, 'derived');
    assert.equal(s.root, undefined);
    assert.deepEqual(s.fields, ['shelf']);
  });

  test('a method or a getter, with the fields its helpers read and the field it returns as is', () => {
    const members = `  liked(): Song[] { return this.songs.filter((x: Song) => x.liked && this.onShelf(x)) }
  onShelf(x: Song): boolean { return SHELVES[this.shelf].includes(x) }
  get all(): Song[] { return this.songs }`;
    const called = source('this.liked()', members);
    assert.equal(called.shape, 'call');
    assert.equal(called.helper, 'liked');
    assert.equal(called.returns, undefined);
    assert.deepEqual(called.fields.sort(), ['shelf', 'songs']);
    assert.equal(called.returnsFrom, 'songs');
    assert.deepEqual(source('this.all', members), {
      text: 'this.all',
      shape: 'call',
      helper: 'all',
      returns: 'songs',
      returnsFrom: 'songs',
      shows: [{ field: 'songs', path: [] }],
      fields: ['songs'],
    });
  });

  test('the arrays a source may show: the field each starts from and the accesses on it before any call', () => {
    const at = [{ index: 'this.shelf' }, { prop: 'artist' }];
    assert.deepEqual(source('this.songs[this.shelf].artist.slice().reverse()').shows, [{ field: 'songs', path: at }]);
    assert.deepEqual(source('this.songs.slice(0, 2)[0].artist').shows, [{ field: 'songs', path: [] }]);
    assert.deepEqual(source('this.shelf > 0 ? this.songs[this.shelf].artist : []').shows, [
      { field: 'songs', path: at },
    ]);
  });

  test("a helper's accesses in its handlers are left out", () => {
    const members = '  list(): Song[] { setTimeout(() => { this.shelf++ }, 1)\n    return this.songs }';
    assert.deepEqual(source('this.list()', members).fields, ['songs']);
  });

  test('a new expression, and an expression that reads no field', () => {
    assert.equal(source('new SongSource(this.songs)').shape, 'new');
    assert.deepEqual(source('SHELVES[0]'), { text: 'SHELVES[0]', shape: 'other', fields: [] });
  });
});

describe('loop key', () => {
  const key = (row: string, generator?: string) =>
    only(page('', `ForEach(this.songs, ${row}${generator ? `, ${generator}` : ''})`)).key;
  const row = '(s: Song) => { Text(s.title) }';
  const indexedRow = '(s: Song, i: number) => { Text(s.title) }';

  test('none given: the default key, which holds the index', () => {
    assert.deepEqual(key(row), { kind: 'default', withIndex: true });
  });

  test('item properties, the index, the whole item, a method of the item', () => {
    assert.deepEqual(key(row, '(s: Song) => `${s.id}-${s.artist.name}`'), {
      kind: 'props',
      text: '(s: Song) => `${s.id}-${s.artist.name}`',
      props: ['id', 'artist.name'],
      withIndex: false,
    });
    assert.deepEqual(key(row, '(s: Song) => s.id.toString()').props, ['id']);
    assert.equal(key(row, '(s: Song, i: number) => `${i}`').kind, 'index');
    assert.equal(key(row, '(s: Song) => JSON.stringify(s)').kind, 'whole');
    assert.equal(key(row, '(s: Song) => s.toString()').kind, 'other');
    assert.equal(key(row, 'keyOf').kind, 'other');
  });

  test('block bodies, function expressions, shadowing, and an explicit undefined or null', () => {
    assert.deepEqual(key(row, 'function (s: Song): string { const k = s.id; return k + "" }').props, ['id']);
    assert.equal(key(row, '(s: Song) => { const f = (s: number) => s; return f(1) + "" }').kind, 'other');
    assert.equal(key(row, '(s: Song) => JSON.stringify({ s() { return 1 } })').kind, 'other');
    assert.deepEqual(key(row, 'undefined'), { kind: 'default', withIndex: true });
    assert.deepEqual(key(row, 'null'), { kind: 'default', withIndex: true });
  });

  test('the index joins the key when the row declares it and the key generator does not', () => {
    assert.equal(key(indexedRow, '(s: Song) => `${s.id}`').withIndex, true);
    assert.equal(key(indexedRow, '(s: Song, i: number) => `${s.id}`').withIndex, false);
    assert.equal(key(row, '(s: Song, i: number) => `${s.id}-${i}`').withIndex, true);
  });

  test('LazyForEach: no join rule; the default key holds the index', () => {
    const lazy = (generator: string) =>
      only(page('', `List() { LazyForEach(this.source, ${indexedRow}${generator}) }`)).key;
    assert.equal(lazy(', (s: Song) => `${s.id}`').withIndex, false);
    assert.deepEqual(lazy(''), { kind: 'default', withIndex: true });
  });
});

describe('loop row', () => {
  test('inline reads with their attribute; reads in handlers and under a shadowing parameter are left out', () => {
    const loop = only(
      page(
        '',
        `      ForEach(this.songs, (s: Song, i: number) => {
        Row() {
          Text(s.title).fontColor(s.liked ? Color.Red : Color.Black)
          Text(s.artist?.name)
          Button('like').onClick(() => { s.liked = !s.liked })
          Text(['a'].map((s: string) => s.length).join())
        }
      }, (s: Song) => \`\${s.id}\`)`,
      ),
    );
    assert.equal(loop.itemParam, 's');
    assert.equal(loop.indexParam, 'i');
    assert.equal(loop.itemDeclaresIndex, true);
    assert.deepEqual(paths(loop.row.reads), ['.title', '.liked', '.artist?.name']);
    assert.equal(loop.row.reads[1].attribute, 'fontColor');
  });

  test('nested loops: each call is a fact, and the inner row reads of the outer item count for the outer loop', () => {
    const loops = loopsOf(
      page(
        '',
        `      ForEach(SHELVES, (shelf: Song[], n: number) => {
        ForEach(shelf, (s: Song) => { Text(s.title + n) }, (s: Song) => \`\${s.id}\`)
      })`,
      ),
    );
    assert.deepEqual(
      loops.map((l) => l.itemParam),
      ['shelf', 's'],
    );
    assert.deepEqual(paths(loops[0].row.reads), ['']);
    assert.deepEqual(paths(loops[1].row.reads), ['.title']);
  });

  test('loops in @Builder methods and in helpers build() calls; none in handlers or methods that draw nothing', () => {
    const loops = loopsOf(
      page(
        `  @Builder List() { ForEach(this.songs, (s: Song) => { Text(s.title) }) }
  rows() { ForEach(this.songs, (s: Song) => { Text(s.title) }) }
  load() { ForEach(this.songs, (s: Song) => {}) }`,
        `      this.List()
      this.rows()
      Button('x').onClick(() => { ForEach(this.songs, (s: Song) => {}) })`,
      ),
    );
    assert.deepEqual(
      loops.map((l) => l.method),
      ['List', 'rows'],
    );
  });

  test('a disable comment above a multi-line call', () => {
    const loop = only(
      page(
        '',
        `      // arkui-sem-disable-next-line R1 -- keys are stable on purpose
      ForEach(this.songs,
        (s: Song) => { Text(s.title) },
        (s: Song) => \`\${s.id}\`)`,
      ),
    );
    assert.deepEqual(loop.disabledRules, ['R1']);
  });

  test('the components a row and a builder create, outside handlers; builder calls are not components', () => {
    const facts = extract(
      page(
        `  @Builder Editor(s: Song) { TextInput({ text: s.title }) }`,
        `      ForEach(this.songs, (s: Song) => {
        Row() {
          Text(s.title)
          SongCard({ song: s })
          Tag(s.title)
          this.Editor(s)
          Button('x').bindSheet(true, () => { Slider() }).onClick(() => { Toggle() })
        }
      }, (s: Song) => \`\${s.id}\`)`,
        `${MODEL}
@Builder function Tag(t: string) { Text(t) }`,
      ),
    );
    const c = facts.components[0];
    assert.deepEqual(c.loops[0].creates.sort(), ['Button', 'Row', 'Slider', 'SongCard', 'Text']);
    assert.deepEqual(c.builders[0].creates, ['TextInput']);
  });

  test('a row that is not a function written in place has no item', () => {
    const loop = only(page('  row = (s: Song) => {}', '      ForEach(this.songs, this.row)'));
    assert.equal(loop.itemParam, undefined);
    assert.deepEqual(loop.row, { reads: [], builders: [], children: [] });
  });
});

describe('builders and rowReads', () => {
  const HEAD = `${MODEL}
@Builder function Byline(a: Artist) {
  Text(a.name).opacity(0.6)
}
@Component
struct SongRow {
  @Prop song: Song = { id: 0, title: '', artist: { name: '' }, liked: false }
  build() {
    Row() {
      Text(this.song.title)
      Toggle({ type: ToggleType.Checkbox, isOn: this.song.liked }).onChange(() => { this.song.liked = true })
    }
  }
}`;
  const reads = (facts: FileFacts, i = 0, resolver?: ProjectIndex): RowRead[] => {
    const c = facts.components.find((x) => x.name === 'Playlist');
    assert.ok(c);
    return rowReads(c.loops[i], c, facts, resolver);
  };

  test('parameter uses of builder methods and builder functions', () => {
    const facts = extract(
      page('  @Builder Card(s: Song, { x }: Pos) { Text(s.title)\n    Byline(s.artist) }', '', HEAD),
    );
    assert.deepEqual(
      facts.builders.map((b) => [b.name, paths(b.params[0].uses.reads)]),
      [['Byline', ['.name']]],
    );
    const [card] = facts.components[1].builders;
    assert.equal(card.name, 'Card');
    assert.deepEqual(paths(card.params[0].uses.reads), ['.title']);
    assert.deepEqual(card.params[0].uses.builders, [
      { line: card.line + 1, builder: 'Byline', method: false, argument: 0, path: [{ prop: 'artist' }] },
    ]);
    assert.deepEqual(card.params[1], { uses: { reads: [], builders: [], children: [] } });
  });

  test('through a builder method and the builder function it calls, with the paths joined', () => {
    const facts = extract(
      page(
        '  @Builder Card(s: Song) {\n    Text(s.title)\n    Byline(s.artist) }',
        '      ForEach(this.songs, (s: Song) => { this.Card(s) }, (s: Song) => `${s.id}`)',
        HEAD,
      ),
    );
    assert.deepEqual(
      reads(facts).map((r) => [pathText(r.path), r.via, r.attribute ?? null]),
      [
        ['.title', { kind: 'builder', name: 'Card' }, null],
        ['.artist.name', { kind: 'builder', name: 'Card' }, null],
      ],
    );
  });

  test("through a child: the child's rendering reads of the field, with its decorators", () => {
    const facts = extract(
      page('', '      ForEach(this.songs, (s: Song) => { SongRow({ song: s }) }, (s: Song) => `${s.id}`)', HEAD),
    );
    const via = { kind: 'child', child: 'SongRow', field: 'song', decorators: ['@Prop'] };
    assert.deepEqual(
      reads(facts).map((r) => [pathText(r.path), r.via]),
      [
        ['.title', via],
        ['.liked', via],
      ],
    );
  });

  test('a component or function that is not found counts as a read of what it is passed', () => {
    const facts = extract(
      page(
        '',
        '      ForEach(this.songs, (s: Song) => { TextInput({ text: s.title })\n        Text(format(s.artist)) }, (s: Song) => `${s.id}`)',
        `import { format } from './format'\n${HEAD}`,
      ),
    );
    assert.deepEqual(
      reads(facts).map((r) => [pathText(r.path), r.via.kind]),
      [
        ['.artist', 'inline'],
        ['.title', 'inline'],
      ],
    );
  });

  test('the attribute holding a pass is kept when its target is not found; a lowercase call is no child', () => {
    const facts = extract(
      page(
        '',
        "      ForEach(this.songs, (s: Song) => { Text('a').width(calc(s.id)).opacity(fmt({ v: s.liked })) })",
        `import { calc } from './calc'\n${HEAD}`,
      ),
    );
    const [loop] = facts.components[1].loops;
    assert.deepEqual(loop.row.children, []);
    assert.deepEqual(
      reads(facts).map((r) => [pathText(r.path), r.attribute]),
      [
        ['.liked', 'opacity'],
        ['.id', 'width'],
      ],
    );
  });

  test('a builder, local or imported, called in a closure that fills a @BuilderParam draws the row; an event does not', () => {
    const facts = extract(
      page(
        '  @Builder Card(s: Song) { Text(s.title) }',
        `      ForEach(this.songs, (s: Song) => {
        Sheet({
          content: () => { this.Card(s) },
          footer: () => { Cover(s.artist) },
          onOpen: () => { this.Card(s) },
          onClose: () => { s.liked = false },
        })
      })`,
        `import { Cover } from './Cover'\n${HEAD}`,
      ),
    );
    assert.deepEqual(
      facts.components[1].loops[0].row.builders.map((b) => b.builder),
      ['Card', 'Cover'],
    );
    assert.deepEqual(
      reads(facts).map((r) => [pathText(r.path), r.via]),
      [
        ['.title', { kind: 'builder', name: 'Card' }],
        ['.artist', { kind: 'inline' }],
      ],
    );
  });

  test('a builder imported from another file', () => {
    const dir = tempDir();
    put(
      join(dir, 'common', 'Builders.ets'),
      `${MODEL}\n@Builder export function Cover(s: Song) {\n  Text(s.artist.name)\n}`,
    );
    put(
      join(dir, 'P.ets'),
      page(
        '',
        '      ForEach(this.songs, (s: Song) => { Cover(s) }, (s: Song) => `${s.id}`)',
        `import { Cover } from './common/Builders'\n${MODEL}`,
      ),
    );
    const index = new ProjectIndex();
    const facts = index.facts(join(dir, 'P.ets'));
    assert.deepEqual(paths(reads(facts)), ['']);
    const resolved = reads(facts, 0, index);
    assert.deepEqual(
      resolved.map((r) => [pathText(r.path), r.via, r.file.endsWith('Builders.ets')]),
      [['.artist.name', { kind: 'builder', name: 'Cover' }, true]],
    );
  });

  test('a builder that passes the value to itself ends', () => {
    const facts = extract(
      page(
        '  @Builder Tree(s: Song) {\n    Text(s.title)\n    this.Tree(s) }',
        '      ForEach(this.songs, (s: Song) => { this.Tree(s) })',
      ),
    );
    assert.deepEqual(paths(reads(facts)), ['.title']);
  });
});

describe('loop branches', () => {
  test('the if arms that hold the loop, outermost first', () => {
    const [loop] = loopsOf(
      page(
        '',
        "      if (this.shelf > 0) { Text('x') } else { if (this.songs.length) { ForEach(this.songs, (s: Song) => { Text(s.title) }) } }",
      ),
    );
    assert.deepEqual(
      loop.branches.map((b) => b.arm),
      ['else', 'then'],
    );
  });

  test('through the @Builders that reach it: nested calls compose, calls from both arms leave none', () => {
    const builders = `  @Builder Outer() {
    if (this.songs.length) { this.Inner() }
  }
  @Builder Inner() {
    ForEach(this.songs, (s: Song) => { Text(s.title) })
  }
  @Builder Both() {
    ForEach(this.songs, (s: Song) => { Text(s.artist.name) })
  }`;
    const loops = loopsOf(
      page(builders, '      if (this.shelf > 0) { this.Outer(); this.Both() } else { this.Both() }'),
    );
    const armsOf = (method: string) => loops.find((l) => l.method === method)?.branches.map((b) => b.arm);
    assert.deepEqual(armsOf('Inner'), ['then', 'then']);
    assert.deepEqual(armsOf('Both'), []);
  });
});
