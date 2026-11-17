from pathlib import Path

import pytest

from harness.constants import STUB_MARK
from harness.errors import SpecError
from harness.lang.python import PythonAdapter

from conftest import make_unit

PY = PythonAdapter()
CLASS_SIGNATURE = """
class Box:
    def __init__(self, size: int) -> None: ...
    @property
    def size(self) -> int: ...
"""


def test_function_stub_compiles_and_raises_the_mark():
    unit = make_unit("m.f", signature="def f(x: int, y: str = 'a') -> int")
    stub = PY.render_stub(unit)
    assert stub.startswith("def f(x: int, y: str='a') -> int:")
    namespace: dict = {}
    exec(stub, namespace)
    with pytest.raises(NotImplementedError, match=f"{STUB_MARK} m.f"):
        namespace["f"](1)


def test_class_stub_keeps_fields_and_stubs_methods():
    unit = make_unit("m.Box", name="Box", kind="class", signature=CLASS_SIGNATURE)
    stub = PY.render_stub(unit)
    assert "@property" in stub and stub.count("raise NotImplementedError") == 2
    dataclass_unit = make_unit("m.P", name="P", kind="class", signature="class P:\n    x: int\n    y: int")
    assert PY.render_stub(dataclass_unit) == "class P:\n    x: int\n    y: int"


def test_signature_check_accepts_matching_code():
    unit = make_unit("m.f", signature="def f(x: int, y: str = 'a') -> int")
    errors, warnings = PY.signature_check("def f(x: int, y: str = \"a\") -> int:\n    return x", unit, False)
    assert errors == [] and warnings == []


def test_signature_check_reports_parameter_and_default_mismatches():
    unit = make_unit("m.f", signature="def f(x: int, y: str = 'a') -> int")
    errors, _ = PY.signature_check("def f(x, z='a'):\n    return x", unit, False)
    assert "must take (x: int, y: str='a')" in errors[0]
    errors, _ = PY.signature_check("def f(x: int, y: str = 'b') -> int:\n    return x", unit, False)
    assert errors == ["Parameter `y` of `f` must default to `'a'`."]
    errors, _ = PY.signature_check("def g(x):\n    return x", unit, False)
    assert "must define `f` at the top level" in errors[0]


def test_annotation_mismatch_is_a_warning_unless_strict():
    unit = make_unit("m.f", signature="def f(x: list[int]) -> int")
    code = "from typing import List\ndef f(x: List[int]) -> int:\n    return 0"
    errors, warnings = PY.signature_check(code, unit, False)
    assert errors == [] and len(warnings) == 1
    errors, _ = PY.signature_check(code, unit, True)
    assert len(errors) == 1


def test_class_check_finds_missing_methods_and_decorators():
    unit = make_unit("m.Box", name="Box", kind="class", signature=CLASS_SIGNATURE)
    code = "class Box:\n    def __init__(self, size: int) -> None:\n        self._s = size\n    def size(self) -> int:\n        return 1"
    errors, _ = PY.signature_check(code, unit, False)
    assert errors == ["`Box.size` must keep the decorator(s): @property."]
    errors, _ = PY.signature_check("class Box:\n    pass", unit, False)
    assert len(errors) == 2


def test_sanitize_removes_noise_and_redefinitions_but_keeps_helpers():
    unit = make_unit("m.f")
    code = (
        "from __future__ import annotations\n"
        "import re\n\n"
        "class Stats:\n    pass\n\n"
        "def _helper(x):\n    return x\n\n"
        "def f(x: int) -> int:\n    return _helper(x)\n\n"
        "assert f(1) == 1\n"
        "print(f(2))\n"
        "if __name__ == '__main__':\n    f(3)\n"
    )
    cleaned, notes = PY.sanitize(code, unit, reserved={"Stats"})
    assert cleaned == "import re\n\n\ndef _helper(x):\n    return x\n\ndef f(x: int) -> int:\n    return _helper(x)"
    assert len(notes) == 5


def test_sanitize_keeps_string_literals_intact():
    unit = make_unit("m.f")
    code = 'def f(x: int) -> int:\n    s = "a\x0cb"\n    t = """x\n\n\n\ny"""\n    return x\n\nprint(1)\n'
    cleaned, notes = PY.sanitize(code, unit, reserved=set())
    assert notes == ["removed the top-level statement `print(1)`"]
    assert '"a\x0cb"' in cleaned and '"""x\n\n\n\ny"""' in cleaned
    assert PY.syntax_error(cleaned) is None


def test_defined_names_ignores_imports_and_subscripts():
    code = "import os\nA = 1\nb, (c, *d) = 1, (2, 3)\nx[0] = 1\ndef f(): pass\nclass K: pass"
    assert PY.defined_names(code) == {"A", "b", "c", "d", "f", "K"}


def test_import_policy():
    allowed, internal = {"numpy"}, {"textstats"}
    ok = "import json\nimport numpy as np\nfrom textstats.models import Stats\nfrom .x import y\n"
    assert PY.import_errors(ok, True, allowed, internal) == []
    errors = PY.import_errors("def f():\n    import requests\n", True, allowed, internal)
    assert "`requests`" in errors[0] and "the Python standard library" in errors[0]
    assert PY.import_errors("import json", False, set(), set()) != []


def test_header_rendering_and_names():
    imports = ["import re", "from __future__ import annotations", "import re", "from a.b import C as D, E"]
    assert PY.render_header(imports) == "from __future__ import annotations\nimport re\nfrom a.b import C as D, E"
    assert PY.header_names(imports) == {"annotations", "re", "D", "E"}


def test_locate_reads_both_traceback_styles(tmp_path: Path):
    output = (
        "src\\pkg\\mod.py:12: in f\n"
        '  File "C:\\work\\pkg\\other.py", line 7, in g\n'
        "E   AssertionError"
    )
    frames = PY.locate(output, tmp_path)
    assert frames[0] == (tmp_path / "src\\pkg\\mod.py", 12)
    assert frames[1][1] == 7 and str(frames[1][0]).endswith("other.py")


def test_contract_errors():
    with pytest.raises(SpecError):
        PY.infer_kind("def broken(:", "here")
    unit = make_unit("m.f", signature="def g(x)")
    assert "target name is `f`" in PY.check_contract(unit)[0]
    unit = make_unit("m.f", imports=["x = 1"])
    assert "one import statement" in PY.check_contract(unit)[0]
