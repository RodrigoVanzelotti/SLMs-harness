from pathlib import Path

from harness.lang.python import PythonAdapter
from harness.text import clean_output, extract_code, strip_reasoning, trim_output

PREFER = PythonAdapter().definition_pattern("add")


def test_prefers_the_block_that_defines_the_target():
    reply = (
        "Here it is:\n```python\ndef add(a, b):\n    return a + b\n```\n"
        "Usage:\n```python\nprint(add(1, 2))\n```"
    )
    assert extract_code(reply, PREFER) == "def add(a, b):\n    return a + b"


def test_takes_the_last_matching_block():
    reply = "```python\ndef add(a, b):\n    return 0\n```\nCorrected:\n```python\ndef add(a, b):\n    return a + b\n```"
    assert extract_code(reply, PREFER).endswith("return a + b")


def test_unterminated_fence_runs_to_the_end():
    assert extract_code("```python\ndef add(a, b):\n    return a + b", PREFER) == "def add(a, b):\n    return a + b"


def test_indented_fence_is_dedented():
    reply = "1. Code:\n   ```python\n   def add(a, b):\n       return a + b\n   ```"
    assert extract_code(reply, PREFER) == "def add(a, b):\n    return a + b"


def test_fence_inside_a_docstring_does_not_end_the_block():
    reply = '```python\ndef add(a, b):\n    """Add.\n\n    ```\n    add(1, 2)\n    ```\n    """\n    return a + b\n```'
    assert extract_code(reply, PREFER).endswith("return a + b")


def test_form_feed_inside_code_is_kept():
    assert extract_code('```python\ndef add(a, b):\n    s = "x\x0cy"\n    return a + b\n```', PREFER).count("\n") == 2


def test_bare_reply_counts_only_if_it_defines_the_target():
    assert extract_code("def add(a, b):\n    return a + b", PREFER) is not None
    assert extract_code("I cannot help with that.", PREFER) is None
    assert extract_code('{"a": 1}', None) == '{"a": 1}'


def test_reasoning_is_removed():
    assert strip_reasoning("<think>plan</think>answer") == "answer"
    assert strip_reasoning("plan only</think>answer") == "answer"
    assert strip_reasoning("answer<think>never closed") == "answer"
    assert extract_code("<think>```python\ndef add(): pass\n```</think>no code", PREFER) is None


def test_clean_output_removes_banners_and_paths(tmp_path: Path):
    raw = (
        f"===== FAILURES =====\n____ test_x ____\n{tmp_path}\\src\\m.py:3: in f\n"
        "!!!!! stopping after 1 failures !!!!!\n\n\nE   boom"
    )
    cleaned = clean_output(raw, [tmp_path])
    assert cleaned == "FAILURES\ntest_x\nsrc\\m.py:3: in f\nstopping after 1 failures\n\nE   boom"


def test_trim_keeps_the_end():
    text = "\n".join(f"line {i}" for i in range(2000)) + "\nE   the real error"
    trimmed = trim_output(text, max_tokens=100, chars_per_token=3.5)
    assert trimmed.startswith("[... earlier output trimmed ...]")
    assert trimmed.endswith("E   the real error")
    assert len(trimmed) < 450
