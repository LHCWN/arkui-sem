// The .ets files under a path, and the files an agent's edit touched.
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build', 'dist']);

export function absolute(p: string, base: string) {
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * followed: real paths of the listing's root and of directories behind links, each listed once so link cycles end.
 * unreadable: when given, a path the listing can't read is added to it and skipped; otherwise the error is thrown.
 */
export function etsFiles(path: string, followed = new Set<string>(), unreadable?: string[]): string[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    if (statSync(path).isFile()) {
      return path.endsWith('.ets') ? [path] : [];
    }
    const real = realpathSync(path);
    if (followed.has(real)) {
      return [];
    }
    followed.add(real);
    return etsFilesIn(path, followed, unreadable);
  } catch (e) {
    return skipped(path, e, unreadable);
  }
}

function skipped<T>(path: string, e: unknown, unreadable?: string[]): T[] {
  if (!unreadable) {
    throw e;
  }
  unreadable.push(path);
  return [];
}

/** Empty when the directory has gone since its parent was listed. */
function entriesOf(dir: string, unreadable?: string[]): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    return skipped(dir, e, unreadable);
  }
}

/** Directory entries carry their type, so only links and entries of unknown type cost a stat. */
export function etsFilesIn(dir: string, followed = new Set<string>(), unreadable?: string[]): string[] {
  return entriesOf(dir, unreadable).flatMap((e) => {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
      return [];
    }
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return etsFilesIn(path, followed, unreadable);
    }
    if (e.isFile()) {
      return e.name.endsWith('.ets') ? [path] : [];
    }
    return etsFiles(path, followed, unreadable);
  });
}

export function editedFiles(args: unknown, directory: string): string[] {
  const a = (args ?? {}) as { filePath?: unknown; patchText?: unknown };
  if (typeof a.filePath === 'string') {
    return [absolute(a.filePath, directory)];
  }
  if (typeof a.patchText === 'string') {
    return [...a.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) =>
      absolute((m[1] ?? m[2]).trim(), directory),
    );
  }
  return [];
}
