// Planner tool: reads the original repository and proposes the unit cut.
//
//   node extract.cjs <original-repo> <out.json>
//
// Needs the `typescript` package (HARNESS_TYPESCRIPT, or resolvable from here).
// It only parses the original source; it never runs it. The output is consumed by
// build_bundle.py, which writes spec/, tests/ and the planning report.
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require(process.env.HARNESS_TYPESCRIPT || 'typescript');

const ROOT = path.resolve(process.argv[2]);
const OUT = process.argv[3];

// ---------------------------------------------------------------- configuration

// Where units come from. Everything else (and every test) is scaffold or tests/.
const SOURCE_ROOTS = ['apps/api/src', 'apps/storefront/src', 'packages/api-contract/src',
  'packages/config-schema/src', 'database/src', 'database/seeds'];
const ID_PREFIX = [
  ['apps/api/src/modules/', 'api.'], ['apps/api/src/', 'api.'],
  ['apps/storefront/src/', 'sf.'],
  ['packages/api-contract/src/', 'contract.'], ['packages/config-schema/src/', 'config.'],
  ['database/src/', 'db.'], ['database/seeds/', 'db.seeds.'],
];
const ALIASES = [['@/', 'apps/storefront/src/']];
const PACKAGES = {
  '@amazon-mvp/api-contract': 'packages/api-contract/src/index.ts',
  '@amazon-mvp/config-schema': 'packages/config-schema/src/index.ts',
  '@amazon-mvp/database': 'database/src/index.ts',
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage']);
const isTestFile = (rel) => /\.(spec|e2e-spec|test)\.tsx?$/.test(rel) || /^apps\/[^/]+\/test\//.test(rel);
const isSourceFile = (rel) => SOURCE_ROOTS.some((r) => rel.startsWith(r + '/')) && /\.tsx?$/.test(rel) &&
  !rel.endsWith('.d.ts') && !isTestFile(rel);
const isIntegrate = (rel, decl) =>
  rel.startsWith('apps/storefront/src/app/') || /(^|\/)(main|bootstrap|openapi)\.ts$/.test(rel) ||
  /\.controller\.ts$/.test(rel) || rel.startsWith('database/seeds/') || /-server\.ts$/.test(rel) ||
  (decl && decl.decorators && decl.decorators.some((d) => /^Controller\b/.test(d)));

// ---------------------------------------------------------------- files

const allFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else allFiles.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
})(ROOT);
allFiles.sort();
const sourceRels = allFiles.filter(isSourceFile);
const testRels = allFiles.filter((r) => isTestFile(r) && /\.tsx?$/.test(r));
// The project's own modules resolve (so inferred types name real project types); third-party
// packages are not installed, so their types are `any`, and such inferences are not used.
const program = ts.createProgram(
  [...sourceRels, ...testRels].map((r) => path.join(ROOT, r)),
  {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, allowJs: false, resolveJsonModule: true, esModuleInterop: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [], skipLibCheck: true, noEmit: true, experimentalDecorators: true,
    baseUrl: ROOT,
    paths: {
      '@/*': ['apps/storefront/src/*'],
      '@amazon-mvp/api-contract': ['packages/api-contract/src/index.ts'],
      '@amazon-mvp/config-schema': ['packages/config-schema/src/index.ts'],
      '@amazon-mvp/database': ['database/src/index.ts'],
    },
  },
);
const checker = program.getTypeChecker();
const sfOf = (rel) => program.getSourceFile(path.join(ROOT, rel));

const problems = [];
const problem = (text) => problems.push(text);

// ---------------------------------------------------------------- module resolution

function resolveFile(fromRel, spec) {
  let base = null;
  if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const [prefix, target] of ALIASES) if (spec.startsWith(prefix)) base = target + spec.slice(prefix.length);
  if (PACKAGES[spec]) return PACKAGES[spec];
  if (base === null) return null;
  for (const candidate of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
    if (allFiles.includes(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------- helpers

const mods = (node) => ((ts.canHaveModifiers(node) && ts.getModifiers(node)) || []).map((m) => m.kind);
const hasMod = (node, kind) => mods(node).includes(kind);
const decoratorsOf = (sf, node) =>
  ((ts.canHaveDecorators(node) && ts.getDecorators(node)) || []).map((d) => d.expression.getText(sf));
const unwrap = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
};
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function jsdoc(sf, node) {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) || [];
  const docs = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith('/**'));
  if (!docs.length) return '';
  return docs[docs.length - 1]
    .replace(/^\/\*\*|\*\/$/g, '')
    .split('\n').map((l) => l.replace(/^\s*\* ?/, '').trimEnd()).join('\n').trim();
}

function containsFunctionLike(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isClassExpression(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function inTypePosition(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isExpressionWithTypeArguments(p) && p.parent && ts.isHeritageClause(p.parent) &&
      p.parent.token === ts.SyntaxKind.ImplementsKeyword) return true;
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isExpression(p) && !ts.isTypeNode(p) || ts.isStatement(p) || ts.isSourceFile(p)) return false;
    n = p;
  }
  return false;
}

// ---------------------------------------------------------------- per-file analysis

const files = {};  // rel -> info

function topLevelOwner(decl) {
  // The top-level statement a declaration belongs to, if the declaration *is* that statement's binding.
  if (!decl) return null;
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
    let n = decl;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    return n && n.parent && ts.isSourceFile(n.parent) ? { import: true, node: n } : null;
  }
  let statement = null;
  if (ts.isVariableDeclaration(decl) && decl.parent && decl.parent.parent && ts.isVariableStatement(decl.parent.parent)) {
    statement = decl.parent.parent;
  } else if (ts.isBindingElement(decl)) {
    let n = decl;
    while (n && !ts.isVariableStatement(n)) n = n.parent;
    statement = n;
  } else if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) ||
    ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl)) {
    statement = decl;
  }
  return statement && statement.parent && ts.isSourceFile(statement.parent) ? { import: false, node: statement } : null;
}

// Identifiers inside `node` that refer to top-level bindings of its file: name -> {value, type}
function references(sf, node, selfNames) {
  const refs = new Map();
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      let symbol = null;
      if (n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n) {
        symbol = checker.getShorthandAssignmentValueSymbol(n.parent);
      } else {
        symbol = checker.getSymbolAtLocation(n);
      }
      const decl = symbol && symbol.declarations && symbol.declarations[0];
      if (decl && decl.getSourceFile() === sf) {
        const owner = topLevelOwner(decl);
        if (owner) {
          const name = n.text;
          if (!selfNames.has(name) || owner.import) {
            const entry = refs.get(name) || { value: false, type: false };
            if (inTypePosition(n)) entry.type = true; else entry.value = true;
            refs.set(name, entry);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return refs;
}

function classify(sf, s) {
  if (ts.isFunctionDeclaration(s)) return 'function';
  if (ts.isClassDeclaration(s)) return 'class';
  if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) return 'type';
  if (ts.isVariableStatement(s)) {
    const decls = s.declarationList.declarations;
    const init = decls[0].initializer ? unwrap(decls[0].initializer) : null;
    if (decls.length === 1 && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return 'arrow';
    if (!init) return 'data';
    if (!containsFunctionLike(init)) return 'data';  // literals, tokens, formatters, font loaders
    if (isSchemaChain(sf, init)) return 'data';  // z.object(...).refine(...): a declarative schema
    return 'value';  // objects with methods, wrapped functions, computed values
  }
  return null;
}

// The return type the compiler infers for a function the original left unannotated, when it can be
// written down: no `any` (a type from an uninstalled package), no import() types, short.
const RET_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;
let inferredReturns = 0;
function inferredReturn(fn) {
  if (!fn || fn.type || ts.isConstructorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) return null;
  try {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (!signature) return null;
    const text = checker.typeToString(checker.getReturnTypeOfSignature(signature), fn, RET_FLAGS);
    if (!text || /\bany\b|import\(|\.\.\.|\[x: string\]/.test(text) || text.length > 160) return null;
    inferredReturns++;
    return text;
  } catch (error) {
    return null;
  }
}
const withReturn = (head, fn) => {
  const ret = inferredReturn(fn);
  return ret ? `${head}: ${ret}` : head;
};

// A call chain rooted at the zod namespace (`z.object({...}).superRefine(...)`).
function isSchemaChain(sf, expr) {
  let e = expr;
  while (e && (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e))) e = e.expression;
  if (!e || !ts.isIdentifier(e)) return false;
  const imp = sf.statements.find((st) => ts.isImportDeclaration(st) && st.moduleSpecifier.text === 'zod');
  return !!imp && imp.importClause && imp.importClause.namedBindings && ts.isNamedImports(imp.importClause.namedBindings) &&
    imp.importClause.namedBindings.elements.some((el) => el.name.text === e.text);
}

// Wrappers that return the function they are given (React's `cache`, and locals typed `typeof cache`).
function preservesFunction(sf, callee) {
  if (!ts.isIdentifier(callee)) return false;
  if (callee.text === 'cache') return true;
  const local = sf.statements.find((st) => ts.isVariableStatement(st) &&
    st.declarationList.declarations.some((v) => v.name.getText(sf) === callee.text && v.type && /typeof cache\b/.test(v.type.getText(sf))));
  return !!local;
}

function functionSignature(sf, s) {
  return withReturn(sf.text.slice(s.getStart(sf), s.body.getStart(sf)).trim(), s);
}

function arrowSignature(sf, s, exported) {
  const d = s.declarationList.declarations[0];
  const fn = unwrap(d.initializer);
  const async = hasMod(fn, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const tps = fn.typeParameters ? `<${fn.typeParameters.map((t) => t.getText(sf)).join(', ')}>` : '';
  const params = fn.parameters.map((p) => p.getText(sf)).join(', ');
  const inferred = inferredReturn(fn);
  const ret = fn.type ? `: ${fn.type.getText(sf)}` : inferred ? `: ${inferred}` : '';
  if (d.type) problem(`${sf.fileName}: ${d.name.getText(sf)} has a type annotation on the const; the function signature drops it.`);
  return `${exported ? 'export ' : ''}${async}function ${d.name.getText(sf)}${tps}(${params})${ret}`;
}

function classSignature(sf, s, exported) {
  const lines = [];
  for (const d of decoratorsOf(sf, s)) lines.push(`@${d}`);
  const modifiers = [];
  if (exported) modifiers.push('export');
  if (hasMod(s, ts.SyntaxKind.DefaultKeyword)) modifiers.push('default');
  if (hasMod(s, ts.SyntaxKind.AbstractKeyword)) modifiers.push('abstract');
  const tps = s.typeParameters ? `<${s.typeParameters.map((t) => t.getText(sf)).join(', ')}>` : '';
  const heritage = (s.heritageClauses || []).map((h) => h.getText(sf)).join(' ');
  lines.push(`${modifiers.concat(['class']).join(' ')} ${s.name.text}${tps}${heritage ? ' ' + heritage : ''} {`);
  for (const m of s.members) {
    const isPrivate = hasMod(m, ts.SyntaxKind.PrivateKeyword) || (m.name && ts.isPrivateIdentifier(m.name));
    if (isPrivate || ts.isSemicolonClassElement(m) || ts.isClassStaticBlockDeclaration(m)) continue;
    let text;
    if (ts.isPropertyDeclaration(m)) {
      const start = m.getStart(sf);
      const end = m.initializer ? m.initializer.getFullStart() : m.end;
      text = sf.text.slice(start, end).trim().replace(/=\s*$/, '').replace(/;$/, '').trim() + ';';
    } else if (m.body) {
      text = withReturn(sf.text.slice(m.getStart(sf), m.body.getStart(sf)).trim(), m) + ';';
    } else {
      text = m.getText(sf).trim();
      if (!text.endsWith(';')) text += ';';
    }
    lines.push(...text.split('\n').map((l) => '  ' + l.trim()));
  }
  lines.push('}');
  return lines.join('\n');
}

function objectTypeSignature(sf, obj) {
  // `{ async get(): Promise<X> {...}, list: () => ... }` -> `{ get(): Promise<X>; list(): ...; }`
  const members = [];
  for (const p of obj.properties) {
    if (ts.isMethodDeclaration(p)) {
      const tps = p.typeParameters ? `<${p.typeParameters.map((t) => t.getText(sf)).join(', ')}>` : '';
      const ret = p.type ? p.type.getText(sf) : inferredReturn(p);
      members.push(`${p.name.getText(sf)}${tps}(${p.parameters.map((x) => x.getText(sf)).join(', ')})` +
        `${ret ? ': ' + ret : ''};`);
    } else if (ts.isPropertyAssignment(p) && p.initializer && (ts.isArrowFunction(unwrap(p.initializer)) ||
      ts.isFunctionExpression(unwrap(p.initializer)))) {
      const fn = unwrap(p.initializer);
      const ret = fn.type ? fn.type.getText(sf) : inferredReturn(fn);
      members.push(`${p.name.getText(sf)}(${fn.parameters.map((x) => x.getText(sf)).join(', ')})` +
        `${ret ? ': ' + ret : ''};`);
    } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const type = checker.typeToString(checker.getTypeAtLocation(p.name));
      members.push(`${p.name.getText(sf)}: ${type};`);
    } else {
      return null;
    }
  }
  return `{\n${members.map((m) => '  ' + m).join('\n')}\n}`;
}

function valueSignature(sf, s, exported) {
  const d = s.declarationList.declarations[0];
  const keyword = s.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const head = `${exported ? 'export ' : ''}${keyword} ${d.name.getText(sf)}`;
  if (d.type) return `${head}: ${d.type.getText(sf)}`;
  const init = d.initializer ? unwrap(d.initializer) : null;
  if (init && ts.isObjectLiteralExpression(init)) {
    const object = objectTypeSignature(sf, init);
    if (object) return `${head}: ${object}`;
  }
  if (init && ts.isCallExpression(init)) {
    const inner = init.arguments.map(unwrap).find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    const inferred = checker.typeToString(checker.getTypeAtLocation(d.name), d.name, RET_FLAGS);
    if (!preservesFunction(sf, init.expression)) {
      // Not a pass-through wrapper: the value is whatever the call returns.
      if (inferred && !/\bany\b|import\(/.test(inferred) && inferred.length <= 300) return `${head}: ${inferred}`;
      const callee = init.expression.getText(sf);
      if (/^[A-Za-z_$][\w$.]*$/.test(callee)) return `${head}: ReturnType<typeof ${callee}>`;
      return `${head}: unknown`;
    }
    if (inner) {
      const async = hasMod(inner, ts.SyntaxKind.AsyncKeyword);
      const params = inner.parameters.map((p) => p.getText(sf)).join(', ');
      const ret = inner.type ? inner.type.getText(sf) : inferredReturn(inner) || (async ? 'Promise<unknown>' : 'unknown');
      return `${head}: (${params}) => ${ret}`;
    }
  }
  return `${head}: ${checker.typeToString(checker.getTypeAtLocation(d.name))}`;
}

function dataSignature(sf, s, exported, text) {
  const d = s.declarationList.declarations[0];
  const keyword = s.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const head = `${exported ? 'export ' : ''}${keyword} ${d.name.getText(sf)}`;
  if (d.type) return `${head}: ${d.type.getText(sf)}`;
  if (text.length <= 400) return text.replace(/^export\s+/, exported ? 'export ' : '');
  const typeOf = (node) => checker.typeToString(checker.getTypeAtLocation(node), undefined,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType);
  const type = typeOf(d.name);
  const usable = (t) => t && !/\bany\b|import\(/.test(t);
  if (usable(type) && type.length <= 600) return `${head}: ${type}`;
  if (text.length <= 2500) return text.replace(/^export\s+/, exported ? 'export ' : '');  // a schema or table: show it
  // A very large literal: describe its shape.
  const init = d.initializer ? unwrap(d.initializer) : null;
  if (init && ts.isObjectLiteralExpression(init)) {
    const props = init.properties.filter((x) => ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x));
    const values = props.map((x) => typeOf(x.name));
    const keys = props.map((x) => `'${x.name.getText(sf).replace(/^['"]|['"]$/g, '')}'`);
    if (values.length && values.every((v) => v === values[0]) && usable(values[0]) && values[0].length <= 120) {
      const shape = `Record<${keys.join(' | ')}, ${values[0]}>`;
      if (shape.length <= 1500) return `${head}: ${shape}`;
    }
    const fields = props.map((x, i) => `${keys[i].slice(1, -1)}: ${usable(values[i]) && values[i].length <= 80 ? values[i] : 'unknown'};`);
    const shape = `{ ${fields.join(' ')} }`;
    if (shape.length <= 1500) return `${head}: ${shape}`;
  }
  if (init && ts.isArrayLiteralExpression(init) && init.elements.length) {
    const element = typeOf(init.elements[0]);
    if (usable(element) && element.length <= 600) return `${head}: Array<${element}>`;
  }
  return `${head}: unknown /* large literal; see the description */`;
}

// Names a declaration's *signature* uses as types: parameter and return types, heritage clauses,
// public member types, and whole type declarations. A unit that uses this declaration needs them too.
function signatureTypeRefs(sf, d) {
  const nodes = [];
  const s = d.node;
  const fnLike = (fn) => {
    for (const p of fn.parameters) if (p.type) nodes.push(p.type);
    if (fn.type) nodes.push(fn.type);
    for (const t of fn.typeParameters || []) nodes.push(t);
  };
  if (d.kind === 'function') fnLike(s);
  else if (d.kind === 'arrow') fnLike(unwrap(s.declarationList.declarations[0].initializer));
  else if (d.kind === 'class') {
    for (const h of s.heritageClauses || []) nodes.push(h);
    for (const m of s.members) {
      if (hasMod(m, ts.SyntaxKind.PrivateKeyword) || (m.name && ts.isPrivateIdentifier(m.name))) continue;
      if (ts.isPropertyDeclaration(m) && m.type) nodes.push(m.type);
      // Constructor parameters are what the class needs injected; a caller never needs those types.
      if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) fnLike(m);
    }
  } else if (d.kind === 'type') nodes.push(s);
  else if (ts.isVariableStatement(s)) {
    const v = s.declarationList.declarations[0];
    const init = v.initializer ? unwrap(v.initializer) : null;
    if (v.type) nodes.push(v.type);
    else if (init && ts.isObjectLiteralExpression(init)) {  // the synthesized object type of the signature
      for (const prop of init.properties) {
        if (ts.isMethodDeclaration(prop)) fnLike(prop);
        else if (ts.isPropertyAssignment(prop) && (ts.isArrowFunction(unwrap(prop.initializer)) ||
          ts.isFunctionExpression(unwrap(prop.initializer)))) fnLike(unwrap(prop.initializer));
      }
    } else if (init && ts.isCallExpression(init)) {
      const inner = init.arguments.map(unwrap).find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (inner) fnLike(inner); else nodes.push(init);
    } else if (init && d.kind === 'data') nodes.push(init);
  }
  const refs = new Set();
  for (const n of nodes) for (const name of references(sf, n, new Set([d.name])).keys()) refs.add(name);
  return refs;
}

for (const rel of sourceRels) {
  const sf = sfOf(rel);
  const info = {
    rel, imports: {}, sideEffects: [], reexports: [], directives: [], localExports: new Map(),
    decls: [], script: false, defaultExport: null,
  };
  files[rel] = info;
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const module = s.moduleSpecifier.text;
      const clause = s.importClause;
      info.importOrder = info.importOrder || [];
      info.importOrder.push(clause ? { module } : { module, sideEffect: s.getText(sf) });
      if (!clause) { info.sideEffects.push(s.getText(sf)); continue; }
      const typeOnly = !!clause.isTypeOnly;
      if (clause.name) info.imports[clause.name.text] = { module, imported: 'default', typeOnly };
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) info.imports[nb.name.text] = { module, imported: '*', typeOnly };
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) {
          info.imports[e.name.text] = {
            module, imported: e.propertyName ? e.propertyName.text : e.name.text, typeOnly: typeOnly || e.isTypeOnly,
          };
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(s)) {
      if (s.moduleSpecifier) {
        info.reexports.push({
          text: s.getText(sf), module: s.moduleSpecifier.text, star: !s.exportClause,
          names: s.exportClause && ts.isNamedExports(s.exportClause)
            ? s.exportClause.elements.map((e) => ({ local: (e.propertyName || e.name).text, exported: e.name.text }))
            : [],
        });
      } else if (s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const e of s.exportClause.elements) info.localExports.set((e.propertyName || e.name).text, e.name.text);
        info.localExportText = (info.localExportText || []).concat([s.getText(sf)]);
      }
      continue;
    }
    if (ts.isExportAssignment(s)) {
      const e = unwrap(s.expression);
      if (e && ts.isIdentifier(e)) info.defaultExport = e.text; else info.script = true;
      continue;
    }
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && /^use (client|server)$/.test(s.expression.text)) {
      info.directives.push(`'${s.expression.text}';`);
      continue;
    }
    const kind = classify(sf, s);
    if (!kind) { info.script = true; continue; }
    const names = ts.isVariableStatement(s)
      ? s.declarationList.declarations.map((d) => d.name.getText(sf))
      : [s.name ? s.name.text : null];
    if (names.length !== 1 || !names[0] || !/^[A-Za-z_$][\w$]*$/.test(names[0])) {
      info.script = true;
      problem(`${rel}: a statement declares ${names.join(', ') || 'no name'}; the file becomes a file unit.`);
      continue;
    }
    info.decls.push({
      name: names[0], kind, node: s, text: s.getText(sf), start: lineOf(sf, s.getStart(sf)), end: lineOf(sf, s.end),
      exported: hasMod(s, ts.SyntaxKind.ExportKeyword), isDefault: hasMod(s, ts.SyntaxKind.DefaultKeyword),
      decorators: ts.isClassDeclaration(s) ? decoratorsOf(sf, s) : [], doc: jsdoc(sf, s),
    });
  }
  const names = new Set(info.decls.map((d) => d.name));
  for (const d of info.decls) {
    d.refs = references(sf, d.node, new Set([d.name]));
    d.sigRefs = signatureTypeRefs(sf, d);
    if (info.localExports.has(d.name)) { d.exported = true; d.viaExportList = true; }
    if (info.defaultExport === d.name) { d.exported = true; d.isDefault = true; d.viaExportList = true; }
  }
  if (info.decls.length === 0) info.scaffold = true;  // re-exports only (index files)
  info.names = names;
}

// ---------------------------------------------------------------- export resolution

function resolveExport(rel, name, seen = new Set()) {
  const key = rel + '#' + name;
  if (seen.has(key)) return null;
  seen.add(key);
  const info = files[rel];
  if (!info) return null;
  if (name === 'default') {
    const d = info.decls.find((x) => x.isDefault);
    return d ? { rel, name: d.name } : null;
  }
  const d = info.decls.find((x) => x.name === name && x.exported);
  if (d) return { rel, name: d.name };
  for (const re of info.reexports) {
    const target = resolveFile(rel, re.module);
    if (!target) continue;
    if (re.star) {
      const r = resolveExport(target, name, seen);
      if (r) return r;
    } else {
      const hit = re.names.find((n) => n.exported === name);
      if (hit) return resolveExport(target, hit.local, seen);
    }
  }
  const imported = info.imports[name];
  if (imported && info.localExports.has(name)) {  // `import { x } from './y'; export { x };`
    const target = resolveFile(rel, imported.module);
    if (target) return resolveExport(target, imported.imported, seen);
  }
  return null;
}

// A name a project file re-exports from an external package (for example Prisma from @prisma/client).
function reexportedFromPackage(rel, name) {
  const info = files[rel];
  return !!info && info.reexports.some((re) => !resolveFile(rel, re.module) &&
    (re.star || re.names.some((n) => n.exported === name)));
}

// ---------------------------------------------------------------- units

let idFor = function idFor(rel, name) {
  let stem = rel.replace(/\.(tsx?|mts|cts)$/, '');
  let prefix = '';
  for (const [from, to] of ID_PREFIX) {
    if (stem.startsWith(from)) { stem = stem.slice(from.length); prefix = to; break; }
  }
  if (stem === 'index' && prefix === 'contract.') stem = '';
  const parts = stem.split('/').filter(Boolean).map((p) => p.replace(/^\[(.+)\]$/, '_$1_').replace(/[^A-Za-z0-9_.-]/g, '_'));
  return prefix + [...parts, name].filter(Boolean).join('.');
};

const units = {};          // id -> unit
const declUnit = {};       // rel#name -> unit id (owner after folding)

// Ids become file names, and file systems may ignore case: `DepartmentFacet` (a type) and
// `departmentFacet` (a function) in one file must not share an id. Types get a `-type` suffix.
const caseTaken = new Map();
for (const info of Object.values(files)) {
  for (const d of info.decls) {
    const key = idFor(info.rel, d.name).toLowerCase();
    caseTaken.set(key, (caseTaken.get(key) || 0) + 1);
  }
}
const baseIdFor = idFor;
idFor = (rel, name) => {
  const id = baseIdFor(rel, name);
  if (!name || (caseTaken.get(id.toLowerCase()) || 0) < 2) return id;
  const decl = files[rel] && files[rel].decls.find((d) => d.name === name);
  return decl && decl.kind === 'type' ? `${id}-type` : id;
};

for (const info of Object.values(files)) {
  if (info.scaffold) continue;
  const rel = info.rel;
  if (info.script) {
    const id = idFor(rel, '');
    const sf = sfOf(rel);
    units[id] = {
      id, rel, name: null, type: 'integrate', kind: 'file', target: rel, replay: sf.text, refs: new Map(),
      doc: jsdoc(sf, sf.statements[0] || sf), lines: sf.text.split('\n').length, exported: false, members: [],
    };
    for (const d of info.decls) declUnit[rel + '#' + d.name] = id;
    const all = references(sf, sf, new Set());
    units[id].refs = all;
    continue;
  }
  // Folding: a private function/value used by exactly one other declaration of the file goes into that unit.
  const byName = new Map(info.decls.map((d) => [d.name, d]));
  const users = new Map(info.decls.map((d) => [d.name, new Set()]));
  for (const d of info.decls) for (const name of d.refs.keys()) if (users.has(name)) users.get(name).add(d.name);
  const owner = new Map();
  for (const d of info.decls) {
    const foldable = !d.exported && (d.kind === 'function' || d.kind === 'arrow' || d.kind === 'value');
    if (foldable && users.get(d.name).size === 1) owner.set(d.name, [...users.get(d.name)][0]);
  }
  const ownerOf = (name) => {
    let n = name;
    const seen = new Set();
    while (owner.has(n) && !seen.has(n)) { seen.add(n); n = owner.get(n); }
    return n;
  };
  for (const d of info.decls) {
    const root = ownerOf(d.name);
    if (root === d.name && owner.has(d.name)) owner.delete(d.name);  // a folding cycle: keep it as a unit
  }
  const sf = sfOf(rel);
  const seenName = new Set();
  for (const d of info.decls) {
    const root = ownerOf(d.name);
    declUnit[rel + '#' + d.name] = idFor(rel, root);
    if (root !== d.name) continue;
    if (seenName.has(d.name)) continue;  // merged with the first declaration of this name
    seenName.add(d.name);
    const sameName = info.decls.filter((x) => x.name === d.name);
    const members = info.decls.filter((x) => ownerOf(x.name) === d.name);
    // Declarative classes are written by the planner: DTOs (validation schema) and Nest modules (wiring).
    const declarative = d.kind === 'class' && (/(^|[/.-])dto\.ts$/.test(rel) || d.decorators.some((x) => /^Module\(/.test(x)));
    const provided = d.kind === 'type' || d.kind === 'data' || declarative;
    const kind = d.kind === 'class' ? 'class' : (d.kind === 'function' || d.kind === 'arrow') ? 'function' : 'declaration';
    let signature;
    if (d.kind === 'function') signature = functionSignature(sf, d.node);
    else if (d.kind === 'arrow') signature = arrowSignature(sf, d.node, d.exported);
    else if (d.kind === 'class') signature = classSignature(sf, d.node, d.exported);
    else if (d.kind === 'type') signature = d.text;
    else if (d.kind === 'data') signature = dataSignature(sf, d.node, d.exported, d.text);
    else signature = valueSignature(sf, d.node, d.exported);
    if (d.viaExportList && !/^export\b/.test(signature)) {
      signature = (d.isDefault ? 'export default ' : 'export ') + signature;
    }
    if (sameName.length > 1) {  // for example `export const ErrorCode = {...}` and `export type ErrorCode = ...`
      signature = sameName.map((x) => (x.kind === 'type' ? x.text
        : x.kind === 'data' ? dataSignature(sf, x.node, x.exported, x.text) : x === d ? signature : x.text)).join('\n');
    }
    const exportPrefix = (text, x) => (x.viaExportList && !/^export\b/.test(text.trimStart())
      ? (x.isDefault ? 'export default ' : 'export ') + text.trimStart() : text);
    const replay = members.map((x) => exportPrefix(x.text, x)).join('\n\n');
    const refs = new Map();
    for (const m of members) {
      for (const [name, how] of m.refs) {
        if (members.some((x) => x.name === name)) continue;
        const entry = refs.get(name) || { value: false, type: false };
        entry.value = entry.value || how.value;
        entry.type = entry.type || how.type;
        refs.set(name, entry);
      }
    }
    units[idFor(rel, d.name)] = {
      id: idFor(rel, d.name), rel, name: d.name, kind, declKind: d.kind,
      type: provided ? 'provided' : isIntegrate(rel, d) ? 'integrate' : 'implement',
      target: `${rel}::${d.name}`, signature, replay, refs, sigRefs: d.sigRefs, doc: d.doc, exported: d.exported,
      members: members.filter((x) => x !== d).map((x) => x.name),
      lines: members.reduce((n, x) => n + x.end - x.start + 1, 0), start: d.start,
    };
  }
}

// Resolve each unit's references to other units, and build its import lines.
for (const unit of Object.values(units)) {
  const info = files[unit.rel];
  const uses = [];
  const valueUses = [];
  const importGroups = new Map();
  for (const [name, how] of unit.refs) {
    let target = null;
    if (info.imports[name]) {
      const imp = info.imports[name];
      const group = importGroups.get(imp.module) || [];
      group.push({ local: name, imported: imp.imported, typeOnly: imp.typeOnly });
      importGroups.set(imp.module, group);
      const file = resolveFile(unit.rel, imp.module);
      if (file && files[file]) {
        const r = imp.imported === '*' ? null : resolveExport(file, imp.imported);
        if (r) target = declUnit[r.rel + '#' + r.name];
        else if (imp.imported === '*') problem(`${unit.id}: namespace import of ${imp.module}`);
        else if (!reexportedFromPackage(file, imp.imported)) problem(`${unit.id}: cannot resolve ${imp.imported} from ${imp.module}`);
      }
    } else if (info.names.has(name)) {
      target = declUnit[unit.rel + '#' + name];
    }
    if (target && target !== unit.id) {
      if (!uses.includes(target)) uses.push(target);
      if (how.value && !valueUses.includes(target)) valueUses.push(target);
    }
  }
  unit.uses = uses;
  unit.valueUses = valueUses;
  unit.importGroups = importGroups;
}

// Every unit of a file gets the same import lines: the original import statements, in their original
// order, keeping the bindings that some unit of the file uses. The harness merges the units' lines into
// one header, so a shared list keeps that header in the original order (CSS and polyfill imports keep
// their place) and the prompt shows nothing it would not show anyway.
for (const info of Object.values(files)) {
  if (info.scaffold) continue;
  const fileUnits = Object.values(units).filter((u) => u.rel === info.rel);
  const used = new Map();  // module -> Map(local -> binding)
  for (const unit of fileUnits) {
    for (const [module, group] of unit.importGroups || []) {
      const m = used.get(module) || new Map();
      for (const g of group) m.set(g.local, g);
      used.set(module, m);
    }
  }
  const lines = [...info.directives];
  const done = new Set();
  for (const entry of info.importOrder || []) {
    if (entry.sideEffect) { lines.push(entry.sideEffect); continue; }
    if (done.has(entry.module) || !used.has(entry.module)) continue;
    done.add(entry.module);
    const group = [...used.get(entry.module).values()];
    const def = group.find((g) => g.imported === 'default');
    const ns = group.find((g) => g.imported === '*');
    const named = group.filter((g) => g.imported !== 'default' && g.imported !== '*');
    const q = `'${entry.module}'`;
    const spec = (g) => (g.imported === g.local ? g.local : `${g.imported} as ${g.local}`);
    const allType = named.length > 0 && !def && named.every((g) => g.typeOnly);
    const parts = named.map((g) => (g.typeOnly && !allType ? 'type ' : '') + spec(g));
    // `import type D, { x }` is not valid TypeScript, so a default import next to named ones is a value import.
    if (def && parts.length) lines.push(`import ${def.local}, { ${parts.join(', ')} } from ${q};`);
    else if (def) lines.push(`import ${def.typeOnly ? 'type ' : ''}${def.local} from ${q};`);
    else if (parts.length) lines.push(`import ${allType ? 'type ' : ''}{ ${parts.join(', ')} } from ${q};`);
    if (ns) lines.push(`import ${ns.typeOnly ? 'type ' : ''}* as ${ns.local} from ${q};`);
  }
  for (const unit of fileUnits) unit.imports = unit.kind === 'file' ? [] : [...lines];
}

// The unit a name in a file refers to (an import resolved through re-exports, or a local declaration).
function resolveName(rel, name) {
  const info = files[rel];
  if (info.imports[name]) {
    const imp = info.imports[name];
    const file = resolveFile(rel, imp.module);
    if (!file || !files[file] || imp.imported === '*') return null;
    const r = resolveExport(file, imp.imported);
    return r ? declUnit[r.rel + '#' + r.name] || null : null;
  }
  if (info.names.has(name)) return declUnit[rel + '#' + name] || null;
  // An inferred type can name a project type the file never imports; use it if the name is unique.
  const matches = Object.values(units).filter((u) => u.name === name && (u.declKind === 'type' || u.kind === 'class'));
  return matches.length === 1 ? matches[0].id : null;
}

// Names a signature text uses as types (same rules as the harness's typeNames): annotations and
// heritage clauses, not decorators, constructor parameters or `typeof` queries.
function typeNamesOf(signature) {
  const sf = ts.createSourceFile('signature.ts', signature, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();
  const visit = (node, inType) => {
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
  return names;
}

// Type context: types (and data constants used as types) that appear in the signatures the
// model will see, followed transitively. Only provided declarations are added, and never when the
// addition would close a cycle. Each added type also gets an `import type` line when it is exported,
// so the model can name it.
const signatureTypes = {};
for (const unit of Object.values(units)) {
  const names = unit.signature ? typeNamesOf(unit.signature) : new Set();
  signatureTypes[unit.id] = [...names].map((n) => resolveName(unit.rel, n)).filter(Boolean);
}
function provClosure(id, out = new Set()) {
  if (out.has(id) || !units[id]) return out;
  out.add(id);
  for (const d of units[id].valueUses) provClosure(d, out);
  return out;
}
function importSpecifier(fromRel, unit) {
  for (const [pkg, entry] of Object.entries(PACKAGES)) {
    const r = resolveExport(entry, unit.name);
    const pkgRoot = entry.replace(/src\/index\.ts$/, '');
    if (r && declUnit[r.rel + '#' + r.name] === unit.id && !fromRel.startsWith(pkgRoot)) return pkg;
  }
  if (!unit.exported) return null;
  const noExt = unit.rel.replace(/\.tsx?$/, '').replace(/\/index$/, '');
  if (fromRel.startsWith('apps/storefront/src/') && unit.rel.startsWith('apps/storefront/src/')) {
    return '@/' + noExt.slice('apps/storefront/src/'.length);
  }
  let relPath = path.posix.relative(path.posix.dirname(fromRel), noExt);
  if (!relPath.startsWith('.')) relPath = './' + relPath;
  return relPath;
}
let addedContext = 0;
const contextImports = {};
for (const unit of Object.values(units)) {
  if (unit.type === 'provided') continue;
  const queue = [...unit.uses];
  const seen = new Set(queue);
  while (queue.length) {
    const dep = queue.shift();
    for (const t of signatureTypes[dep] || []) {
      if (seen.has(t) || t === unit.id || !units[t]) continue;
      seen.add(t);
      const target = units[t];
      const usable = target.type === 'provided' ? ['type', 'data', 'class'].includes(target.declKind)
        : target.kind === 'class';  // an implemented class used as a type: the model needs its methods
      if (!usable) continue;
      // A private constant in another file cannot be imported, and is rarely needed to use a type.
      if (target.declKind === 'data' && !target.exported && target.rel !== unit.rel) continue;
      if ((target.type === 'provided' ? provClosure(t) : closure([t])).has(unit.id)) continue;
      if (!unit.uses.includes(t)) {
        unit.uses.push(t);
        addedContext++;
        if (target.rel !== unit.rel && !Object.keys(files[unit.rel].imports).includes(target.name)) {
          const spec = importSpecifier(unit.rel, target);
          // Always type-only: context for the model, with no effect on what the file loads at run time.
          if (spec) (contextImports[unit.id] = contextImports[unit.id] || []).push(`import type { ${target.name} } from '${spec}';`);
        }
      }
      queue.push(t);
    }
  }
}

for (const [id, lines] of Object.entries(contextImports)) {
  if (units[id].kind !== 'file') units[id].imports.push(...lines);
}

// Re-export statements and `export { importedName }` lists go into the header of the file's first unit.
for (const info of Object.values(files)) {
  if (info.scaffold || info.script) continue;
  const first = Object.values(units).filter((u) => u.rel === info.rel).sort((a, b) => a.start - b.start)[0];
  if (!first) continue;
  for (const re of info.reexports) first.imports.push(re.text.endsWith(';') ? re.text : re.text + ';');
  for (const [local, exported] of info.localExports) {
    if (info.names.has(local)) continue;
    if (info.imports[local]) {
      const imp = info.imports[local];
      first.imports.push(`import { ${imp.imported === local ? local : imp.imported + ' as ' + local} } from '${imp.module}';`);
      first.imports.push(`export { ${local === exported ? local : local + ' as ' + exported} };`);
    }
  }
}

// ---------------------------------------------------------------- dependency graph

const unitIds = Object.keys(units);
function depsOf(u) { return (u.type === 'provided' ? u.valueUses : u.uses).concat(u.after || []); }
function closure(roots) {
  const out = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id) || !units[id]) continue;
    out.add(id);
    stack.push(...depsOf(units[id]));
  }
  return out;
}
function findCycles() {
  const index = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const sccs = [];
  let counter = 0;
  const strong = (v) => {
    index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v);
    for (const w of depsOf(units[v])) {
      if (!units[w]) continue;
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  };
  for (const id of unitIds) if (!index.has(id)) strong(id);
  return sccs;
}

// Load-time dependencies. A provided constant whose initializer refers to an implemented unit
// (`const shortDate = dateFormat({...})`, `[...PRODUCTS]`) runs that unit when its file loads.
// Loading a file also loads every file it imports for a value (type-only imports are erased).
// So each unit needs the load-time dependencies of its file and of everything that file imports,
// or its tests would reach a stub it cannot know about.
const ownLoadDeps = {};
for (const info of Object.values(files)) {
  const set = new Set();
  for (const u of Object.values(units)) {
    if (u.rel !== info.rel || u.type !== 'provided') continue;
    for (const dep of u.valueUses) if (units[dep] && units[dep].type !== 'provided') set.add(dep);
  }
  ownLoadDeps[info.rel] = set;
}
const valueImports = {};  // file -> project files it imports for a value
for (const info of Object.values(files)) {
  const usedAsValue = new Set();
  for (const u of Object.values(units)) {
    if (u.rel !== info.rel) continue;
    for (const [name, how] of u.refs) if (how.value) usedAsValue.add(name);
  }
  const targets = new Set();
  for (const [name, imp] of Object.entries(info.imports)) {
    if (imp.typeOnly || !usedAsValue.has(name)) continue;
    const file = resolveFile(info.rel, imp.module);
    if (file && files[file]) targets.add(file);
  }
  for (const entry of info.importOrder || []) {  // side-effect imports always load
    if (entry.sideEffect) {
      const file = resolveFile(info.rel, entry.module);
      if (file && files[file]) targets.add(file);
    }
  }
  for (const re of info.reexports) {  // `export * from './x'` loads ./x
    const file = resolveFile(info.rel, re.module);
    if (file && files[file]) targets.add(file);
  }
  valueImports[info.rel] = targets;
}
const loadDepsMemo = {};
function loadDeps(rel, stack = new Set()) {
  if (loadDepsMemo[rel]) return loadDepsMemo[rel];
  if (stack.has(rel)) return new Set();  // an import cycle: the outer call collects the rest
  stack.add(rel);
  const out = new Set(ownLoadDeps[rel] || []);
  for (const next of valueImports[rel] || []) for (const dep of loadDeps(next, stack)) out.add(dep);
  stack.delete(rel);
  loadDepsMemo[rel] = out;
  return out;
}
let loadEdges = 0;
for (const u of Object.values(units)) {
  if (u.type === 'provided' || !files[u.rel] || files[u.rel].scaffold) continue;
  for (const dep of loadDeps(u.rel)) {
    if (dep === u.id || u.uses.includes(dep) || (u.after || []).includes(dep)) continue;
    if (closure([dep]).has(u.id)) continue;  // dep depends on u: an edge would close a cycle
    u.after = (u.after || []).concat([dep]);
    loadEdges++;
  }
}

// ---------------------------------------------------------------- tests

const TEST_CALLS = new Set(['describe', 'it', 'test', 'suite']);
function testCallRoot(expr) {
  // describe(...) / it.each(...)(...) / describe.skip(...) -> 'describe' / 'it'
  let e = expr;
  while (e) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else break;
  }
  return e && ts.isIdentifier(e) && TEST_CALLS.has(e.text) ? e.text : null;
}
const isTestCall = (s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && testCallRoot(s.expression);
const callbackOf = (call) => [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

const tests = [];
for (const rel of testRels) {
  const sf = sfOf(rel);
  const imports = {};
  const mocked = new Set();
  const localDecls = new Map();
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause) {
      const module = s.moduleSpecifier.text;
      const clause = s.importClause;
      if (clause.name) imports[clause.name.text] = { module, imported: 'default' };
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imports[e.name.text] = { module, imported: (e.propertyName || e.name).text };
      if (nb && ts.isNamespaceImport(nb)) imports[nb.name.text] = { module, imported: '*' };
    }
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['vi', 'jest'].includes(n.expression.expression.getText(sf)) &&
        ['mock', 'doMock'].includes(n.expression.name.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const file = resolveFile(rel, n.arguments[0].text);
        if (file) mocked.add(file);
      }
      ts.forEachChild(n, visit);
    };
    visit(s);
    if (ts.isFunctionDeclaration(s) && s.name) localDecls.set(s.name.text, s);
    if (ts.isClassDeclaration(s) && s.name) localDecls.set(s.name.text, s);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) for (const n of bindingNamesOf(d.name)) localDecls.set(n, s);
  }
  // Units an import binding resolves to (none for mocked modules or external packages).
  const unitOfImport = (name) => {
    const imp = imports[name];
    if (!imp) return [];
    const file = resolveFile(rel, imp.module);
    if (!file || mocked.has(file) || !files[file]) return [];
    if (imp.imported === '*') return Object.values(units).filter((u) => u.rel === file).map((u) => u.id);
    const r = resolveExport(file, imp.imported);
    return r && declUnit[r.rel + '#' + r.name] ? [declUnit[r.rel + '#' + r.name]] : [];
  };
  // `import('../x')` and `import(`../app/${dir}/page.tsx`)` (a pattern: every matching file).
  let sawPattern = false;
  // Files a test reads as text (readFileSync(join(SRC, 'app/login/page.tsx'))): their units must be
  // finished before the test can pass, exactly as if the test imported them.
  const readFiles = (node) => {
    const out = new Set();
    const bases = [path.posix.dirname(rel), 'apps/storefront/src', 'apps/storefront', 'apps/api/src', 'apps/api', ''];
    const visit = (n) => {
      if (ts.isStringLiteralLike(n) && /\.(tsx?|mts)$/.test(n.text) && !n.text.startsWith('.')) {
        for (const base of bases) {
          const candidate = path.posix.normalize(path.posix.join(base, n.text));
          if (files[candidate]) {
            for (const u of Object.values(units)) if (u.rel === candidate && !mocked.has(candidate)) out.add(u.id);
            break;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };
  const dynamicImports = (node) => {
    const out = new Set();
    const visit = (n) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0]) {
        const arg = n.arguments[0];
        let targets = [];
        if (ts.isStringLiteralLike(arg)) {
          const file = resolveFile(rel, arg.text);
          if (file) targets = [file];
        } else if (ts.isTemplateExpression(arg)) {
          sawPattern = true;
          const parts = [arg.head.text, ...arg.templateSpans.map((span) => span.literal.text)];
          const pattern = parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
          const base = path.posix.dirname(rel);
          const re = new RegExp('^' + pattern + '$');
          targets = Object.keys(files).filter((f) => {
            let relative = path.posix.relative(base, f);
            if (!relative.startsWith('.')) relative = './' + relative;
            return re.test(relative) || re.test(relative.replace(/\.tsx?$/, ''));
          });
        }
        for (const file of targets) {
          if (mocked.has(file)) continue;
          for (const u of Object.values(units)) if (u.rel === file) out.add(u.id);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };
  const memo = new Map();
  const unitsReached = (node) => {
    // Units reached from a node: its import references, and (transitively) local declarations it uses.
    const out = new Set();
    sawPattern = false;
    const seenLocal = new Set();
    const walk = (n) => {
      for (const id of dynamicImports(n)) out.add(id);
      for (const id of readFiles(n)) out.add(id);
      for (const name of references(sf, n, new Set()).keys()) {
        for (const id of unitOfImport(name)) out.add(id);
        const local = localDecls.get(name);
        if (local && !seenLocal.has(local)) { seenLocal.add(local); walk(local); }
      }
    };
    walk(node);
    if (sawPattern) out.pattern = true;  // reached through import(`...${x}...`): too broad to pin on one unit
    return out;
  };
  // Code that runs for every test: top-level statements other than declarations of functions and test calls.
  const always = new Set();
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || isTestCall(s) || ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s)) continue;
    if (ts.isVariableStatement(s)) {
      const inits = s.declarationList.declarations.map((d) => d.initializer).filter(Boolean);
      if (inits.every((i) => ts.isArrowFunction(unwrap(i)) || ts.isFunctionExpression(unwrap(i)))) continue;
    }
    for (const id of unitsReached(s)) always.add(id);
  }
  // Collect test cases with the setup of their enclosing describes.
  const cases = [];
  const collect = (statements, setup, pathNames, atomicGroup) => {
    for (const s of statements) {
      if (!isTestCall(s)) continue;
      const call = s.expression;
      const root = testCallRoot(call);
      const name = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : '?';
      if (root === 'describe' || root === 'suite') {
        const cb = callbackOf(call);
        if (!cb || !ts.isBlock(cb.body)) continue;
        const inner = cb.body.statements.filter((x) => !isTestCall(x));
        const innerSetup = new Set(setup);
        for (const x of inner) for (const id of unitsReached(x)) innerSetup.add(id);
        const hasLet = inner.some((x) => ts.isVariableStatement(x) && !(x.declarationList.flags & ts.NodeFlags.Const));
        collect(cb.body.statements, innerSetup, pathNames.concat([name]), atomicGroup || (hasLet ? s : null));
      } else {
        const reached = new Set(setup);
        const own = unitsReached(call);
        for (const id of own) reached.add(id);
        cases.push({ node: s, reached, group: atomicGroup, path: pathNames.concat([name]), pattern: !!own.pattern });
      }
    }
  };
  collect(sf.statements, always, [], null);
  tests.push({ rel, sf, cases, mocked: [...mocked] });
}
function bindingNamesOf(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return (name.elements || []).flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNamesOf(e.name)));
}

// Expand provided units to the implemented units beneath them (a Nest module stands for its providers).
const isImpl = (id) => units[id] && units[id].type !== 'provided';
function implSet(reached) {
  const out = new Set();
  for (const id of reached) {
    if (isImpl(id)) out.add(id);
    else for (const x of closure([id])) if (isImpl(x)) out.add(x);
  }
  return out;
}

const assignments = {};  // unit id -> [{rel, case}]
const orderingEdges = [];
const topoIndex = (() => { const order = new Map(); unitIds.forEach((id, i) => order.set(id, i)); return order; })();
for (const t of tests) {
  if (/^apps\/api\/test\//.test(t.rel)) continue;  // end-to-end suites boot the whole app: milestones only
  const groups = new Map();
  for (const c of t.cases) {
    const key = c.group || c.node;
    const g = groups.get(key) || { cases: [], reached: new Set(), pattern: false };
    g.cases.push(c);
    g.pattern = g.pattern || c.pattern;
    for (const id of c.reached) g.reached.add(id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const S = implSet(g.reached);
    if (S.size === 0 || g.pattern) continue;
    let tops = [...S].filter((u) => [...S].every((v) => closure([u]).has(v)));
    if (tops.length === 0) {
      // No single unit covers what the tests reach (for example siblings in one file, or a helper the
      // test file's own setup calls). Let the unit with the largest closure wait for the rest with
      // ordering-only `after` edges, unless that would close a cycle. The edges are not shown in prompts.
      {
        const candidate = [...S].sort((a, b) => closure([b]).size - closure([a]).size || units[b].start - units[a].start)[0];
        const missing = [...S].filter((v) => !closure([candidate]).has(v));
        if (missing.length <= 8 && missing.every((v) => !closure([v]).has(candidate))) {
          units[candidate].after = (units[candidate].after || []).concat(missing.filter((m) => !(units[candidate].after || []).includes(m)));
          orderingEdges.push({ unit: candidate, after: missing, test: t.rel });
          tops = [candidate];
        }
      }
    }
    if (tops.length !== 1) {
      if (process.env.EXPLAIN && t.rel.includes(process.env.EXPLAIN)) {
        console.log(`unassigned in ${t.rel}: ${g.cases.map((c) => c.path.join(' > ')).join(' | ')}
  reaches ${[...S].join(', ')}`);
      }
      continue;
    }
    (assignments[tops[0]] = assignments[tops[0]] || []).push(...g.cases.map((c) => ({ rel: t.rel, node: c.node })));
  }
}

// Write the split test files' text: the original file minus the test calls not assigned to the unit.
function splitText(t, keep) {
  const sf = t.sf;
  const containsKept = (node) => {
    let found = false;
    const visit = (n) => { if (found) return; if (keep.has(n)) { found = true; return; } ts.forEachChild(n, visit); };
    visit(node);
    return found;
  };
  const emit = (statements) => {
    let out = '';
    for (const s of statements) {
      if (!isTestCall(s)) { out += s.getFullText(sf); continue; }
      if (keep.has(s)) { out += s.getFullText(sf); continue; }
      const root = testCallRoot(s.expression);
      if ((root === 'describe' || root === 'suite') && containsKept(s)) {
        const cb = callbackOf(s.expression);
        const body = cb.body;
        out += sf.text.slice(s.getFullStart(), body.getStart(sf) + 1);
        out += emit(body.statements);
        out += sf.text.slice(body.statements.length ? body.statements[body.statements.length - 1].end : body.getStart(sf) + 1, s.end);
      }
    }
    return out;
  };
  return emit(sf.statements).replace(/^\n+/, '') + '\n';
}

const splitFiles = [];
for (const [unitId, items] of Object.entries(assignments)) {
  const byFile = new Map();
  for (const item of items) {
    const set = byFile.get(item.rel) || new Set();
    set.add(item.node);
    byFile.set(item.rel, set);
  }
  for (const [rel, keep] of byFile) {
    const t = tests.find((x) => x.rel === rel);
    const total = t.cases.length;
    const unit = units[unitId];
    const m = rel.match(/^(.*\/)?([^/]+?)\.(spec|test)\.(tsx?)$/);
    const short = (unit.name || 'file').replace(/[^A-Za-z0-9_-]/g, '_');
    let out = `${m[1] || ''}${m[2]}.${short}.unit.${m[3]}.${m[4]}`;
    let n = 2;
    while (splitFiles.some((s) => s.rel === out)) out = `${m[1] || ''}${m[2]}.${short}${n++}.unit.${m[3]}.${m[4]}`;
    splitFiles.push({ rel: out, from: rel, unit: unitId, cases: keep.size, of: total, text: splitText(t, keep) });
    (unit.tests = unit.tests || []).push(out);
  }
}

// One milestone per original test file: the units its tests reach, minus those covered by others.
const milestones = tests.map((t) => {
  const reached = new Set();
  for (const c of t.cases) for (const id of c.reached) reached.add(id);
  const relevant = [...reached].filter((id) => isImpl(id) || [...closure([id])].some(isImpl));
  const after = relevant.filter((u) => !relevant.some((v) => v !== u && closure([v]).has(u)));
  return { test: t.rel, after: after.sort(), cases: t.cases.length, e2e: /^apps\/api\/test\//.test(t.rel) };
});

// ---------------------------------------------------------------- output

const cycles = findCycles();
const scaffold = allFiles.filter((r) => !(isSourceFile(r) && files[r] && !files[r].scaffold) && !(isTestFile(r) && /\.tsx?$/.test(r)));
const testHelpers = allFiles.filter((r) => isTestFile(r) && !/\.tsx?$/.test(r));
fs.writeFileSync(OUT, JSON.stringify({
  units: Object.values(units).map((u) => ({
    id: u.id, rel: u.rel, name: u.name, type: u.type, kind: u.kind, declKind: u.declKind || null, target: u.target,
    signature: u.signature || null, uses: u.uses, valueUses: u.valueUses, after: u.after || [], imports: u.imports,
    doc: u.doc || '', replay: u.replay, lines: u.lines, members: u.members, tests: u.tests || [], exported: u.exported,
  })),
  milestones, splitFiles, orderingEdges, cycles, problems,
  scaffold: scaffold.filter((r) => !testHelpers.includes(r)), testFiles: testRels, testHelpers,
  unassigned: tests.map((t) => ({ rel: t.rel, cases: t.cases.length,
    assigned: splitFiles.filter((s) => s.from === t.rel).reduce((n, s) => n + s.cases, 0) })),
}, null, 1));
console.log(`type context added to uses: ${addedContext}; return types inferred: ${inferredReturns}; load-time edges: ${loadEdges}`);
console.log(`units ${Object.keys(units).length}, split files ${splitFiles.length}, milestones ${milestones.length}, ` +
  `cycles ${cycles.length}, problems ${problems.length}`);
