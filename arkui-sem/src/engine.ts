// Candidates → judgments (cached) → findings/questions, and their text for agents.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Questions } from '@typesafe-ai/sdk';
import {
  type CallSiteOptions,
  type CallSites,
  type Candidate,
  type ComponentFact,
  candidates,
  type Declaration,
  type FieldFact,
  type FileFacts,
  hasUnsetCallbacks,
  nestedDepth,
  omitsCallback,
  type Project,
  pathText,
  readLines,
  type Unwired,
  unwiredCallbacks,
  type V2Gap,
} from './analysis.js';
import { buildSlice, Q_R1, Q_R2, Q_R3, type SystemOneBackend } from './judge.js';
import { ProjectIndex } from './project.js';

// --- Formatting ---

/** The backend of a finding the facts decide alone. */
export const FACTS = 'facts';
const MAX_RELATED_SHOWN = 3;

function source(f: Finding) {
  if (f.backend === FACTS) {
    return FACTS;
  }
  return `${f.p === null ? 'judge unavailable' : `p=${f.p.toFixed(2)}`}, ${f.backend}`;
}

function relatedLine(f: Finding, cwd: string): string[] {
  if (!f.related?.length) {
    return [];
  }
  const shown = f.related.slice(0, MAX_RELATED_SHOWN).map((r) => `${relative(cwd, r.file)}:${r.line}`);
  const more = f.related.length - shown.length;
  return [`  at: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`];
}

export function formatForAgent(findings: Finding[], cwd = process.cwd()): string {
  if (findings.length === 0) {
    return '';
  }
  const out: string[] = [];
  const confident = findings.filter((f) => f.band === 'finding');
  const questions = findings.filter((f) => f.band === 'question');
  out.push(`arkui-sem: ${confident.length} finding(s), ${questions.length} question(s) about ArkUI state semantics.`);

  for (const f of confident) {
    out.push(`- [${f.rule} ${f.kind}] ${relative(cwd, f.file)}:${f.line} ${f.subject} (${source(f)})`);
    out.push(`  why: ${f.evidence}`, ...relatedLine(f, cwd));
    out.push(`  fix: ${f.fix}`);
  }
  for (const f of questions) {
    out.push(`- [${f.rule}?] ${relative(cwd, f.file)}:${f.line} ${f.subject} (${source(f)})`);
    out.push(`  ${f.evidence}. Is this intended? If it should behave reactively/be released: ${f.fix}`);
    const where =
      f.kind === 'nested-write-unobserved'
        ? "above each write it lists, or above the field's decorators for all of them"
        : `above line ${f.line}`;
    out.push(
      `  If it is intentional, leave it and add \`// arkui-sem-disable-next-line ${f.rule} -- <reason>\` ${where}.`,
    );
  }
  return out.join('\n');
}

// --- Engine ---

export type Band = 'finding' | 'question';

export interface Finding {
  fingerprint: string;
  rule: Candidate['rule'];
  kind: Candidate['kind'];
  file: string;
  line: number;
  component: string;
  subject: string;
  /** P(violation); null when the judge failed, and for a finding the facts decide alone (backend FACTS). */
  p: number | null;
  band: Band;
  backend: string;
  evidence: string;
  fix: string;
  /** Other places the finding is about: the call sites that don't pass an unwired callback. */
  related?: { file: string; line: number }[];
}

export interface EngineOptions {
  backend: SystemOneBackend;
  /** P ≥ finding → reported as a finding; question ≤ P < finding → asked as a question; below → dropped. */
  thresholds?: { finding: number; question: number };
  cachePath?: string;
  taskContext?: string;
  judgeTimeoutMs?: number;
  /** The checked files' facts and cross-file lookups; a fresh project index when absent. Long-lived callers pass one to
   *  keep its cache. */
  project?: Project;
  /** Passed to the call-site lookup (see CallSiteOptions). */
  workspace?: string;
  /** How long the check waits for call sites; candidates that need them are dropped when it runs out. */
  callSiteBudgetMs?: number;
}

/** Above this many structs to look up, one pass over the project replaces a search for each. */
const MAX_SEARCHES = 8;

const QUESTIONS: Record<Candidate['rule'], Questions> = { R1: Q_R1, R2: Q_R2, R3: Q_R3 };
const VIOLATION_LABEL: Record<Candidate['rule'], string> = {
  R1: 'desync_bug',
  R2: 'shared_with_parent',
  R3: 'leak_bug',
};
// R2 label assumes the @Link → @Prop mismatch (shared intent); callers map the other intent × decorator pairs.

class JudgmentCache {
  private entries: Record<string, number> = {};
  constructor(private readonly path?: string) {
    if (!path) {
      return;
    }
    try {
      this.entries = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* empty or missing cache */
    }
  }
  get(key: string): number | undefined {
    return this.entries[key];
  }
  set(key: string, p: number) {
    this.entries[key] = p;
  }
  save() {
    if (!this.path) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries));
  }
}

/** The promise's value, or `late` when it takes longer than ms. */
function within<T>(p: Promise<T>, ms: number | undefined, late: () => T): Promise<T> {
  if (ms === undefined) {
    return p;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`judge timed out after ${ms} ms`)), ms)),
  ]);
}

/** "line 4", "lines 4 and 9", "lines 4, 7 and 9". */
function lineList(lines: number[]): string {
  if (lines.length === 1) {
    return `line ${lines[0]}`;
  }
  return `lines ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
}

function gapReason(g: V2Gap): string {
  switch (g.kind) {
    case 'class':
    case 'untraced':
      return 'V2 sees a property write only when the property is @Trace on an @ObservedV2 class';
    case 'object-type':
    case 'object-literal':
      return 'V2 never observes plain objects';
    case 'nested-container':
      return "V2 doesn't observe containers nested in containers";
  }
}

function gapFix(g: V2Gap): string {
  switch (g.kind) {
    case 'class':
      return `mark class ${g.owner} @ObservedV2 and the mutated properties @Trace`;
    case 'object-type':
      return `make ${g.owner} an @ObservedV2 class with @Trace on the mutated properties and create its objects with new`;
    case 'object-literal':
      return `reassign ${g.owner} with a new object, or make it an @ObservedV2 class instance with @Trace on the mutated properties`;
    case 'nested-container':
      return `assign a new inner array or map to ${g.owner} instead of changing it in place`;
    case 'untraced':
      return `mark ${g.owner}.${g.property} @Trace`;
  }
}

function describeUnwired(
  c: ComponentFact,
  f: FieldFact,
  u: Unwired,
): { subject: string; evidence: string; fix: string } {
  const subject = `${c.name}.${f.name}`;
  const calls = lineList([...new Set(f.calls.map((call) => call.line))]);
  const sites = `${u.sites} call site${u.sites === 1 ? '' : 's'} of ${c.name}`;
  if (u.effect === 'throws') {
    const omit = u.omitted.length === 1 ? "doesn't" : "don't";
    const opaque = u.opaque > 0 ? ` (the arguments of ${u.opaque} can't be read)` : '';
    return {
      subject,
      evidence: `${f.name} has no default and is called without a check (${calls}), but ${u.omitted.length} of ${sites} ${omit} pass it${opaque}: the call throws there`,
      fix: `pass ${f.name} at those call sites; or declare it optional (${f.name}?: …) and call this.${f.name}?.(…).`,
    };
  }
  const name = [...f.decorators, f.name].join(' ');
  const pass = u.sites === 1 ? `the only call site of ${c.name} doesn't pass` : `none of the ${sites} pass`;
  return {
    subject,
    evidence: `${name} is called (${calls}), but ${pass} it: an @Event the parent doesn't pass is an empty function, so the call does nothing`,
    fix: `pass ${f.name} where ${c.name} is created, with a handler that updates the parent's state; or remove the callback and its calls if nothing should handle it.`,
  };
}

function describe(c: Candidate): { subject: string; evidence: string; fix: string } {
  const v2 = c.component.version === 'V2';
  if (c.resource) {
    const r = c.resource;
    const release = r.release;
    return {
      subject: `${c.component.name} ${r.key}`,
      evidence: `${r.kind} acquired in ${r.acquireIn}() at line ${r.acquireLine}; no matching release in aboutToDisappear/onPageHide`,
      fix: `release it in aboutToDisappear(): ${release}.${r.kind === 'listener' ? ' Keep the handler in a field so off() receives the same reference.' : ''}`,
    };
  }
  const f = c.field;
  if (c.unwired) {
    return describeUnwired(c.component, f, c.unwired);
  }
  const writes = f.writes
    .slice(0, 2)
    .map((w) => `${w.context} in ${w.method}() line ${w.line}`)
    .join('; ');
  if (c.kind === 'nested-write-unobserved') {
    const [w, ...rest] = c.writes?.length ? c.writes : f.writes;
    const path = pathText(w?.path);
    const head = w?.path?.[0];
    const first = head && 'prop' in head ? head.prop : undefined;
    const otherLines = [...new Set(rest.map((x) => x.line))].filter((l) => l !== w.line);
    const also = otherLines.length ? `; also written in place at ${lineList(otherLines)}` : '';
    const at = `${w?.context} in ${w?.method}() line ${w?.line}${also}`;
    if (c.gaps) {
      return {
        subject: `${c.component.name}.${f.name}${path}`,
        evidence: `${f.decorators.join(' ')} field's property written in place (${at}); ${[...new Set(c.gaps.map(gapReason))].join('; ')}`,
        fix: `${[...new Set(c.gaps.map(gapFix))].join('; ')}.`,
      };
    }
    return {
      subject: `${c.component.name}.${f.name}${path}`,
      evidence: `${f.decorators.join(' ')} field written ${nestedDepth(w?.path)} levels deep (${at}); V1 state decorators observe only first-layer changes, and @Observed on the classes alone does not change that`,
      fix: `change it at the first layer instead, e.g. build a new object and assign this.${f.name}${first ? `.${first}` : ''} = <new object> (or reassign this.${f.name}); or render the nested object in a child component that receives it as @ObjectLink (its class @Observed) and mutate it there.`,
    };
  }
  return {
    subject: `${c.component.name}.${f.name}`,
    evidence: `rendered in build() (line ${readLines(f)[0]}) and written after init (${writes}); no state decorator`,
    fix: v2
      ? `declare it @Local; if the value comes from the parent, use @Param plus an @Event callback instead.`
      : `declare it @State; if the value comes from the parent, use @Prop (one-way) or @Link (two-way) instead.`,
  };
}

interface Struct {
  decl: Declaration;
  component: ComponentFact;
}

/** The structs whose call sites decide a candidate: those the files declare that call a callback only a parent can
 *  supply, and those they instantiate without passing one. */
function callbackOwners(files: FileFacts[], project: Project): Struct[] {
  const owners = new Map<string, Struct>();
  const add = (decl: Declaration, component: ComponentFact) =>
    owners.set(`${decl.facts.file}#${decl.name}`, { decl, component });
  for (const facts of files) {
    for (const c of facts.components.filter(hasUnsetCallbacks)) {
      add({ facts, name: c.name }, c);
    }
    for (const use of facts.componentUses) {
      const decl = project.declaration(use.child, facts);
      const component = decl?.facts.components.find((c) => c.name === decl.name);
      if (decl && component && omitsCallback(component, use)) {
        add(decl, component);
      }
    }
  }
  return [...owners.values()];
}

/**
 * A struct's call sites: from a search for it, or from the pass over the project that the structs of a check share.
 * One unusable file anywhere leaves that pass incomplete for every struct, so a struct that would have a candidate
 * without it is then searched for alone.
 */
function sitesOf(
  o: Struct,
  shared: boolean,
  project: Project,
  options: CallSiteOptions,
): Promise<CallSites | undefined> {
  if (!shared) {
    return project.searchCallSites(o.decl, options);
  }
  const sites = project.callSites(o.decl, options);
  const count = (s: CallSites) => unwiredCallbacks(o.component, o.decl.facts, s).length;
  const heldBack = sites !== undefined && sites.unscanned > 0 && count({ ...sites, unscanned: 0 }) > count(sites);
  return heldBack ? project.searchCallSites(o.decl, options) : Promise.resolve(sites);
}

/** R2 event-unwired candidates. Every lookup starts before the first await, so a later refresh of the index can't
 *  change which structs are asked about. */
async function unwiredIn(files: FileFacts[], project: Project, opts: EngineOptions): Promise<Candidate[]> {
  const owners = callbackOwners(files, project);
  const options = { budgetMs: opts.callSiteBudgetMs, workspace: opts.workspace };
  const shared = owners.length > MAX_SEARCHES;
  const found = await Promise.all(owners.map((o) => sitesOf(o, shared, project, options)));
  return found.flatMap((sites, i) => (sites ? unwiredCallbacks(owners[i].component, owners[i].decl.facts, sites) : []));
}

export async function checkFiles(
  files: string[],
  opts: EngineOptions,
): Promise<{ findings: Finding[]; errors: string[] }> {
  const thresholds = opts.thresholds ?? { finding: 0.8, question: 0.5 };
  const cache = new JudgmentCache(opts.cachePath);
  const findings: Finding[] = [];
  const errors: string[] = [];

  // Every candidate is found before the first await: a shared index can't be refreshed by another check in between.
  const project = opts.project ?? new ProjectIndex();
  project.refresh();
  const found: { file: string; facts: FileFacts; candidates: Candidate[] }[] = [];
  for (const file of files) {
    try {
      // Through the project, a checked file that another checked file imports is parsed once; facts.file is its
      // normalized path, which findings and fingerprints share.
      const facts = project.facts(file);
      found.push({ file: facts.file, facts, candidates: candidates(facts, project) });
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  const unwired = within(
    unwiredIn(
      found.map((f) => f.facts),
      project,
      opts,
    ).catch((e: Error): Candidate[] => {
      errors.push(`call sites: ${e.message}`);
      return [];
    }),
    opts.callSiteBudgetMs,
    () => {
      errors.push(
        `call sites: not found within ${opts.callSiteBudgetMs} ms; callbacks no parent passes were not checked`,
      );
      return [];
    },
  );

  for (const { file, facts, candidates: fileCandidates } of found) {
    for (const c of fileCandidates) {
      const slice = buildSlice(facts, c, opts.taskContext);
      const questions = QUESTIONS[c.rule];
      const key = createHash('sha256')
        .update(opts.backend.name)
        .update(JSON.stringify(slice))
        .update(Object.keys(questions).join())
        .digest('hex');

      let p: number | null = cache.get(key) ?? null;
      if (p === null) {
        try {
          const { answers } = await withTimeout(opts.backend.systemOne(slice, questions), opts.judgeTimeoutMs ?? 8000);
          const verdict = answers.verdict;
          if (verdict?.type === 'choice') {
            p = verdict.probabilities[VIOLATION_LABEL[c.rule]] ?? null;
            if (p !== null) {
              cache.set(key, p);
            }
          }
        } catch (e) {
          errors.push(`${opts.backend.name}: ${(e as Error).message}`);
        }
      }

      // Judge unavailable → degrade to deterministic-only and ask rather than assert.
      const band: Band | null =
        p === null ? 'question' : p >= thresholds.finding ? 'finding' : p >= thresholds.question ? 'question' : null;
      if (band === null) {
        continue;
      }
      findings.push({
        fingerprint: c.fingerprint,
        rule: c.rule,
        kind: c.kind,
        file,
        line: c.line,
        component: c.component.name,
        p,
        band,
        backend: opts.backend.name,
        ...describe(c),
      });
    }
  }
  for (const c of await unwired) {
    findings.push({
      fingerprint: c.fingerprint,
      rule: c.rule,
      kind: c.kind,
      file: c.file,
      line: c.line,
      component: c.component.name,
      p: null,
      band: 'finding',
      backend: FACTS,
      ...describe(c),
      related: c.unwired?.omitted.map((s) => ({ file: s.file, line: s.line })),
    });
  }
  cache.save();
  return { findings, errors };
}
