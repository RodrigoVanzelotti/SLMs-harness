import pytest

from harness import dag
from harness.errors import SpecError

from conftest import make_unit


def units(*items):
    return {u.id: u for u in items}


def test_topological_order_and_levels():
    graph = units(make_unit("c", uses=["a", "b"]), make_unit("b", uses=["a"]), make_unit("a"), make_unit("d"))
    assert dag.topo_order(graph) == ["a", "b", "c", "d"]
    assert dag.levels(graph) == {"a": 0, "b": 1, "c": 2, "d": 0}


def test_after_counts_as_a_dependency():
    graph = units(make_unit("a", after=["b"]), make_unit("b"))
    assert dag.topo_order(graph) == ["b", "a"]


def test_cycles_are_reported():
    graph = units(make_unit("a", uses=["b"]), make_unit("b", uses=["c"]), make_unit("c", uses=["a"]))
    assert dag.find_cycle(graph) == ["a", "b", "c", "a"]
    with pytest.raises(SpecError, match="a -> b -> c -> a"):
        dag.topo_order(graph)


def test_ready_and_blocked():
    graph = units(make_unit("a"), make_unit("b", uses=["a"]), make_unit("c", uses=["b"]), make_unit("d"))
    assert dag.ready(graph, {}) == ["a", "d"]
    assert dag.ready(graph, {"a": "done", "d": "provided"}) == ["b"]
    assert dag.blocked(graph, {"a": "escalated"}) == {"b", "c"}


def test_ready_and_blocked_look_at_indirect_dependencies():
    # After a reset, `b` can be done while `a` beneath it is not: `c` would call a stub through `b`.
    graph = units(make_unit("a"), make_unit("b", uses=["a"]), make_unit("c", uses=["b"]))
    assert dag.ready(graph, {"a": "pending", "b": "done"}) == ["a"]
    assert dag.blocked(graph, {"a": "escalated", "b": "done"}) == {"c"}
    assert dag.closure(graph, ["c"]) == {"a", "b", "c"}
    assert dag.dependents(graph, "a") == {"b", "c"}
