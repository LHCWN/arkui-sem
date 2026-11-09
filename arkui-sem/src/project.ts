// Project index: finds the file that declares a name used in an .ets file, across imports, module packages and re-exports.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import JSON5 from 'json5';
import { type Declaration, declares, type FactExtractor, type FileFacts, type Project } from './analysis.js';
import { EtsExtractor } from './ets/extract.js';

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

  constructor(private readonly extractor: FactExtractor = new EtsExtractor()) {}

  refresh(): void {
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
      const dependency = this.packages.get(join(moduleDir, OH_PACKAGE))?.dependencies?.[name];
      const path = dependency?.startsWith(FILE_DEPENDENCY) ? dependency.slice(FILE_DEPENDENCY.length) : dependency;
      if (path?.startsWith('.')) {
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
