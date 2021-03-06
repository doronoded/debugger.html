// @flow

const babylon = require("babylon");
const traverse = require("babel-traverse").default;
const t = require("babel-types");
const { isDevelopment } = require("devtools-config");
const toPairs = require("lodash/toPairs");
const isEmpty = require("lodash/isEmpty");
const uniq = require("lodash/uniq");

import type { SourceText, Location, Frame, TokenResolution } from "../../types";

const ASTs = new Map();

const symbolDeclarations = new Map();

type ASTLocation = {
  start: {
    line: number,
    column: number
  },
  end: {
    line: number,
    column: number
  }
};

export type SymbolDeclaration = {
  name: string,
  location: ASTLocation
};

export type FormattedSymbolDeclaration = {
  id: string,
  title: string,
  subtitle: string,
  value: string,
  location: ASTLocation
};

export type SymbolDeclarations = {
  functions: Array<FormattedSymbolDeclaration>,
  variables: Array<FormattedSymbolDeclaration>
};

type Scope = {
  location: {
    line: number,
    column: number
  },
  parent: Scope,
  bindings: Object[]
};

function _parse(code) {
  return babylon.parse(code, {
    sourceType: "module",

    plugins: ["jsx", "flow"]
  });
}

function parse(text: string) {
  let ast;
  if (!text) {
    return;
  }

  try {
    ast = _parse(text);
  } catch (error) {
    if (isDevelopment()) {
      console.warn("parse failed", text);
    }

    ast = {};
  }

  return ast;
}

function getAst(sourceText: SourceText) {
  if (ASTs.has(sourceText.id)) {
    return ASTs.get(sourceText.id);
  }

  let ast = {};
  if (sourceText.contentType == "text/javascript") {
    ast = parse(sourceText.text);
  }

  ASTs.set(sourceText.id, ast);
  return ast;
}

function getNodeValue(node) {
  if (t.isThisExpression(node)) {
    return "this";
  }

  return node.name;
}

function getFunctionName(path) {
  if (path.node.id) {
    return path.node.id.name;
  }

  const parent = path.parent;
  if (parent.type == "ObjectProperty") {
    return parent.key.name;
  }

  if (parent.type == "ObjectExpression" || path.node.type == "ClassMethod") {
    return path.node.key.name;
  }

  if (parent.type == "VariableDeclarator") {
    return parent.id.name;
  }

  if (parent.type == "AssignmentExpression") {
    if (parent.left.type == "MemberExpression") {
      return parent.left.property.name;
    }

    return parent.left.name;
  }

  return "anonymous";
}

function isFunction(path) {
  return (
    t.isFunction(path) ||
    t.isArrowFunctionExpression(path) ||
    t.isObjectMethod(path) ||
    t.isClassMethod(path)
  );
}

function formatSymbol(symbol: SymbolDeclaration): FormattedSymbolDeclaration {
  return {
    id: `${symbol.name}:${symbol.location.start.line}`,
    title: symbol.name,
    subtitle: `:${symbol.location.start.line}`,
    value: symbol.name,
    location: symbol.location
  };
}

function getVariableNames(path) {
  if (t.isObjectProperty(path) && !isFunction(path.node.value)) {
    return [
      formatSymbol({
        name: path.node.key.name,
        location: path.node.loc
      })
    ];
  }

  if (!path.node.declarations) {
    return path.node.params.map(dec =>
      formatSymbol({
        name: dec.name,
        location: dec.loc
      })
    );
  }

  return path.node.declarations.map(dec =>
    formatSymbol({
      name: dec.id.name,
      location: dec.loc
    })
  );
}

function isVariable(path) {
  return (
    t.isVariableDeclaration(path) ||
    (isFunction(path) && path.node.params.length) ||
    (t.isObjectProperty(path) && !isFunction(path.node.value))
  );
}

function getMemberExpression(root) {
  function _getMemberExpression(node, expr) {
    if (t.isMemberExpression(node)) {
      expr = [node.property.name].concat(expr);
      return _getMemberExpression(node.object, expr);
    }

    if (t.isThisExpression(node)) {
      return ["this"].concat(expr);
    }
    return [node.name].concat(expr);
  }

  return _getMemberExpression(root, []);
}

function getScopeVariables(scope: Scope) {
  const { bindings } = scope;

  return toPairs(bindings).map(([name, binding]) => ({
    name,
    references: binding.referencePaths
  }));
}

function getScopeChain(scope: Scope): Scope[] {
  const scopes = [scope];

  do {
    scopes.push(scope);
  } while ((scope = scope.parent));

  return scopes;
}

/**
 * helps find member expressions on one line and function scopes that are
 * often many lines
 */
function nodeContainsLocation({ node, location }) {
  const { start, end } = node.loc;
  const { line, column } = location;

  if (start.line === end.line) {
    return (
      start.line === line && start.column <= column && end.column >= column
    );
  }

  // node is likely a function parameter
  if (start.line === line) {
    return start.column <= column;
  }

  // node is on the same line as the closing curly
  if (end.line === line) {
    return end.column >= column;
  }

  // node is either inside the block body or outside of it
  return start.line < line && end.line > line;
}

function isLexicalScope(path) {
  return isFunction(path) || t.isProgram(path);
}

export function getSymbols(source: SourceText): SymbolDeclarations {
  if (symbolDeclarations.has(source.id)) {
    const symbols = symbolDeclarations.get(source.id);
    if (symbols) {
      return symbols;
    }
  }

  const ast = getAst(source);

  const symbols = { functions: [], variables: [] };

  if (!ast || isEmpty(ast)) {
    return symbols;
  }

  traverse(ast, {
    enter(path) {
      if (isVariable(path)) {
        symbols.variables.push(...getVariableNames(path));
      }

      if (isFunction(path)) {
        symbols.functions.push(
          formatSymbol({
            name: getFunctionName(path),
            location: path.node.loc
          })
        );
      }

      if (t.isClassDeclaration(path)) {
        symbols.variables.push(
          formatSymbol({
            name: path.node.id.name,
            location: path.node.loc
          })
        );
      }
    }
  });

  symbolDeclarations.set(source.id, symbols);
  return symbols;
}

function getClosestMemberExpression(source, token, location) {
  const ast = getAst(source);
  if (isEmpty(ast)) {
    null;
  }

  let expression = null;
  traverse(ast, {
    enter(path) {
      const { node } = path;
      if (
        t.isMemberExpression(node) &&
        node.property.name === token &&
        nodeContainsLocation({ node, location })
      ) {
        const memberExpression = getMemberExpression(node);
        expression = {
          value: memberExpression.join("."),
          location: node.loc
        };
      }
    }
  });

  return expression;
}

export function getClosestExpression(
  source: SourceText,
  token: string,
  location: Location
) {
  const memberExpression = getClosestMemberExpression(source, token, location);
  if (memberExpression) {
    return memberExpression;
  }

  const path = getClosestPath(source, location);
  if (!path || !path.node) {
    return;
  }

  const { node } = path;
  return { value: getNodeValue(node), location: node.loc };
}

// Resolves a token (at location) in the source to determine if it is in scope
// of the given frame and the expression (if any) to which it belongs
export function resolveToken(
  source: SourceText,
  token: string,
  location: Location,
  frame: Frame
): ?TokenResolution {
  const expression = getClosestExpression(source, token, location);
  const scope = getClosestScope(source, location);

  if (!expression || !expression.value) {
    return { expression: null, inScope: false };
  }

  const inScope = isExpressionInScope(expression.value, scope);

  return {
    expression,
    inScope
  };
}

export function getClosestScope(source: SourceText, location: Location) {
  const ast = getAst(source);
  let closestPath = null;

  traverse(ast, {
    enter(path) {
      if (
        isLexicalScope(path) &&
        nodeContainsLocation({ node: path.node, location })
      ) {
        closestPath = path;
      }
    }
  });

  if (!closestPath) {
    return;
  }

  return closestPath.scope;
}

export function getClosestPath(source: SourceText, location: Location) {
  const ast = getAst(source);
  let closestPath = null;

  traverse(ast, {
    enter(path) {
      if (nodeContainsLocation({ node: path.node, location })) {
        closestPath = path;
      }
    }
  });

  return closestPath;
}

export function getVariablesInLocalScope(scope: Scope) {
  return getScopeVariables(scope);
}

export function getVariablesInScope(scope: Scope) {
  const scopes = getScopeChain(scope);
  const scopeVars = scopes.map(getScopeVariables);
  const vars = [{ name: "this" }, { name: "arguments" }]
    .concat(...scopeVars)
    .map(variable => variable.name);
  return uniq(vars);
}

export function isExpressionInScope(expression: string, scope?: Scope) {
  if (!scope) {
    return false;
  }

  const variables = getVariablesInScope(scope);
  const firstPart = expression.split(/\./)[0];
  return variables.includes(firstPart);
}
