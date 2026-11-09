import { relative } from 'node:path';
import { type Plugin, tool } from '@opencode-ai/plugin';
import {
  absolute,
  type CallSites,
  classesWith,
  type Declaration,
  editedFiles,
  etsFiles,
  pathText,
  readLines,
} from './analysis.js';
import { cachePath, loadSettings } from './config.js';
import { checkFiles, type Finding, formatForAgent } from './engine.js';
import { createBackend, type SystemOneBackend } from './judge.js';
import { ProjectIndex } from './project.js';

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch', 'apply_patch']);
const MAX_GATE_FOLLOWUPS = 3;
/** The scan blocks opencode while it runs. */
const CALL_SITE_BUDGET_MS = 15_000;
const MAX_ARGUMENT_TEXT = 200;

/** Undefined when nothing could be searched: a failed project listing must not cost the file's own facts. */
function callSitesOf(project: ProjectIndex, decl: Declaration): CallSites | undefined {
  try {
    return project.callSites(decl, { budgetMs: CALL_SITE_BUDGET_MS });
  } catch {
    return undefined;
  }
}

function shortened(text: string): string {
  return text.length > MAX_ARGUMENT_TEXT ? `${text.slice(0, MAX_ARGUMENT_TEXT - 3)}...` : text;
}

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

  async function run(files: string[]): Promise<Finding[]> {
    backend ??= await createBackend(settings.backend, settings.credentials);
    const { findings, errors } = await checkFiles(files, {
      backend,
      thresholds: settings.thresholds,
      cachePath: cachePath(settings),
      judgeTimeoutMs: settings.judgeTimeoutMs,
      project,
    });
    if (errors.length) {
      await log('warn', errors.join('; '));
    }
    return findings;
  }

  await log(
    'info',
    `loaded (backend=${settings.backend}, gate=${settings.gate}, config=${settings.sources.join(', ') || 'none'})`,
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
        }
        const fresh = (await run(files)).filter((f) => !s.reported.has(f.fingerprint));
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
        const confident = (await run([...s.touched])).filter((f) => f.band === 'finding');
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

    tool: {
      arkui_check: tool({
        description:
          "Check ArkTS/ArkUI .ets files for state-management and lifecycle defects: state that won't re-render the UI, nested mutation of unobserved classes, listeners and timers that are never released. Pass files or directories; defaults to the project.",
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

      arkui_facts: tool({
        description:
          "Show ArkUI state-ownership facts for one .ets file: each component's fields with decorators, where each is read in build() and where it is written (event handler, async callback, lifecycle), listeners/timers with their release status, and where the component is used (parent, arguments and how each is written). unscanned above 0 means call sites may be missing or wrong; callSites null means none could be searched (for example, the file is in no project). Use before changing state decorators or how data flows between components.",
        args: { file: tool.schema.string().describe('Path to a .ets file') },
        async execute(args, ctx) {
          const file = absolute(args.file, ctx.directory);
          project.refresh();
          const facts = project.facts(file);
          const uses = new Map(facts.components.map((c) => [c.name, callSitesOf(project, { facts, name: c.name })]));
          return JSON.stringify(
            {
              file: relative(ctx.directory, file),
              observedClasses: classesWith(facts, '@Observed'),
              unscanned: [...uses.values()][0]?.unscanned ?? 0,
              components: facts.components.map((c) => ({
                name: c.name,
                line: c.line,
                stateManagement: c.version,
                fields: c.fields.map((f) => ({
                  name: f.name,
                  line: f.line,
                  decorators: f.decorators,
                  type: f.type ?? null,
                  readInBuildAt: readLines(f),
                  writes: f.writes.map(({ path, ...w }) => ({ ...w, nestedPath: pathText(path) || undefined })),
                })),
                resources: c.resources,
                callSites:
                  uses.get(c.name)?.sites.map((s) => ({
                    ...s,
                    file: relative(ctx.directory, s.file),
                    args: s.args.map((a) => ({ ...a, text: shortened(a.text) })),
                  })) ?? null,
              })),
            },
            null,
            2,
          );
        },
      }),
    },
  };
};
