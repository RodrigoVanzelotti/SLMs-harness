"""Text helpers: token estimates, code extraction from replies, output trimming."""

from __future__ import annotations

import math
import os
import re
import textwrap
from pathlib import Path
from typing import Iterable

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)
_BANNER_RE = re.compile(r"^[=_!]{3,}\s*(.*?)\s*[=_!]{3,}$")
_RULE_RE = re.compile(r"^[=_\-!]{3,}$")


def estimate_tokens(text: str, chars_per_token: float) -> int:
    return math.ceil(len(text) / chars_per_token) if text else 0


def strip_reasoning(text: str) -> str:
    """Drop <think>...</think> sections that reasoning models put before the answer."""
    text = _THINK_RE.sub("", text)
    lowered = text.lower()
    if "</think>" in lowered:  # opening tag was part of the chat template
        text = text[lowered.rindex("</think>") + len("</think>"):]
        lowered = text.lower()
    if "<think>" in lowered:  # never closed: the reply ran out while reasoning
        text = text[: lowered.index("<think>")]
    return text


def split_lines(text: str) -> list[str]:
    """Split on newlines only. str.splitlines() also splits on form feeds, \\u2028 and other
    characters that can appear inside string literals, which would change the code."""
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def code_blocks(text: str) -> list[tuple[str, str]]:
    """Fenced blocks as (language, code). An unterminated last fence runs to the end.

    A block closes at a bare ``` line indented no deeper than its opening fence, so
    a fence inside the code (for example in a docstring) does not end it early.
    """
    blocks: list[tuple[str, str]] = []
    language: str | None = None
    indent = 0
    buffer: list[str] = []
    for line in split_lines(text):
        stripped = line.strip()
        depth = len(line) - len(line.lstrip())
        if language is None:
            if stripped.startswith("```"):
                language, indent, buffer = stripped[3:].strip().lower(), depth, []
            continue
        if stripped == "```" and depth <= indent:
            blocks.append((language, "\n".join(buffer)))
            language = None
            continue
        buffer.append(line)
    if language is not None and buffer:
        blocks.append((language, "\n".join(buffer)))
    return blocks


def extract_code(text: str, prefer: re.Pattern[str] | None = None) -> str | None:
    """Pick the code from a model reply.

    Prefers the last fenced block matching `prefer` (usually "defines the target"),
    then the largest block. A reply without fences counts as code only if it
    matches `prefer` (or when there is nothing to prefer, e.g. data files).
    """
    text = strip_reasoning(text)
    blocks = [textwrap.dedent(code).strip("\n") for _, code in code_blocks(text)]
    blocks = [block for block in blocks if block.strip()]
    if not blocks:
        bare = text.strip()
        if not bare or (prefer is not None and not prefer.search(bare)):
            return None
        return bare
    if prefer is not None:
        matching = [block for block in blocks if prefer.search(block)]
        if matching:
            return matching[-1]
    return max(blocks, key=len)


def _strip_path(text: str, path: Path) -> str:
    flags = re.I if os.name == "nt" else 0
    for variant in {str(path), str(path).replace("\\", "/")}:
        text = re.sub(re.escape(variant) + r"[\\/]?", "", text, flags=flags)
    return text


def clean_output(text: str, strip_paths: Iterable[Path] = ()) -> str:
    """Remove colors, long path prefixes, and banner lines from tool output."""
    text = _ANSI_RE.sub("", text)
    for path in sorted(strip_paths, key=lambda p: len(str(p)), reverse=True):
        text = _strip_path(text, Path(path))
    lines: list[str] = []
    for line in text.splitlines():
        line = line.rstrip()
        if _RULE_RE.match(line.strip()):
            continue
        banner = _BANNER_RE.match(line.strip())
        if banner:
            line = banner.group(1)
        if not line and (not lines or not lines[-1]):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def trim_output(text: str, max_tokens: int, chars_per_token: float, strip_paths: Iterable[Path] = ()) -> str:
    """Clean tool output and keep its end (where errors and summaries are) within budget."""
    cleaned = clean_output(text, strip_paths)
    limit = max(200, int(max_tokens * chars_per_token))
    if len(cleaned) <= limit:
        return cleaned
    tail = cleaned[-limit:]
    newline = tail.find("\n")
    if 0 <= newline < 200:
        tail = tail[newline + 1:]
    return "[... earlier output trimmed ...]\n" + tail
