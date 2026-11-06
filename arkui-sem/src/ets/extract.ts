// .ets source → FileFacts, from the ohos-typescript syntax tree of one file (no type checker).
import type { ComponentFact, FactExtractor, FileFacts, TypeFact } from '../analysis.js';
import { component } from './component.js';
import { moduleLinks } from './modules.js';
import { defaultParser, type EtsParser, ts } from './parse.js';
import { FileScan } from './scan.js';
import { typeFactOf } from './types.js';

export class EtsExtractor implements FactExtractor {
  readonly name = 'ets';

  constructor(private readonly parser: EtsParser = defaultParser()) {}

  extract(file: string, text: string): FileFacts {
    const scan = new FileScan(file, text, this.parser);
    const components: ComponentFact[] = [];
    const types: Record<string, TypeFact> = {};
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if ((ts.isCallExpression(n) || ts.isEtsComponentExpression(n)) && ts.isIdentifier(n.expression)) {
        called.add(n.expression.text);
      }
      if (ts.isStructDeclaration(n)) {
        const c = component(n, scan);
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
    const links = moduleLinks(scan.sf);
    for (const i of links.imports) {
      i.called = called.has(i.local);
    }
    return { file, components, types, ...links, lines: text.split(/\r?\n/) };
  }
}
