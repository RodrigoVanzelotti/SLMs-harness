from textstats.tokenize import tokenize


def test_splits_and_strips_apostrophes():
    assert tokenize("It's a 'test', isn't it?") == ["it's", "a", "test", "isn't", "it"]


def test_drops_words_that_become_empty():
    assert tokenize(" ' -- '' ") == []
