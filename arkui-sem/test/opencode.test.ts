// The opencode plugin with a mock client, the heuristic backend and test/fixtures/fake-ace-server.mjs as the language
// server. Tests run in order: later ones depend on what earlier ones reported.

import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArkuiSemPlugin } from '../src/opencode.js';
import { put, ROOT, tempDir } from './helpers.js';

const data = tempDir();
process.env.ARKUI_SEM_DATA_DIR = data;
process.env.ARKUI_SEM_BACKEND = 'heuristic';
process.env.ARKUI_SEM_CONFIG = join(data, 'no-user-config.json'); // ignore any real user config

copyFileSync(
  join(ROOT, 'test', 'fixtures', 'fake-ace-server.mjs'),
  put(join(data, 'server', 'out', 'standardIndex', 'index.js'), ''),
);
process.env.ARKUI_SEM_ACE_SERVER = join(data, 'server');
// No ets-loader inside, so the parser keeps its bundled options.
process.env.ARKUI_SEM_SDK = join(data, 'sdk');
put(join(data, 'sdk', 'default', 'openharmony', '.keep'), '');
process.env.ARKUI_SEM_LSP_NODE = process.execPath;
delete process.env.ARKUI_SEM_LSP;

const prompts: any[] = [];
const logs: string[] = [];
const serverLogs = () => logs.filter((m) => m.includes('language server'));
const client = {
  app: {
    log: async (opts: { body: { message: string } }) => {
      logs.push(opts.body.message);
    },
  },
  session: {
    promptAsync: async (opts: unknown) => {
      prompts.push(opts);
    },
  },
};
const input = {
  client,
  directory: ROOT,
  worktree: ROOT,
  project: {},
  serverUrl: new URL('http://localhost'),
  $: undefined,
  experimental_workspace: { register() {} },
} as any;
const hooks: any = await ArkuiSemPlugin(input);

/** Runs the tool.execute.after hook and returns the tool output it leaves. */
const after = async (tool: string, args: object, sessionID = 's1') => {
  const output = { title: '', output: 'ok', metadata: {} };
  await hooks['tool.execute.after']({ tool, sessionID, callID: 'c', args }, output);
  return output.output;
};
const idle = (sessionID: string) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
const ctx = {
  sessionID: 's1',
  messageID: 'm',
  agent: 'build',
  directory: ROOT,
  worktree: ROOT,
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
};

test('edit on .ets appends new findings and questions to the tool output', async () => {
  const out = await after('edit', { filePath: 'test/fixtures/Feed.ets', oldString: 'a', newString: 'b' });
  assert.match(out, /^ok\n\narkui-sem: 1 finding\(s\), 1 question\(s\)/);
  assert.match(out, /Feed\.items/);
  assert.match(out, /\[R1\?\].*Feed\.lastFetchMs/);
});

test('re-editing the same file reports nothing already reported', async () => {
  assert.equal(await after('edit', { filePath: 'test/fixtures/Feed.ets' }), 'ok');
});

test('non-.ets edits and non-editing tools are ignored', async () => {
  assert.equal(await after('write', { filePath: 'README.md', content: 'x' }), 'ok');
  assert.equal(await after('read', { filePath: 'test/fixtures/Counter.ets' }), 'ok');
});

test('apply_patch: files are taken from the patch headers', async () => {
  const patchText = '*** Begin Patch\n*** Update File: test/fixtures/Ticker.ets\n@@\n-a\n+b\n*** End Patch';
  const out = await after('apply_patch', { patchText });
  assert.match(out, /Ticker emitter\.on:refresh/);
  assert.match(out, /Ticker timer:this\.pollId/);
});

test('session.idle sends one follow-up listing confident findings', async () => {
  await idle('s1');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].path.id, 's1');
  const text = prompts[0].body.parts[0].text;
  assert.match(text, /3 finding\(s\)/);
  assert.doesNotMatch(text, /lastFetchMs/, 'questions never go through the gate');
});

test('the gate does not repeat for the same set of findings', async () => {
  await idle('s1');
  assert.equal(prompts.length, 1);
});

test('idle sessions with no .ets edits are left alone', async () => {
  await idle('other');
  assert.equal(prompts.length, 1);
});

test('arkui_check tool scans a directory', async () => {
  const out = await hooks.tool.arkui_check.execute({ paths: ['test/fixtures'] }, ctx);
  assert.match(out, /6 finding\(s\), 1 question\(s\)/);
  assert.match(out, /NotePage\.ets:\d+ NotePage\.note/);
});

test('the first .ets edit started the language server; dispose stops it and later edits start none', async () => {
  for (let waited = 0; serverLogs().length === 0 && waited < 10_000; waited += 20) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(serverLogs().join(' '), /language server ready for .*fixtures \(standard\)/);
  await hooks.dispose();
  assert.match(await after('edit', { filePath: 'test/fixtures/Counter.ets' }, 's2'), /Counter/);
  assert.equal(serverLogs().length, 1);
});

test('lsp: off starts no language server', async () => {
  const off: any = await ArkuiSemPlugin(input, { lsp: 'off' });
  const output = { title: '', output: 'ok', metadata: {} };
  await off['tool.execute.after'](
    { tool: 'edit', sessionID: 's3', callID: 'c', args: { filePath: 'test/fixtures/Counter.ets' } },
    output,
  );
  await off.dispose();
  assert.match(output.output, /Counter/);
  assert.equal(serverLogs().length, 1);
});
