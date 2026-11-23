// Candidates → judgments (cached) → findings/questions, and their text for agents.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Questions } from '@typesafe-ai/sdk';
import type {
  CallSiteOptions,
  CallSites,
  ComponentFact,
  Declaration,
  FieldFact,
  FileFacts,
  LoopFact,
  Project,
} from './facts.js';
import { buildSlice, Q_R1, Q_R2, Q_R3, type SystemOneBackend } from './judge.js';
import { ProjectIndex } from './project.js';
import { feedsRender, nestedDepth, pathText, type RowRead, renderingReads } from './queries.js';
import {
  type Candidate,
  type CandidateKind,
  type CandidateOf,
  candidates,
  hasUnsetCallbacks,
  omitsCallback,
  type Unwired,
  unwiredCallbacks,
  type V2Gap,
} from './rules/index.js';

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
    const { ask, disableWhere } = KINDS[f.kind];
    out.push(`  ${f.evidence}. Is this intended? ${ask}: ${f.fix}`);
    const where = disableWhere ?? `above line ${f.line}`;
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

function describeUnwired(c: ComponentFact, f: FieldFact, u: Unwired): Description {
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

interface Description {
  subject: string;
  evidence: string;
  fix: string;
}

function describeResource(c: CandidateOf<'unreleased-resource'>): Description {
  const r = c.resource;
  return {
    subject: `${c.component.name} ${r.key}`,
    evidence: `${r.kind} acquired in ${r.acquireIn}() at line ${r.acquireLine}; no matching release in aboutToDisappear/onPageHide`,
    fix: `release it in aboutToDisappear(): ${r.release}.${r.kind === 'listener' ? ' Keep the handler in a field so off() receives the same reference.' : ''}`,
  };
}

function describeNested(c: CandidateOf<'nested-write-unobserved'>): Description {
  const f = c.field;
  const [w, ...rest] = c.writes.length ? c.writes : f.writes;
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
  const evidence = `${f.decorators.join(' ')} field written ${nestedDepth(w?.path)} levels deep (${at}); V1 state decorators observe only first-layer changes, and @Observed on the classes alone does not change that`;
  const { loop } = c;
  if (loop) {
    const second = w?.path?.[1];
    const prop = second && 'prop' in second ? second.prop : undefined;
    const example = prop === undefined ? '' : `, e.g. ${keyExample(loop, prop)}`;
    return {
      subject: `${c.component.name}.${f.name}${path}`,
      evidence,
      fix: `replace the element with a new object (this.${f.name}[i] = { ...old, ${prop ?? '<property>'}: … }, or reassign this.${f.name}) and make the ForEach key at line ${loop.line} (${loop.key.text}) change with it${example}: a new object under an unchanged key keeps the old row. Or render the element in a child component that receives it as @ObjectLink (its class @Observed) and change it there; anything the parent itself renders from it (a total) still needs a first-layer write.`,
    };
  }
  return {
    subject: `${c.component.name}.${f.name}${path}`,
    evidence,
    fix: `change it at the first layer instead, e.g. build a new object and assign this.${f.name}${first ? `.${first}` : ''} = <new object> (or reassign this.${f.name}); or render the nested object in a child component that receives it as @ObjectLink (its class @Observed) and mutate it there.`,
  };
}

/** A key for the loop that changes with prop: its first key property (or the index) joined with the property. */
function keyExample(loop: LoopFact, prop: string): string {
  const item = loop.itemParam ?? 'item';
  const [key] = loop.key.props ?? [];
  return key === undefined
    ? `(${item}, index) => \`\${index}-\${${item}.${prop}}\``
    : `(${item}) => \`\${${item}.${key}}-\${${item}.${prop}}\``;
}

function describeKeyStale(c: CandidateOf<'foreach-key-stale'>): Description {
  const f = c.field;
  const { loop } = c;
  const methods = [...new Set(c.rebuilds.map((r) => `${r.write.method}()`))].join(', ');
  const stale = [...new Set(c.rebuilds.flatMap((r) => r.stale))];
  const objects = c.opaque ? 'new class instances, which may keep' : 'new objects that keep';
  const rows = [...new Set(c.staleReads.map((r) => rowKind(r.via)))].join(', ');
  const keyRoute = `make the key change with what the row shows, e.g. ${keyExample(loop, stale[0])}, and keep replacing the element (a write below it doesn't re-render either); this rebuilds the row, so what the row holds itself (typed text, focus, an animation) resets`;
  const linkRoute = `keep the key, make the items instances of an @Observed class shown by a row child that takes the item as @ObjectLink, and change the property on that object instead of replacing it; values the parent computes from the items (totals) then need their own first-layer update`;
  return {
    subject: `${c.component.name}.${f.name}`,
    evidence: `${methods} put ${objects} the ForEach key (${loop.key.text}, line ${loop.line}) where elements of this.${f.name} were (${lineList(rebuiltLines(c))}); ForEach keeps the existing row for an unchanged key and does not pass it the new item, so the row still shows the old ${stale.join(', ')} (row: ${rows})`,
    fix: c.statefulRow
      ? `the row holds state of its own, so ${linkRoute}. Or ${keyRoute}.`
      : `${keyRoute}. Or ${linkRoute}.`,
  };
}

function rebuiltLines(c: CandidateOf<'foreach-key-stale'>): number[] {
  return [...new Set(c.rebuilds.map((r) => r.element.line))];
}

function rowKind(via: RowRead['via']): string {
  switch (via.kind) {
    case 'inline':
      return 'inline';
    case 'builder':
      return `@Builder ${via.name}`;
    case 'child':
      return `${via.child}.${via.field}${via.decorators.length ? ` ${via.decorators.join(' ')}` : ''}`;
  }
}

function describeUndecorated(c: CandidateOf<'undecorated-mutated-rendered'>): Description {
  const f = c.field;
  const writes = f.writes
    .filter((w) => !feedsRender(w))
    .slice(0, 2)
    .map((w) => `${w.context} in ${w.method}() line ${w.line}`)
    .join('; ');
  return {
    subject: `${c.component.name}.${f.name}`,
    evidence: `rendered in build() (${shownRead(f)}) and written after init (${writes}); no state decorator`,
    fix:
      c.component.version === 'V2'
        ? `declare it @Local; if the value comes from the parent, use @Param plus an @Event callback instead.`
        : `declare it @State; if the value comes from the parent, use @Prop (one-way) or @Link (two-way) instead.`,
  };
}

/** R2 a–c: a field the parent initializes, whose sync direction may not be the one the UI needs. */
function describeOwnership(c: CandidateOf<'ownership-intent'>): Description {
  const f = c.field;
  return {
    subject: `${c.component.name}.${f.name}`,
    evidence: `${[...f.decorators, f.name].join(' ')} is initialized by the parent; its sync direction may not match how the parent and this component use it`,
    fix:
      c.component.version === 'V2'
        ? `use @Param plus an @Event callback to share it with the parent, or @Local for a copy the parent doesn't refresh.`
        : `use @Link to share it with the parent, @Prop for a one-way copy the parent refreshes, or a plain field for a snapshot.`,
  };
}

/** How a kind becomes a finding. judge: P(violation) is the judge's probability of `violation` for `questions`, and the
 *  thresholds set the band. facts: the facts decide alone (p null) at a fixed band. */
type KindPath<C extends Candidate = Candidate> =
  | { judge: { questions: Questions; violation: string } }
  | { facts: Band | ((c: C) => Band) };

interface KindSpec<C extends Candidate> {
  path: KindPath<C>;
  describe(c: C): Description;
  /** Where the question tells the agent to put a disable comment; above the finding's line when absent. */
  disableWhere?: string;
  /** The question's lead-in to the fix, e.g. "If it should behave reactively". */
  ask: string;
  related?(c: C): Finding['related'];
}

const R1_JUDGE: KindPath = { judge: { questions: Q_R1, violation: 'desync_bug' } };
const R1_ASK = 'If it should behave reactively';

/** Every kind a rule emits. A kind also picks its judge slice in FIELD_SLICE (judge.ts). */
const KINDS: { [K in CandidateKind]: KindSpec<CandidateOf<K>> } = {
  'undecorated-mutated-rendered': { path: R1_JUDGE, describe: describeUndecorated, ask: R1_ASK },
  'nested-write-unobserved': {
    path: R1_JUDGE,
    describe: describeNested,
    ask: R1_ASK,
    disableWhere: "above each write it lists, or above the field's decorators for all of them",
  },
  'foreach-key-stale': {
    path: { facts: (c) => (c.opaque ? 'question' : 'finding') },
    describe: describeKeyStale,
    ask: 'If the row should show the change',
    disableWhere: "above the ForEach call, or above the field's decorators for every R1 kind",
    related: (c) => rebuiltLines(c).map((line) => ({ file: c.file, line })),
  },
  // The label assumes the @Link → @Prop mismatch (shared intent); callers map the other intent × decorator pairs.
  'ownership-intent': {
    path: { judge: { questions: Q_R2, violation: 'shared_with_parent' } },
    describe: describeOwnership,
    ask: 'If the sync direction is wrong',
  },
  'event-unwired': {
    path: { facts: 'finding' },
    describe: (c) => describeUnwired(c.component, c.field, c.unwired),
    ask: 'If the call should do something',
    related: (c) => c.unwired.omitted.map((s) => ({ file: s.file, line: s.line })),
  },
  'unreleased-resource': {
    path: { judge: { questions: Q_R3, violation: 'leak_bug' } },
    describe: describeResource,
    ask: 'If it should be released',
  },
};

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
async function unwiredIn(files: FileFacts[], project: Project, opts: EngineOptions): Promise<Checked[]> {
  const owners = callbackOwners(files, project);
  const options = { budgetMs: opts.callSiteBudgetMs, workspace: opts.workspace };
  const shared = owners.length > MAX_SEARCHES;
  const found = await Promise.all(owners.map((o) => sitesOf(o, shared, project, options)));
  return found.flatMap((sites, i) => {
    const { component, decl } = owners[i];
    return sites ? unwiredCallbacks(component, decl.facts, sites).map((c) => ({ facts: decl.facts, c })) : [];
  });
}

/** A candidate with the facts of the file it is in. */
interface Checked {
  facts: FileFacts;
  c: Candidate;
}

/** Exported for callers that build candidates themselves (R2 ownership) and for tests. */
export function toFinding(c: Candidate, p: number | null, band: Band, backend: string): Finding {
  const spec = specOf(c.kind);
  return {
    fingerprint: c.fingerprint,
    rule: c.rule,
    kind: c.kind,
    file: c.file,
    line: c.line,
    component: c.component.name,
    p,
    band,
    backend,
    ...spec.describe(c),
    ...(spec.related ? { related: spec.related(c) } : {}),
  };
}

/** The spec of a kind, typed for that kind's candidates. */
function specOf<K extends CandidateKind>(kind: K): KindSpec<CandidateOf<K>> {
  return KINDS[kind];
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
  const found: { facts: FileFacts; candidates: Candidate[] }[] = [];
  for (const file of files) {
    try {
      // Through the project, a checked file that another checked file imports is parsed once; facts.file is its
      // normalized path, which findings and fingerprints share.
      const facts = project.facts(file);
      found.push({ facts, candidates: candidates(facts, project) });
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  const unwired = within(
    unwiredIn(
      found.map((f) => f.facts),
      project,
      opts,
    ).catch((e: Error): Checked[] => {
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

  const decide = async ({ facts, c }: Checked) => {
    const { path } = specOf(c.kind);
    if ('facts' in path) {
      findings.push(toFinding(c, null, typeof path.facts === 'function' ? path.facts(c) : path.facts, FACTS));
      return;
    }
    const { questions, violation } = path.judge;
    const slice = buildSlice(facts, c, opts.taskContext);
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
          p = verdict.probabilities[violation] ?? null;
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
    if (band !== null) {
      findings.push(toFinding(c, p, band, opts.backend.name));
    }
  };

  // Judge results already fetched are kept even if a candidate throws.
  try {
    for (const { facts, candidates: fileCandidates } of found) {
      for (const c of fileCandidates) {
        await decide({ facts, c });
      }
    }
    for (const checked of await unwired) {
      await decide(checked);
    }
  } finally {
    cache.save();
  }
  return { findings, errors };
}

/** Where build() renders the field, for the evidence: `line 12`, or `through this.calcWidth(), line 40`. */
function shownRead(f: FieldFact): string {
  const read = renderingReads(f)[0];
  return read?.via ? `through ${read.via}, line ${read.line}` : `line ${read?.line}`;
}
