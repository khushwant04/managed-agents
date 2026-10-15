from __future__ import annotations

import json
import time

import httpx
import pytest

from runhive.tools.executor import ToolExecutionError
from runhive.tools.webhook import EgressPolicy, WebhookCaller, sign, verify

SECRET = "whsec_test"
URL = "https://tools.example.com/hook"


def test_sign_and_verify():
    body = b'{"tool":"x"}'
    now = 1_760_000_000
    header = sign(SECRET, body, now)
    assert header.startswith(f"t={now},v1=") and len(header.split("v1=")[1]) == 64
    assert verify(SECRET, header, body, now=now + 10)
    assert verify(SECRET.encode(), header, body, now=now)
    assert not verify(SECRET, header, body + b" ", now=now)  # tampered body
    assert not verify("other", header, body, now=now)  # wrong secret
    assert not verify(SECRET, header, body, now=now + 301)  # stale
    assert not verify(SECRET, header, body, now=now - 301)
    assert not verify(SECRET, "garbage", body, now=now)
    assert not verify(SECRET, "t=abc,v1=00", body, now=now)
    rotated = f"{header},v1={sign('old', body, now).split('v1=')[1]}"
    assert verify("old", rotated, body, now=now) and verify(SECRET, rotated, body, now=now)


class Receiver:
    """A webhook receiver that verifies signatures and plays back responses."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert verify(SECRET, request.headers["x-runhive-signature"], request.content, now=time.time())
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def caller(receiver: Receiver, **kw) -> WebhookCaller:
    http = httpx.AsyncClient(transport=httpx.MockTransport(receiver))
    return WebhookCaller(SECRET, client=http, backoff_s=0, **kw)


async def call(c: WebhookCaller, **kw) -> str:
    return await c.call(
        URL,
        tool="lookup",
        arguments={"id": 7},
        idempotency_key="run_1:tool:c1",
        session_id="ses_1",
        run_id="run_1",
        call_id="c1",
        **kw,
    )


async def test_payload_headers_and_result():
    rx = Receiver(httpx.Response(200, json={"result": {"rows": [1, 2]}}))
    out = await call(caller(rx), headers={"Authorization": "Bearer s3cret"})
    assert json.loads(out) == {"rows": [1, 2]}
    (req,) = rx.requests
    assert json.loads(req.content) == {"tool": "lookup", "arguments": {"id": 7}, "call_id": "c1", "session_id": "ses_1", "run_id": "run_1"}
    assert req.headers["idempotency-key"] == "run_1:tool:c1"
    assert req.headers["content-type"] == "application/json"
    assert req.headers["authorization"] == "Bearer s3cret"


async def test_result_shapes():
    assert await call(caller(Receiver(httpx.Response(200, json={"result": "plain"})))) == "plain"
    assert await call(caller(Receiver(httpx.Response(200, text="just text")))) == "just text"
    assert await call(caller(Receiver(httpx.Response(200, json=[1, 2])))) == "[1,2]"  # not an envelope: body as is
    with pytest.raises(ToolExecutionError, match="no such id"):
        await call(caller(Receiver(httpx.Response(200, json={"error": "no such id"}))))
    with pytest.raises(ToolExecutionError, match="bad"):
        await call(caller(Receiver(httpx.Response(200, json={"error": {"message": "bad"}}))))


async def test_retries_with_same_idempotency_key():
    rx = Receiver(
        httpx.ConnectError("refused"),
        httpx.Response(503, text="busy"),
        httpx.Response(429, text="slow down"),
        httpx.Response(200, json={"result": "ok"}),
    )
    assert await call(caller(rx, max_attempts=4)) == "ok"
    assert len(rx.requests) == 4
    assert {r.headers["idempotency-key"] for r in rx.requests} == {"run_1:tool:c1"}
    assert len({r.content for r in rx.requests}) == 1


async def test_gives_up_after_max_attempts():
    rx = Receiver(*[httpx.Response(500, text="kaput")] * 3)
    with pytest.raises(ToolExecutionError, match="after 3 attempts.*HTTP 500: kaput"):
        await call(caller(rx))
    assert len(rx.requests) == 3


async def test_client_error_is_not_retried():
    rx = Receiver(httpx.Response(422, text="field 'id' " + "x" * 500), httpx.Response(200, json={"result": "unused"}))
    with pytest.raises(ToolExecutionError, match="HTTP 422: field 'id'") as info:
        await call(caller(rx))
    assert len(rx.requests) == 1
    assert len(str(info.value)) < 300


def test_egress_policy():
    anywhere = EgressPolicy(None)
    anywhere.check("https://a.example.org/x")
    assert not anywhere.allows("file:///etc/passwd") and not anywhere.allows("ftp://example.com")
    policy = EgressPolicy(["api.example.com", "*.tools.example.com"])
    assert policy.allows("https://api.example.com/v1")
    assert policy.allows("http://API.example.com:8080/")
    assert policy.allows("https://a.tools.example.com/") and policy.allows("https://a.b.tools.example.com/")
    assert not policy.allows("https://tools.example.com/")
    assert not policy.allows("https://evil.com/?api.example.com")
    assert not policy.allows("https://api.example.com.evil.com/")
    assert not policy.allows("https://xtools.example.com/")
    with pytest.raises(ToolExecutionError, match="not allowed"):
        policy.check("https://evil.com/")


async def test_egress_policy_blocks_before_sending():
    rx = Receiver(httpx.Response(200, json={"result": "unused"}))
    with pytest.raises(ToolExecutionError, match="not allowed"):
        await call(caller(rx, egress=EgressPolicy(["other.example.com"])))
    assert rx.requests == []
