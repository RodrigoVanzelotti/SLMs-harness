"""Research metrics for a run, computed from status.json and log.jsonl."""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING, Any

from . import dag

if TYPE_CHECKING:
    from .spec import Project
    from .state import RunState


def summarize(project: Project, state: RunState, run_name: str) -> dict[str, Any]:
    units = project.units
    statuses = state.statuses(units)
    blocked = dag.blocked(units, statuses)
    entries = state.data["units"]
    built = [uid for uid, unit in units.items() if unit.type != "provided"]
    done = [uid for uid in built if statuses[uid] == "done"]
    escalated = [uid for uid in built if statuses[uid] == "escalated"]
    pending = [uid for uid in built if uid not in blocked and statuses[uid] not in ("done", "escalated")]

    events = state.events()
    # First-try metrics use each unit's FIRST round only, so a unit that escalated, was reset,
    # and then passed is not counted as a first-attempt success.
    first_outcome: dict[str, dict[str, Any]] = {}
    first_pass: dict[str, dict[str, Any]] = {}
    for event in events:
        uid = event.get("unit")
        if uid is None or uid in first_outcome:
            continue
        if event["event"] == "candidate" and event.get("ok") and event.get("mode") == "implement":
            first_pass.setdefault(uid, event)
        elif event["event"] in ("unit_done", "unit_escalated"):
            first_outcome[uid] = event
    first_attempt = [
        uid for uid in built
        if first_outcome.get(uid, {}).get("event") == "unit_done" and first_outcome[uid].get("attempts") == 1
    ]
    first_sample = [uid for uid in first_attempt if first_pass.get(uid, {}).get("sample") == 1]
    starts = [e for e in events if e["event"] == "run_start"]
    calls = [e for e in events if e["event"] == "llm_call"]
    candidates = [e for e in events if e["event"] == "candidate"]
    passed = [m for m in project.milestones if state.data["milestones"].get(m, {}).get("status") == "done"]

    def share(count: int) -> float:
        return round(count / len(built), 3) if built else 0.0

    def mean(values: list[float]) -> float:
        return round(sum(values) / len(values), 2) if values else 0.0

    prompt_tokens = sum(e.get("prompt_tokens") or 0 for e in calls)
    completion_tokens = sum(e.get("completion_tokens") or 0 for e in calls)
    return {
        "run": run_name,
        "backend": starts[-1].get("backend") if starts else None,
        "model": starts[-1].get("model") if starts else None,
        "units_built_by_model": len(built),
        "units_provided": len(units) - len(built),
        "done": len(done),
        "escalated": len(escalated),
        "blocked": len([uid for uid in built if uid in blocked]),
        "pending": len(pending),
        "pass_rate": share(len(done)),
        "pass_rate_first_attempt": share(len(first_attempt)),
        "pass_rate_first_sample": share(len(first_sample)),
        "mean_attempts_when_done": mean([entries[uid].get("attempts", 0) for uid in done]),
        "mean_samples_when_done": mean([entries[uid].get("samples", 0) for uid in done]),
        "milestones_passed": len(passed),
        "milestones_total": len(project.milestones),
        "repairs_succeeded": sum(e["event"] == "unit_repaired" for e in events),
        "repairs_failed": sum(e["event"] == "repair_failed" for e in events),
        "llm_calls": len(calls),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tokens_per_done_unit": round((prompt_tokens + completion_tokens) / len(done)) if done else 0,
        "max_prompt_tokens": max((e.get("prompt_tokens") or 0 for e in calls), default=0),
        "token_counts_estimated": any(e.get("estimated") for e in calls),
        "llm_seconds": round(sum(e.get("latency_s") or 0 for e in calls), 1),
        "wall_seconds": round(sum(e.get("duration_s") or 0 for e in events if e["event"] == "run_end"), 1),
        "candidate_failures_by_stage": dict(Counter(e["stage"] for e in candidates if not e.get("ok"))),
        "sanitize_repairs": sum(len(e.get("sanitized") or []) for e in candidates),
    }


def render(summary: dict[str, Any]) -> str:
    width = max(len(key) for key in summary)
    lines = []
    for key, value in summary.items():
        if isinstance(value, dict):
            value = ", ".join(f"{k}: {v}" for k, v in sorted(value.items())) or "-"
        lines.append(f"{key.ljust(width)}  {value}")
    return "\n".join(lines)


def render_table(summaries: list[dict[str, Any]]) -> str:
    columns = [
        ("run", "run"), ("model", "model"), ("done", "done"), ("built", "units_built_by_model"),
        ("pass", "pass_rate"), ("pass@1", "pass_rate_first_attempt"), ("esc", "escalated"),
        ("blocked", "blocked"), ("miles", "milestones_passed"), ("calls", "llm_calls"),
        ("tok_in", "prompt_tokens"), ("tok_out", "completion_tokens"), ("wall_s", "wall_seconds"),
    ]
    rows = [[title for title, _ in columns]]
    rows += [[str(s.get(key, "")) for _, key in columns] for s in summaries]
    widths = [max(len(row[i]) for row in rows) for i in range(len(columns))]
    return "\n".join("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)) for row in rows)
