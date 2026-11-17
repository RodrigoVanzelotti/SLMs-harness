import json
import subprocess
import sys


def test_module_entry_point_with_stop_words(tmp_path):
    path = tmp_path / "in.txt"
    path.write_text("The cat and the hat. The end!", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "textstats", str(path), "--top", "2", "--stop-words", "the", "and"],
        capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == {"total_words": 3, "unique_words": 3, "top_words": [["cat", 1], ["end", 1]]}
