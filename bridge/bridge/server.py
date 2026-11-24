"""The bridge's inbound HTTP surface, reachable only over Tailscale:
POST /v1/assist and POST /v1/approval-answer (both authenticated with
BRIDGE_INBOUND_SECRET) and GET /health. Stdlib http.server only.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

logger = logging.getLogger("bridge.server")

MAX_BODY_BYTES = 16 * 1024
DEFAULT_MAX_SKEW_SECONDS = 300
_APPROVAL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def validate_approval_answer(payload) -> Optional[str]:
    """Body of POST /v1/approval-answer. Returns an error or None."""
    if not isinstance(payload, dict):
        return "body must be a JSON object"
    if not isinstance(payload.get("request_id"), str) or not payload["request_id"]:
        return "request_id must be a non-empty string"
    approval_id = payload.get("approval_id")
    if not isinstance(approval_id, str) or not _APPROVAL_ID_RE.match(approval_id):
        return "approval_id must be 1-64 letters, digits, dashes or underscores"
    if not isinstance(payload.get("approved"), bool):
        return "approved must be true or false"
    return None


def validate_assist_payload(
    payload,
    max_utterance_chars: int,
    now: Optional[datetime] = None,
    max_skew_seconds: float = DEFAULT_MAX_SKEW_SECONDS,
) -> Optional[str]:
    """Returns an error message, or None if the payload is well-formed."""
    if not isinstance(payload, dict):
        return "body must be a JSON object"
    for field in ("request_id", "session_id", "utterance", "created_at"):
        if field not in payload:
            return f"{field} is required"
    if not isinstance(payload["request_id"], str) or not payload["request_id"]:
        return "request_id must be a non-empty string"
    if not isinstance(payload["session_id"], str):
        return "session_id must be a string"
    if not isinstance(payload["utterance"], str) or not payload["utterance"]:
        return "utterance must be a non-empty string"
    if len(payload["utterance"]) > max_utterance_chars:
        return f"utterance exceeds {max_utterance_chars} characters"
    if not isinstance(payload["created_at"], str):
        return "created_at must be an ISO-8601 string"
    try:
        created_dt = datetime.fromisoformat(payload["created_at"].replace("Z", "+00:00"))
    except ValueError:
        return "created_at must be a valid ISO-8601 timestamp"
    if now is not None:
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=timezone.utc)
        skew = abs((now - created_dt).total_seconds())
        if skew > max_skew_seconds:
            return "created_at is too far from the current time"
    return None


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        logger.debug("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        secret = self.server.config.bridge_inbound_secret
        return bool(secret) and self.headers.get("Authorization") == f"Bearer {secret}"

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "pending": self.server.store.size()})
            return
        self._send_json(404, {"error": "not found"})

    def _read_json(self):
        """Returns the parsed body, or None after sending an error response."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "body too large"})
            return None
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "malformed JSON body"})
            return None

    def do_POST(self):
        if self.path not in ("/v1/assist", "/v1/approval-answer"):
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"})
            return
        payload = self._read_json()
        if payload is None:
            return
        if self.path == "/v1/approval-answer":
            self._approval_answer(payload)
        else:
            self._assist(payload)

    def _approval_answer(self, payload):
        error = validate_approval_answer(payload)
        if error:
            self._send_json(400, {"error": error})
            return
        request_id = payload["request_id"]
        if not self.server.store.is_pending(request_id):
            self._send_json(409, {"error": "request is no longer pending"})
            return
        try:
            self.server.on_approval_answer(request_id, payload["approval_id"], payload["approved"])
        except Exception as exc:  # noqa: BLE001 - report it, never 500
            logger.warning("approval answer for request_id=%s not delivered: %s", request_id, exc)
            self._send_json(502, {"error": "could not reach Muse"})
            return
        self.server.store.touch(request_id)
        logger.info("approval.answered request_id=%s approved=%s", request_id, payload["approved"])
        self._send_json(202, {"request_id": request_id, "accepted": True})

    def _assist(self, payload):
        error = validate_assist_payload(
            payload, self.server.config.max_utterance_chars, now=datetime.now(timezone.utc)
        )
        if error:
            self._send_json(400, {"error": error})
            return

        request_id = payload["request_id"]
        created = self.server.store.create(request_id, payload["session_id"], payload["utterance"])
        if not created:
            logger.info("assist.duplicate request_id=%s", request_id)
            self._send_json(200, {"request_id": request_id, "accepted": True, "duplicate": True})
            return

        try:
            self.server.on_new_request(request_id, payload["session_id"], payload["utterance"])
        except Exception as exc:  # noqa: BLE001 - never let a notify failure 500 the request
            logger.warning("on_new_request failed for request_id=%s: %s", request_id, exc)

        logger.info("assist.accepted request_id=%s", request_id)
        self._send_json(202, {"request_id": request_id, "accepted": True})


class AssistServer(ThreadingHTTPServer):
    """`on_new_request(request_id, session_id, utterance)` is called once the
    request is durably persisted; it is expected to call musegadget, and
    should not raise for the handler to still respond 202.
    `on_approval_answer(request_id, approval_id, approved)` passes the user's
    yes/no to Muse; if it raises the handler answers 502, so the glasses can
    say the answer did not get through."""

    daemon_threads = True

    def __init__(self, server_address, config, store, on_new_request: Callable,
                 on_approval_answer: Optional[Callable] = None):
        super().__init__(server_address, _Handler)
        self.config = config
        self.store = store
        self.on_new_request = on_new_request
        self.on_approval_answer = on_approval_answer or _approvals_not_wired


def _approvals_not_wired(request_id, approval_id, approved):
    raise RuntimeError("approval answers are not wired up")
