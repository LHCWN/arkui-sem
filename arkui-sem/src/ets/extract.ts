// .ets source → FileFacts, from the ohos-typescript syntax tree of one file (no type checker).
import type { ComponentFact, FactExtractor, FileFacts, TypeFact } from '../facts.js';
import type { BuilderNames } from './callbacks.js';
import { component } from './component.js';
import { builderFact } from './loops.js';
import { moduleLinks } from './modules.js';
import { defaultParser, type EtsParser, ts } from './parse.js';
import { FileScan } from './scan.js';
import { decoratorNames, hasParseErrors } from './syntax.js';
import { typeFactOf } from './types.js';
import { componentUses } from './uses.js';

export class EtsExtractor implements FactExtractor {
  /** "ets/sdk" or "ets/bundled": which component list parsed the files (see EtsParser). */
  readonly name: string;

  constructor(private readonly parser: EtsParser = defaultParser()) {
    this.name = `ets/${parser.source}`;
  }

  extract(file: string, text: string): FileFacts {
    const scan = new FileScan(file, text, this.parser);
    const links = moduleLinks(scan.sf);
    const builderFunctions = scan.sf.statements.filter(
      (st): st is ts.FunctionDeclaration & { name: ts.Identifier } =>
        ts.isFunctionDeclaration(st) && st.name !== undefined && decoratorNames(st).includes('@Builder'),
    );
    const names: BuilderNames = {
      methods: new Set(),
      functions: new Set(builderFunctions.map((f) => f.name.text)),
      imports: new Set(links.imports.map((i) => i.local)),
    };
    const components: ComponentFact[] = [];
    const types: Record<string, TypeFact> = {};
    const visit = (n: ts.Node) => {
      if (ts.isStructDeclaration(n)) {
        const c = component(n, scan, names);
        if (c) {
          components.push(c);
        }
      } else {
        const declared = typeFactOf(n, scan.sf);
        if (declared) {
          types[declared[0]] = declared[1];
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scan.sf);
    const callable = new Set([...links.imports.map((i) => i.local), ...components.map((c) => c.name)]);
    return {
      file,
      components,
      types,
      ...links,
      componentUses: componentUses(scan, callable),
      builders: builderFunctions.map((f) => builderFact(f.name.text, f, scan, names)),
      parseErrors: hasParseErrors(scan.sf),
      lines: text.split(/\r?\n/),
    };
  }
}
