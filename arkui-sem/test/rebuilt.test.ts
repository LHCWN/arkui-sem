// The rebuilt fact: new objects a write puts where a field's elements were.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RebuiltElement } from '../src/facts.js';
import { extract } from './helpers.js';

/** A playlist component with `extra` members; the rebuilt elements of each write of `songs`, in source order. */
const rebuilt = (extra: string): Omit<RebuiltElement, 'line'>[] => {
  const src = `interface Song { id: number; title: string; liked: boolean }
@Component
struct Playlist {
  @State songs: Song[] = []
  ${extra}
  build() {
    Column() {}
  }
}`;
  const songs = extract(src).components[0].fields[0];
  return songs.writes.flatMap((w) => (w.rebuilt ?? []).map(({ line: _, ...r }) => r));
};

const literal = (form: RebuiltElement['form'], kept: string[], changed: string[], keepsRest = false) => ({
  form,
  value: 'object-literal' as const,
  kept,
  changed,
  keepsRest,
});

describe('rebuilt forms', () => {
  test('map: an arrow returning a ternary, a block with returns, and through a local', () => {
    assert.deepEqual(
      rebuilt(`like(id: number) {
    this.songs = this.songs.map((s) => s.id === id ? { id: s.id, title: s.title, liked: !s.liked } : s)
  }`),
      [literal('map', ['id', 'title'], ['liked'])],
    );
    assert.deepEqual(
      rebuilt(`like(id: number) {
    const next = this.songs.map((s: Song) => {
      if (s.id !== id) {
        return s
      }
      return { ...s, liked: true }
    })
    this.songs = next
  }`),
      [literal('map', [], ['liked'], true)],
    );
  });

  test('a loop over the field pushing into a local: for-of, an index loop and forEach', () => {
    for (const loop of [
      'for (const s of this.songs) { out.push({ id: s.id, title: s.title, liked: false }) }',
      'for (let i = 0; i < this.songs.length; i++) { out.push({ id: this.songs[i].id, title: this.songs[i].title, liked: false }) }',
      'this.songs.forEach((s) => { out.push({ id: s.id, title: s.title, liked: false }) })',
    ]) {
      assert.deepEqual(
        rebuilt(`reset() {
    const out: Song[] = []
    ${loop}
    this.songs = out
  }`),
        [literal('loop', ['id', 'title'], ['liked'])],
        loop,
      );
    }
  });

  test('a copy written at an index, then assigned', () => {
    for (const copy of ['[...this.songs]', 'this.songs.slice()']) {
      assert.deepEqual(
        rebuilt(`like(i: number) {
    const copy = ${copy}
    const old = copy[i]
    copy[i] = { id: old.id, title: 'x', liked: true }
    this.songs = copy
  }`),
        [literal('copy-index', ['id'], ['title', 'liked'])],
        copy,
      );
    }
  });

  test('an index write and a splice on the field; Object.assign and new', () => {
    assert.deepEqual(
      rebuilt(`like(i: number) {
    this.songs[i] = Object.assign({}, this.songs[i], { liked: true })
    this.songs.splice(i, 1, new SongItem(1))
  }`),
      [
        literal('index', [], ['liked'], true),
        { form: 'splice', value: 'new', kept: [], changed: [], keepsRest: false },
      ],
    );
  });

  test('an index write in a ForEach row over the field keeps what it copies from the item', () => {
    const src = `interface Song { id: number; liked: boolean }
@Component
struct Playlist {
  @State songs: Song[] = []
  build() {
    Column() {
      ForEach(this.songs, (s: Song, i: number) => {
        Text('x').onClick(() => {
          const copy = [...this.songs]
          copy[i] = { id: s.id, liked: !s.liked }
          this.songs = copy
        })
      }, (s: Song) => \`\${s.id}\`)
    }
  }
}`;
    const songs = extract(src).components[0].fields[0];
    assert.deepEqual(
      songs.writes.flatMap((w) => w.rebuilt ?? []).map((r) => [r.kept, r.changed]),
      [[['id'], ['liked']]],
    );
  });
});

describe('kept properties', () => {
  test('a value equal to a guard on the element: ternary, if, an && chain, an early return, shorthand', () => {
    for (const cb of [
      '(s) => s.id === sel ? { id: sel, title: s.title, liked: true } : s',
      '(s) => { if (s.title !== "" && sel === s.id) { return { id: sel, title: s.title, liked: true } } return s }',
      '(s) => { if (s.id !== sel) return s; let u: Song = { id: sel, title: s.title, liked: true }; return u }',
    ]) {
      assert.deepEqual(
        rebuilt(`like(sel: number) { this.songs = this.songs.map(${cb}) }`),
        [literal('map', ['id', 'title'], ['liked'])],
        cb,
      );
    }
    assert.deepEqual(
      rebuilt(
        `like(id: number) { this.songs = this.songs.map((s) => s.id === id ? { id, title: s.title, liked: true } : s) }`,
      ),
      [literal('map', ['id', 'title'], ['liked'])],
    );
  });

  test('a nested literal over a property of the element changes only what it sets', () => {
    assert.deepEqual(
      rebuilt(`retitle(i: number) {
    this.songs[i] = { ...this.songs[i], album: { ...this.songs[i].album, title: 'x' } }
    this.songs[i] = { ...this.songs[i], album: { ...this.songs[i].album } }
    this.songs[i] = { ...this.songs[i], album: { title: 'x' } }
    this.songs[i] = { ...this.songs[i], album: { id: this.songs[i].album.id, title: 'x' } }
  }`),
      [
        literal('index', [], ['album.title'], true),
        literal('index', ['album'], [], true),
        literal('index', [], ['album'], true),
        literal('index', ['album.id'], ['album'], true),
      ],
    );
  });

  test('Object.assign lays its sources over one another in order', () => {
    assert.deepEqual(
      rebuilt(`like(i: number) {
    this.songs[i] = Object.assign({}, { liked: true }, this.songs[i])
    this.songs[i] = Object.assign({}, this.songs[i], { liked: true })
  }`),
      [literal('index', ['liked'], [], true), literal('index', [], ['liked'], true)],
    );
  });

  test('a value from another object, a later override and a guard that does not hold are changes', () => {
    assert.deepEqual(
      rebuilt(`like(o: Song, sel: number) {
    this.songs = this.songs.map((s) => s.id !== sel ? { id: sel, title: o.title, liked: true } : s)
    this.songs = this.songs.map((s) => ({ ...s, id: this.next++ }))
  }`),
      [literal('map', [], ['id', 'title', 'liked']), literal('map', [], ['id'], true)],
    );
  });
});

describe('not rebuilt', () => {
  test('filter, a loop that skips, push, an appending spread, a sort, a map to non-objects', () => {
    assert.deepEqual(
      rebuilt(`edit(id: number, s: Song) {
    this.songs = this.songs.filter((x) => x.id !== id)
    const kept: Song[] = []
    for (const x of this.songs) { if (x.id !== id) { kept.push(x) } }
    this.songs = kept
    this.songs.push({ id: 9, title: 't', liked: false })
    this.songs = [...this.songs, { id: 9, title: 't', liked: false }]
    this.songs = [...this.songs].sort((a, b) => a.id - b.id)
    this.songs = this.songs.map((x) => x)
  }`),
      [],
    );
  });

  test('a push outside a loop over the field, a local assigned twice, a var', () => {
    assert.deepEqual(
      rebuilt(`edit(other: Song[]) {
    const out: Song[] = []
    for (const x of other) { out.push({ id: x.id, title: x.title, liked: true }) }
    this.songs = out
    let twice = this.songs.map((x) => ({ ...x, liked: true }))
    twice = []
    this.songs = twice
    var v = this.songs.map((x) => ({ ...x, liked: true }))
    this.songs = v
  }`),
      [],
    );
  });
});
