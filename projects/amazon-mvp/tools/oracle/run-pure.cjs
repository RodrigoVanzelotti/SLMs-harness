// Runs pure-logic test files without installing the project's dependencies.
//
//   node tools/oracle/run-pure.cjs --root <tree> [--mount <dir>] <test file> [...]
//
// <tree> is the original repository or a harness workspace (same layout). TypeScript is
// transpiled with the `typescript` package (HARNESS_TYPESCRIPT). `vitest` is replaced by a
// small compatible subset (describe/it/expect/vi.fn). A test file that needs anything else
// (react, next, zod, @nestjs, vi.mock, a DOM) is reported as SKIPPED, never as passed.
// Exit code: 0 if every file that ran passed, 1 if any test failed, 3 if nothing ran.
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const util = require('util');
const ts = require(process.env.HARNESS_TYPESCRIPT || 'typescript');

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex < 0) { console.error('usage: run-pure.cjs --root <tree> <test files>'); process.exit(2); }
const ROOT = path.resolve(args[rootIndex + 1]);
// --mount <dir>: test files under <dir> are run as if they were at the same path under <tree>, so a
// new test can be checked against the original without copying it into the original.
const mountIndex = args.indexOf('--mount');
const MOUNT = mountIndex >= 0 ? path.resolve(args[mountIndex + 1]) : null;
const optionIndexes = new Set([rootIndex, rootIndex + 1, ...(mountIndex >= 0 ? [mountIndex, mountIndex + 1] : [])]);
const testFiles = args.filter((_, i) => !optionIndexes.has(i)).map((f) => {
  const real = path.resolve(f.startsWith('.') || path.isAbsolute(f) || MOUNT ? process.cwd() : ROOT, f);
  if (MOUNT && real.startsWith(MOUNT + path.sep)) return { real, virtual: path.join(ROOT, path.relative(MOUNT, real)) };
  const inRoot = path.resolve(ROOT, f);
  return { real: fs.existsSync(real) ? real : inRoot, virtual: fs.existsSync(real) ? real : inRoot };
});

const ALIASES = [['@/', 'apps/storefront/src/']];
const PACKAGES = {
  '@amazon-mvp/api-contract': 'packages/api-contract/src/index.ts',
  '@amazon-mvp/config-schema': 'packages/config-schema/src/index.ts',
};
const EMPTY = new Set(['server-only']);

class Unsupported extends Error {}

// ------------------------------------------------------------------ vitest subset

function format(value) { return util.inspect(value, { depth: 6, breakLength: 100 }); }
const ASYM = Symbol('asymmetric');
const asym = (name, test) => ({ [ASYM]: true, name, test, toString: () => name });

function equals(a, b, strict) {
  if (b && b[ASYM]) return b.test(a);
  if (a && a[ASYM]) return a.test(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict)) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (![...b].some((w) => equals(v, w, strict))) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => equals(v, b[i], strict));
  }
  const keys = (o) => Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ka = keys(a); const kb = keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equals(a[k], b[k], strict));
}

function matchesObject(actual, expected) {
  if (expected && expected[ASYM]) return expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  }
  if (typeof expected !== 'object' || expected === null || expected instanceof Date || expected instanceof RegExp) {
    return equals(actual, expected, false);
  }
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.keys(expected).every((k) => matchesObject(actual[k], expected[k]));
}

function getPath(obj, keyPath) {
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || !(p in Object(cur))) return { found: false };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function makeExpect() {
  const build = (actual, negate, mode) => {
    const assert = (pass, message) => {
      if (pass === negate) throw new Error(negate ? `expected NOT: ${message}` : message);
    };
    const m = {
      toBe: (e) => assert(Object.is(actual, e), `expected ${format(actual)} to be ${format(e)}`),
      toEqual: (e) => assert(equals(actual, e, false), `expected ${format(actual)} to equal ${format(e)}`),
      toStrictEqual: (e) => assert(equals(actual, e, true), `expected ${format(actual)} to strictly equal ${format(e)}`),
      toMatchObject: (e) => assert(matchesObject(actual, e), `expected ${format(actual)} to match ${format(e)}`),
      toContain: (e) => assert(actual != null && (typeof actual === 'string' ? actual.includes(e) : [...actual].includes(e)),
        `expected ${format(actual)} to contain ${format(e)}`),
      toContainEqual: (e) => assert([...actual].some((x) => equals(x, e, false)), `expected ${format(actual)} to contain ${format(e)}`),
      toHaveLength: (n) => assert(actual != null && actual.length === n, `expected length ${n}, got ${actual && actual.length}`),
      toHaveProperty: (p, ...v) => {
        const r = getPath(actual, p);
        assert(r.found && (v.length === 0 || equals(r.value, v[0], false)), `expected property ${format(p)}${v.length ? ' = ' + format(v[0]) : ''} in ${format(actual)}`);
      },
      toBeNull: () => assert(actual === null, `expected ${format(actual)} to be null`),
      toBeUndefined: () => assert(actual === undefined, `expected ${format(actual)} to be undefined`),
      toBeDefined: () => assert(actual !== undefined, 'expected a defined value'),
      toBeTruthy: () => assert(!!actual, `expected ${format(actual)} to be truthy`),
      toBeFalsy: () => assert(!actual, `expected ${format(actual)} to be falsy`),
      toBeNaN: () => assert(Number.isNaN(actual), `expected ${format(actual)} to be NaN`),
      toBeGreaterThan: (n) => assert(actual > n, `expected ${actual} > ${n}`),
      toBeGreaterThanOrEqual: (n) => assert(actual >= n, `expected ${actual} >= ${n}`),
      toBeLessThan: (n) => assert(actual < n, `expected ${actual} < ${n}`),
      toBeLessThanOrEqual: (n) => assert(actual <= n, `expected ${actual} <= ${n}`),
      toBeCloseTo: (n, digits = 2) => assert(Math.abs(actual - n) < 10 ** -digits / 2, `expected ${actual} to be close to ${n}`),
      toMatch: (re) => assert(typeof actual === 'string' && (re instanceof RegExp ? re.test(actual) : actual.includes(re)),
        `expected ${format(actual)} to match ${re}`),
      toBeInstanceOf: (c) => assert(actual instanceof c, `expected an instance of ${c && c.name}`),
      toThrow: (e) => {
        let thrown = null;
        try { actual(); } catch (err) { thrown = err || new Error(String(err)); }
        const ok = thrown !== null && (e === undefined ||
          (typeof e === 'string' && String(thrown.message).includes(e)) ||
          (e instanceof RegExp && e.test(String(thrown.message))) ||
          (typeof e === 'function' && thrown instanceof e) ||
          (typeof e === 'object' && e !== null && !(e instanceof RegExp) && matchesObject(thrown, e)));
        assert(ok, thrown ? `threw ${format(thrown.message)}, expected ${format(e)}` : 'expected the function to throw');
      },
      toHaveBeenCalled: () => assert(actual.mock.calls.length > 0, 'expected the mock to be called'),
      toHaveBeenCalledTimes: (n) => assert(actual.mock.calls.length === n, `expected ${n} calls, got ${actual.mock.calls.length}`),
      toHaveBeenCalledWith: (...a) => assert(actual.mock.calls.some((c) => equals(c, a, false)), `expected a call with ${format(a)}`),
    };
    m.toThrowError = m.toThrow;
    if (mode) {
      const wrapped = {};
      for (const [k, fn] of Object.entries(m)) {
        wrapped[k] = async (...a) => {
          let value;
          try {
            value = await actual;
            if (mode === 'rejects') throw Object.assign(new Error('expected the promise to reject'), { _shim: true });
          } catch (err) {
            if (err && err._shim) throw err;
            if (mode === 'resolves') throw new Error(`expected the promise to resolve, it rejected: ${err && err.message}`);
            value = err;
          }
          return build(value, negate, null)[k](...a);
        };
      }
      return wrapped;
    }
    return m;
  };
  const expect = (actual) => {
    const api = build(actual, false, null);
    api.not = build(actual, true, null);
    api.resolves = build(actual, false, 'resolves');
    api.rejects = build(actual, false, 'rejects');
    api.resolves.not = build(actual, true, 'resolves');
    api.rejects.not = build(actual, true, 'rejects');
    return api;
  };
  expect.any = (c) => asym(`Any<${c.name}>`, (v) => v != null && (Object(v) instanceof c || v.constructor === c));
  expect.anything = () => asym('Anything', (v) => v !== null && v !== undefined);
  expect.objectContaining = (o) => asym('ObjectContaining', (v) => matchesObject(v, o));
  expect.arrayContaining = (arr) => asym('ArrayContaining', (v) => Array.isArray(v) && arr.every((e) => v.some((x) => equals(x, e, false))));
  expect.stringContaining = (str) => asym('StringContaining', (v) => typeof v === 'string' && v.includes(str));
  expect.stringMatching = (re) => asym('StringMatching', (v) => typeof v === 'string' && new RegExp(re).test(v));
  return expect;
}

function makeVitest(registry) {
  const fn = (impl) => {
    const mock = (...a) => { mock.mock.calls.push(a); return mock._impl ? mock._impl(...a) : undefined; };
    mock.mock = { calls: [] };
    mock._impl = impl;
    mock.mockImplementation = (f) => { mock._impl = f; return mock; };
    mock.mockReturnValue = (v) => { mock._impl = () => v; return mock; };
    mock.mockResolvedValue = (v) => { mock._impl = () => Promise.resolve(v); return mock; };
    mock.mockRejectedValue = (v) => { mock._impl = () => Promise.reject(v); return mock; };
    mock.mockReset = () => { mock.mock.calls = []; mock._impl = undefined; return mock; };
    mock.mockClear = () => { mock.mock.calls = []; return mock; };
    return mock;
  };
  const unsupported = (name) => () => { throw new Unsupported(`vi.${name} needs the real vitest`); };
  const vi = { fn, mock: unsupported('mock'), doMock: unsupported('doMock'), hoisted: (f) => f(),
    useFakeTimers: unsupported('useFakeTimers'), stubGlobal: unsupported('stubGlobal'),
    spyOn: (obj, key) => { const orig = obj[key]; const m = fn((...a) => orig.apply(obj, a)); obj[key] = m; m.mockRestore = () => { obj[key] = orig; }; return m; },
    restoreAllMocks: () => {}, clearAllMocks: () => {}, resetAllMocks: () => {} };
  const stack = [registry];
  const node = (name) => ({ name, tests: [], children: [], hooks: { beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] } });
  const describe = (name, body) => {
    const child = node(name);
    stack[stack.length - 1].children.push(child);
    stack.push(child);
    try { body(); } finally { stack.pop(); }
  };
  const it = (name, body) => { stack[stack.length - 1].tests.push({ name, body }); };
  const each = (register) => (table) => (name, body) => {
    table.forEach((row, i) => {
      const rowArgs = Array.isArray(row) ? row : [row];
      const title = util.format(name, ...rowArgs).replace('%#', String(i));
      register(title, () => body(...rowArgs));
    });
  };
  const skip = () => {};
  for (const f of [describe, it]) {
    f.skip = skip; f.todo = skip; f.only = f; f.concurrent = f; f.each = each(f);
  }
  const hook = (kind) => (f) => { stack[stack.length - 1].hooks[kind].push(f); };
  return {
    describe, it, test: it, suite: describe, expect: makeExpect(), vi,
    beforeEach: hook('beforeEach'), afterEach: hook('afterEach'), beforeAll: hook('beforeAll'), afterAll: hook('afterAll'),
  };
}

// ------------------------------------------------------------------ module loading

function resolveFile(fromFile, spec) {
  let base = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  for (const [prefix, target] of ALIASES) if (spec.startsWith(prefix)) base = path.join(ROOT, target, spec.slice(prefix.length));
  if (PACKAGES[spec]) return path.join(ROOT, PACKAGES[spec]);
  if (base === null) return null;
  for (const c of [base, base + '.ts', base + '.tsx', base + '.json', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`Cannot find module ${spec} from ${fromFile}`);
}

function loadTree(entry, vitestApi, realEntry) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    if (/\.css$/.test(file)) return {};
    if (/\.json$/.test(file)) {
      const mod = { exports: JSON.parse(fs.readFileSync(file, 'utf8')) };
      cache.set(file, mod);
      return mod.exports;
    }
    if (/\.tsx$|\.jsx$/.test(file)) throw new Unsupported(`${path.relative(ROOT, file)} needs React`);
    // CommonJS has no import.meta; vitest code uses it for file URLs.
    const source = fs.readFileSync(file === entry && realEntry ? realEntry : file, 'utf8').replace(/\bimport\.meta\.url\b/g, "require('url').pathToFileURL(__filename).href");
    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
        experimentalDecorators: true, jsx: ts.JsxEmit.ReactJSX, sourceMap: false },
    }).outputText;
    const mod = { exports: {} };
    cache.set(file, mod);
    const localRequire = (spec) => {
      if (spec === 'vitest') return vitestApi;
      if (EMPTY.has(spec) || spec.endsWith('.css')) return {};
      if (spec.startsWith('node:') || Module.builtinModules.includes(spec.split('/')[0])) return require(spec);
      const target = resolveFile(file, spec);
      if (target === null) throw new Unsupported(`${path.relative(ROOT, file)} imports \`${spec}\``);
      return load(target);
    };
    const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', output);
    wrapper(mod.exports, localRequire, mod, file, path.dirname(file));
    return mod.exports;
  };
  return load(entry);
}

// ------------------------------------------------------------------ running

async function runNode(n, parents, results, prefix) {
  const chain = [...parents, n];
  for (const h of n.hooks.beforeAll) await h();
  for (const t of n.tests) {
    const title = [...prefix, t.name].join(' > ');
    try {
      for (const p of chain) for (const h of p.hooks.beforeEach) await h();
      await t.body();
      for (const p of [...chain].reverse()) for (const h of p.hooks.afterEach) await h();
      results.push({ title, ok: true });
    } catch (err) {
      results.push({ title, ok: false, error: err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : String(err) });
    }
  }
  for (const c of n.children) await runNode(c, chain, results, [...prefix, c.name]);
  for (const h of n.hooks.afterAll) await h();
}

(async () => {
  let ran = 0; let failed = 0; let skipped = 0;
  for (const { real, virtual: file } of testFiles) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    // Runners start in the package folder; some tests build paths from process.cwd().
    let pkgDir = path.dirname(file);
    while (pkgDir.startsWith(ROOT) && !fs.existsSync(path.join(pkgDir, 'package.json'))) pkgDir = path.dirname(pkgDir);
    process.chdir(pkgDir.startsWith(ROOT) ? pkgDir : ROOT);
    const text = fs.readFileSync(real, 'utf8');
    if (/\bvi\.mock\(|@vitest-environment\s+jsdom|jest\.mock\(/.test(text)) {
      console.log(`SKIPPED ${rel}: uses module mocks or a DOM`);
      skipped++;
      continue;
    }
    const registry = { name: '', tests: [], children: [], hooks: { beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] } };
    const api = makeVitest(registry);
    const saved = {};
    for (const k of ['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi']) {
      saved[k] = global[k];
      global[k] = api[k];  // jest-style globals
    }
    try {
      loadTree(file, api, real);
      const results = [];
      await runNode(registry, [], results, []);
      const bad = results.filter((r) => !r.ok);
      ran++;
      failed += bad.length ? 1 : 0;
      console.log(`${bad.length ? 'FAIL' : 'PASS'} ${rel} (${results.length - bad.length}/${results.length})`);
      for (const r of bad) console.log(`  x ${r.title}\n    ${r.error.replace(/\n/g, '\n    ')}`);
    } catch (err) {
      if (err instanceof Unsupported) {
        console.log(`SKIPPED ${rel}: ${err.message}`);
        skipped++;
      } else {
        ran++;
        failed++;
        console.log(`FAIL ${rel}: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : err}`);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) global[k] = v;
    }
  }
  console.log(`${ran} file(s) ran, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : ran ? 0 : 3);
})();
