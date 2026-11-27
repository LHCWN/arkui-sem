// Finds the HarmonyOS SDK on this machine: a given directory or DevEco Studio's.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STUDIO_CANDIDATES: Record<string, string[]> = {
  win32: ['C:\\Program Files\\Huawei\\DevEco Studio', 'C:\\Program Files (x86)\\Huawei\\DevEco Studio'],
  darwin: ['/Applications/DevEco-Studio.app/Contents', '/Applications/DevEco Studio.app/Contents'],
};

function hasSdk(dir: string): boolean {
  return existsSync(join(dir, 'default', 'openharmony'));
}

/** The SDK of the first DevEco Studio install that has one: `DEVECO_STUDIO`, then the default install paths. */
function studioSdk(env: NodeJS.ProcessEnv): string | undefined {
  return [env.DEVECO_STUDIO, ...(STUDIO_CANDIDATES[process.platform] ?? [])]
    .filter((p): p is string => !!p)
    .map((p) => join(p, 'sdk'))
    .find(hasSdk);
}

/** The HarmonyOS SDK root, the directory holding `default/openharmony` and `default/hms`: `explicit`, else
 *  `ARKUI_SEM_SDK`, else DevEco Studio's. A given directory without an SDK gives none, with no fallback. */
export function findSdk(explicit?: string, env = process.env): string | undefined {
  const given = explicit || env.ARKUI_SEM_SDK;
  if (given) {
    return hasSdk(given) ? given : undefined;
  }
  return studioSdk(env);
}

/** ets-loader's directory in one SDK kit (`openharmony`, `hms`): the ArkTS compiler's options and component lists. */
export function etsLoaderDir(sdk: string, kit: 'openharmony' | 'hms'): string {
  return join(sdk, 'default', kit, 'ets', 'build-tools', 'ets-loader');
}
