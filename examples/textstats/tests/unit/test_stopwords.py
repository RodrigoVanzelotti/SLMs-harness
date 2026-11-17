from textstats.tokenize import StopWordFilter


def test_filters_ignoring_case_and_keeps_order():
    stop = StopWordFilter(["The", "a"])
    assert stop.filter(["the", "cat", "A", "dog", "THE"]) == ["cat", "dog"]


def test_accepts_any_iterable():
    stop = StopWordFilter(word for word in ["x"])
    assert stop.filter(["x", "y", "X"]) == ["y"]
