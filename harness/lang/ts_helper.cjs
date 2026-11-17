// TypeScript helper for the harness: parses code with the TypeScript compiler API.
//
// Started once per harness process by harness/lang/typescript.py. It reads one JSON
// request per line on stdin and writes one JSON response per line on stdout:
//   {"id": 1, "op": "analyze", "code": "...", "path": "src/a.ts"}
//   {"id": 1, "ok": true, "result": {...}}
// It never writes files and never runs the code it parses.
'use strict';

const path = require('path');
const readline = require('readline');
const { builtinModules } = require('module');

function loadTypeScript() {
  const explicit = process.env.HARNESS_TYPESCRIPT;
  if (explicit) {  // an explicit choice that does not work is an error, not a reason to use another copy
    try {
      return require(explicit);
    } catch (error) {
      throw new Error(`HARNESS_TYPESCRIPT is set to ${explicit}, but no \`typescript\` package loads from there.`);
    }
  }
  const tried = [];
  const searchPaths = (process.env.HARNESS_TS_SEARCH || '').split(path.delimiter).filter(Boolean);
  for (const base of searchPaths) {
    try {
      return require(require.resolve('typescript', { paths: [base] }));
    } catch (error) {
      tried.push(base);
    }
  }
  try {
    const globalRoot = require('child_process')
      .execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 })
      .trim();
    return require(require.resolve('typescript', { paths: [globalRoot] }));
  } catch (error) {
    tried.push('the global npm folder');
  }
  throw new Error(
    'The TypeScript adapter needs the `typescript` package and could not find it (looked in: ' +
      tried.join(', ') + '). Run `npm install` in the project folder, or set HARNESS_TYPESCRIPT ' +
      'to the path of an installed `typescript` package.',
  );
}

let ts = null;
let loadError = null;
try {
  ts = loadTypeScript();
} catch (error) {
  loadError = error.message;  // reported in every response, so the harness can show it
}

function scriptKind(file) {
  const lower = (file || '').toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(code, file) {
  const name = file || 'snippet.ts';
  return ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, scriptKind(name));
}

function diagnostics(sf) {
  return (sf.parseDiagnostics || []).map((d) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start || 0);
    const lineText = sf.text.split('\n')[line] || '';
    return {
      line: line + 1,
      column: character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      text: lineText.trim(),
    };
  });
}

const textOf = (sf, node) => (node ? node.getText(sf) : null);
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function modifierNames(node) {
  const mods = (ts.canHaveModifiers(node) && ts.getModifiers(node)) || [];
  return mods.map((m) => ts.tokenToString(m.kind));
}

function decorators(sf, node) {
  const list = (ts.canHaveDecorators(node) && ts.getDecorators(node)) || [];
  return list.map((d) => textOf(sf, d.expression));
}

function params(sf, list) {
  return (list || []).map((p) => ({
    name: textOf(sf, p.name),
    identifier: ts.isIdentifier(p.name),
    optional: !!p.questionToken || !!p.initializer,
    question: !!p.questionToken,
    rest: !!p.dotDotDotToken,
    type: textOf(sf, p.type),
    init: textOf(sf, p.initializer),
    decorators: decorators(sf, p),
    modifiers: modifierNames(p).filter((m) => m !== null),
  }));
}

function functionInfo(sf, node) {
  const mods = modifierNames(node);
  return {
    async: mods.includes('async'),
    generator: !!node.asteriskToken,
    hasBody: !!node.body,
    typeParams: node.typeParameters ? node.typeParameters.map((t) => textOf(sf, t)).join(', ') : null,
    params: params(sf, node.parameters),
    returnType: textOf(sf, node.type),
  };
}

function memberName(sf, member) {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (!member.name) return '';
  return textOf(sf, member.name);
}

function memberInfo(sf, member) {
  const mods = modifierNames(member);
  let kind = 'other';
  if (ts.isMethodDeclaration(member)) kind = 'method';
  else if (ts.isPropertyDeclaration(member)) kind = 'property';
  else if (ts.isConstructorDeclaration(member)) kind = 'constructor';
  else if (ts.isGetAccessorDeclaration(member)) kind = 'get';
  else if (ts.isSetAccessorDeclaration(member)) kind = 'set';
  else if (ts.isIndexSignatureDeclaration(member)) kind = 'index';
  else if (ts.isClassStaticBlockDeclaration(member)) kind = 'static-block';
  const info = {
    kind,
    name: memberName(sf, member),
    privateName: !!(member.name && ts.isPrivateIdentifier(member.name)),
    static: mods.includes('static'),
    abstract: mods.includes('abstract'),
    accessibility: mods.find((m) => m === 'private' || m === 'protected' || m === 'public') || null,
    readonly: mods.includes('readonly'),
    optional: !!member.questionToken,
    decorators: decorators(sf, member),
    line: lineOf(sf, member.getStart(sf)),
  };
  if (kind === 'method' || kind === 'constructor' || kind === 'get' || kind === 'set') {
    Object.assign(info, functionInfo(sf, member));
  }
  if (kind === 'property') {
    info.type = textOf(sf, member.type);
    info.hasInit = !!member.initializer;
  }
  return info;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  const out = [];
  for (const element of name.elements || []) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...bindingNames(element.name));
  }
  return out;
}

function unwrap(expr) {
  let node = expr;
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) {
    node = node.expression;
  }
  return node;
}

function statementInfo(sf, s) {
  const mods = modifierNames(s);
  const base = {
    kind: 'other',
    names: [],
    exported: mods.includes('export'),
    default: mods.includes('default'),
    declare: mods.includes('declare'),
    start: lineOf(sf, s.getStart(sf)),
    end: lineOf(sf, s.end),
    pos: s.getStart(sf),
    endPos: s.end,
    text: s.getText(sf),
  };
  if (ts.isFunctionDeclaration(s)) {
    return Object.assign(base, { kind: 'function', names: s.name ? [s.name.text] : [] }, functionInfo(sf, s));
  }
  if (ts.isClassDeclaration(s)) {
    const heritage = { extends: null, implements: [] };
    for (const clause of s.heritageClauses || []) {
      const types = clause.types.map((t) => textOf(sf, t));
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) heritage.extends = types[0] || null;
      else heritage.implements.push(...types);
    }
    return Object.assign(base, {
      kind: 'class',
      names: s.name ? [s.name.text] : [],
      abstract: mods.includes('abstract'),
      decorators: decorators(sf, s),
      extends: heritage.extends,
      implements: heritage.implements,
      typeParams: s.typeParameters ? s.typeParameters.map((t) => textOf(sf, t)).join(', ') : null,
      members: s.members.map((m) => memberInfo(sf, m)),
    });
  }
  if (ts.isVariableStatement(s)) {
    const list = s.declarationList;
    const flags = list.flags;
    const declKind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
    const first = list.declarations[0];
    const init = first && first.initializer ? unwrap(first.initializer) : null;
    const info = {
      kind: 'variable',
      declKind,
      names: list.declarations.flatMap((d) => bindingNames(d.name)),
      type: first ? textOf(sf, first.type) : null,
      hasInit: !!(first && first.initializer),
      init: init ? ts.SyntaxKind[init.kind] : null,
    };
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      info.fn = functionInfo(sf, init);
      info.fn.hasBody = true;
    }
    return Object.assign(base, info);
  }
  if (ts.isInterfaceDeclaration(s)) return Object.assign(base, { kind: 'interface', names: [s.name.text] });
  if (ts.isTypeAliasDeclaration(s)) return Object.assign(base, { kind: 'type', names: [s.name.text] });
  if (ts.isEnumDeclaration(s)) return Object.assign(base, { kind: 'enum', names: [s.name.text] });
  if (ts.isModuleDeclaration(s)) return Object.assign(base, { kind: 'module', names: [textOf(sf, s.name)] });
  if (ts.isImportDeclaration(s)) {
    const clause = s.importClause;
    const info = {
      kind: 'import',
      module: s.moduleSpecifier.text,
      typeOnly: !!(clause && clause.isTypeOnly),
      defaultName: clause && clause.name ? clause.name.text : null,
      namespaceName: null,
      named: [],
      sideEffect: !clause,
    };
    const bindings = clause && clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) info.namespaceName = bindings.name.text;
    if (bindings && ts.isNamedImports(bindings)) {
      info.named = bindings.elements.map((e) => ({
        local: e.name.text,
        imported: e.propertyName ? e.propertyName.text : e.name.text,
        typeOnly: !!e.isTypeOnly,
      }));
    }
    info.names = [info.defaultName, info.namespaceName, ...info.named.map((n) => n.local)].filter(Boolean);
    return Object.assign(base, info);
  }
  if (ts.isImportEqualsDeclaration(s)) {
    return Object.assign(base, { kind: 'import-equals', names: [s.name.text] });
  }
  if (ts.isExportDeclaration(s)) {
    const named = s.exportClause && ts.isNamedExports(s.exportClause)
      ? s.exportClause.elements.map((e) => ({
        local: e.propertyName ? e.propertyName.text : e.name.text,
        exported: e.name.text,
        typeOnly: !!e.isTypeOnly,
      }))
      : [];
    return Object.assign(base, {
      kind: 'export',
      module: s.moduleSpecifier ? s.moduleSpecifier.text : null,
      typeOnly: !!s.isTypeOnly,
      star: !s.exportClause,
      namespaceExport: s.exportClause && ts.isNamespaceExport(s.exportClause) ? s.exportClause.name.text : null,
      named,
    });
  }
  if (ts.isExportAssignment(s)) {
    const expr = unwrap(s.expression);
    return Object.assign(base, {
      kind: 'export-assignment',
      exportEquals: !!s.isExportEquals,
      expression: textOf(sf, s.expression),
      identifier: expr && ts.isIdentifier(expr) ? expr.text : null,
    });
  }
  if (ts.isExpressionStatement(s)) {
    const expr = s.expression;
    if (ts.isStringLiteral(expr) && /^['"]use (client|server|strict)['"];?$/.test(base.text.trim())) {
      return Object.assign(base, { kind: 'directive', value: expr.text });
    }
    let callee = null;
    let node = unwrap(expr);
    if (node && ts.isVoidExpression(node)) node = unwrap(node.expression);
    if (node && ts.isAwaitExpression(node)) node = unwrap(node.expression);
    if (node && ts.isCallExpression(node)) callee = textOf(sf, node.expression);
    return Object.assign(base, { kind: 'expression', callee });
  }
  return base;
}

// Every module specifier the code loads: import/export declarations, require() and import().
function moduleSpecifiers(sf) {
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, line: lineOf(sf, node.getStart(sf)) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, line: lineOf(sf, node.getStart(sf)) });
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isImport) {
        found.push({ specifier: node.arguments[0].text, line: lineOf(sf, node.getStart(sf)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function analyze({ code, path: file }) {
  const sf = parse(code, file);
  return {
    diagnostics: diagnostics(sf),
    statements: sf.statements.map((s) => statementInfo(sf, s)),
    modules: moduleSpecifiers(sf),
  };
}

// Give every body-less function, method, constructor and accessor a body that throws `message`.
// A `const` declared without a value gets a value that throws as soon as it is used.
function stub({ code, path: file, message }) {
  const sf = parse(code, file);
  const thrower = `throw new Error(${JSON.stringify(message)});`;
  const edits = [];
  const addBody = (node) => {
    if (node.body) return;
    let end = node.end;
    const text = node.getText(sf);
    if (text.endsWith(';')) end -= 1;
    edits.push({ start: end, end: node.end, text: ` { ${thrower} }` });
  };
  // Iterating a stub (`[...STUB]`) must fail with the marker too, or the harness cannot tell a stub was reached.
  const value = '(new Proxy(function () {}, { get(_target, key) { ' +
    `if (key === Symbol.iterator || key === Symbol.asyncIterator) ${thrower} ` +
    'if (typeof key === "symbol" || ' +
    '["then", "$$typeof", "__esModule", "toJSON", "asymmetricMatch", "nodeType"].includes(key)) ' +
    `return undefined; ${thrower} }, apply() { ${thrower} }, construct() { ${thrower} } }) as never)`;
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s)) addBody(s);
    else if (ts.isClassDeclaration(s)) {
      for (const m of s.members) {
        const abstract = modifierNames(m).includes('abstract');
        if (!abstract && (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m))) addBody(m);
      }
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!d.initializer) edits.push({ start: d.end, end: d.end, text: ` = ${value}` });
      }
    }
  }
  let out = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { text: out };
}

// Names used in type positions (annotations, heritage clauses), not in decorators or values.
function typeNames({ code, path: file }) {
  const sf = parse(code, file);
  const names = new Set();
  const visit = (node, inType) => {
    // Decorators and `typeof x` name values; constructor parameters are what a class needs injected.
    if (ts.isDecorator(node) || ts.isConstructorDeclaration(node) || ts.isTypeQueryNode(node)) return;
    const typeHere = inType || ts.isTypeNode(node) || ts.isHeritageClause(node);
    if (typeHere && ts.isIdentifier(node)) {
      const parent = node.parent;
      const isMemberName = parent && (ts.isPropertySignature(parent) || ts.isMethodSignature(parent) ||
        ts.isParameter(parent) || ts.isTypeParameterDeclaration(parent)) && parent.name === node;
      const isQualifiedRight = parent && ts.isQualifiedName(parent) && parent.right === node;
      if (!isMemberName && !isQualifiedRight) names.add(node.text);
    }
    ts.forEachChild(node, (child) => visit(child, typeHere));
  };
  visit(sf, false);
  return { names: [...names] };
}

const OPS = {
  hello: () => ({ typescript: ts.version, builtins: builtinModules }),
  analyze,
  stub,
  typeNames,
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'Bad request: ' + error.message }) + '\n');
    return;
  }
  let response;
  try {
    if (loadError) throw new Error(loadError);
    const op = OPS[request.op];
    if (!op) throw new Error(`Unknown op ${request.op}`);
    response = { id: request.id, ok: true, result: op(request) };
  } catch (error) {
    const detail = loadError || String(error && error.stack ? error.stack : error);
    response = { id: request.id, ok: false, error: detail, setup: !!loadError };
  }
  process.stdout.write(JSON.stringify(response) + '\n');
});
