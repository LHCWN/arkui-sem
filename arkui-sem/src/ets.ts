// Parses .ets files with ohos-typescript, OpenHarmony's TypeScript fork that the ArkTS compiler itself builds on.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import ts from 'ohos-typescript';
import BUNDLED from './ets-options.json' with { type: 'json' };
import { findStudio } from './lsp/server.js';

export { ts };

/** ets-loader's directory in one SDK kit (`openharmony`, `hms`). */
function loaderDir(sdk: string, kit: string): string {
  return join(sdk, 'default', kit, 'ets', 'build-tools', 'ets-loader');
}

/** The options the SDK's compiler parses with: its ets-loader options, plus the HMS components it registers. */
function sdkEtsOptions(sdk: string): ts.EtsOptions | undefined {
  try {
    const config = JSON5.parse(readFileSync(join(loaderDir(sdk, 'openharmony'), 'tsconfig.json'), 'utf8'));
    const ets: ts.EtsOptions = config.compilerOptions.ets;
    const hmsDir = join(loaderDir(sdk, 'hms'), 'components');
    const hms = readdirSync(hmsDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          const name: unknown = JSON.parse(readFileSync(join(hmsDir, f), 'utf8')).name;
          return typeof name === 'string' ? [name] : [];
        } catch {
          return [];
        }
      });
    return { ...ets, components: [...new Set([...ets.components, ...hms])] };
  } catch {
    return undefined;
  }
}

let options: ts.CompilerOptions | undefined;

/** Component names decide how `Name(…) { … }.attr()` parses: from the SDK (`ARKUI_SEM_SDK`, else DevEco Studio's), else
 *  the copy in ets-options.json (`scripts/ets-options.mjs`). */
export function etsOptions(env = process.env): ts.CompilerOptions {
  if (!options) {
    const studio = findStudio(env);
    const sdk = env.ARKUI_SEM_SDK || (studio && join(studio, 'sdk'));
    const ets = (sdk && sdkEtsOptions(sdk)) || (BUNDLED as unknown as ts.EtsOptions);
    options = { ets };
  }
  return options;
}

export function parseEts(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, etsOptions());
}
