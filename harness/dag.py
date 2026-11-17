"""Dependency graph over units: ordering, readiness, and blocking."""

from __future__ import annotations

import heapq
from typing import TYPE_CHECKING, Iterable

from .errors import SpecError

if TYPE_CHECKING:
    from .spec import Unit

DONE = frozenset({"done", "provided"})


def _deps(units: dict[str, Unit], uid: str) -> list[str]:
    return sorted(d for d in units[uid].deps if d in units)


def find_cycle(units: dict[str, Unit]) -> list[str] | None:
    """Return one dependency cycle as a path (first node repeated at the end), or None."""
    state: dict[str, int] = {}  # 1 = on the current path, 2 = finished
    for start in sorted(units):
        if start in state:
            continue
        path = [start]
        stack = [iter(_deps(units, start))]
        state[start] = 1
        while stack:
            nxt = next(stack[-1], None)
            if nxt is None:
                state[path.pop()] = 2
                stack.pop()
            elif state.get(nxt) == 1:
                return path[path.index(nxt):] + [nxt]
            elif nxt not in state:
                state[nxt] = 1
                path.append(nxt)
                stack.append(iter(_deps(units, nxt)))
    return None


def topo_order(units: dict[str, Unit]) -> list[str]:
    """Dependencies first; ties broken by id so the order is deterministic."""
    indegree = {uid: 0 for uid in units}
    dependents: dict[str, list[str]] = {uid: [] for uid in units}
    for uid in units:
        for dep in _deps(units, uid):
            indegree[uid] += 1
            dependents[dep].append(uid)
    heap = [uid for uid, n in indegree.items() if n == 0]
    heapq.heapify(heap)
    order = []
    while heap:
        uid = heapq.heappop(heap)
        order.append(uid)
        for dependent in dependents[uid]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                heapq.heappush(heap, dependent)
    if len(order) != len(units):
        cycle = find_cycle(units) or sorted(set(units) - set(order))
        raise SpecError("Dependency cycle: " + " -> ".join(cycle))
    return order


def levels(units: dict[str, Unit]) -> dict[str, int]:
    """0 for units without dependencies, otherwise 1 + the deepest dependency."""
    result: dict[str, int] = {}
    for uid in topo_order(units):
        result[uid] = 1 + max((result[d] for d in _deps(units, uid)), default=-1)
    return result


def closure(units: dict[str, Unit], roots: Iterable[str]) -> set[str]:
    """The roots and everything they depend on, directly or not."""
    seen: set[str] = set()
    stack = [uid for uid in roots if uid in units]
    while stack:
        uid = stack.pop()
        if uid not in seen:
            seen.add(uid)
            stack.extend(_deps(units, uid))
    return seen


def dependents(units: dict[str, Unit], uid: str) -> set[str]:
    """Units that depend on `uid`, directly or not."""
    reverse: dict[str, list[str]] = {u: [] for u in units}
    for u in units:
        for dep in _deps(units, u):
            reverse[dep].append(u)
    seen: set[str] = set()
    stack = list(reverse.get(uid, []))
    while stack:
        current = stack.pop()
        if current not in seen:
            seen.add(current)
            stack.extend(reverse[current])
    return seen


def ready(units: dict[str, Unit], statuses: dict[str, str]) -> list[str]:
    """Pending units whose dependencies, direct and indirect, are all finished; shallowest first.

    Checking only direct dependencies is not enough: after a reset, a finished unit
    can sit on top of an unfinished one, and its code would call a stub.
    """
    depth = levels(units)
    found = [
        uid for uid in units
        if statuses.get(uid, "pending") == "pending"
        and all(statuses.get(d) in DONE for d in closure(units, [uid]) - {uid})
    ]
    return sorted(found, key=lambda uid: (depth[uid], uid))


def blocked(units: dict[str, Unit], statuses: dict[str, str]) -> set[str]:
    """Unfinished units that cannot run because something they depend on, directly or not, escalated."""
    return {
        uid for uid in units
        if statuses.get(uid, "pending") not in DONE | {"escalated"}
        and any(statuses.get(d) == "escalated" for d in closure(units, [uid]) - {uid})
    }
