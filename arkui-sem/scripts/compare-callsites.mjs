#!/usr/bin/env node
// Checks that the searched call sites of a sample of structs equal the whole-project scan's, and times both:
//   node scripts/compare-callsites.mjs <project> [--sample <n>] [--all] [--no-rg]
//   node scripts/compare-callsites.mjs --generate <files> [--sample <n>] [--no-rg]   (a synthetic project in a temp dir)
// <project>: a directory with build-profile.json5. --all compares every struct; --no-rg searches from Node only.
// Needs `npm run build`. Exits with 1 when a struct's sites differ.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { etsFiles } from '../dist/analysis.js';
import { ProjectIndex } from '../dist/project.js';
import { FileSearch } from '../dist/search.js';

const DEFAULT_SAMPLE = 200;
const MODULES = 20;

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Pages that call components of their own and other modules by name, alias, default import and package entry. */
function generate(files) {
  const root = mkdtempSync(join(tmpdir(), 'arkui-sem-callsites-'));
  const perModule = Math.ceil(files / MODULES);
  const modules = Array.from({ length: MODULES }, (_, m) => `m${m}`);
  put(
    join(root, 'build-profile.json5'),
    JSON.stringify({ modules: modules.map((name) => ({ name, srcPath: `./${name}` })) }),
  );
  put(join(root, 'oh-package.json5'), '{}');
  const filler = Array.from({ length: 150 }, (_, i) => `  private v${i}: number = ${i} // padding line ${i}`).join(
    '\n',
  );
  modules.forEach((name, m) => {
    const dependencies = Object.fromEntries(modules.filter((d) => d !== name).map((d) => [d, `file:../${d}`]));
    put(join(root, name, 'oh-package.json5'), JSON.stringify({ name, dependencies }));
    const exports = [];
    for (let i = 0; i < perModule; i++) {
      const struct = `C${m}x${i}`;
      const isDefault = i % 7 === 0;
      const other = `m${(m + 1 + (i % (MODULES - 1))) % MODULES}`;
      const near = `C${m}x${(i + 1) % perModule}`;
      const nearDefault = ((i + 1) % perModule) % 7 === 0;
      const far = `C${(m + 1 + (i % (MODULES - 1))) % MODULES}x${(i * 3) % perModule}`;
      const farDefault = ((i * 3) % perModule) % 7 === 0;
      const imports = [
        nearDefault ? `import Near${i} from './${near}'` : `import { ${near} as Near${i} } from './${near}'`,
        `import { ${farDefault ? `${far}Alias` : far} } from '${other}'`,
      ];
      const calls = [`Near${i}({ n: this.n })`, `${farDefault ? `${far}Alias` : far}({ n: 1 })`];
      put(
        join(root, name, 'src', 'main', 'ets', `${struct}.ets`),
        `${imports.join('\n')}\n@Component\nexport ${isDefault ? 'default ' : ''}struct ${struct} {\n  @State n: number = 0\n${filler}\n  build() {\n    Column() {\n      ${calls.join('\n      ')}\n    }\n  }\n}\n`,
      );
      exports.push(
        isDefault
          ? `export { default as ${struct}Alias } from './src/main/ets/${struct}'`
          : i % 2 === 0
            ? `export { ${struct} } from './src/main/ets/${struct}'`
            : `export * from './src/main/ets/${struct}'`,
      );
    }
    put(join(root, name, 'Index.ets'), `${exports.join('\n')}\n`);
  });
  return root;
}

function sample(items, n) {
  const step = Math.max(1, Math.floor(items.length / n));
  return items.filter((_, i) => i % step === 0).slice(0, n);
}

const canonical = (sites) =>
  JSON.stringify(
    sites
      .map((s) => ({ ...s, file: resolve(s.file).toLowerCase() }))
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)),
  );

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const generated = option('--generate');
const root = generated ? generate(Number(generated)) : resolve(args[0] ?? '');
const search = args.includes('--no-rg') ? new FileSearch([]) : new FileSearch();

try {
  const files = etsFiles(root);
  const full = new ProjectIndex();
  let started = performance.now();
  const structs = files.flatMap((file) => {
    try {
      return full.facts(file).components.map((c) => ({ file, name: c.name }));
    } catch {
      return [];
    }
  });
  const picked = args.includes('--all') ? structs : sample(structs, Number(option('--sample') ?? DEFAULT_SAMPLE));
  const reference = new Map();
  for (const s of picked) {
    reference.set(s, full.callSites({ facts: full.facts(s.file), name: s.name }, { workspace: root }));
  }
  const fullMs = performance.now() - started;

  // A fresh index per struct, so each search pays for its own parsing, as the first question in a session does.
  const times = [];
  let different = 0;
  let sites = 0;
  for (const s of picked) {
    const index = new ProjectIndex(undefined, search);
    started = performance.now();
    const found = await index.searchCallSites({ facts: index.facts(s.file), name: s.name }, { workspace: root });
    times.push(performance.now() - started);
    const expected = reference.get(s);
    sites += expected?.sites.length ?? 0;
    if (canonical(found?.sites ?? []) !== canonical(expected?.sites ?? [])) {
      different++;
      console.log(`differs: ${s.name} in ${s.file}: searched ${found?.sites.length}, scan ${expected?.sites.length}`);
    }
  }
  times.sort((a, b) => a - b);
  const ms = (t) => `${Math.round(t)} ms`;
  console.log(`${files.length} .ets files, ${structs.length} structs, ${picked.length} compared, ${sites} sites`);
  console.log(`whole-project scan (parse and resolve everything, once): ${ms(fullMs)}`);
  console.log(
    `search per struct: median ${ms(percentile(times, 0.5))}, p95 ${ms(percentile(times, 0.95))}, max ${ms(times.at(-1) ?? 0)}`,
  );
  console.log(different === 0 ? 'all equal' : `${different} structs differ`);
  process.exitCode = different === 0 ? 0 : 1;
} finally {
  if (generated) {
    rmSync(root, { recursive: true, force: true });
  }
}
