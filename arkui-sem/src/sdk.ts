// Finds DevEco Studio and the HarmonyOS SDK on this machine.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STUDIO_CANDIDATES: Record<string, string[]> = {
  win32: ['C:\\Program Files\\Huawei\\DevEco Studio', 'C:\\Program Files (x86)\\Huawei\\DevEco Studio'],
  darwin: ['/Applications/DevEco-Studio.app/Contents', '/Applications/DevEco Studio.app/Contents'],
};

export function findStudio(env = process.env): string | undefined {
  const candidates = [env.DEVECO_STUDIO, ...(STUDIO_CANDIDATES[process.platform] ?? [])].filter(
    (p): p is string => !!p,
  );
  return candidates.find((p) => existsSync(join(p, 'plugins', 'openharmony', 'ace-server')));
}

/** The HarmonyOS SDK root, the directory holding `default/openharmony` and `default/hms`: `explicit`, else
 *  `ARKUI_SEM_SDK`, else DevEco Studio's. */
export function findSdk(explicit?: string, env = process.env): string | undefined {
  const studio = findStudio(env);
  const sdk = explicit || env.ARKUI_SEM_SDK || (studio && join(studio, 'sdk'));
  return sdk && existsSync(join(sdk, 'default', 'openharmony')) ? sdk : undefined;
}

/** ets-loader's directory in one SDK kit (`openharmony`, `hms`): the ArkTS compiler's options and component lists. */
export function etsLoaderDir(sdk: string, kit: 'openharmony' | 'hms'): string {
  return join(sdk, 'default', kit, 'ets', 'build-tools', 'ets-loader');
}
