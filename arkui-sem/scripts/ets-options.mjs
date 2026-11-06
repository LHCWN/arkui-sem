#!/usr/bin/env node
// Regenerate src/ets-options.json, the ArkTS parser options used when no HarmonyOS SDK is found:
//   node scripts/ets-options.mjs <sdk>   (<sdk>: the directory holding default/openharmony and default/hms)
// Then run `npm run format`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const sdk = process.argv[2];
if (!sdk) {
  console.error('usage: node scripts/ets-options.mjs <sdk>');
  process.exit(2);
}
const loader = (kit) => join(sdk, 'default', kit, 'ets', 'build-tools', 'ets-loader');
const { ets } = JSON5.parse(readFileSync(join(loader('openharmony'), 'tsconfig.json'), 'utf8')).compilerOptions;
const hmsDir = join(loader('hms'), 'components');
const hms = readdirSync(hmsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(hmsDir, f), 'utf8')).name)
  .filter((n) => typeof n === 'string');
ets.components = [...new Set([...ets.components, ...hms])].sort();

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ets-options.json');
writeFileSync(out, `${JSON.stringify(ets, null, 2)}\n`);
console.log(`${ets.components.length} components -> ${out}`);
