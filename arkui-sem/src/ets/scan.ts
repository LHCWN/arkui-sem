// One file being extracted: its tree, and positions and text read from it.
import { directives } from './directives.js';
import type { EtsParser, ts } from './parse.js';
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
}
