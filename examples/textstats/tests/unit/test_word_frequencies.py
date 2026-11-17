from textstats.analyze import word_frequencies


def test_counts():
    assert word_frequencies(["a", "b", "a"]) == {"a": 2, "b": 1}


def test_case_sensitive():
    assert word_frequencies(["A", "a"]) == {"A": 1, "a": 1}


def test_empty():
    assert word_frequencies([]) == {}
