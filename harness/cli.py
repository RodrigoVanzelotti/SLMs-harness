"""Command-line interface: python -m harness <command>."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .errors import HarnessError, LLMError
from .init_project import init_project
from .orchestrator import Orchestrator
from .report import render, render_table, summarize
from .spec import load_project
from .state import RunState


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    args = _parser().parse_args(argv)
    try:
        return args.func(args)
    except LLMError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m harness",
        description="Rebuild a project unit by unit with a small language model.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, summary: str, func, project: bool = True) -> argparse.ArgumentParser:
        command = sub.add_parser(name, help=summary, description=summary)
        if project:
            command.add_argument("-p", "--project", default=".", help="project directory (default: .)")
            command.add_argument("-c", "--config", default="harness.yaml",
                                 help="run config, relative to the project (default: harness.yaml)")
            command.add_argument("-r", "--run", default=None,
                                 help="run name; state goes to runs/<name>/ (default: run_name in the config)")
        command.set_defaults(func=func)
        return command

    command = add("init", "Create an empty project skeleton.", cmd_init, project=False)
    command.add_argument("directory")
    add("validate", "Check references, cycles, contracts, test paths, and token budgets.", cmd_validate)
    add("scaffold", "Create or refresh the workspace with a stub for every unit.", cmd_scaffold)
    command = add("run", "Build units with the model until everything is done or blocked.", cmd_run)
    command.add_argument("--unit", action="append", default=None, help="only build this unit (repeatable)")
    command.add_argument("--max-units", type=int, default=None, help="stop after this many units")
    add("status", "Show unit and milestone status.", cmd_status)
    command = add("prompt", "Print the prompt a unit would receive.", cmd_prompt)
    command.add_argument("unit")
    command.add_argument("--fix", action="store_true", help="show the fix prompt with placeholders")
    command = add("reset", "Send units back to pending (logs and attempt files are kept).", cmd_reset)
    command.add_argument("units", nargs="*")
    command.add_argument("--escalated", action="store_true", help="reset every escalated unit and milestone")
    command.add_argument("--all", action="store_true", dest="everything", help="reset everything")
    command = add("report", "Print research metrics for a run.", cmd_report)
    command.add_argument("--all", action="store_true", dest="all_runs", help="compare every run in runs/")
    command.add_argument("--json", action="store_true", help="print JSON")
    return parser


def _orchestrator(args) -> Orchestrator:
    return Orchestrator(Path(args.project), config_file=args.config, run_name=args.run)


def _table(rows: list[list[str]]) -> str:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows)


def cmd_init(args) -> int:
    created = init_project(Path(args.directory))
    print(f"Created a project skeleton in {Path(args.directory).resolve()} ({len(created)} items).")
    print("Next: write contracts in spec/contracts/ and tests in tests/, then run `validate`.")
    return 0


def cmd_validate(args) -> int:
    orch = _orchestrator(args)
    report = orch.validate()
    for warning in report.warnings:
        print(f"warning: {warning}")
    for error in report.errors:
        print(f"error: {error}")
    if report.budgets:
        rows = [["unit", "prompt", "fix (worst)", "output", "limit", "fits"]]
        rows += [[b.unit_id, str(b.prompt_tokens), str(b.fix_prompt_tokens), str(b.output_tokens),
                  str(b.limit), "yes" if b.ok else "NO"] for b in report.budgets]
        print("\nEstimated tokens per unit:\n" + _table(rows))
    units = len(orch.project.units)
    print(f"\n{units} unit(s), {len(orch.project.milestones)} milestone(s): "
          f"{len(report.errors)} error(s), {len(report.warnings)} warning(s).")
    return 1 if report.errors else 0


def cmd_scaffold(args) -> int:
    orch = _orchestrator(args)
    orch.require_valid()
    with orch.state.lock():
        orch.sync()
    print(f"Workspace ready: {orch.workspace.root}")
    return 0


def cmd_run(args) -> int:
    return _orchestrator(args).run(only=args.unit, max_units=args.max_units)


def cmd_status(args) -> int:
    orch = _orchestrator(args)
    rows = [["level", "unit", "kind", "type", "status", "attempts", "note"]]
    rows += [[str(level), uid, kind, utype, status, attempts, note]
             for uid, kind, utype, status, attempts, level, note in orch.status_rows()]
    print(_table(rows))
    if orch.project.milestones:
        print("\nMilestones:")
        for mid, milestone in orch.project.milestones.items():
            entry = orch.state.milestone(mid)
            print(f"  {mid}: {entry['status']} (after {', '.join(milestone.after) or '-'}; "
                  f"repairs {entry.get('repairs', 0)})")
    print("\n" + orch.summary_line())
    if orch.state.escalations_path.is_file():
        print(f"Escalations: {orch.state.escalations_path}")
    return 0


def cmd_prompt(args) -> int:
    orch = _orchestrator(args)
    unit = orch.project.units.get(args.unit)
    if unit is None:
        raise HarnessError(f"Unknown unit `{args.unit}`.")
    if unit.type == "provided":
        print(f"`{unit.id}` is provided by the spec; the model never sees a prompt for it.")
        return 0
    if args.fix:
        messages = orch.prompts.build(unit, "fix", "<previous code>", "<error message>")
    else:
        messages = orch.prompts.build(unit)
    for message in messages:
        print(f"===== {message['role']} =====\n{message['content']}\n")
    budget = orch.prompts.budget(unit)
    print(f"~{orch.prompts.estimate(messages)} tokens now; worst-case fix prompt ~{budget.fix_prompt_tokens} "
          f"+ {budget.output_tokens} output; limit {budget.limit}.")
    return 0


def cmd_reset(args) -> int:
    if not (args.units or args.escalated or args.everything):
        raise HarnessError("Name units to reset, or use --escalated or --all.")
    reset = _orchestrator(args).reset(args.units, escalated=args.escalated, everything=args.everything)
    print(f"Reset {len(reset)} unit(s): {', '.join(reset) or '-'}")
    return 0


def cmd_report(args) -> int:
    if args.all_runs:
        root = Path(args.project).resolve()
        project = load_project(root)
        runs_dir = root / "runs"
        summaries = [
            summarize(project, RunState(run_dir), run_dir.name)
            for run_dir in sorted(runs_dir.iterdir()) if (run_dir / "state" / "status.json").is_file()
        ] if runs_dir.is_dir() else []
        if not summaries:
            print("No runs found.")
            return 0
        print(json.dumps(summaries, indent=2) if args.json else render_table(summaries))
        return 0
    orch = _orchestrator(args)
    summary = summarize(orch.project, orch.state, orch.run_name)
    print(json.dumps(summary, indent=2) if args.json else render(summary))
    return 0
