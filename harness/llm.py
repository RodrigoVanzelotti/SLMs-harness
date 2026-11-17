"""Model clients. To the harness the SLM is a pure function: messages in, text out."""

from __future__ import annotations

import http.client
import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlparse

import yaml

from .errors import ConfigError, LLMError

if TYPE_CHECKING:
    from .config import Config, ModelConfig

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_RETRY_STATUS = {408, 429, 500, 502, 503, 504}


@dataclass
class Completion:
    text: str
    finish_reason: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_s: float = 0.0


class Client(Protocol):
    def complete(self, messages: list[dict[str, str]], *, temperature: float, max_tokens: int,
                 tag: str | None = None) -> Completion: ...


class OpenAICompatibleClient:
    """Any server with POST {base_url}/chat/completions: Ollama, llama.cpp, vLLM, LM Studio, and others."""

    def __init__(self, cfg: ModelConfig, retries: int = 3):
        if not cfg.model:
            raise ConfigError("model.model is empty. Set the model name in the run config.")
        self.cfg = cfg
        self.retries = retries
        self.url = cfg.base_url.rstrip("/") + "/chat/completions"
        handlers = []
        if urlparse(self.url).hostname in _LOCAL_HOSTS:
            handlers.append(urllib.request.ProxyHandler({}))  # keep local traffic off any proxy
        self._opener = urllib.request.build_opener(*handlers)
        self._api_key = None
        if cfg.api_key_env:
            self._api_key = os.environ.get(cfg.api_key_env)
            if not self._api_key:
                raise ConfigError(f"The environment variable {cfg.api_key_env} (model.api_key_env) is not set.")

    def complete(self, messages, *, temperature, max_tokens, tag=None) -> Completion:
        body = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
            **self.cfg.extra_body,
        }
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        delay = 2.0
        for attempt in range(1, self.retries + 1):
            started = time.monotonic()
            request = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
            try:
                with self._opener.open(request, timeout=self.cfg.timeout_s) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300]
                if exc.code not in _RETRY_STATUS or attempt == self.retries:
                    raise LLMError(f"The model server returned HTTP {exc.code} for {self.url}: {detail}") from None
            except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                if attempt == self.retries:
                    raise LLMError(f"Could not reach the model server at {self.url}: {exc}") from None
            except ValueError as exc:
                raise LLMError(f"The model server sent a reply that is not JSON: {exc}") from None
            time.sleep(delay)
            delay *= 2
        latency = time.monotonic() - started
        try:
            choice = payload["choices"][0]
            content = (choice.get("message") or {}).get("content")
            if isinstance(content, list):  # content given as parts: [{"type": "text", "text": ...}]
                content = "".join(part.get("text") or "" for part in content if isinstance(part, dict))
            text = content if isinstance(content, str) else ""
        except (KeyError, IndexError, TypeError, AttributeError):
            raise LLMError(f"Unexpected reply from the model server: {str(payload)[:300]}") from None
        usage = payload.get("usage") or {}
        return Completion(
            text=text,
            finish_reason=choice.get("finish_reason"),
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            latency_s=latency,
        )


class MockClient:
    """Replays scripted replies per unit id, for demos and tests. No model needed.

    File format (YAML): {unit_id: [reply, reply, ...], "*": [fallback replies]}.
    Replies are served in order; the last one repeats once the list runs out.
    """

    def __init__(self, path: Path):
        if not path.is_file():
            raise ConfigError(f"Mock responses file not found: {path}")
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            raise ConfigError(f"{path} must map unit ids to replies.")
        self.replies: dict[str, list[str]] = {}
        for key, value in data.items():
            replies = [value] if isinstance(value, str) else value
            if not isinstance(replies, list) or not replies or not all(isinstance(r, str) for r in replies):
                raise ConfigError(f"{path}: `{key}` must be a reply text or a non-empty list of reply texts.")
            self.replies[str(key)] = replies
        self.served: dict[str, int] = {}
        self._lock = threading.Lock()

    def complete(self, messages, *, temperature, max_tokens, tag=None) -> Completion:
        key = tag if tag in self.replies else "*"
        replies = self.replies.get(key) or [""]
        with self._lock:
            index = self.served.get(key, 0)
            self.served[key] = index + 1
        return Completion(text=replies[min(index, len(replies) - 1)], finish_reason="stop")


def make_client(config: Config) -> Client:
    if config.model.backend == "mock":
        if not config.model.mock_responses:
            raise ConfigError("model.mock_responses must be set when model.backend is `mock`.")
        return MockClient((config.base_dir / config.model.mock_responses).resolve())
    return OpenAICompatibleClient(config.model)
