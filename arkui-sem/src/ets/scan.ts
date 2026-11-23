// One file being extracted: its tree, and positions and text read from it.
import { directives } from './directives.js';
import { type EtsParser, ts } from './parse.js';
import { oneLine } from './syntax.js';

export class FileScan {
  readonly sf: ts.SourceFile;
  private readonly disabled: Map<number, string[]>;

  constructor(
    readonly file: string,
    readonly source: string,
    parser: EtsParser,
  ) {
    this.sf = parser.parse(file, source);
    this.disabled = directives(this.sf, source);
  }

  line(n: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1;
  }

  /** The node's text on one line. */
  text(n: ts.Node): string {
    return oneLine(n.getText(this.sf));
  }

  /** The rules a disable comment on the line above `line` disables. */
  disabledAt(line: number): string[] {
    return this.disabled.get(line) ?? [];
  }

  /** The rules disabled for a node: by a comment above its line, or above the first line of the innermost statement
   *  holding it, so one comment above a multi-line call covers its arguments. A statement inside a callback's block body
   *  is its own statement; an `else if` or unbraced branch belongs to the outer `if`. */
  disabledFor(n: ts.Node): string[] {
    let statement: ts.Node | undefined = n;
    while (statement && !isStatement(statement)) {
      statement = statement.parent;
    }
    const lines = new Set([this.line(n), statement ? this.line(statement) : this.line(n)]);
    return [...new Set([...lines].flatMap((l) => this.disabledAt(l)))];
  }
}

/** A statement in a block, a file or a case, or a member of a class or struct; an object literal's methods and accessors
 *  are part of the expression that holds them. */
function isStatement(n: ts.Node): boolean {
  const p = n.parent;
  if (p === undefined) {
    return false;
  }
  if (ts.isClassLike(p) || ts.isStructDeclaration(p)) {
    return ts.isClassElement(n);
  }
  return ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseOrDefaultClause(p);
}
