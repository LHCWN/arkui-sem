// R1 foreach-key-stale: new objects under an unchanged ForEach key while the row renders what they change; and the
// nested-write fix text for a field a keyed ForEach renders.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are ArkTS sources, whose key generators are templates
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkFiles, type Finding } from '../../src/engine.js';
import type { CandidateOf } from '../../src/rules/candidate.js';
import { found, put, tempDir } from '../helpers.js';

const MODEL = `interface Song { id: number; title: string; liked: boolean; plays: number }
@Observed
class SongItem {
  id: number = 0
  title: string = ''
  liked: boolean = false
  constructor(id: number) { this.id = id }
}`;

const INLINE_ROW = 'Row() { Text(s.title); Text(s.liked ? "♥" : "") }';
const ID_KEY = '(s: Song) => `${s.id}`';

/** A V1 playlist: `members`, then a ForEach over `this.songs` with `row` and `key`, plus `extra` after the struct. */
const playlist = (members: string, opts: { row?: string; key?: string; head?: string; extra?: string } = {}) => `${
  opts.head ?? MODEL
}
@Component
struct Playlist {
  @State songs: Song[] = []
  private next: number = 0
${members}
  build() {
    List() {
      ForEach(this.songs, (s: Song) => {
        ListItem() { ${opts.row ?? INLINE_ROW} }
      }, ${opts.key ?? ID_KEY})
    }
  }
}
${opts.extra ?? ''}`;

const stale = (src: string) =>
  found(src).filter((c): c is CandidateOf<'foreach-key-stale'> => c.kind === 'foreach-key-stale');

const TOGGLE_MAP =
  '  like(id: number) {\n    this.songs = this.songs.map((s: Song) => s.id === id ? { id: s.id, title: s.title, liked: !s.liked, plays: s.plays } : s)\n  }';

describe('foreach-key-stale fires', () => {
  test('a map that rebuilds under an id key, inline row', () => {
    const src = playlist(TOGGLE_MAP);
    const [c, ...rest] = stale(src);
    assert.equal(rest.length, 0);
    assert.equal(c.line, src.split('\n').findIndex((l) => l.includes('ForEach(')) + 1);
    assert.equal(c.fingerprint, 'T.ets#Playlist.songs#R1-foreach-key@(s: Song) => `${s.id}`');
    assert.deepEqual(
      c.rebuilds.map((r) => [r.write.method, r.element.form, r.stale]),
      [['like', 'map', ['liked']]],
    );
    assert.deepEqual(
      c.staleReads.map((r) => r.via.kind),
      ['inline'],
    );
    assert.equal(c.statefulRow, false);
  });

  test('each rebuild form: a loop push, a copy at an index, an index write, a splice, an alias', () => {
    for (const body of [
      'const out: Song[] = []\n    for (const s of this.songs) { out.push(s.id === id ? { ...s, liked: true } : s) }\n    this.songs = out',
      'const copy = [...this.songs]\n    const old = copy[id]\n    copy[id] = { ...old, liked: true }\n    this.songs = copy',
      'this.songs[id] = { ...this.songs[id], liked: true }',
      'this.songs.splice(id, 1, Object.assign({}, this.songs[id], { liked: true }))',
      'const next = this.songs.map((s: Song) => ({ ...s, liked: s.id === id }))\n    this.songs = next',
    ]) {
      const candidates = stale(playlist(`  like(id: number) {\n    ${body}\n  }`));
      assert.deepEqual(
        candidates.map((c) => c.rebuilds.map((r) => r.stale)),
        [[['liked']]],
        body,
      );
    }
  });

  test('a key property set to the value its guard compares the element with is kept', () => {
    const body = `  like(sel: number) {
    this.songs = this.songs.map((s: Song) => {
      if (s.id !== sel) {
        return s
      }
      let u: Song = { id: sel, title: s.title, liked: true, plays: s.plays }
      return u
    })
  }`;
    assert.equal(stale(playlist(body)).length, 1);
  });

  test('an index key with a copy written at the row index, from a handler in the row', () => {
    const src = playlist('', {
      row: `Row() {
          Text(s.title)
          Button(s.liked ? 'unlike' : 'like').onClick(() => {
            const copy = [...this.songs]
            copy[i] = { id: s.id, title: s.title, liked: !s.liked, plays: s.plays }
            this.songs = copy
          })
        }`,
      key: '(s: Song, i: number) => `${i}`',
    }).replace('(s: Song) => {\n        ListItem', '(s: Song, i: number) => {\n        ListItem');
    const [c] = stale(src);
    assert.deepEqual(c.rebuilds[0].stale, ['liked']);
    assert.equal(c.staleReads[0].attribute, undefined);
  });

  test('rows through a @Builder, a @Prop child and an @ObjectLink child', () => {
    const builder = playlist(`${TOGGLE_MAP}\n  @Builder Line(s: Song) { Text(s.liked ? 'on' : 'off') }`, {
      row: 'this.Line(s)',
    });
    const child = (decorator: string, type: string) =>
      playlist(TOGGLE_MAP, {
        row: 'SongRow({ song: s })',
        extra: `@Component
struct SongRow {
  ${decorator} song: ${type}
  build() { Text(this.song.liked ? 'on' : 'off') }
}`,
      });
    assert.deepEqual(
      [builder, child('@Prop', 'Song'), child('@ObjectLink', 'SongItem')].map((src) =>
        stale(src).flatMap((c) => c.staleReads.map((r) => r.via)),
      ),
      [
        [{ kind: 'builder', name: 'Line' }],
        [{ kind: 'child', child: 'SongRow', field: 'song', decorators: ['@Prop'] }],
        [{ kind: 'child', child: 'SongRow', field: 'song', decorators: ['@ObjectLink'] }],
      ],
    );
  });

  test('a row with an input or a child with its own state is stateful', () => {
    const input = playlist(TOGGLE_MAP, { row: 'Row() { Text(s.liked ? "on" : "off"); TextInput({ text: s.title }) }' });
    const child = playlist(TOGGLE_MAP, {
      row: 'Row() { Text(s.liked ? "on" : "off"); Rater() }',
      extra: '@Component\nstruct Rater {\n  @State stars: number = 0\n  build() { Text(String(this.stars)) }\n}',
    });
    assert.deepEqual(
      [input, child].map((src) => stale(src)[0].statefulRow),
      [true, true],
    );
  });

  test('two loops over the field with the same key text: a counter on the second', () => {
    const src = playlist(TOGGLE_MAP).replace(
      '    List() {',
      `    Column() {
      ForEach(this.songs.filter((s: Song) => s.plays > 0), (s: Song) => { Text(s.liked ? 'x' : '') }, ${ID_KEY})
    }
    List() {`,
    );
    assert.deepEqual(
      stale(src).map((c) => c.fingerprint.split('#').at(-1)),
      ['R1-foreach-key@(s: Song) => `${s.id}`', 'R1-foreach-key@(s: Song) => `${s.id}`~2'],
    );
  });

  test('a filtered loop: a change to a property the filter reads moves the element instead', () => {
    const src = playlist(TOGGLE_MAP).replace(
      'ForEach(this.songs,',
      'ForEach(this.songs.filter((s: Song) => !s.liked),',
    );
    assert.deepEqual(stale(src), []);
    const unknown = playlist(TOGGLE_MAP).replace('ForEach(this.songs,', 'ForEach(this.songs.filter(this.visible),');
    assert.deepEqual(stale(unknown), []);
  });

  test('a nested change: stale only where the row reads it, named by its path', async () => {
    const retitle =
      "  retitle(i: number) {\n    this.songs[i] = { ...this.songs[i], album: { ...this.songs[i].album, title: 'x' } }\n  }";
    assert.deepEqual(stale(playlist(retitle, { row: 'Text(s.album.year)' })), []);
    const src = playlist(retitle, { row: 'Row() { Text(s.album.title); Text(s.album.year) }' });
    assert.deepEqual(
      stale(src).map((c) => c.rebuilds.map((r) => r.stale)),
      [[['album.title']]],
    );
    const [f] = (await findingsOf(src)).filter((x) => x.kind === 'foreach-key-stale');
    assert.match(f.evidence, /still shows the old album\.title/);
    assert.match(f.fix, /e\.g\. \(s\) => `\$\{s\.id\}-\$\{s\.album\.title\}`/);
  });

  test('a new instance under the key: the key property the row shows is not stale', () => {
    const src = playlist('  reset(i: number) {\n    this.songs[i] = new SongItem(this.songs[i].id)\n  }', {
      row: 'Row() { Text(`#${s.id}`); Text(s.title) }',
    });
    assert.deepEqual(
      stale(src).map((c) => c.rebuilds.map((r) => r.stale)),
      [[['title']]],
    );
    const keyOnly = playlist('  reset(i: number) {\n    this.songs[i] = new SongItem(this.songs[i].id)\n  }', {
      row: 'Text(`#${s.id}`)',
    });
    assert.deepEqual(stale(keyOnly), []);
  });
});

describe('foreach-key-stale does not fire', () => {
  test('deletes, appends, reorders, and rebuilds the row does not render or that change the key', () => {
    for (const body of [
      'this.songs = this.songs.filter((s: Song) => s.id !== id)',
      'const out: Song[] = []\n    for (const s of this.songs) { if (s.id !== id) { out.push(s) } }\n    this.songs = out',
      "this.songs.push({ id: this.next++, title: 'new', liked: false, plays: 0 })",
      "this.songs = [...this.songs, { id: this.next++, title: 'new', liked: false, plays: 0 }]",
      'this.songs = [...this.songs].sort((a: Song, b: Song) => a.plays - b.plays)',
      'this.songs = this.songs.map((s: Song) => ({ ...s, plays: s.plays + 1 }))',
      'this.songs = this.songs.map((s: Song) => ({ ...s, id: this.next++, liked: true }))',
      'this.songs = this.songs.map((s: Song) => s.id !== id ? { ...s, id, liked: true } : s)',
    ]) {
      assert.deepEqual(stale(playlist(`  edit(id: number) {\n    ${body}\n  }`)), [], body);
    }
  });

  test('a key that holds the changed property, the default key, the whole item', () => {
    for (const key of ['(s: Song) => `${s.id}-${s.liked}`', 'undefined', '(s: Song) => JSON.stringify(s)']) {
      assert.deepEqual(stale(playlist(TOGGLE_MAP, { key })), [], key);
    }
    assert.deepEqual(stale(playlist(TOGGLE_MAP).replace(', (s: Song) => `${s.id}`)', ')')), []);
  });

  test('a changed property read only in a handler of the row', () => {
    const row = 'Row() { Text(s.title).onClick(() => { console.info(String(s.liked)) }) }';
    assert.deepEqual(stale(playlist(TOGGLE_MAP, { row })), []);
  });

  test('a V2 component', () => {
    const src = playlist(TOGGLE_MAP)
      .replace('@Component\nstruct Playlist', '@ComponentV2\nstruct Playlist')
      .replace('@State songs', '@Local songs');
    assert.deepEqual(stale(src), []);
  });

  test('a loop over something else that starts from the field', () => {
    const src = playlist(TOGGLE_MAP).replace('ForEach(this.songs,', 'ForEach(this.songs.map((s: Song) => s),');
    assert.deepEqual(stale(src), []);
  });

  test('a rebuild before the first render, at another index, or flattening nested items', () => {
    for (const members of [
      `  aboutToAppear() {
    this.songs = this.songs.map((s: Song) => ({ ...s, liked: true }))
  }`,
      `  move(i: number, j: number) {
    const c = [...this.songs]
    if (c[j].id === 5) {
      c[i] = { id: 5, title: '', liked: true, plays: 0 }
    }
    c[i] = { ...c[j], liked: true }
    this.songs = c
  }`,
      `  split(parts: string[]) {
    const out: Song[] = []
    for (const s of this.songs) {
      for (const t of parts) { out.push({ ...s, title: t, liked: false }) }
    }
    this.songs = out
  }`,
    ]) {
      assert.deepEqual(stale(playlist(members)), [], members);
    }
  });

  test('a rebuild in a deferred callback of aboutToAppear fires', () => {
    const members = `  aboutToAppear() {
    setTimeout(() => { this.songs = this.songs.map((s: Song) => ({ ...s, liked: true })) }, 10)
  }`;
    assert.equal(stale(playlist(members)).length, 1);
  });

  test('a helper only aboutToAppear calls runs before the first render; one a handler also calls does not', () => {
    const init = `  private init() {
    this.songs = this.songs.map((s: Song) => ({ ...s, liked: false }))
  }`;
    assert.deepEqual(stale(playlist(`  aboutToAppear() {\n    this.init()\n  }\n${init}`)), []);
    const tapped = playlist(`  aboutToAppear() {\n    this.init()\n  }\n${init}`, {
      row: 'Row() { Text(s.liked ? "on" : "off").onClick(() => { this.init() }) }',
    });
    assert.equal(stale(tapped).length, 1);
    const awaited = `  async aboutToAppear() {\n    await this.load()\n    this.init()\n  }\n  async load() {}\n${init}`;
    assert.equal(stale(playlist(awaited)).length, 1);
  });

  test('a disable comment above the ForEach call, above the field, or above the write', () => {
    const above = playlist(TOGGLE_MAP).replace(
      '      ForEach(this.songs,',
      '      // arkui-sem-disable-next-line R1 -- rows are rebuilt by the parent\n      ForEach(this.songs,',
    );
    const field = playlist(TOGGLE_MAP).replace(
      '  @State songs',
      '  // arkui-sem-disable-next-line R1 -- rows are rebuilt by the parent\n  @State songs',
    );
    const write = playlist(TOGGLE_MAP).replace(
      '    this.songs = this.songs.map',
      '    // arkui-sem-disable-next-line R1 -- rows are rebuilt by the parent\n    this.songs = this.songs.map',
    );
    for (const src of [above, field, write]) {
      assert.deepEqual(stale(src), []);
    }
  });
});

/** The findings of one file, with the stub judge of every judged kind left out. */
async function findingsOf(src: string): Promise<Finding[]> {
  const path = put(join(tempDir(), 'Playlist.ets'), src);
  const none = { name: 'none', systemOne: async () => ({ backend: 'none', latencyMs: 0, answers: {} }) } as never;
  const { findings } = await checkFiles([path], { backend: none });
  return findings;
}

describe('foreach-key-stale findings', () => {
  test('a finding decided by the facts, with evidence, related lines and the key route first', async () => {
    const [f] = (await findingsOf(playlist(TOGGLE_MAP))).filter((x) => x.kind === 'foreach-key-stale');
    assert.equal(f.band, 'finding');
    assert.equal(f.p, null);
    assert.match(
      f.evidence,
      /^like\(\) put new objects that keep the ForEach key \(\(s: Song\) => `\$\{s\.id\}`, line 18\)/,
    );
    assert.match(f.evidence, /still shows the old liked \(row: inline\)/);
    assert.deepEqual(
      f.related?.map((r) => r.line),
      [14],
    );
    assert.match(f.fix, /^make the key change with what the row shows, e\.g\. \(s\) => `\$\{s\.id\}-\$\{s\.liked\}`/);
    assert.doesNotMatch(f.fix, /remove the key|drop the key|without a key/);
  });

  test('a stateful row leads with the @ObjectLink route; new class instances make a question', async () => {
    const input = playlist(TOGGLE_MAP, { row: 'Row() { Text(s.liked ? "on" : "off"); TextInput({ text: s.title }) }' });
    const [a] = (await findingsOf(input)).filter((x) => x.kind === 'foreach-key-stale');
    assert.match(
      a.fix,
      /^the row holds state of its own, so keep the key, make the items instances of an @Observed class/,
    );
    const instances = playlist('  reset(i: number) {\n    this.songs[i] = new SongItem(this.songs[i].id)\n  }');
    const [b] = (await findingsOf(instances)).filter((x) => x.kind === 'foreach-key-stale');
    assert.equal(b.band, 'question');
    assert.match(b.evidence, /new class instances, which may keep the ForEach key/);
  });
});

describe('nested-write fix text with a keyed ForEach', () => {
  const nested = (key: string) =>
    playlist('  play(i: number) {\n    this.songs[i].plays++\n  }', { row: 'Text(`${s.title} ${s.plays}`)', key });

  test('names the key and a key that changes with the written property', async () => {
    const [f] = (await findingsOf(nested(ID_KEY))).filter((x) => x.kind === 'nested-write-unobserved');
    assert.match(f.fix, /make the ForEach key at line 18 \(\(s: Song\) => `\$\{s\.id\}`\) change with it/);
    assert.match(f.fix, /e\.g\. \(s\) => `\$\{s\.id\}-\$\{s\.plays\}`/);
    assert.match(f.fix, /@ObjectLink/);
  });

  test('keeps the first-layer text without a keyed ForEach over the field', async () => {
    const [f] = (await findingsOf(nested('undefined'))).filter((x) => x.kind === 'nested-write-unobserved');
    assert.match(f.fix, /^change it at the first layer instead/);
  });

  test('keeps the first-layer text for an element of a nested array', async () => {
    const src = `@Component
struct Board {
  @State grid: number[][] = []
  set(i: number, j: number) {
    this.grid[i][j] = 1
  }
  build() {
    Column() {
      ForEach(this.grid, (row: number[]) => { Text(row.join()) }, (row: number[], i: number) => i.toString())
    }
  }
}`;
    const [f] = (await findingsOf(src)).filter((x) => x.kind === 'nested-write-unobserved');
    assert.match(f.fix, /^change it at the first layer instead/);
  });

  test('a write two properties below the element: the example key holds the whole path', async () => {
    const src = playlist('  rate(i: number) {\n    this.songs[i].album.year++\n  }', {
      row: 'Text(`${s.album.year}`)',
    });
    const [f] = (await findingsOf(src)).filter((x) => x.kind === 'nested-write-unobserved');
    assert.match(f.fix, /\{ \.\.\.old, album: … \}/);
    assert.match(f.fix, /e\.g\. \(s\) => `\$\{s\.id\}-\$\{s\.album\.year\}`/);
  });
});
