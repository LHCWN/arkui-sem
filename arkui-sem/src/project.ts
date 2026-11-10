// Project index: finds the file that declares a name used in an .ets file, across imports, module packages and re-exports,
// and where each struct is used.
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';
import {
  type CallSite,
  type CallSites,
  type Declaration,
  declares,
  type FactExtractor,
  type FileFacts,
  type Project,
} from './analysis.js';
import { EtsExtractor } from './ets/extract.js';
import { FileSearch, listEtsFiles, type SearchTerms, type TextSearch } from './search.js';

/** A whole-project pass over call sites. */
interface EdgeScan {
  /** By edgeKey of the declaring struct. */
  edges: Map<string, CallSite[]>;
  unscanned: number;
  /** The scan reached the last file. */
  complete: boolean;
  /** What the edges were built from: the listing, and every path looked at (absent ones as undefined). */
  listing: string;
  mtimes: Map<string, number | undefined>;
}

/** How importers can reach one struct, grown while searching for its call sites. */
interface Aliases {
  /** Names it can be imported under, whatever the file. */
  names: Set<string>;
  /** Files whose default export is the struct, by directoryKey. */
  defaultFiles: Map<string, string>;
}

interface Module {
  name: string;
  dir: string;
}

interface ModuleList {
  /** Module directories, keyed by directoryKey. */
  dirs: Map<string, string>;
  /** Keyed by module name and by oh-package.json5 name. */
  dirByName: Map<string, string>;
}

interface OhPackage {
  name?: string;
  main?: string;
  dependencies?: Record<string, string>;
}

const BUILD_PROFILE = 'build-profile.json5';
const OH_PACKAGE = 'oh-package.json5';
const DEFAULT_ENTRY = 'Index.ets';
const FILE_DEPENDENCY = 'file:';
/** ArkTS imports omit the extension. */
const SOURCE_SUFFIXES = ['', '.ets', '.ts', '/Index.ets', '/index.ets', '/index.ts'];
const SDK_PREFIXES = ['@ohos.', '@kit.', '@system.', '@arkts.', '@hms.'];
/** Word-bounded: `constructor` contains `struct`. A @LocalBuilder sits inside a struct. */
const MAY_USE_COMPONENTS = /\bstruct\b|@Builder\b/;
const SOURCE_EXTENSION = /\.(?:ets|ts)$/;
/** An import of a directory's index file that names no directory: `'.'`, `'../'`, `'../..'`. */
const DOT_DIRECTORY_IMPORT = String.raw`['"/]\.\.?/?['"]`;

function readJson5<T>(path: string): Partial<T> {
  return JSON5.parse(readFileSync(path, 'utf8')) ?? {};
}

function readProfileModules(path: string): Module[] | undefined {
  return readJson5<{ modules: { name: string; srcPath: string }[] }>(path).modules?.map((m) => ({
    name: m.name,
    dir: resolve(dirname(path), m.srcPath),
  }));
}

function mtime(path: string): number | undefined {
  try {
    const s = statSync(path, { throwIfNoEntry: false });
    return s?.isFile() ? s.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** Windows paths compare without case, as in path.relative. */
function directoryKey(dir: string) {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

function isOutside(dir: string, root: string) {
  const path = relative(root, dir);
  return path.startsWith('..') || isAbsolute(path);
}

function edgeKey(file: string, struct: string) {
  return `${directoryKey(file)}#${struct}`;
}

function sameFile(a: string, b: string) {
  return directoryKey(a) === directoryKey(b);
}

/** The directory a local dependency (`file:../x` or `../x`) points to, as written. */
function localDependency(dependency: string | undefined): string | undefined {
  const path = dependency?.startsWith(FILE_DEPENDENCY) ? dependency.slice(FILE_DEPENDENCY.length) : dependency;
  return path?.startsWith('.') ? path : undefined;
}

function memo<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  if (!cache.has(key)) {
    cache.set(key, compute());
  }
  return cache.get(key) as V;
}

/** A value loaded from a file, reloaded when its mtime changes. get: undefined when the file is missing or fails to load;
 *  load: the value, or the error reading or loading it. */
class FileCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; value: T | undefined; error?: unknown }>();

  constructor(
    private readonly stat: (path: string) => number | undefined,
    private readonly load: (path: string) => T | undefined,
  ) {}

  get(path: string): T | undefined {
    if (this.stat(path) === undefined) {
      this.entries.delete(path);
      return undefined;
    }
    try {
      return this.require(path);
    } catch {
      return undefined;
    }
  }

  require(path: string): T | undefined {
    const mtimeMs = this.stat(path);
    if (mtimeMs === undefined) {
      this.entries.delete(path);
      return this.load(path); // the file is missing: let the loader report it
    }
    let hit = this.entries.get(path);
    if (hit?.mtimeMs !== mtimeMs) {
      try {
        hit = { mtimeMs, value: this.load(path) };
      } catch (error) {
        hit = { mtimeMs, value: undefined, error };
      }
      this.entries.set(path, hit);
    }
    if (hit.error !== undefined) {
      throw hit.error;
    }
    return hit.value;
  }
}

/**
 * Call refresh() before each check; between refreshes, files and the project layout are not re-read. Parse with the
 * extractor that produced the checked file's facts, so both sides agree on what a file declares.
 */
export class ProjectIndex implements Project {
  /** Each path is stat'ed once per check, so a check sees every file as it was at first use. */
  private readonly mtimes = new Map<string, number | undefined>();
  private readonly stat = (path: string) => memo(this.mtimes, path, () => mtime(path));
  private readonly parsed = new FileCache(this.stat, (p) => this.extractor.extract(p, readFileSync(p, 'utf8')));
  private readonly packages = new FileCache(this.stat, (p) => readJson5<OhPackage>(p));
  private readonly profiles = new FileCache(this.stat, readProfileModules);
  private readonly roots = new Map<string, string | undefined>();
  private readonly moduleLists = new Map<string, ModuleList | undefined>();
  private readonly moduleDirs = new Map<string, string | undefined>();
  private readonly lookups = new Map<string, Declaration | undefined>();
  /** The answer depends on the importing directory, not the file: its module, and the base of relative specifiers. */
  private readonly imports = new Map<string, string | undefined>();
  private readonly mayUseComponents = new FileCache(this.stat, (p) => MAY_USE_COMPONENTS.test(readFileSync(p, 'utf8')));
  /** This check's scan of each project, complete or not: one scan and one clock per check. */
  private readonly scans = new Map<string, EdgeScan>();
  /** Reused by later checks while nothing the scan looked at has changed. */
  private readonly completeScans = new Map<string, EdgeScan>();

  /** This check's search for each struct's call sites. */
  private readonly searches = new Map<string, Promise<CallSites>>();

  constructor(
    private readonly extractor: FactExtractor = new EtsExtractor(),
    private readonly search: TextSearch = new FileSearch(),
  ) {}

  refresh(): void {
    this.scans.clear();
    this.searches.clear();
    this.mtimes.clear();
    this.roots.clear();
    this.moduleLists.clear();
    this.moduleDirs.clear();
    this.lookups.clear();
    this.imports.clear();
  }

  /** The facts of a file, keyed by its normalized path; throws when the file can't be read or parsed. */
  facts(file: string): FileFacts {
    const facts = this.parsed.require(resolve(file));
    if (!facts) {
      throw new Error(`${file}: no facts`);
    }
    return facts;
  }

  declaration(name: string, from: FileFacts): Declaration | undefined {
    return memo(this.lookups, `${from.file}#${name}`, () => this.find(name, from, new Set()));
  }

  /**
   * Where a struct is used across its project. budgetMs stops the scan between files and counts the rest as unscanned,
   * so sites may be missing; it applies to the first call after refresh, whose scan later calls share. Without a budget
   * the scan reads the whole project. Undefined when the file belongs to no project, so nothing was searched.
   * Synchronous by design: a check must not see a refresh of this index mid-scan.
   */
  callSites(decl: Declaration, options: { budgetMs?: number; workspace?: string } = {}): CallSites | undefined {
    const dirs = this.projectDirs(decl.facts.file, options.workspace);
    if (dirs.length === 0) {
      return undefined;
    }
    const scan = this.scanOf(dirs, options.budgetMs ?? Number.POSITIVE_INFINITY);
    return { sites: scan.edges.get(edgeKey(decl.facts.file, decl.name)) ?? [], unscanned: scan.unscanned };
  }

  private scanOf(dirs: string[], budgetMs: number): EdgeScan {
    const deadline = performance.now() + budgetMs;
    const key = directoryKey(dirs[0]);
    return memo(this.scans, key, () => {
      const unreadable: string[] = [];
      const files = this.projectFiles(dirs, unreadable);
      const previous = this.completeScans.get(key);
      if (previous && this.isCurrent(previous, files)) {
        return previous;
      }
      const scan = this.scan(files, deadline, unreadable.length);
      if (scan.complete) {
        this.completeScans.set(key, scan);
      }
      return scan;
    });
  }

  /** unreadable: collects the directories the listing could not read. */
  private projectFiles(dirs: string[], unreadable: string[]): string[] {
    return listEtsFiles(dirs, unreadable);
  }

  /**
   * The same sites as callSites without reading the whole project: a text search finds the files that mention the
   * struct under any name it is exported as, only those are parsed, and each use is resolved as in callSites. Sites are
   * ordered by file path. unscanned counts the matching files with syntax errors, unreadable ones, those left when
   * budgetMs ran out, and directories the search could not read. The search is shared by the calls of one check; a
   * refresh while it runs is harmless, and files parsed after it are read as they are then.
   */
  searchCallSites(
    decl: Declaration,
    options: { budgetMs?: number; workspace?: string } = {},
  ): Promise<CallSites | undefined> {
    const dirs = this.projectDirs(decl.facts.file, options.workspace);
    if (dirs.length === 0) {
      return Promise.resolve(undefined);
    }
    const deadline = performance.now() + (options.budgetMs ?? Number.POSITIVE_INFINITY);
    const key = `${directoryKey(dirs[0])}#${edgeKey(decl.facts.file, decl.name)}`;
    return memo(this.searches, key, () => this.findSites(decl, dirs, deadline));
  }

  private async findSites(decl: Declaration, dirs: string[], deadline: number): Promise<CallSites> {
    if (!decl.facts.components.some((c) => c.name === decl.name)) {
      return { sites: [], unscanned: 0 };
    }
    const aliases: Aliases = { names: new Set([decl.name]), defaultFiles: new Map() };
    const candidates = new Map([[directoryKey(resolve(decl.facts.file)), decl.facts]]);
    const unusable = new Set<string>();
    const searched = new Set<string>();
    for (;;) {
      const terms = this.newTerms(decl, dirs, candidates, aliases, searched);
      if (terms.words.length + terms.patterns.length === 0) {
        break;
      }
      const found = await this.search.search(dirs, terms);
      for (const path of found.unreadable) {
        unusable.add(directoryKey(path));
      }
      for (const file of found.files) {
        const key = directoryKey(file);
        if (candidates.has(key) || unusable.has(key)) {
          continue;
        }
        const facts = performance.now() < deadline ? this.parsed.get(file) : undefined;
        if (!facts || facts.parseErrors) {
          unusable.add(key);
        }
        if (facts) {
          candidates.set(key, facts);
        }
      }
    }
    const sites = [...candidates.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([, facts]) => {
        const locals = this.localNames(facts, decl, aliases);
        return facts.componentUses.filter((use) => locals.has(use.child)).map((use) => ({ ...use, file: facts.file }));
      });
    return { sites, unscanned: unusable.size };
  }

  /** Brings the aliases up to date with the candidates, and returns the search terms they add. */
  private newTerms(
    decl: Declaration,
    dirs: string[],
    candidates: Map<string, FileFacts>,
    aliases: Aliases,
    searched: Set<string>,
  ): SearchTerms {
    // A name one file adds can make another candidate export the struct too.
    let known: number;
    do {
      known = aliases.names.size + aliases.defaultFiles.size;
      for (const facts of candidates.values()) {
        this.addExports(facts, decl, aliases);
      }
    } while (known !== aliases.names.size + aliases.defaultFiles.size);
    const words = [...aliases.names];
    const patterns: string[] = [];
    if (aliases.defaultFiles.size > 0) {
      const entryNames = this.entryNames(dirs);
      for (const [key, file] of aliases.defaultFiles) {
        const stem = basename(file).replace(SOURCE_EXTENSION, '');
        words.push(stem, ...(entryNames.get(key) ?? []));
        if (stem.toLowerCase() === 'index') {
          words.push(basename(dirname(file)));
          patterns.push(DOT_DIRECTORY_IMPORT);
        }
      }
    }
    const unsearched = (terms: string[]) => [...new Set(terms)].filter((term) => !searched.has(term));
    const terms = { words: unsearched(words), patterns: unsearched(patterns) };
    for (const term of [...terms.words, ...terms.patterns]) {
      searched.add(term);
    }
    return terms;
  }

  /** Adds the names under which importers of the file reach the struct, and the file when its default export does. */
  private addExports(facts: FileFacts, decl: Declaration, aliases: Aliases): void {
    const locals = this.localNames(facts, decl, aliases);
    // An import's local name is left out: declaration() follows it from another file, but ArkTS can't import it.
    const exported: string[] = [];
    for (const r of facts.reexports) {
      const mayReach =
        r.source === undefined
          ? locals.has(r.imported)
          : this.mayImport({ imported: r.imported, source: r.source }, facts, aliases);
      if (mayReach && this.reaches(r.exported, facts, decl)) {
        exported.push(r.exported);
      }
    }
    // Without a default export of its own, declaration() looks for `default` through `export *` too.
    const defaultReaches =
      facts.defaultExport !== undefined
        ? locals.has(facts.defaultExport)
        : facts.exportAll.some((source) => this.mayImport({ imported: 'default', source }, facts, aliases)) &&
          this.reaches('default', facts, decl);
    if (defaultReaches) {
      exported.push('default');
    }
    for (const name of exported) {
      if (name === 'default') {
        aliases.defaultFiles.set(directoryKey(facts.file), facts.file);
      } else {
        aliases.names.add(name);
      }
    }
  }

  /** The names that stand for the struct inside the file: its own declaration, and imports that resolve to it. */
  private localNames(facts: FileFacts, decl: Declaration, aliases: Aliases): Set<string> {
    const locals = new Set(sameFile(facts.file, decl.facts.file) ? [decl.name] : []);
    for (const i of facts.imports) {
      if (this.mayImport(i, facts, aliases) && this.reaches(i.local, facts, decl)) {
        locals.add(i.local);
      }
    }
    return locals;
  }

  /** A cheap test before resolving: the import takes a known alias, or the default of a file known to export it. */
  private mayImport(i: { imported: string; source: string }, from: FileFacts, aliases: Aliases): boolean {
    if (i.imported !== 'default') {
      return aliases.names.has(i.imported);
    }
    const file = this.resolveImport(i.source, from.file);
    return file !== undefined && aliases.defaultFiles.has(directoryKey(file));
  }

  private reaches(name: string, from: FileFacts, decl: Declaration): boolean {
    const target = this.declaration(name, from);
    return target !== undefined && target.name === decl.name && sameFile(target.facts.file, decl.facts.file);
  }

  /** What importers can write for each package entry file (by directoryKey): module names, package names, dependency keys. */
  private entryNames(dirs: string[]): Map<string, string[]> {
    const modules = this.moduleList(dirs[0]);
    const named: [string, string][] = [...(modules?.dirByName ?? [])];
    for (const dir of new Set([...dirs, ...(modules?.dirs.values() ?? [])])) {
      for (const [name, dependency] of Object.entries(this.packages.get(join(dir, OH_PACKAGE))?.dependencies ?? {})) {
        const path = localDependency(dependency);
        if (path !== undefined) {
          named.push([name, resolve(dir, path)]);
        }
      }
    }
    const names = new Map<string, string[]>();
    for (const [name, dir] of named) {
      const entry = this.sourceFile(join(dir, this.packages.get(join(dir, OH_PACKAGE))?.main || DEFAULT_ENTRY));
      if (entry !== undefined) {
        memo(names, directoryKey(entry), () => []).push(name);
      }
    }
    return names;
  }

  /** The build-profile root and the module directories outside it; without a profile, the closest package directory. */
  private projectDirs(file: string, workspace?: string): string[] {
    const root = this.projectRoot(file) ?? (workspace === undefined ? undefined : this.rootListing(file, workspace));
    if (root !== undefined) {
      const modules = [...(this.moduleList(root)?.dirs.values() ?? [])];
      return [root, ...modules.filter((dir) => isOutside(dir, root))];
    }
    const packageDir = this.moduleDir(file);
    return packageDir === undefined ? [] : [packageDir];
  }

  /** The workspace's project, when it lists the file's module: a module outside the root has no profile above it. */
  private rootListing(file: string, workspace: string): string | undefined {
    const root = this.projectRoot(join(workspace, OH_PACKAGE));
    const dirs = root === undefined ? undefined : this.moduleList(root)?.dirs;
    const listed = dirs && this.closestDir(dirname(resolve(file)), (dir) => dirs.has(directoryKey(dir)));
    return listed === undefined ? undefined : root;
  }

  private isCurrent(scan: EdgeScan, files: string[]): boolean {
    return scan.listing === files.join('\n') && [...scan.mtimes].every(([path, m]) => this.stat(path) === m);
  }

  /** unreadable: directories the listing skipped; each counts as unscanned, and the scan is never reused as complete. */
  private scan(files: string[], deadline: number, unreadable: number): EdgeScan {
    const edges = new Map<string, CallSite[]>();
    let unscanned = unreadable;
    let done = 0;
    for (; done < files.length && performance.now() < deadline; done++) {
      const file = files[done];
      if (this.mayUseComponents.get(file) === false) {
        continue;
      }
      const facts = this.parsed.get(file);
      if (!facts || facts.parseErrors) {
        unscanned++;
      }
      if (facts) {
        this.addEdges(facts, edges);
      }
    }
    return {
      edges,
      unscanned: unscanned + files.length - done,
      complete: done === files.length && unreadable === 0,
      listing: files.join('\n'),
      mtimes: new Map(this.mtimes),
    };
  }

  private addEdges(facts: FileFacts, edges: Map<string, CallSite[]>): void {
    for (const use of facts.componentUses) {
      const target = this.declaration(use.child, facts);
      if (target?.facts.components.some((c) => c.name === target.name)) {
        memo(edges, edgeKey(target.facts.file, target.name), () => []).push({ ...use, file: facts.file });
      }
    }
  }

  /** The file an import specifier points to: a relative path, a package entry or a file inside a package. */
  resolveImport(spec: string, fromFile: string): string | undefined {
    return memo(this.imports, `${dirname(fromFile)}#${spec}`, () => this.findImport(spec, fromFile));
  }

  private findImport(spec: string, fromFile: string): string | undefined {
    if (spec.startsWith('.')) {
      return this.sourceFile(resolve(dirname(fromFile), spec));
    }
    if (SDK_PREFIXES.some((p) => spec.startsWith(p))) {
      return undefined;
    }
    const parts = spec.split('/');
    const nameLength = spec.startsWith('@') ? 2 : 1;
    const dir = this.packageDir(parts.slice(0, nameLength).join('/'), fromFile);
    if (dir === undefined) {
      return undefined;
    }
    const inner = parts.slice(nameLength).join('/') || this.packages.get(join(dir, OH_PACKAGE))?.main || DEFAULT_ENTRY;
    return this.sourceFile(join(dir, inner));
  }

  private find(name: string, facts: FileFacts, seen: Set<string>): Declaration | undefined {
    const key = `${facts.file}#${name}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    if (declares(facts, name)) {
      return { facts, name };
    }
    const imported = facts.imports.find((i) => i.local === name);
    if (imported) {
      return this.follow(imported.imported, imported.source, facts.file, seen);
    }
    const reexport = facts.reexports.find((r) => r.exported === name);
    if (reexport) {
      return reexport.source === undefined
        ? this.find(reexport.imported, facts, seen)
        : this.follow(reexport.imported, reexport.source, facts.file, seen);
    }
    for (const source of facts.exportAll) {
      const found = this.follow(name, source, facts.file, seen);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private follow(name: string, spec: string, fromFile: string, seen: Set<string>): Declaration | undefined {
    const file = this.resolveImport(spec, fromFile);
    const facts = file === undefined ? undefined : this.parsed.get(resolve(file));
    const target = name === 'default' ? (facts?.defaultExport ?? name) : name;
    return facts && target ? this.find(target, facts, seen) : undefined;
  }

  /** The `file:` dependency of the importing module, else a project module of that name. */
  private packageDir(name: string, fromFile: string): string | undefined {
    const moduleDir = this.moduleDir(fromFile);
    if (moduleDir !== undefined) {
      const path = localDependency(this.packages.get(join(moduleDir, OH_PACKAGE))?.dependencies?.[name]);
      if (path !== undefined) {
        const dir = resolve(moduleDir, path);
        return this.stat(join(dir, OH_PACKAGE)) === undefined ? undefined : dir;
      }
    }
    return this.moduleListOf(fromFile)?.dirByName.get(name);
  }

  private moduleListOf(file: string): ModuleList | undefined {
    const root = this.projectRoot(file);
    return root === undefined ? undefined : this.moduleList(root);
  }

  private moduleDir(file: string): string | undefined {
    const start = dirname(resolve(file));
    return memo(this.moduleDirs, start, () => {
      const dirs = this.moduleListOf(file)?.dirs;
      const innermost = dirs && this.closestDir(start, (dir) => dirs.has(directoryKey(dir)));
      return innermost !== undefined
        ? dirs?.get(directoryKey(innermost))
        : this.closestDir(start, (dir) => this.stat(join(dir, OH_PACKAGE)) !== undefined);
    });
  }

  private projectRoot(file: string): string | undefined {
    const start = dirname(resolve(file));
    return memo(this.roots, start, () =>
      this.closestDir(start, (dir) => this.profiles.get(join(dir, BUILD_PROFILE)) !== undefined),
    );
  }

  private closestDir(start: string, matches: (dir: string) => boolean): string | undefined {
    for (let dir = start; ; dir = dirname(dir)) {
      if (matches(dir)) {
        return dir;
      }
      if (dirname(dir) === dir) {
        return undefined;
      }
    }
  }

  private sourceFile(base: string): string | undefined {
    for (const suffix of SOURCE_SUFFIXES) {
      const path = resolve(base + suffix);
      if (this.stat(path) !== undefined) {
        return path;
      }
    }
    return undefined;
  }

  private moduleList(root: string): ModuleList | undefined {
    return memo(this.moduleLists, root, () => {
      const profile = this.profiles.get(join(root, BUILD_PROFILE));
      if (!profile) {
        return undefined;
      }
      const dirByName = new Map<string, string>();
      const dirs = new Map<string, string>();
      for (const m of profile) {
        dirs.set(directoryKey(m.dir), m.dir);
        dirByName.set(m.name, m.dir);
        const packageName = this.packages.get(join(m.dir, OH_PACKAGE))?.name;
        if (packageName) {
          dirByName.set(packageName, m.dir);
        }
      }
      return { dirs, dirByName };
    });
  }
}
