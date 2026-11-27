# arkui-sem

Semantic lint for ArkTS/ArkUI declarative state, built for the coding-agent loop. It ships as an
[opencode](https://opencode.ai) v1 plugin and a CLI. Prototype.

It targets UI state desynchronization: a field that is written and rendered but not reactive, a nested write
that V1 `@State` does not observe, a list that doesn't redraw what changed (a `ForEach` that replaces items
under an unchanged key or keys rows by index over items that change, a `LazyForEach` whose data source is
created while drawing or reassigned), a callback or `@Event` a child calls and no parent passes, a resource that
is never released, a text input wired to its field one way (the field is set by code but not shown, or
typed into but read nowhere), a selection the rows compare against that nothing sets. A fact extractor finds
candidates; a small "System One" judge model scores each one; scores of 0.8 and above become findings, scores
from 0.5 to 0.8 become questions back to the agent. The list kinds, the unwired callback and the input and
selection wiring are decided by the facts alone, with no judge call; some of them are asked as questions (an
input nothing reads, a selection nothing sets).

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
```

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
The parser takes its ArkTS options from the HarmonyOS SDK: `ARKUI_SEM_SDK`, else DevEco Studio's (default install, or
`DEVECO_STUDIO`); without one it uses the options bundled with the linter.
