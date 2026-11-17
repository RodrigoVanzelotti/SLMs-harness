import json

from textstats.cli import main


def test_prints_json(tmp_path, capsys):
    path = tmp_path / "in.txt"
    path.write_text("b a b", encoding="utf-8")
    assert main([str(path), "--top", "1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"total_words": 3, "unique_words": 2, "top_words": [["b", 2]]}


def test_missing_file(tmp_path, capsys):
    assert main([str(tmp_path / "missing.txt")]) == 1
    assert "error: file not found" in capsys.readouterr().err
