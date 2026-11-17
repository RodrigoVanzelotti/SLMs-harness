"""Run state: status.json (current truth), log.jsonl (history), escalations.md,
and accepted/ (the code that passed for every finished unit).

The orchestrator is the only writer. Workers (the SLM) never touch these
files; they return text, and the orchestrator records what the checks decided.
The workspace is rebuilt from spec + accepted/ on every sync, so it never has
to be trusted after a crash.
"""

from __future__ import annotations

import json
import os
import socket
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from .errors import HarnessError, LockError


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RunState:
    def __init__(self, run_dir: Path):
        self.run_dir = Path(run_dir)
        self.dir = self.run_dir / "state"
        self.status_path = self.dir / "status.json"
        self.log_path = self.dir / "log.jsonl"
        self.escalations_path = self.dir / "escalations.md"
        self.attempts_dir = self.dir / "attempts"
        self.accepted_dir = self.dir / "accepted"
        self.lock_path = self.dir / ".lock"
        self.data: dict[str, Any] = {"units": {}, "milestones": {}}
        if self.status_path.is_file():
            try:
                self.data = json.loads(self.status_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise HarnessError(
                    f"{self.status_path} is not valid JSON ({exc}). Restore it, or delete the run folder to start over."
                ) from None
            self.data.setdefault("units", {})
            self.data.setdefault("milestones", {})

    # -- units

    def unit(self, uid: str) -> dict[str, Any]:
        return self.data["units"].setdefault(uid, {"status": "pending", "attempts": 0})

    def status(self, uid: str) -> str:
        entry = self.data["units"].get(uid)
        return entry["status"] if entry else "pending"

    def statuses(self, uids: Iterable[str]) -> dict[str, str]:
        return {uid: self.status(uid) for uid in uids}

    def update_unit(self, uid: str, **fields: Any) -> None:
        entry = self.unit(uid)
        entry.update(fields)
        entry["updated_at"] = now_iso()
        self.save()

    # -- milestones

    def milestone(self, mid: str) -> dict[str, Any]:
        return self.data["milestones"].setdefault(mid, {"status": "pending", "repairs": 0, "tried": []})

    def update_milestone(self, mid: str, **fields: Any) -> None:
        entry = self.milestone(mid)
        entry.update(fields)
        entry["updated_at"] = now_iso()
        self.save()

    # -- files

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.status_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8")
        for attempt in range(5):
            try:
                os.replace(tmp, self.status_path)
                return
            except PermissionError:  # Windows: a scanner or reader briefly holds the file
                if attempt == 4:
                    raise
                time.sleep(0.2)

    def log(self, event: str, **fields: Any) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        record = {"ts": now_iso(), "event": event, **fields}
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")

    def events(self) -> list[dict[str, Any]]:
        """All logged events. A line that is still being written (or damaged) is skipped."""
        if not self.log_path.is_file():
            return []
        events = []
        with self.log_path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return events

    # -- accepted code

    def _accepted_path(self, uid: str) -> Path:
        return self.accepted_dir / f"{uid}.txt"

    def save_accepted(self, uid: str, code: str) -> None:
        self.accepted_dir.mkdir(parents=True, exist_ok=True)
        self._accepted_path(uid).write_text(code, encoding="utf-8", newline="\n")

    def load_accepted(self, uid: str) -> str | None:
        path = self._accepted_path(uid)
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def drop_accepted(self, uid: str) -> None:
        self._accepted_path(uid).unlink(missing_ok=True)

    def note_escalation(self, title: str, lines: list[str], error: str = "") -> None:
        """Append a section to escalations.md, the queue a person or the planner reviews."""
        self.dir.mkdir(parents=True, exist_ok=True)
        parts = [f"## {title}", "", f"- time: {now_iso()}", *[f"- {line}" for line in lines]]
        if error:
            parts += ["", "```text", error.strip(), "```"]
        with self.escalations_path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(parts) + "\n\n")

    @contextmanager
    def lock(self) -> Iterator[None]:
        """Only one orchestrator may work on a run at a time.

        A lock left behind by a process that no longer exists on this machine
        (for example after a hard kill) is removed automatically.
        """
        self.dir.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                if not self._lock_is_stale():
                    holder = self.lock_path.read_text(encoding="utf-8", errors="replace").strip()
                    raise LockError(
                        f"This run is locked ({holder}). If no orchestrator is running, delete {self.lock_path}."
                    ) from None
                self.lock_path.unlink(missing_ok=True)
        else:
            raise LockError(f"Could not take the lock {self.lock_path}.")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"pid": os.getpid(), "host": socket.gethostname(), "since": now_iso()}, fh)
        try:
            yield
        finally:
            self.lock_path.unlink(missing_ok=True)

    def _lock_is_stale(self) -> bool:
        try:
            holder = json.loads(self.lock_path.read_text(encoding="utf-8"))
            pid, host = int(holder["pid"]), str(holder["host"])
        except (OSError, ValueError, KeyError, TypeError):
            return False  # unreadable or from another version: leave it to a person
        return host == socket.gethostname() and not _process_exists(pid)


def _process_exists(pid: int) -> bool:
    """Whether a process with this id runs on this machine. Never sends it a signal on Windows."""
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # access denied: it exists, it just isn't ours
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)  # signal 0 only checks that the process exists
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
