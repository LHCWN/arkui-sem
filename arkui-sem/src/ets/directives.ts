// `// arkui-sem-disable-next-line R1, R3` comments.
import { ts } from './parse.js';

const DIRECTIVE = 'arkui-sem-disable-next-line';
const DISABLE = /arkui-sem-disable-next-line\s+([\w\s,]+)/;

/** For each line, the rules a disable comment on the line above disables. */
export function directives(sf: ts.SourceFile, text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!text.includes(DIRECTIVE)) {
    return out;
  }
  const seen = new Set<number>();
  const read = (ranges: ts.CommentRange[] | undefined) => {
    for (const c of ranges ?? []) {
      if (seen.has(c.pos)) {
        continue;
      }
      seen.add(c.pos);
      const m = text.slice(c.pos, c.end).match(DISABLE);
      if (m) {
        const line = sf.getLineAndCharacterOfPosition(c.pos + (m.index ?? 0)).line + 2;
        const rules = m[1].split(/[\s,]+/).filter((r) => /^R\d+$/.test(r));
        out.set(line, [...new Set([...(out.get(line) ?? []), ...rules])]);
      }
    }
  };
  // Every comment is trivia before or after some node's bounds.
  const visit = (n: ts.Node) => {
    for (const pos of [n.pos, n.end]) {
      read(ts.getLeadingCommentRanges(text, pos));
      read(ts.getTrailingCommentRanges(text, pos));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
