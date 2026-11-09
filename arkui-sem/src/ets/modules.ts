// Imports and exports that link a file to others.
import type { FileFacts, ImportFact, ReexportFact } from '../analysis.js';
import { ts } from './parse.js';
import { hasModifier } from './syntax.js';

export function moduleLinks(
  sf: ts.SourceFile,
): Pick<FileFacts, 'imports' | 'reexports' | 'exportAll' | 'defaultExport'> {
  const imports: ImportFact[] = [];
  const reexports: ReexportFact[] = [];
  const exportAll: string[] = [];
  let defaultExport: string | undefined;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const source = st.moduleSpecifier.text;
      const { name, namedBindings } = st.importClause;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          imports.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, source });
        }
      }
      if (name) {
        imports.push({ imported: 'default', local: name.text, source });
      }
    } else if (ts.isExportDeclaration(st)) {
      const source = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (!st.exportClause) {
        if (source !== undefined) {
          exportAll.push(source);
        }
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          reexports.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text, source });
        }
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
      defaultExport = st.expression.text;
    } else if (
      (ts.isClassDeclaration(st) || ts.isStructDeclaration(st)) &&
      st.name &&
      hasModifier(st, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(st, ts.SyntaxKind.DefaultKeyword)
    ) {
      defaultExport = st.name.text;
    }
  }
  return { imports, reexports, exportAll, defaultExport };
}
