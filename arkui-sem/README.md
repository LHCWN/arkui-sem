# arkui-sem

Semantic lint for ArkTS/ArkUI declarative state, built for the coding-agent loop. It ships as an
[opencode](https://opencode.ai) v1 plugin and a CLI. Prototype.

It targets UI state desynchronization: a field that is written and rendered but not reactive, a nested write
that V1 `@State` does not observe, a callback or `@Event` a child calls and no parent passes, a resource that
is never released. A fact extractor finds candidates; a small "System One" judge model scores each one; scores
of 0.8 and above become findings, scores from 0.5 to 0.8 become questions back to the agent. The unwired
callback is decided by the facts alone, with no judge call.

## Build and test

```sh
npm install
npm test          # typechecks, then runs test/**/*.test.ts from src/ (offline, heuristic backend)
```

## Use in opencode or DevEco Code

```sh
node scripts/install.mjs <project-dir>            # .opencode/plugins/arkui-sem.ts
node scripts/install.mjs --global                 # ~/.config/opencode/plugins/
node scripts/install.mjs <project-dir> --deveco   # .deveco/plugins/arkui-sem.ts (DevEco Code)
node scripts/install.mjs --global --deveco        # ~/.config/deveco/plugins/
node scripts/install.mjs <project-dir> --uninstall   # also with --global and/or --deveco
```

The plugin re-exports this checkout's `dist/opencode.js`: rebuild, then restart the agent. It reviews `.ets`
edits after each tool call, gates the session once on idle while findings remain open, and adds the tool
`arkui_check`.

## CLI

```sh
node dist/cli.js check <file.ets|dir>... [--format agent|json] [--backend <name>]
node dist/cli.js config [--init]           # prints masked key fragments
node dist/cli.js lsp <definition|references|callers|callees> <file.ets> <line:col> [--project <dir>] [--ace-server <dir>] [--sdk <dir>] [--node <path>] [--verbose]
```

`lsp` queries Huawei's ArkTS language server (ace-server, not bundled): DevEco Studio's own (default install on Windows
and macOS), or the build `ARKUI_SEM_ACE_SERVER` / `--ace-server` points to; a build with `out/standardIndex/index.js`
(DevEco 26+) is driven over standard LSP. The SDK comes from DevEco Studio or `ARKUI_SEM_SDK`; `ARKUI_SEM_LSP_NODE`
picks the node that runs the server.

The plugin starts the same server in the background on the first `.ets` edit of a project, sends it each edited
file, and stops it when opencode disposes the plugin. Nothing waits for it: without a server, or while it starts, checks
run as before. No rule asks it anything so far. `"lsp": "off"` in a config file, or `ARKUI_SEM_LSP=off`, keeps it
from starting (default `auto`); on a large project the server takes minutes and several GB to start.
The server follows imports by package name only in a project with `oh_modules` links (after a DevEco sync or
`ohpm install`); the rules don't depend on that, they use the project index.

## Backends and configuration

| Backend | What it is |
|---|---|
| `clef` (default) | Cloudflare Clef |
| `clef-flash` | Cloudflare Clef-flash |
| `or-clef`, `or-clef-flash` | the same Clef models through OpenRouter's Decisions API (`OPENROUTER_API_KEY` or `openrouter.apiKey`) |
| `jev` | TypeSafe Jev |
| `deepseek-flash` | DeepSeek flash with structured output |
| `laya` | a local TypeSafe-compatible server (`laya.baseUrl`, default `http://127.0.0.1:8080`) |
| `heuristic` | offline rules, no model; used by the tests |

Any backend can be tried on your own files: `node dist/cli.js check <file.ets> --backend <name>`.

Settings merge in this order: defaults < `~/.config/arkui-sem/config.json` < `.opencode/arkui-sem.json`
(or `.deveco/arkui-sem.json` when only that one exists) < environment (`ARKUI_SEM_*`; `ARKUI_SEM_CONFIG` points at another config file) < plugin options.
API keys belong in the user config file only; `node dist/cli.js config --init` writes a starter file.
