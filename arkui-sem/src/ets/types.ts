// Type annotations, object literals, and the classes, interfaces and object type aliases a file declares.
import type { ClassMember, LiteralValue, ObjectLiteralFact, TypeFact, TypeRef } from '../analysis.js';
import { ts } from './parse.js';
import { decoratorNames, expressionName, isThis, memberName, oneLine, unwrap } from './syntax.js';

const KEYWORD_TYPES = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NeverKeyword,
]);

function entityName(n: ts.EntityName): string {
  return ts.isIdentifier(n) ? n.text : `${entityName(n.left)}.${n.right.text}`;
}

export function typeRef(t: ts.TypeNode): TypeRef {
  if (ts.isParenthesizedTypeNode(t)) {
    return typeRef(t.type);
  }
  if (ts.isTypeOperatorNode(t) && t.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return typeRef(t.type);
  }
  if (ts.isArrayTypeNode(t)) {
    return { kind: 'array', element: typeRef(t.elementType) };
  }
  if (ts.isUnionTypeNode(t)) {
    return { kind: 'union', members: t.types.map(typeRef) };
  }
  if (ts.isFunctionTypeNode(t) || ts.isConstructorTypeNode(t)) {
    return { kind: 'function' };
  }
  if (ts.isTypeLiteralNode(t)) {
    return { kind: 'object' };
  }
  if (ts.isTypeReferenceNode(t)) {
    return { kind: 'name', name: entityName(t.typeName), args: (t.typeArguments ?? []).map(typeRef) };
  }
  if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: 'keyword', name: 'null' };
  }
  if (KEYWORD_TYPES.has(t.kind)) {
    return { kind: 'keyword', name: ts.tokenToString(t.kind) ?? 'unknown' };
  }
  return { kind: 'other' };
}

export function objectLiteral(e: ts.Expression | undefined): ObjectLiteralFact | undefined {
  const o = e && unwrap(e);
  if (!o || !ts.isObjectLiteralExpression(o)) {
    return undefined;
  }
  const props: Record<string, LiteralValue> = {};
  for (const p of o.properties) {
    const name = ts.isSpreadAssignment(p) ? undefined : memberName(p.name);
    if (name !== undefined) {
      props[name] = ts.isPropertyAssignment(p) ? literalValue(p.initializer) : { kind: 'other' };
    }
  }
  return { props };
}

function literalValue(e: ts.Expression): LiteralValue {
  const nested = objectLiteral(e);
  if (nested) {
    return { kind: 'object', literal: nested };
  }
  const created = createdType(e);
  return created ? { kind: 'new', type: created.typeRef } : { kind: 'other' };
}

/** The type a `new X<A>(…)` expression creates, with its text. */
function createdType(e: ts.Expression, sf?: ts.SourceFile): { type: string; typeRef: TypeRef } | undefined {
  const n = unwrap(e);
  const name = ts.isNewExpression(n) ? expressionName(n.expression) : undefined;
  if (!ts.isNewExpression(n) || name === undefined) {
    return undefined;
  }
  const args = n.typeArguments ?? [];
  return {
    type: args.length ? `${name}<${args.map((a) => oneLine(a.getText(sf))).join(', ')}>` : name,
    typeRef: { kind: 'name', name, args: args.map(typeRef) },
  };
}

/** A member's declared type, else the class of a `new X(…)` initializer: its text and structure. */
export function declaredType(
  type: ts.TypeNode | undefined,
  init: ts.Expression | undefined,
  sf: ts.SourceFile,
): { type?: string; typeRef?: TypeRef } {
  if (type) {
    return { type: oneLine(type.getText(sf)), typeRef: typeRef(type) };
  }
  return (init && createdType(init, sf)) || {};
}

/** The class, interface or object type alias a node declares, by name. */
export function typeFactOf(n: ts.Node, sf: ts.SourceFile): [string, TypeFact] | undefined {
  if (ts.isClassDeclaration(n) && n.name) {
    return [
      n.name.text,
      { kind: 'class', decorators: decoratorNames(n), ...heritage(n), members: classMembers(n, sf) },
    ];
  }
  if (ts.isInterfaceDeclaration(n)) {
    return [n.name.text, { kind: 'interface', decorators: [], ...heritage(n), members: signatures(n.members, sf) }];
  }
  if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
    return [
      n.name.text,
      { kind: 'object-alias', decorators: [], parents: [], members: signatures(n.type.members, sf) },
    ];
  }
  return undefined;
}

function classMembers(n: ts.ClassDeclaration, sf: ts.SourceFile): Record<string, ClassMember> {
  const members: Record<string, ClassMember> = {};
  const field = (decorators: string[], type: ts.TypeNode | undefined, init: ts.Expression | undefined) => ({
    decorators,
    setter: false,
    typeRef: declaredType(type, init, sf).typeRef,
  });
  for (const m of n.members) {
    if (ts.isPropertyDeclaration(m)) {
      const key = memberName(m.name);
      if (key !== undefined) {
        members[key] = { ...field(decoratorNames(m), m.type, m.initializer), literal: objectLiteral(m.initializer) };
      }
    } else if (ts.isMethodDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
      const key = memberName(m.name);
      if (key !== undefined) {
        members[key] = { decorators: decoratorNames(m), setter: ts.isSetAccessorDeclaration(m) };
      }
    } else if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name)) {
          members[p.name.text] = field(decoratorNames(p), p.type, p.initializer);
        }
      }
    }
  }
  // A literal initializer is the value only while no code in the class reassigns the field.
  for (const assigned of assignedThisMembers(n)) {
    const m = Object.hasOwn(members, assigned) ? members[assigned] : undefined;
    if (m?.literal !== undefined) {
      members[assigned] = { ...m, literal: undefined };
    }
  }
  return members;
}

function assignedThisMembers(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      isThis(n.left.expression)
    ) {
      out.add(n.left.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** What a class or interface extends: parents by name, and the element type when it extends Array<…>. */
function heritage(n: ts.ClassDeclaration | ts.InterfaceDeclaration): Pick<TypeFact, 'parents' | 'arrayOf'> {
  const parents: string[] = [];
  let arrayOf: TypeFact['arrayOf'];
  for (const clause of n.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const t of clause.types) {
      if (!ts.isIdentifier(t.expression)) {
        continue;
      }
      if (t.expression.text !== 'Array') {
        parents.push(t.expression.text);
      } else if (t.typeArguments?.length) {
        arrayOf = { element: typeRef(t.typeArguments[0]), params: (n.typeParameters ?? []).map((p) => p.name.text) };
      }
    }
  }
  return arrayOf ? { parents, arrayOf } : { parents };
}

function signatures(members: ts.NodeArray<ts.TypeElement>, sf: ts.SourceFile): Record<string, ClassMember> {
  const out: Record<string, ClassMember> = {};
  for (const m of members) {
    const key = memberName(m.name);
    if (key === undefined) {
      continue;
    }
    if (ts.isPropertySignature(m)) {
      out[key] = { decorators: [], setter: false, typeRef: declaredType(m.type, undefined, sf).typeRef };
    } else if (ts.isMethodSignature(m)) {
      out[key] = { decorators: [], setter: false };
    } else if (ts.isSetAccessorDeclaration(m)) {
      out[key] = { decorators: [], setter: true };
    }
  }
  return out;
}
