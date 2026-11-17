#!/usr/bin/env node
// Test entry point for the SLM harness inside the rebuilt workspace. It is not part of the
// original project; the harness copies it to tools/harness-test.mjs.
//
//   node tools/harness-test.mjs --setup         install dependencies, generate the Prisma client,
//                                                build the shared packages (the run's preflight)
//   node tools/harness-test.mjs <test files>    run tests with each package's own runner:
//       apps/storefront/**, packages/config-schema/**   vitest
//       apps/api/src/**                                  jest (unit config)
//       apps/api/test/**                                 jest (integration config; needs DATABASE_URL)
//       tools/checks/<name>.check.json                   a whole-workspace check (typecheck, storefront-build)
//
// Output goes to stdout/stderr unchanged; the exit code is non-zero if anything failed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['packages/api-contract', 'packages/config-schema', 'database'];
const TYPECHECKED = ['packages/api-contract', 'packages/config-schema', 'database', 'apps/api', 'apps/storefront'];

function bin(pkgDir, request) {
  try {
    return createRequire(path.join(ROOT, pkgDir, 'package.json')).resolve(request);
  } catch {
    console.error(`Cannot find ${request} from ${pkgDir}. Run \`node tools/harness-test.mjs --setup\` first.`);
    process.exit(2);
  }
}

function run(pkgDir, script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.join(ROOT, pkgDir), stdio: 'inherit', env: { ...process.env, ...extraEnv },
  });
  if (result.error) console.error(String(result.error));
  return result.status === 0;
}

function sourceHash(pkgDir) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) hash.update(entry.name).update(fs.readFileSync(full));
    }
  };
  for (const sub of ['src', 'tsconfig.json']) {
    const full = path.join(ROOT, pkgDir, sub);
    if (fs.existsSync(full)) (fs.statSync(full).isDirectory() ? walk(full) : hash.update(fs.readFileSync(full)));
  }
  return hash.digest('hex');
}

// The apps import the shared packages through their dist/ folders, as in the original CI.
function buildShared() {
  let ok = true;
  for (const pkgDir of SHARED) {
    const stamp = path.join(ROOT, pkgDir, 'dist', '.harness-build');
    const hash = sourceHash(pkgDir);
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) continue;
    run(pkgDir, bin(pkgDir, 'typescript/bin/tsc'), ['-p', 'tsconfig.json']);  // emits even with type errors
    if (!fs.existsSync(path.join(ROOT, pkgDir, 'dist', 'index.js'))) {
      console.error(`Building ${pkgDir} produced no dist/index.js.`);
      ok = false;
      continue;
    }
    fs.writeFileSync(stamp, hash);
  }
  return ok;
}

function setup() {
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (install.status !== 0) return false;
  if (!run('database', bin('database', 'prisma/build/index.js'), ['generate'])) return false;
  return buildShared();
}

function check(name) {
  if (name === 'typecheck') {
    let ok = true;
    for (const pkgDir of TYPECHECKED) {
      console.log(`# tsc --noEmit (${pkgDir})`);
      ok = run(pkgDir, bin(pkgDir, 'typescript/bin/tsc'), ['-p', 'tsconfig.json', '--noEmit', '--pretty', 'false']) && ok;
    }
    return ok;
  }
  if (name === 'storefront-build') {
    return run('apps/storefront', bin('apps/storefront', 'next/dist/bin/next'), ['build'], { NEXT_TELEMETRY_DISABLED: '1' });
  }
  console.error(`Unknown check ${name}.`);
  return false;
}

function main(argv) {
  if (argv[0] === '--setup') return setup();
  const groups = { storefront: [], config: [], apiUnit: [], apiE2e: [], checks: [] };
  for (const arg of argv) {
    const rel = path.relative(ROOT, path.resolve(arg)).split(path.sep).join('/');
    if (rel.startsWith('apps/storefront/')) groups.storefront.push(rel.slice('apps/storefront/'.length));
    else if (rel.startsWith('packages/config-schema/')) groups.config.push(rel.slice('packages/config-schema/'.length));
    else if (rel.startsWith('apps/api/test/')) groups.apiE2e.push(rel.slice('apps/api/'.length));
    else if (rel.startsWith('apps/api/')) groups.apiUnit.push(rel.slice('apps/api/'.length));
    else if (rel.startsWith('tools/checks/') && rel.endsWith('.check.json')) {
      groups.checks.push(JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).check);
    } else {
      console.error(`Do not know how to run ${rel}.`);
      return false;
    }
  }
  let ok = buildShared();
  if (groups.config.length) {
    ok = run('packages/config-schema', bin('packages/config-schema', 'vitest/vitest.mjs'), ['run', ...groups.config]) && ok;
  }
  if (groups.storefront.length) {
    ok = run('apps/storefront', bin('apps/storefront', 'vitest/vitest.mjs'), ['run', ...groups.storefront]) && ok;
  }
  if (groups.apiUnit.length) {
    ok = run('apps/api', bin('apps/api', 'jest/bin/jest.js'), ['--ci', '--runTestsByPath', ...groups.apiUnit]) && ok;
  }
  if (groups.apiE2e.length) {
    if (!process.env.DATABASE_URL) {
      console.error('The API integration tests need DATABASE_URL (a disposable local PostgreSQL).');
      return false;
    }
    ok = run('database', bin('database', 'prisma/build/index.js'), ['migrate', 'deploy']) && ok;
    ok = run('apps/api', bin('apps/api', 'jest/bin/jest.js'),
      ['--ci', '--config', 'jest.integration.config.js', '--runInBand', '--runTestsByPath', ...groups.apiE2e]) && ok;
  }
  for (const name of groups.checks) ok = check(name) && ok;
  return ok;
}

process.exit(main(process.argv.slice(2)) ? 0 : 1);
