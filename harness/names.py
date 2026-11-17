"""Rules for names that become file or folder names (unit ids, milestone ids, run names)."""

from __future__ import annotations

import re

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$")
# Windows treats these as devices, even with an extension ("nul.txt").
_DEVICE_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def name_problem(name: str) -> str | None:
    """Why `name` cannot be used as a file name on every platform, or None if it can."""
    if not NAME_RE.match(name):
        return "may only contain letters, digits, '.', '_' and '-', and must not start with '.' or '-'"
    if name.endswith("."):
        return "must not end with '.'"
    if name.split(".")[0].upper() in _DEVICE_NAMES:
        return "starts with a name Windows reserves for devices (CON, PRN, AUX, NUL, COM1-9, LPT1-9)"
    return None
