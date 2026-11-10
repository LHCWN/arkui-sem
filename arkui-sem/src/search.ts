// Text search over a project's .ets files: ripgrep when a binary runs, else reading the files from Node.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { etsFiles, SKIP_DIRS } from './analysis.js';

export interface SearchTerms {
  /** Matched as whole identifiers: no letter, digit, `_` or `$` on either side. */
  words: string[];
  /** Regular expressions in the syntax JavaScript and ripgrep share, matched within one line. */
  patterns: string[];
}

export interface SearchResult {
  /** Files with a match for any term. A superset is allowed: ripgrep and JavaScript differ on non-ASCII letters. */
  files: string[];
  /** Directories and files that could not be read. */
  unreadable: string[];
}

export interface TextSearch {
  search(dirs: string[], terms: SearchTerms): Promise<SearchResult>;
}

const READS_AT_ONCE = 64;
const RG_OUTPUT_LIMIT = 64 * 1024 * 1024;
/** ripgrep exits with 1 when nothing matched; above that an error cut the search short. */
const RG_NO_MATCH = 1;

/** The .ets files under the directories, each once; unreadable collects what the listing could not read. */
export function listEtsFiles(dirs: string[], unreadable: string[]): string[] {
  return [...new Set(dirs.flatMap((dir) => etsFiles(dir, new Set(), unreadable)))];
}

function escaped(literal: string) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(words: string[]) {
  return `(?:^|[^\\w$])(?:${words.map(escaped).join('|')})(?:$|[^\\w$])`;
}

function patternOf(terms: SearchTerms) {
  return [...(terms.words.length > 0 ? [wordPattern(terms.words)] : []), ...terms.patterns].join('|');
}

/** PATH first, then the binary opencode downloads for itself (cache directory; data directory in older versions). */
function ripgrepBinaries(): string[] {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const configured = process.env.ARKUI_SEM_RG;
  return [
    ...(configured ? [configured] : []),
    'rg',
    join(cache, 'opencode', 'bin', exe),
    join(data, 'opencode', 'bin', exe),
  ];
}

/** The same files as etsFiles: no ignore files, hidden attributes or binary detection; links followed. */
function ripgrepArgs(dirs: string[], pattern: string): string[] {
  return [
    '--no-config',
    '--no-ignore',
    '--hidden',
    '--text',
    '--follow',
    '--files-with-matches',
    '--glob=*.ets',
    '--glob=!.*',
    `--glob=!{${[...SKIP_DIRS].join(',')}}`,
    `--regexp=${pattern}`,
    '--',
    ...dirs,
  ];
}

type RipgrepRun = { files: string[] } | 'missing' | 'failed';

function runRipgrep(binary: string, dirs: string[], pattern: string): Promise<RipgrepRun> {
  return new Promise((done) => {
    execFile(binary, ripgrepArgs(dirs, pattern), { maxBuffer: RG_OUTPUT_LIMIT, windowsHide: true }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        done(error.code === 'ENOENT' || error.code === 'EACCES' ? 'missing' : 'failed');
      } else if (error && error.code !== RG_NO_MATCH) {
        done('failed');
      } else {
        done({ files: stdout.split(/\r?\n/).filter((line) => line !== '') });
      }
    });
  });
}

async function searchFromNode(dirs: string[], pattern: string): Promise<SearchResult> {
  const unreadable: string[] = [];
  const listed = listEtsFiles(dirs, unreadable);
  const matcher = new RegExp(pattern, 'm');
  const files: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const file = listed[next++];
      try {
        if (matcher.test(await readFile(file, 'utf8'))) {
          files.push(file);
        }
      } catch {
        unreadable.push(file);
      }
    }
  };
  await Promise.all(Array.from({ length: READS_AT_ONCE }, worker));
  return { files, unreadable };
}

/**
 * ripgrep with a fallback to Node. A binary that can't be started is dropped for the process; a run that fails (a link
 * cycle, an unreadable directory) is repeated from Node, which reports what it could not read.
 */
export class FileSearch implements TextSearch {
  /** binaries: ripgrep paths to try in order; none searches from Node only. */
  constructor(private readonly binaries: string[] = ripgrepBinaries()) {}

  async search(dirs: string[], terms: SearchTerms): Promise<SearchResult> {
    const pattern = patternOf(terms);
    if (pattern === '') {
      return { files: [], unreadable: [] };
    }
    while (this.binaries.length > 0) {
      const binary = this.binaries[0];
      const run = await runRipgrep(binary, dirs, pattern);
      if (run === 'missing') {
        // A search running alongside may have dropped it already.
        if (this.binaries[0] === binary) {
          this.binaries.shift();
        }
      } else if (run === 'failed') {
        break;
      } else {
        return { files: run.files.map((file) => resolve(file)), unreadable: [] };
      }
    }
    return searchFromNode(dirs, pattern);
  }
}
