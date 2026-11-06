// Project index: finds the file that declares a name used in an .ets file, through relative imports, module packages
// (hvigor's dependency map, else our parse of build-profile.json5 and oh-package.json5) and Index.ets re-exports.
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { type ClassResolver, type Declaration, type FileFacts, NaiveExtractor } from './analysis.js';

/** Where a module package list came from. */
export type PackageSource = 'map' | 'parser';

interface ModuleDir {
  name: string;
  dir: string;
}

interface ModuleList {
  source: PackageSource;
  modules: ModuleDir[];
  /** Module name and oh-package.json5 name → module dir. */
  byName: Map<string, string>;
}

interface PackageJson {
  name?: string;
  main?: string;
  dependencies: Record<string, string>;
}

/** `.hvigor/dependencyMap/dependencyMap.json5` as DevEco 6.x sync writes it. */
interface DependencyMap {
  /** Absolute path of the map file itself; `srcPath`s resolve against it. */
  basePath: string;
  /** Copy of the root oh-package.json5, relative to the map dir. */
  rootDependency: string;
  /** Module name → copy of its oh-package.json5, relative to the map dir. */
  dependencyMap: Record<string, string>;
  /** `srcPath` uses Windows separators. */
  modules: { name: string; srcPath: string }[];
}

const MAP_PATH = join('.hvigor', 'dependencyMap', 'dependencyMap.json5');
const BUILD_PROFILE = 'build-profile.json5';
const OH_PACKAGE = 'oh-package.json5';
const DEFAULT_ENTRY = 'Index.ets';
/** Tried in order after an import path; ArkTS imports omit the extension. */
const SOURCE_SUFFIXES = ['', '.ets', '.ts', '/Index.ets', '/index.ets', '/index.ts'];
/** SDK and system modules: never in the project. */
const SYSTEM_IMPORT = /^@(?:ohos|kit|system|arkts|hms)\./;

const UNQUOTED_KEY = /[A-Za-z_$][\w$]*(?=\s*:)/y;

/** JSON5 as hvigor and DevEco write it: comments, unquoted keys, single-quoted strings, trailing commas. */
export function parseJson5(text: string): unknown {
  let out = '';
  let trailingComma = -1;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === '\\') {
          s += text[j + 1] === "'" ? "'" : text[j] + text[j + 1];
          j++;
        } else {
          s += c === "'" && text[j] === '"' ? '\\"' : text[j];
        }
      }
      out += `"${s}"`;
      trailingComma = -1;
      i = j + 1;
      continue;
    }
    UNQUOTED_KEY.lastIndex = i;
    const key = UNQUOTED_KEY.exec(text)?.[0];
    if (key && !/[\w$.]/.test(text[i - 1] ?? '')) {
      out += `"${key}"`;
      trailingComma = -1;
      i += key.length;
      continue;
    }
    if ((c === '}' || c === ']') && trailingComma >= 0) {
      out = out.slice(0, trailingComma) + out.slice(trailingComma + 1);
    }
    if (!/\s/.test(c)) {
      trailingComma = c === ',' ? out.length : -1;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): Record<string, string> {
  return isRecord(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};
}

function readJson5(path: string): unknown {
  return parseJson5(readFileSync(path, 'utf8'));
}

function toPackage(v: unknown): PackageJson | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  return {
    name: typeof v.name === 'string' ? v.name : undefined,
    main: typeof v.main === 'string' ? v.main : undefined,
    dependencies: strings(v.dependencies),
  };
}

function toProfileModules(v: unknown, root: string): ModuleDir[] | undefined {
  if (!isRecord(v) || !Array.isArray(v.modules)) {
    return undefined;
  }
  return v.modules.flatMap((m) =>
    isRecord(m) && typeof m.name === 'string' && typeof m.srcPath === 'string'
      ? [{ name: m.name, dir: resolve(root, m.srcPath) }]
      : [],
  );
}

function toDependencyMap(v: unknown): DependencyMap | undefined {
  if (
    !isRecord(v) ||
    typeof v.basePath !== 'string' ||
    typeof v.rootDependency !== 'string' ||
    !Array.isArray(v.modules)
  ) {
    return undefined;
  }
  const modules = v.modules.flatMap((m) =>
    isRecord(m) && typeof m.name === 'string' && typeof m.srcPath === 'string'
      ? [{ name: m.name, srcPath: m.srcPath }]
      : [],
  );
  return { basePath: v.basePath, rootDependency: v.rootDependency, dependencyMap: strings(v.dependencyMap), modules };
}

/** Modification time, or undefined when the path is not a file. */
function mtime(path: string): number | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string) {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

function isInside(file: string, dir: string) {
  const r = relative(dir, file);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

/** mtimes stat'ed once per generation: within one check, files are taken as they were at their first stat. */
class StatCache {
  private readonly seen = new Map<string, number | undefined>();

  mtime(path: string): number | undefined {
    if (!this.seen.has(path)) {
      this.seen.set(path, mtime(path));
    }
    return this.seen.get(path);
  }

  clear(): void {
    this.seen.clear();
  }
}

/** A value derived from one file, recomputed when its mtime changes; undefined for a missing or unreadable file. */
class FileCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; value: T | undefined }>();
  constructor(
    private readonly stats: StatCache,
    private readonly load: (path: string) => T | undefined,
  ) {}

  get(path: string): T | undefined {
    const m = this.stats.mtime(path);
    if (m === undefined) {
      this.entries.delete(path);
      return undefined;
    }
    const hit = this.entries.get(path);
    if (hit?.mtimeMs === m) {
      return hit.value;
    }
    let value: T | undefined;
    try {
      value = this.load(path);
    } catch {
      value = undefined;
    }
    this.entries.set(path, { mtimeMs: m, value });
    return value;
  }
}

/**
 * Resolves names across the files of a DevEco project; caches parsed files by path and mtime. Call refresh() before each
 * check: between two refreshes, files and the project layout are taken as they were when first read.
 */
export class ProjectIndex implements ClassResolver {
  private readonly extractor = new NaiveExtractor();
  private readonly stats = new StatCache();
  private readonly parsed = new FileCache(this.stats, (p) => this.extractor.extract(p, readFileSync(p, 'utf8')));
  private readonly packages = new FileCache(this.stats, (p) => toPackage(readJson5(p)));
  private readonly profiles = new FileCache(this.stats, (p) => toProfileModules(readJson5(p), dirname(p)));
  private readonly maps = new FileCache(this.stats, (p) => toDependencyMap(readJson5(p)));
  /** Copy/source content comparisons by both mtimes. */
  private readonly sameContent = new Map<string, { copy: number; source: number; same: boolean }>();
  /** Kept until refresh(): source dir → project root, root → module list, source dir → module dir, lookups. */
  private readonly roots = new Map<string, string | undefined>();
  private readonly lists = new Map<string, ModuleList | undefined>();
  private readonly moduleDirs = new Map<string, string | undefined>();
  private readonly lookups = new Map<string, Declaration | undefined>();

  /** Starts a new check: files and the project layout are stat'ed again on their next use. */
  refresh(): void {
    this.stats.clear();
    this.roots.clear();
    this.lists.clear();
    this.moduleDirs.clear();
    this.lookups.clear();
  }

  /** Facts of an .ets/.ts file, or undefined when it is missing or unreadable. */
  facts(file: string): FileFacts | undefined {
    return this.parsed.get(resolve(file));
  }

  declaration(name: string, from: FileFacts): Declaration | undefined {
    const key = `${from.file}#${name}`;
    if (!this.lookups.has(key)) {
      this.lookups.set(key, this.find(name, from, new Set()));
    }
    return this.lookups.get(key);
  }

  /** The file an import specifier in `fromFile` points to: relative path, or package entry (or package subpath). */
  resolveImport(spec: string, fromFile: string): string | undefined {
    if (spec.startsWith('.')) {
      return this.sourceFile(resolve(dirname(fromFile), spec));
    }
    if (SYSTEM_IMPORT.test(spec)) {
      return undefined;
    }
    const parts = spec.split('/');
    const nameParts = spec.startsWith('@') ? 2 : 1;
    const dir = this.packageDir(parts.slice(0, nameParts).join('/'), fromFile);
    if (dir === undefined) {
      return undefined;
    }
    const subpath = parts.slice(nameParts).join('/');
    if (subpath) {
      return this.sourceFile(join(dir, subpath));
    }
    return this.sourceFile(join(dir, this.packages.get(join(dir, OH_PACKAGE))?.main || DEFAULT_ENTRY));
  }

  /** Which source gives the module list for the project around `file`; undefined outside a DevEco project. */
  packageSource(file: string): PackageSource | undefined {
    const root = this.projectRoot(file);
    return root === undefined ? undefined : this.moduleList(root)?.source;
  }

  private find(name: string, facts: FileFacts, seen: Set<string>): Declaration | undefined {
    const key = `${facts.file}#${name}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    if (facts.declaredClasses.includes(name) || facts.components.some((c) => c.name === name)) {
      return { facts, name };
    }
    const imp = facts.imports.find((i) => i.local === name);
    if (imp) {
      return this.follow(imp.imported, imp.source, facts.file, seen);
    }
    const re = facts.reexports.find((r) => r.exported === name);
    if (re) {
      return re.source === undefined
        ? this.find(re.imported, facts, seen)
        : this.follow(re.imported, re.source, facts.file, seen);
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
    const facts = file === undefined ? undefined : this.facts(file);
    const target = name === 'default' ? facts?.defaultExport : name;
    return facts && target ? this.find(target, facts, seen) : undefined;
  }

  /** Dir of the package `name` as the module around `fromFile` depends on it: its `file:` dependency, else a project module. */
  private packageDir(name: string, fromFile: string): string | undefined {
    const root = this.projectRoot(fromFile);
    const list = root === undefined ? undefined : this.moduleList(root);
    const moduleDir = this.moduleDir(fromFile, list);
    const dep = moduleDir && this.packages.get(join(moduleDir, OH_PACKAGE))?.dependencies[name];
    if (moduleDir && dep?.startsWith('file:')) {
      const dir = resolve(moduleDir, dep.slice('file:'.length));
      return this.stats.mtime(join(dir, OH_PACKAGE)) === undefined ? undefined : dir;
    }
    return list?.byName.get(name);
  }

  /** The innermost listed module holding `file`, else the nearest dir above it with an oh-package.json5. */
  private moduleDir(file: string, list: ModuleList | undefined): string | undefined {
    const start = dirname(resolve(file));
    if (!this.moduleDirs.has(start)) {
      const listed = list?.modules
        .filter((m) => isInside(file, m.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir;
      this.moduleDirs.set(start, listed ?? this.nearestPackageDir(start));
    }
    return this.moduleDirs.get(start);
  }

  private nearestPackageDir(start: string): string | undefined {
    for (let dir = start; ; dir = dirname(dir)) {
      if (this.stats.mtime(join(dir, OH_PACKAGE)) !== undefined) {
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
      if (this.stats.mtime(path) !== undefined) {
        return path;
      }
    }
    return undefined;
  }

  /** Nearest dir above `file` whose build-profile.json5 lists modules. */
  private projectRoot(file: string): string | undefined {
    const start = dirname(resolve(file));
    if (!this.roots.has(start)) {
      this.roots.set(start, this.findRoot(start));
    }
    return this.roots.get(start);
  }

  private findRoot(start: string): string | undefined {
    for (let dir = start; ; dir = dirname(dir)) {
      if (this.profiles.get(join(dir, BUILD_PROFILE))) {
        return dir;
      }
      if (dirname(dir) === dir) {
        return undefined;
      }
    }
  }

  private moduleList(root: string): ModuleList | undefined {
    if (!this.lists.has(root)) {
      this.lists.set(root, this.readModuleList(root));
    }
    return this.lists.get(root);
  }

  private readModuleList(root: string): ModuleList | undefined {
    const profile = this.profiles.get(join(root, BUILD_PROFILE));
    if (!profile) {
      return undefined;
    }
    const fromMap = this.mapModules(root, profile);
    const modules = fromMap ?? profile;
    const byName = new Map<string, string>();
    for (const m of modules) {
      byName.set(m.name, m.dir);
      const pkgName = this.packages.get(join(m.dir, OH_PACKAGE))?.name;
      if (pkgName) {
        byName.set(pkgName, m.dir);
      }
    }
    return { source: fromMap ? 'map' : 'parser', modules, byName };
  }

  /**
   * Module dirs from hvigor's dependency map, or undefined when it is missing or stale. Sync rewrites only copies whose
   * content changed, so the map's mtime is not a sync time: it is fresh when it sits where `basePath` says, lists the
   * same modules as build-profile.json5, and every oh-package.json5 copy matches its source.
   */
  private mapModules(root: string, profile: ModuleDir[]): ModuleDir[] | undefined {
    const mapPath = join(root, MAP_PATH);
    const map = this.maps.get(mapPath);
    if (!map || !samePath(map.basePath, mapPath)) {
      return undefined;
    }
    const modules = map.modules.map((m) => ({
      name: m.name,
      dir: resolve(map.basePath, m.srcPath.replace(/\\/g, '/')),
    }));
    const sameModules =
      modules.length === profile.length &&
      profile.every((p) => modules.some((m) => m.name === p.name && samePath(m.dir, p.dir)));
    if (!sameModules) {
      return undefined;
    }
    const mapDir = dirname(mapPath);
    const pairs: [string, string][] = [[resolve(mapDir, map.rootDependency), join(root, OH_PACKAGE)]];
    for (const m of modules) {
      const copy = map.dependencyMap[m.name];
      if (copy === undefined) {
        return undefined;
      }
      pairs.push([resolve(mapDir, copy), join(m.dir, OH_PACKAGE)]);
    }
    return pairs.every(([copy, source]) => this.inSync(copy, source)) ? modules : undefined;
  }

  /** Whether a map copy matches its source: a source no newer than the copy is taken as unchanged, else contents compare. */
  private inSync(copy: string, source: string): boolean {
    const mc = this.stats.mtime(copy);
    const ms = this.stats.mtime(source);
    if (mc === undefined || ms === undefined) {
      return mc === ms;
    }
    if (ms <= mc) {
      return true;
    }
    const key = `${copy}\n${source}`;
    const hit = this.sameContent.get(key);
    if (hit?.copy === mc && hit.source === ms) {
      return hit.same;
    }
    let same: boolean;
    try {
      same = readFileSync(copy, 'utf8') === readFileSync(source, 'utf8');
    } catch {
      same = false;
    }
    this.sameContent.set(key, { copy: mc, source: ms, same });
    return same;
  }
}
