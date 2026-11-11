// The ArkTS LSP client against test/fixtures/fake-ace-server.mjs, installed in Studio (legacy) and CLT (standard)
// layouts under a temp dir.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ArktsLsp, locations, startArktsLsp } from '../src/lsp/client.js';
import { JsonRpc } from '../src/lsp/jsonrpc.js';
import { findModuleDirs, initializeParams, projectRootFor, toFileUri } from '../src/lsp/project.js';
import { defaultNode, locateServer, resolvePaths } from '../src/lsp/server.js';
import { WarmLsp } from '../src/lsp/warm.js';
import { put, ROOT, tempDir } from './helpers.js';

const tmp = tempDir();
const at = (rel: string) => join(tmp, rel);
for (const entry of ['clt/out/standardIndex/index.js', 'studio/plugins/openharmony/ace-server/out/index.js']) {
  copyFileSync(join(ROOT, 'test', 'fixtures', 'fake-ace-server.mjs'), put(at(entry), ''));
}
put(at('sdk/default/openharmony/ets/api/.keep'), '');
put(at('sdk/default/sdk-pkg.json'), { data: { apiVersion: '24', version: '6.1.1.125' } });
const page = put(at('proj/entry/src/main/ets/pages/P.ets'), '@Component\nstruct P {\n  build() {}\n}\n');
// Explicit paths everywhere, so ARKUI_SEM_* variables on the machine can't change the outcome.
// maxOldSpaceMb: undefined must keep the default, as optional settings are passed through that way.
const base = {
  sdk: at('sdk'),
  node: process.execPath,
  initTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  maxOldSpaceMb: undefined,
};

test('modules are the */src/main/ets dirs; the project root is above them', () => {
  put(at('proj/features/lib/src/main/ets/A.ets'), 'P()');
  assert.deepEqual(findModuleDirs(at('proj')).sort(), [at('proj/entry'), at('proj/features/lib')]);
  assert.equal(projectRootFor(page), at('proj'));
  put(at('proj2/build-profile.json5'), "{ modules: [{ name: 'entry', srcPath: './entry' }] }");
  put(at('proj2/entry/build-profile.json5'), "{ apiType: 'stageMode' }");
  assert.equal(projectRootFor(put(at('proj2/entry/src/main/ets/B.ets'), '')), at('proj2'));
});

test('the server is told the modules of the build profile, else the scanned ones', () => {
  const paths = resolvePaths({ aceServer: at('clt'), sdk: at('sdk'), node: process.execPath }, {});
  const names = (root: string) =>
    initializeParams(root, paths, at('work')).initializationOptions.modules.map((m) => m.moduleName);
  assert.deepEqual(names(at('proj')).sort(), ['entry', 'lib']);
  put(at('proj3/build-profile.json5'), "{ modules: [{ name: 'feature_lib', srcPath: './features/lib' }] }");
  put(at('proj3/features/lib/Index.ets'), '');
  put(at('proj3/unlisted/src/main/ets/A.ets'), '');
  assert.deepEqual(names(at('proj3')), ['feature_lib']);
});

test('file URIs use the upper-case drive form and round-trip through locations', () => {
  const uri = toFileUri(page);
  if (process.platform === 'win32') {
    assert.match(uri, /^file:\/\/\/[A-Z]%3A\//);
  }
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
  assert.deepEqual(locations(null), []);
  assert.equal(locations({ uri, range })[0].file, page);
  assert.equal(locations([{ targetUri: uri, targetSelectionRange: range }])[0].range, range);
});

test('locateServer finds Studio and CLT layouts and prefers the standard entry', () => {
  assert.equal(locateServer(at('clt'))?.protocol, 'standard');
  assert.equal(locateServer(at('studio'))?.protocol, 'legacy');
  assert.throws(() => resolvePaths({ aceServer: at('clt'), sdk: at('no-sdk') }, {}), /SDK not found/);
  assert.throws(() => resolvePaths({ aceServer: at('nothing'), sdk: at('sdk') }, {}), /no ace-server entry/);
});

test('the server comes from the option, else ARKUI_SEM_ACE_SERVER', () => {
  const options = { sdk: at('sdk'), node: process.execPath };
  const env = { ARKUI_SEM_ACE_SERVER: at('studio') };
  assert.equal(resolvePaths(options, env).server.protocol, 'legacy');
  assert.equal(resolvePaths({ ...options, aceServer: at('clt') }, env).server.protocol, 'standard');
});

test('under Bun (opencode) the server runs on node, not on process.execPath', () => {
  assert.equal(defaultNode(undefined, false), process.execPath);
  assert.equal(defaultNode(undefined, true), 'node');
  const bundled = put(
    at(process.platform === 'win32' ? 'studio/tools/node/node.exe' : 'studio/tools/node/bin/node'),
    '',
  );
  assert.equal(defaultNode(at('studio'), true), bundled);
});

test('a server that cannot start rejects instead of hanging', async () => {
  await assert.rejects(
    () => startArktsLsp(at('proj'), { ...base, aceServer: at('clt'), node: at('no-node') }),
    /failed to start|exited/,
  );
  await assert.rejects(() => startArktsLsp(at('sdk'), { ...base, aceServer: at('clt') }), /no ArkTS module/);
});

test('writing to a server that just exited does not crash the client', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = new JsonRpc(child);
  const exited = new Promise((r) => rpc.once('exit', r));
  const timer = setInterval(() => child.stdin.writable && child.stdin.write('x'.repeat(65536)), 5);
  await exited;
  clearInterval(timer);
  assert.equal(rpc.alive, false);
  await assert.rejects(() => rpc.request('shutdown', null, 1000), /not running/);
});

for (const [protocol, server] of [
  ['standard', 'clt'],
  ['legacy', 'studio'],
]) {
  test(`${protocol} protocol: initialize, open, change, definition, references, callers, callees, stop`, async () => {
    const lsp = await startArktsLsp(at('proj'), { ...base, aceServer: at(server) });
    const pos = { line: 1, character: 8 };
    try {
      assert.equal(lsp.protocol, protocol);
      lsp.open(page);
      lsp.open(page, '@Component\nstruct P {}\n');
      // The fake answers on the line of the document's last version: 2 means the change arrived.
      assert.deepEqual(
        (await lsp.definition(page, pos)).map((l) => [l.file, l.range.start.line]),
        [[page, 2]],
      );
      const refs = await lsp.references(page, pos);
      if (protocol === 'standard') {
        assert.deepEqual(
          refs.map((l) => l.range.start.line),
          [1, 7],
        );
      }
      // Legacy find-usages sees open documents only, and only the queried file is opened: A.ets stays closed.
      else {
        assert.deepEqual(
          refs.map((l) => l.file),
          [page],
        );
      }
      const callers = await lsp.callers(page, { line: 3, character: 3 });
      assert.deepEqual(
        callers.map((c) => [c.item.name, c.item.container, c.item.file, c.calls.map((r) => r.start.line)]),
        [['build', 'P', page, [9]]],
      );
      assert.deepEqual(
        (await lsp.callees(page, { line: 3, character: 3 })).map((c) => [c.name, c.selection.start.line]),
        [['save', 12]],
      );
      assert.throws(() => lsp.open(at('missing.ets')), /ENOENT/);
      lsp.close(page);
      if (protocol === 'legacy') {
        // A queried file that was closed is opened again.
        assert.ok((await lsp.references(page, pos)).some((l) => l.file === page));
      }
    } finally {
      await lsp.stop();
    }
    const started = Date.now();
    await assert.rejects(() => lsp.definition(page, { line: 0, character: 0 }), /not running/);
    assert.ok(Date.now() - started < 1000, 'a query after stop fails at once');
  });
}

const definitionLine = (lsp: ArktsLsp) =>
  lsp.definition(page, { line: 1, character: 8 }).then((l) => l[0].range.start.line);

test('warm server: edits made while it starts reach it before the first answer, later ones as they come', async () => {
  const logs: string[] = [];
  const warm = new WarmLsp((m) => logs.push(m), { ...base, aceServer: at('clt') });
  try {
    assert.equal(await warm.ask(page, 10_000, definitionLine), undefined, 'no edit, no server');
    warm.edited(page);
    assert.equal(await warm.ask(page, 10_000, definitionLine), 1);
    warm.edited(page);
    assert.equal(await warm.ask(page, 10_000, definitionLine), 2);
    assert.match(logs.join(' '), /language server ready .*standard/);
  } finally {
    await warm.stop();
  }
});

test('warm server: a missing, slow or dead server gives no answer and never throws', async () => {
  const logs: string[] = [];
  const missing = new WarmLsp((m) => logs.push(m), { ...base, aceServer: at('nothing') });
  missing.edited(page);
  assert.equal(await missing.ask(page, 10_000, definitionLine), undefined);
  assert.match(logs.join(' '), /no language server for .*no ace-server entry/);
  await missing.stop();

  const warm = new WarmLsp(() => undefined, { ...base, aceServer: at('studio') });
  try {
    warm.edited(page);
    const started = Date.now();
    assert.equal(await warm.ask(page, 1, definitionLine), undefined, 'still starting');
    assert.ok(Date.now() - started < 1000);
    assert.equal(await warm.ask(page, 10_000, definitionLine), 1);
    await warm.ask(page, 10_000, (lsp) => lsp.stop());
    assert.equal(await warm.ask(page, 10_000, definitionLine), undefined, 'dead');
    warm.edited(page);
    warm.edited(at('missing.ets'));
  } finally {
    await warm.stop();
  }
});

test('warm server: stop ends a running server and one still starting, and later edits start none', async () => {
  const starts: Promise<ArktsLsp>[] = [];
  const warm = new WarmLsp(
    () => undefined,
    { ...base, aceServer: at('clt') },
    (root, options) => {
      starts.push(startArktsLsp(root, options));
      return starts[starts.length - 1];
    },
  );
  warm.edited(page);
  const running = await starts[0];
  warm.edited(put(at('proj2/entry/src/main/ets/C.ets'), ''));
  await warm.stop();
  await assert.rejects(() => running.definition(page, { line: 0, character: 0 }), /not running/);
  await assert.rejects(starts[1], /exited|not running|aborted/i);
  warm.edited(page);
  assert.equal(starts.length, 2);
});
