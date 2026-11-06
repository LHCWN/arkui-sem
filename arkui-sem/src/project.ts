// Project index: finds the file that declares a name used in an .ets file, across imports, module packages and re-exports.
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';
import { type ClassResolver, type Declaration, declares, type FileFacts, NaiveExtractor } from './analysis.js';

interface Module {
  name: string;
  dir: string;
}

interface ModuleList {
  modules: Module[];
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
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function isInside(file: string, dir: string) {
  const r = relative(dir, file);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

function memo<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  if (!cache.has(key)) {
    cache.set(key, compute());
  }
  return cache.get(key) as V;
}

/** A value loaded from a file, reloaded when its mtime changes; undefined when the file is missing or fails to load. */
class FileCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; value: T | undefined }>();

  constructor(
    private readonly stat: (path: string) => number | undefined,
    private readonly load: (path: string) => T | undefined,
  ) {}

  get(path: string): T | undefined {
    const mtimeMs = this.stat(path);
    if (mtimeMs === undefined) {
      this.entries.delete(path);
      return undefined;
    }
    const hit = this.entries.get(path);
    if (hit?.mtimeMs === mtimeMs) {
      return hit.value;
    }
    let value: T | undefined;
    try {
      value = this.load(path);
    } catch {
      value = undefined;
    }
    this.entries.set(path, { mtimeMs, value });
    return value;
  }
}

/** Call refresh() before each check; between refreshes, files and the project layout are not re-read. */
export class ProjectIndex implements ClassResolver {
  private readonly extractor = new NaiveExtractor();
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

  refresh(): void {
    this.mtimes.clear();
    this.roots.clear();
    this.moduleLists.clear();
    this.moduleDirs.clear();
    this.lookups.clear();
  }

  facts(file: string): FileFacts | undefined {
    return this.parsed.get(resolve(file));
  }

  declaration(name: string, from: FileFacts): Declaration | undefined {
    return memo(this.lookups, `${from.file}#${name}`, () => this.find(name, from, new Set()));
  }

  /** The file an import specifier points to: a relative path, a package entry or a file inside a package. */
  resolveImport(spec: string, fromFile: string): string | undefined {
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
    const facts = file === undefined ? undefined : this.facts(file);
    const target = name === 'default' ? (facts?.defaultExport ?? name) : name;
    return facts && target ? this.find(target, facts, seen) : undefined;
  }

  /** The `file:` dependency of the importing module, else a project module of that name. */
  private packageDir(name: string, fromFile: string): string | undefined {
    const moduleDir = this.moduleDir(fromFile);
    if (moduleDir !== undefined) {
      const dependency = this.packages.get(join(moduleDir, OH_PACKAGE))?.dependencies?.[name];
      if (dependency?.startsWith(FILE_DEPENDENCY)) {
        const dir = resolve(moduleDir, dependency.slice(FILE_DEPENDENCY.length));
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
      const innermost = this.moduleListOf(file)
        ?.modules.filter((m) => isInside(file, m.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      return innermost?.dir ?? this.closestDir(start, (dir) => this.stat(join(dir, OH_PACKAGE)) !== undefined);
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
    return SOURCE_SUFFIXES.map((s) => resolve(base + s)).find((p) => this.stat(p) !== undefined);
  }

  private moduleList(root: string): ModuleList | undefined {
    return memo(this.moduleLists, root, () => {
      const profile = this.profiles.get(join(root, BUILD_PROFILE));
      if (!profile) {
        return undefined;
      }
      const dirByName = new Map<string, string>();
      for (const m of profile) {
        dirByName.set(m.name, m.dir);
        const packageName = this.packages.get(join(m.dir, OH_PACKAGE))?.name;
        if (packageName) {
          dirByName.set(packageName, m.dir);
        }
      }
      return { modules: profile, dirByName };
    });
  }
}
