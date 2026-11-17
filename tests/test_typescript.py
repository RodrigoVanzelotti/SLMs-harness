"""TypeScript adapter, and the features added for it: declaration units, tests in the
workspace, preflight commands and milestones that need an environment variable.

The adapter needs Node.js and the `typescript` package. Set HARNESS_TYPESCRIPT, or have
`typescript` installed where npm puts global packages; otherwise these tests are skipped.
The end-to-end tests also need Node.js 22.6+ (it runs .ts files directly).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from harness.errors import HarnessError, SpecError
from harness.lang.typescript import TypeScriptAdapter
from harness.orchestrator import Orchestrator
from harness.spec import Unit, load_project


def _find_typescript() -> str | None:
    if os.environ.get("HARNESS_TYPESCRIPT"):
        return os.environ["HARNESS_TYPESCRIPT"]
    npm = shutil.which("npm")
    if not npm:
        return None
    try:
        root = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=30, shell=os.name == "nt").stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    for candidate in (Path(root) / "typescript", Path(root) / "@nestjs" / "cli" / "node_modules" / "typescript"):
        if (candidate / "package.json").is_file():
            return str(candidate)
    return None


TYPESCRIPT = _find_typescript() if shutil.which("node") else None
pytestmark = pytest.mark.skipif(TYPESCRIPT is None, reason="needs Node.js and the typescript package")


@pytest.fixture(scope="module", autouse=True)
def _typescript_env():
    if TYPESCRIPT:
        old = os.environ.get("HARNESS_TYPESCRIPT")
        os.environ["HARNESS_TYPESCRIPT"] = TYPESCRIPT
        yield
        if old is None:
            os.environ.pop("HARNESS_TYPESCRIPT", None)
        else:
            os.environ["HARNESS_TYPESCRIPT"] = old
    else:
        yield


@pytest.fixture(scope="module")
def ts() -> TypeScriptAdapter:
    return TypeScriptAdapter()


def unit(uid: str, signature: str, kind: str = "function", target: str = "src/a.ts", **extra) -> Unit:
    name = target.split("::")[1] if "::" in target else uid.split(".")[-1]
    return Unit(id=uid, type=extra.pop("type", "implement"), kind=kind, target_file=target.split("::")[0],
                target_name=name, signature=signature, description="d", **extra)


# -- contracts and stubs

def test_infer_kind_and_stubs(ts):
    assert ts.infer_kind("export function f(a: string): number", "x") == "function"
    assert ts.infer_kind("export class C { m(): void; }", "x") == "class"
    assert ts.infer_kind("export const X: number", "x") == "declaration"
    assert ts.infer_kind("export interface I { a: string }", "x") == "declaration"

    fn = unit("m.f", "export async function f(a: string): Promise<number>")
    assert ts.render_stub(fn) == ('export async function f(a: string): Promise<number> '
                                  '{ throw new Error("HARNESS_STUB m.f"); }')
    cls = unit("m.C", "@Injectable()\nexport class C {\n  constructor(private readonly x: X);\n  get n(): number;\n  run(): void;\n}",
               kind="class")
    stub = ts.render_stub(cls)
    assert stub.count('throw new Error("HARNESS_STUB m.C")') == 3 and stub.startswith("@Injectable()")
    const = unit("m.X", "export const X: Record<string, number>", kind="declaration")
    assert "HARNESS_STUB m.X" in ts.render_stub(const) and ts.syntax_error(ts.render_stub(const), "a.ts") is None
    assert "Symbol.iterator" in ts.render_stub(const)  # `[...STUB]` fails with the marker too


def test_check_contract_rules(ts):
    assert ts.check_contract(unit("m.T", "export interface T { a: string }", kind="declaration"))  # must be provided
    assert ts.check_contract(unit("m.X", "export const X: number = 3", kind="declaration"))  # no value in signature
    assert ts.check_contract(unit("m.X", "export const X", kind="declaration"))  # needs a type
    assert not ts.check_contract(unit("m.X", "export const X: number", kind="declaration"))
    assert ts.check_contract(unit("m.f", "export function g(): void"))  # name differs from the target
    bad_import = unit("m.f", "export function f(): void", imports=["const x = 1;"])
    assert any("import" in e for e in ts.check_contract(bad_import))
    provided = unit("m.T", "export type T = string;", kind="declaration", type="provided", code="export type T = string;")
    assert not ts.check_contract(provided)


def test_header_merges_imports_and_keeps_order(ts):
    header = ts.render_header([
        "'use client';", "import './first.css';", "import { A } from 'x';", "import { B, type T } from 'x';",
        "import type { T, U } from 'x';", "import React from 'react';", "import { useState } from 'react';",
        "export { A };", "import './last.css';",
    ])
    assert header.split("\n") == [
        "'use client';", "import './first.css';", "import { A, B, type T, type U } from 'x';",
        "import React, { useState } from 'react';", "import './last.css';", "export { A };",
    ]
    assert ts.header_names(["import { A as Z } from 'x';", "import * as ns from 'y';", "import D from 'd';"]) == {"Z", "ns", "D"}
    assert ts.header_problems(["import { A } from 'x';", "import { A } from 'y';"])
    assert not ts.header_problems(["import { A } from 'x';", "import { A, B } from 'x';"])


# -- checks on a candidate

def test_sanitize_removes_what_would_break_the_file(ts):
    u = unit("m.total", "export function total(xs: number[]): number")
    code = (
        "'use client';\n"
        "import { sum, other } from './math';\n"
        "import { helper } from './helper';\n"
        "export function total(xs: number[]): number { return sum(xs); }\n"
        "export function sum(xs: number[]) { return 0; }\n"
        "console.log(total([1]));\n"
        "export { total };\n"
    )
    cleaned, notes = ts.sanitize(code, u, {"sum", "helper"})
    assert "console.log" not in cleaned and "'use client'" not in cleaned
    assert "import { other } from './math';" in cleaned and "./helper" not in cleaned
    assert "function sum" not in cleaned and "export { total }" not in cleaned
    assert len(notes) == 6
    assert ts.sanitize("export function total(xs: number[]): number { return 1; }", u, set()) == (
        "export function total(xs: number[]): number { return 1; }", [])


def test_signature_check_functions(ts):
    u = unit("m.f", "export function f(a: string, b = 2, c?: number): string")
    assert ts.signature_check("export function f(a: string, b = 2, c?: number): string { return a; }", u, False) == ([], [])
    arrow = "const f = (a: string, b = 2, c?: number): string => a;\nexport { f };"
    assert ts.signature_check(arrow, u, False) == ([], [])
    errors, _ = ts.signature_check("function f(a: string, b = 2, c?: number) { return a; }", u, False)
    assert any("exported" in e for e in errors)
    errors, _ = ts.signature_check("export function f(a: string, b = 3, c?: number) { return a; }", u, False)
    assert any("default to `2`" in e for e in errors)
    errors, _ = ts.signature_check("export function f(x: string, b = 2, c?: number) { return x; }", u, False)
    assert any("must take" in e for e in errors)
    errors, warnings = ts.signature_check("export function f(a: number, b = 2, c?: number): number { return 1; }", u, False)
    assert not errors and len(warnings) == 2
    errors, _ = ts.signature_check("export function f(a: number, b = 2, c?: number): number { return 1; }", u, True)
    assert len(errors) == 2
    page = unit("app.Page", "export default function Page({ params }: { params: { id: string } })", target="app/page.tsx")
    assert ts.signature_check("export default function Page({ params }: { params: { id: string } }) { return <div />; }",
                              page, False) == ([], [])
    errors, _ = ts.signature_check("export function Page(props: { params: { id: string } }) { return null; }", page, False)
    assert any("default export" in e for e in errors)


def test_signature_check_classes(ts):
    sig = ("@Controller('cart')\nexport class CartController {\n"
           "  constructor(@Inject(CART_API) private readonly cart: CartApi);\n"
           "  @Get()\n  get(@CurrentAuth() auth: Identity): Promise<Cart>;\n  static create(): CartController;\n}")
    u = unit("c.CartController", sig, kind="class")
    good = ("@Controller('cart')\nexport class CartController {\n"
            "  constructor(@Inject(CART_API) private readonly cart: CartApi) {}\n"
            "  @Get()\n  async get(@CurrentAuth() auth: Identity): Promise<Cart> { return this.cart.get(auth); }\n"
            "  private helper() {}\n  static create() { return new CartController(null as never); }\n}")
    assert ts.signature_check(good, u, False)[0] == []
    bad = ("export class CartController {\n  constructor(cart: CartApi) {}\n"
           "  get(auth: Identity) { return null; }\n  create() { return null; }\n}")
    errors, _ = ts.signature_check(bad, u, False)
    text = " ".join(errors)
    assert "@Controller('cart')" in text and "@Inject(CART_API)" in text and "parameter property" in text
    assert "@Get()" in text and "@CurrentAuth()" in text and "(static)" in text


def test_signature_check_declarations(ts):
    value = unit("m.X", "export const X: string[]", kind="declaration")
    assert ts.signature_check("export const X: string[] = ['a'];", value, False) == ([], [])
    errors, _ = ts.signature_check("export type X = string[];", value, False)
    assert errors


def test_imports_names_and_locate(ts):
    code = ("import fs from 'node:fs'; import path from 'path'; import { x } from '@nestjs/common';"
            "import y from 'lodash'; import z from '@/features/a'; import w from './w';"
            "const q = require('left-pad'); import p from '@amazon-mvp/api-contract';")
    errors = ts.import_errors(code, True, {"@nestjs/*", "@/"}, {"@amazon-mvp/api-contract"}, "a.ts")
    assert len(errors) == 1 and "`lodash`" in errors[0] and "`left-pad`" in errors[0]
    assert ts.import_errors("import fs from 'node:fs';", False, set(), set(), "a.ts")
    names = ts.defined_names("export interface I {}\ntype T = 1;\nconst [a, b] = [1, 2];\nfunction f() {}\n"
                             "class C {}\nimport { z } from 'z';", "a.ts")
    assert names == {"I", "T", "a", "b", "f", "C"}
    assert ts.syntax_error("export const X = () => <div />;", "a.tsx") is None
    assert ts.syntax_error("export const X = () => <div />;", "a.ts") is not None
    output = ("Error: boom\n    at inner (/ws/src/a.ts:12:5)\n    at outer (/ws/src/b.ts:3:1)\n"
              "    at node_modules/jest/x.js:1:1\n ❯ test/a.test.ts:7:3\nsrc/c.ts(4,2): error TS2304")
    frames = ts.locate(output, Path("/ws"))
    assert [(p.name, line) for p, line in frames] == [("c.ts", 4), ("a.test.ts", 7), ("b.ts", 3), ("a.ts", 12)]


def test_type_names_ignore_decorators_constructors_and_typeof(ts):
    sig = ("@Module({ imports: [AuthModule] })\nexport class C extends Base<Item> {\n"
           "  constructor(private readonly svc: Service);\n  run(x: Input): Promise<Output>;\n  level: (typeof LEVELS)[number];\n}")
    assert ts.type_names(sig) == {"Base", "Item", "Input", "Promise", "Output"}
    assert ts.is_type_only("export interface I { a: string }") and not ts.is_type_only("export const X: number")


# -- a small TypeScript project, end to end

CALC = [
    {"id": "calc.Item", "kind": "declaration", "target": "src/calc.ts::Item",
     "signature": "export interface Item { price: number; qty: number }",
     "code": "export interface Item { price: number; qty: number }"},
    {"id": "calc.lineTotal", "target": "src/calc.ts::lineTotal", "signature": "export function lineTotal(item: Item): number",
     "uses": ["calc.Item"], "description": "Price times quantity.", "tests": ["tests/test/lineTotal.test.mts"]},
    {"id": "calc.total", "target": "src/calc.ts::total", "signature": "export function total(items: Item[]): number",
     "uses": ["calc.lineTotal", "calc.Item"], "description": "Sum of the line totals.", "tests": ["tests/test/total.test.mts"]},
]
TESTS = {
    "lineTotal.test.mts": "import assert from 'node:assert';\nimport { lineTotal } from '../src/calc.ts';\n"
                          "assert.strictEqual(lineTotal({ price: 250, qty: 3 }), 750);\n",
    "total.test.mts": "import assert from 'node:assert';\nimport { total } from '../src/calc.ts';\n"
                      "assert.strictEqual(total([{ price: 100, qty: 2 }, { price: 5, qty: 1 }]), 205);\n",
}
REPLIES = {
    "calc.lineTotal": [
        "```ts\nexport function lineTotal(item: Item): number {\n  return item.price;\n}\n```",
        "```ts\nexport function lineTotal(item: Item): number {\n  return item.price * item.qty;\n}\n```",
    ],
    "calc.total": [
        "```ts\nexport function lineTotal(item: Item): number { return 0; }\n"
        "export function total(items: Item[]): number {\n  return items.reduce((n, i) => n + lineTotal(i), 0);\n}\n"
        "console.log(total([]));\n```",
    ],
}


def _node_runs_typescript() -> bool:
    try:
        out = subprocess.run(["node", "-e", "process.stdout.write(String(!!process.features.typescript))"],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return out.stdout.strip() == "true"


needs_strip_types = pytest.mark.skipif(not (TYPESCRIPT and _node_runs_typescript()),
                                       reason="needs Node.js that runs .ts files directly (22.6+)")


def make_ts_project(root: Path, *, preflight=None, milestone_env=None, env=None) -> Path:
    project = root / "calc"
    (project / "spec" / "contracts").mkdir(parents=True)
    (project / "tests" / "test").mkdir(parents=True)
    milestone = {"id": "m1", "after": ["calc.total"], "tests": ["tests/test/total.test.mts"]}
    if milestone_env:
        milestone["requires_env"] = milestone_env
    (project / "spec" / "project.yaml").write_text(yaml.safe_dump({
        "name": "calc", "language": "typescript", "digest": "Totals.", "tests_in_workspace": True,
        "milestones": [milestone],
    }), encoding="utf-8")
    (project / "spec" / "contracts" / "calc.yaml").write_text(yaml.safe_dump({"units": CALC}), encoding="utf-8")
    for name, text in TESTS.items():
        (project / "tests" / "test" / name).write_text(text, encoding="utf-8")
    (project / "mock.yaml").write_text(yaml.safe_dump(REPLIES), encoding="utf-8")
    checks = {"inherit_env": ["*"], "env": env or {},
              "tests": {"command": ["node", "--test", "{tests}"], "timeout_s": 120}}
    if preflight:
        checks["preflight"] = preflight
    (project / "harness.yaml").write_text(yaml.safe_dump({
        "run_name": "t", "model": {"backend": "mock", "mock_responses": "mock.yaml"},
        "run": {"samples": 1, "max_attempts": 2}, "checks": checks,
    }), encoding="utf-8")
    return project


@needs_strip_types
def test_typescript_project_end_to_end(tmp_path):
    project = make_ts_project(tmp_path, preflight=[{"name": "ok", "command": ["node", "-e", "process.exit(0)"]}])
    orch = Orchestrator(project, echo=lambda _: None)
    assert orch.validate().errors == []
    assert orch.run() == 0
    statuses = orch.statuses()
    assert statuses["calc.lineTotal"] == "done" and statuses["calc.total"] == "done"
    assert orch.state.milestone("m1")["status"] == "done"
    workspace = project / "runs" / "t" / "workspace"
    assert (workspace / "test" / "total.test.mts").is_file()  # tests/ copied into the workspace
    calc = (workspace / "src" / "calc.ts").read_text(encoding="utf-8")
    assert "console.log" not in calc and calc.count("export function lineTotal") == 1
    events = orch.state.events()
    assert any(e["event"] == "preflight" and e["ok"] for e in events)
    attempts = [e for e in events if e["event"] == "candidate" and e["unit"] == "calc.lineTotal"]
    assert [e["ok"] for e in attempts] == [False, True]  # the fix prompt got the test failure
    total = [e for e in events if e["event"] == "candidate" and e["unit"] == "calc.total"][0]
    assert len(total["sanitized"]) == 2


@needs_strip_types
def test_a_failing_preflight_stops_before_any_model_call(tmp_path):
    project = make_ts_project(tmp_path, preflight=[{"name": "install", "command": ["node", "-e", "process.exit(4)"]}])
    orch = Orchestrator(project, echo=lambda _: None)
    with pytest.raises(HarnessError, match="preflight command `install` failed"):
        orch.run()
    assert not any(e["event"] == "candidate" for e in orch.state.events())


@needs_strip_types
def test_milestone_waits_for_its_environment_variable(tmp_path):
    project = make_ts_project(tmp_path, milestone_env=["HARNESS_TEST_ONLY_VAR"])
    orch = Orchestrator(project, echo=lambda _: None)
    assert orch.run() == 1  # units done, but the milestone could not run
    assert orch.state.milestone("m1")["status"] == "pending"
    assert any(e["event"] == "milestone_skipped" for e in orch.state.events())

    config = yaml.safe_load((project / "harness.yaml").read_text(encoding="utf-8"))
    config["checks"]["env"] = {"HARNESS_TEST_ONLY_VAR": "1"}
    (project / "harness.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    again = Orchestrator(project, echo=lambda _: None)
    assert again.run() == 0 and again.state.milestone("m1")["status"] == "done"


@needs_strip_types
def test_tests_reaching_an_undeclared_stub_are_a_spec_problem(tmp_path):
    project = make_ts_project(tmp_path)
    contracts = project / "spec" / "contracts" / "calc.yaml"
    data = yaml.safe_load(contracts.read_text(encoding="utf-8"))
    data["units"][1]["tests"].append("tests/test/total.test.mts")  # lineTotal's tests now call total
    contracts.write_text(yaml.safe_dump(data), encoding="utf-8")
    orch = Orchestrator(project, echo=lambda _: None)
    orch.run()
    assert orch.statuses()["calc.lineTotal"] == "escalated"
    assert "calc.total" in (project / "runs" / "t" / "state" / "escalations.md").read_text(encoding="utf-8")


def test_tests_in_workspace_rules(tmp_path):
    project = make_ts_project(tmp_path)
    contracts = project / "spec" / "contracts" / "calc.yaml"
    data = yaml.safe_load(contracts.read_text(encoding="utf-8"))
    data["units"][1]["tests"] = ["checks/lineTotal.test.mts"]
    contracts.write_text(yaml.safe_dump(data), encoding="utf-8")
    (project / "checks").mkdir()
    (project / "checks" / "lineTotal.test.mts").write_text("// x\n", encoding="utf-8")
    (project / "spec" / "scaffold" / "test").mkdir(parents=True)
    (project / "spec" / "scaffold" / "test" / "total.test.mts").write_text("// x\n", encoding="utf-8")
    errors = Orchestrator(project, echo=lambda _: None).validate().errors
    assert any("must be inside tests/" in e for e in errors)
    assert any("would be copied over spec/scaffold/test/total.test.mts" in e for e in errors)
    loaded = load_project(project)
    assert loaded.workspace_test_path("tests/test/a.mts") == "test/a.mts"
    assert loaded.workspace_test_path("other/a.mts") is None


def test_python_declarations_must_be_provided(example_project):
    path = example_project / "spec" / "contracts" / "models.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    data["units"].append({"id": "models.LIMIT", "target": "src/textstats/models.py::LIMIT",
                          "signature": "LIMIT: int", "description": "A limit."})
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    project = load_project(example_project)
    assert project.units["models.LIMIT"].kind == "declaration"
    errors = Orchestrator(example_project, "harness.mock.yaml", echo=lambda _: None).validate().errors
    assert any("must be `provided`" in e for e in errors)
    data["units"][-1].update(type="provided", code="LIMIT: int = 3")
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    assert not Orchestrator(example_project, "harness.mock.yaml", echo=lambda _: None).validate().errors


def test_missing_typescript_is_a_clear_error(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_TYPESCRIPT", str(tmp_path / "nowhere"))
    adapter = TypeScriptAdapter(tmp_path)
    with pytest.raises(HarnessError, match="HARNESS_TYPESCRIPT is set to"):
        adapter.builtins()
    adapter._helper.close()


def test_unparsable_signature_is_a_spec_error(ts):
    with pytest.raises(SpecError, match="cannot parse the signature"):
        ts.infer_kind("export function (", "x")
