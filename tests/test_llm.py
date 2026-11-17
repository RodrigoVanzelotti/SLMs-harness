"""The OpenAI-compatible client against a local fake server."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from harness.config import ModelConfig
from harness.errors import LLMError
from harness.llm import OpenAICompatibleClient


class FakeServer:
    def __init__(self, statuses: list[int], content: object = "```python\nx = 1\n```"):
        self.statuses = list(statuses)  # one HTTP status per request; the last one repeats
        self.content = content
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 (http.server API)
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"path": self.path, "body": body, "auth": self.headers.get("Authorization")})
                status = outer.statuses.pop(0) if len(outer.statuses) > 1 else outer.statuses[0]
                payload = {
                    "choices": [{"message": {"content": outer.content}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7},
                } if status == 200 else {"error": "busy"}
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server(request):
    fake = FakeServer(getattr(request, "param", [200]))
    yield fake
    fake.close()


def test_sends_a_chat_completion_and_reads_usage(server, monkeypatch):
    monkeypatch.setenv("TEST_SLM_KEY", "test-value")
    cfg = ModelConfig(base_url=server.url, model="tiny", api_key_env="TEST_SLM_KEY", extra_body={"top_p": 0.9})
    completion = OpenAICompatibleClient(cfg).complete(
        [{"role": "user", "content": "hi"}], temperature=0.3, max_tokens=64
    )
    assert completion.text == "```python\nx = 1\n```"
    assert (completion.prompt_tokens, completion.completion_tokens, completion.finish_reason) == (11, 7, "stop")
    sent = server.requests[0]
    assert sent["path"] == "/v1/chat/completions" and sent["auth"] == "Bearer test-value"
    assert sent["body"] == {
        "model": "tiny", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.3,
        "max_tokens": 64, "stream": False, "top_p": 0.9,
    }


@pytest.mark.parametrize("server", [[503, 200]], indirect=True)
def test_retries_transient_errors(server, monkeypatch):
    monkeypatch.setattr("harness.llm.time.sleep", lambda _: None)
    client = OpenAICompatibleClient(ModelConfig(base_url=server.url, model="tiny"))
    assert client.complete([], temperature=0, max_tokens=8).text
    assert len(server.requests) == 2


@pytest.mark.parametrize("server", [[400]], indirect=True)
def test_client_errors_are_not_retried(server):
    client = OpenAICompatibleClient(ModelConfig(base_url=server.url, model="tiny"))
    with pytest.raises(LLMError, match="HTTP 400"):
        client.complete([], temperature=0, max_tokens=8)
    assert len(server.requests) == 1


def test_content_given_as_parts_is_joined():
    fake = FakeServer([200], content=[{"type": "text", "text": "a"}, {"type": "text", "text": "b"}, "junk"])
    try:
        client = OpenAICompatibleClient(ModelConfig(base_url=fake.url, model="tiny"))
        assert client.complete([], temperature=0, max_tokens=8).text == "ab"
    finally:
        fake.close()


def test_unreachable_server_raises_llm_error():
    client = OpenAICompatibleClient(ModelConfig(base_url="http://127.0.0.1:9/v1", model="tiny", timeout_s=2), retries=1)
    with pytest.raises(LLMError, match="Could not reach"):
        client.complete([], temperature=0, max_tokens=8)
