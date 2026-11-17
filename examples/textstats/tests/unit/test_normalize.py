from textstats.tokenize import normalize


def test_lowercases_and_replaces_punctuation():
    assert normalize("Hello, World!") == "hello  world "


def test_keeps_digits_and_apostrophes():
    assert normalize("It's 42_x") == "it's 42 x"


def test_empty():
    assert normalize("") == ""
