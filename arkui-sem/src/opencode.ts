import { type Plugin, tool } from '@opencode-ai/plugin';
import { absolute, editedFiles, etsFiles } from './analysis.js';
import { cachePath, loadSettings } from './config.js';
import { checkFiles, type Finding, formatForAgent } from './engine.js';
import { createBackend, type SystemOneBackend } from './judge.js';
import { WarmLsp } from './lsp/warm.js';
import { ProjectIndex } from './project.js';

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch', 'apply_patch']);
const MAX_GATE_FOLLOWUPS = 3;
/** The wait for call sites after an edit, which holds the agent up, and at the idle gate, which doesn't. */
const EDIT_CALL_SITE_BUDGET_MS = 1000;
const GATE_CALL_SITE_BUDGET_MS = 10_000;

interface SessionState {
  touched: Set<string>;
  reported: Set<string>;
  lastGateKey: string;
  followups: number;
}

export const ArkuiSemPlugin: Plugin = async ({ client, directory }, options) => {
  const settings = loadSettings(options, directory);
  const sessions = new Map<string, SessionState>();
  let backend: SystemOneBackend | undefined;

  function log(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
    return client.app.log({ body: { service: 'arkui-sem', level, message } }).catch(() => undefined);
  }

  function session(id: string): SessionState {
    let s = sessions.get(id);
    if (!s) {
      s = { touched: new Set(), reported: new Set(), lastGateKey: '', followups: 0 };
      sessions.set(id, s);
    }
    return s;
  }

  const project = new ProjectIndex();
  const lsp = settings.lsp === 'off' ? undefined : new WarmLsp((message) => void log('info', message));

  async function run(files: string[], callSiteBudgetMs?: number): Promise<Finding[]> {
    backend ??= await createBackend(settings.backend, settings.credentials);
    const { findings, errors } = await checkFiles(files, {
      backend,
      thresholds: settings.thresholds,
      cachePath: cachePath(settings),
      judgeTimeoutMs: settings.judgeTimeoutMs,
      project,
      workspace: directory,
      callSiteBudgetMs,
    });
    if (errors.length) {
      await log('warn', errors.join('; '));
    }
    return findings;
  }

  await log(
    'info',
    `loaded (backend=${settings.backend}, gate=${settings.gate}, lsp=${settings.lsp}, config=${settings.sources.join(', ') || 'none'})`,
  );
  for (const w of settings.warnings) {
    await log('warn', w);
  }

  return {
    'tool.execute.after': async (input, output) => {
      if (!EDIT_TOOLS.has(input.tool)) {
        return;
      }
      const files = editedFiles(input.args, directory).filter((f) => f.endsWith('.ets'));
      if (files.length === 0) {
        return;
      }
      try {
        const s = session(input.sessionID);
        for (const f of files) {
          s.touched.add(f);
          lsp?.edited(f);
        }
        const fresh = (await run(files, EDIT_CALL_SITE_BUDGET_MS)).filter((f) => !s.reported.has(f.fingerprint));
        for (const f of fresh) {
          s.reported.add(f.fingerprint);
        }
        if (fresh.length > 0) {
          output.output = `${output.output}\n\n${formatForAgent(fresh, directory)}`;
        }
      } catch (e) {
        // Never break the agent loop because the linter failed.
        await log('error', `post-edit check failed: ${(e as Error).message}`);
      }
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle' || !settings.gate) {
        return;
      }
      const id = event.properties.sessionID;
      const s = sessions.get(id);
      if (!s || s.touched.size === 0) {
        return;
      }
      try {
        const confident = (await run([...s.touched], GATE_CALL_SITE_BUDGET_MS)).filter((f) => f.band === 'finding');
        const key = confident
          .map((f) => f.fingerprint)
          .sort()
          .join('|');
        if (confident.length === 0) {
          s.lastGateKey = '';
          return;
        }
        if (key === s.lastGateKey || s.followups >= MAX_GATE_FOLLOWUPS) {
          await log('info', `${confident.length} unresolved finding(s) in session ${id}; gate already used`);
          return;
        }
        s.followups++;
        s.lastGateKey = key;
        await client.session.promptAsync({
          path: { id },
          body: {
            parts: [
              {
                type: 'text',
                text: `${formatForAgent(confident, directory)}\n\nBefore finishing: fix these, or if one is intentional, add the disable comment with a reason.`,
              },
            ],
          },
        });
      } catch (e) {
        await log('error', `end-of-turn gate failed: ${(e as Error).message}`);
      }
    },

    dispose: async () => {
      await lsp?.stop();
    },

    tool: {
      arkui_check: tool({
        description:
          "Check ArkTS/ArkUI .ets files for state-management and lifecycle defects: state that won't re-render the UI, nested mutation of unobserved classes, callbacks and @Event a child calls that no parent passes, listeners and timers that are never released. Pass files or directories; defaults to the project.",
        args: {
          paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Files or directories to check, relative to the project'),
        },
        async execute(args, ctx) {
          const files = (args.paths?.length ? args.paths : ['.']).flatMap((p) => etsFiles(absolute(p, ctx.directory)));
          const findings = await run(files);
          return formatForAgent(findings, ctx.directory) || `arkui-sem: no findings in ${files.length} .ets file(s).`;
        },
      }),
    },
  };
};
