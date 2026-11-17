from textstats.analyze import compute_stats
from textstats.models import Stats


def test_basic():
    assert compute_stats("b a b c", top_n=2) == Stats(4, 3, [("b", 2), ("a", 1)])


def test_ties_are_sorted_alphabetically():
    assert compute_stats("c b a").top_words == [("a", 1), ("b", 1), ("c", 1)]


def test_stop_words_are_removed_before_counting():
    stats = compute_stats("The cat and the hat", stop_words=["the", "and"])
    assert stats == Stats(2, 2, [("cat", 1), ("hat", 1)])
