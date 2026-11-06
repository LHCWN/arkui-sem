// Parses .ets files with ohos-typescript, OpenHarmony's TypeScript fork that the ArkTS compiler itself builds on.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import ts from 'ohos-typescript';
import { etsLoaderDir, findSdk } from '../sdk.js';
import BUNDLED from './options.json' with { type: 'json' };

export { ts };

/** Component names decide how `Name(…) { … }.attr()` parses, so the options come from the SDK the code is built with
 *  when there is one, else from the copy in options.json (`scripts/ets-options.mjs`). */
export class EtsParser {
  readonly options: ts.CompilerOptions;

  /** sdk: the HarmonyOS SDK root (see findSdk); none uses the bundled options. */
  constructor(sdk?: string) {
    this.options = { ets: (sdk && sdkEtsOptions(sdk)) || bundledOptions() };
  }

  parse(file: string, text: string): ts.SourceFile {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, this.options);
  }
}

let shared: EtsParser | undefined;

/** The parser for this machine's SDK, built on first use. */
export function defaultParser(): EtsParser {
  shared ??= new EtsParser(findSdk());
  return shared;
}

function bundledOptions(): ts.EtsOptions {
  const ets = asEtsOptions(BUNDLED);
  if (!ets) {
    throw new Error('src/ets/options.json has no components list: regenerate it with scripts/ets-options.mjs');
  }
  return ets;
}

/** v when it holds a list of component names; the rest of its shape is the compiler's to check. */
function asEtsOptions(v: unknown): ts.EtsOptions | undefined {
  if (typeof v !== 'object' || v === null || !('components' in v)) {
    return undefined;
  }
  const { components } = v;
  return Array.isArray(components) && components.every((c) => typeof c === 'string') ? (v as ts.EtsOptions) : undefined;
}

/** The options the SDK's compiler parses with: its ets-loader options, plus the HMS components it registers when the SDK
 *  has the HMS kit. */
function sdkEtsOptions(sdk: string): ts.EtsOptions | undefined {
  let ets: ts.EtsOptions | undefined;
  try {
    const config: unknown = JSON5.parse(readFileSync(join(etsLoaderDir(sdk, 'openharmony'), 'tsconfig.json'), 'utf8'));
    const compilerOptions =
      typeof config === 'object' && config !== null && 'compilerOptions' in config ? config.compilerOptions : undefined;
    ets =
      typeof compilerOptions === 'object' && compilerOptions !== null && 'ets' in compilerOptions
        ? asEtsOptions(compilerOptions.ets)
        : undefined;
  } catch {
    return undefined;
  }
  if (!ets) {
    return undefined;
  }
  return { ...ets, components: [...new Set([...ets.components, ...hmsComponents(sdk)])] };
}

function hmsComponents(sdk: string): string[] {
  const dir = join(etsLoaderDir(sdk, 'hms'), 'components');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // an OpenHarmony-only SDK
  }
  return files.flatMap((f) => {
    try {
      const name: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8')).name;
      return typeof name === 'string' ? [name] : [];
    } catch {
      return [];
    }
  });
}
