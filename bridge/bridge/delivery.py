"""Watches REPLY_DIR for atomic files written by Muse (via the gadget's
file.write capability) and forwards them to the Windows backend:

* reply files (no "type", or "type": "reply") end the request;
* "type": "status" files are the assistant's progress ("Reviewing drafts"), shown in
  the glasses header; best effort, dropped if the backend is unreachable;
* "type": "approval" files ask the glasses user a yes/no question; the
  answer comes back through POST /v1/approval-answer (see server.py).

Status and approval files keep a request alive (PendingRequestStore.touch).
Separately, expires requests Muse never answered.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Callable, Optional

from . import backend_client
from .state import PendingRequestStore

logger = logging.getLogger("bridge.delivery")

_REQUIRED_FIELDS = {"request_id", "status", "text"}
_VALID_STATUSES = {"ok", "error", "timeout"}
_MAX_TEXT_CHARS = 4000
_MAX_STATUS_CHARS = 120
_MAX_QUESTION_CHARS = 500
APPROVAL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def validate_reply_payload(payload) -> Optional[str]:
    """Returns an error message, or None if the payload is well-formed."""
    if not isinstance(payload, dict):
        return "reply file must contain a JSON object"
    missing = _REQUIRED_FIELDS - payload.keys()
    if missing:
        return f"missing fields: {sorted(missing)}"
    if not isinstance(payload["request_id"], str) or not payload["request_id"]:
        return "request_id must be a non-empty string"
    if payload["status"] not in _VALID_STATUSES:
        return "status must be ok, error, or timeout"
    if not isinstance(payload["text"], str):
        return "text must be a string"
    if len(payload["text"]) > _MAX_TEXT_CHARS:
        return f"text exceeds {_MAX_TEXT_CHARS} characters"
    return None


def validate_event_payload(payload) -> Optional[str]:
    """Validates a "status" or "approval" file. Returns an error or None."""
    if not isinstance(payload, dict):
        return "event file must contain a JSON object"
    if not isinstance(payload.get("request_id"), str) or not payload["request_id"]:
        return "request_id must be a non-empty string"
    kind = payload.get("type")
    if kind == "status":
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return "status text must be a non-empty string"
        if len(text) > _MAX_STATUS_CHARS:
            return f"status text exceeds {_MAX_STATUS_CHARS} characters"
        return None
    if kind == "approval":
        approval_id = payload.get("approval_id")
        if not isinstance(approval_id, str) or not APPROVAL_ID_RE.match(approval_id):
            return "approval_id must be 1-64 letters, digits, dashes or underscores"
        question = payload.get("question")
        if not isinstance(question, str) or not question.strip():
            return "question must be a non-empty string"
        if len(question) > _MAX_QUESTION_CHARS:
            return f"question exceeds {_MAX_QUESTION_CHARS} characters"
        return None
    return "type must be reply, status or approval"


class ReplyForwarder:
    """`post_muse_reply` is injectable so tests never make a real HTTP call."""

    def __init__(
        self,
        windows_backend_url: str,
        backend_reply_secret: str,
        reply_dir: str,
        store: PendingRequestStore,
        timeout: float = 5.0,
        post_muse_reply: Callable = backend_client.post_muse_reply,
        post_muse_event: Callable = backend_client.post_muse_event,
    ):
        self._url = windows_backend_url
        self._secret = backend_reply_secret
        self._reply_dir = reply_dir
        self._store = store
        self._timeout = timeout
        self._post_muse_reply = post_muse_reply
        self._post_muse_event = post_muse_event

    def scan_once(self) -> list:
        """Processes every *.json file currently in reply_dir once. Returns
        the request_ids that were successfully forwarded this pass."""
        try:
            names = sorted(os.listdir(self._reply_dir))
        except FileNotFoundError:
            return []
        handled = []
        for name in names:
            if not name.endswith(".json"):
                continue
            request_id = self._process_file(os.path.join(self._reply_dir, name))
            if request_id:
                handled.append(request_id)
        return handled

    def _process_file(self, path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("reply file unreadable, leaving in place: %s (%s)", path, exc)
            return None

        if isinstance(payload, dict) and payload.get("type", "reply") != "reply":
            self._process_event(path, payload)
            return None

        error = validate_reply_payload(payload)
        if error:
            logger.warning("reply file failed validation (%s), quarantining: %s", error, path)
            self._quarantine(path)
            return None

        request_id = payload["request_id"]
        if self._store.get(request_id) is None:
            logger.warning("reply file for unknown request_id, quarantining: %s", request_id)
            self._quarantine(path)
            return None

        if not self._store.mark_delivered(request_id):
            logger.info("request_id=%s already delivered/expired; discarding duplicate reply file", request_id)
            self._remove(path)
            return None

        try:
            self._post_muse_reply(
                self._url,
                self._secret,
                {"request_id": request_id, "status": payload["status"], "text": payload["text"]},
                self._timeout,
            )
        except backend_client.BackendUnreachable as exc:
            logger.warning("could not forward request_id=%s to Windows backend (%s); will retry", request_id, exc)
            self._store.mark_pending_again(request_id)
            return None

        self._remove(path)
        logger.info("request_id=%s delivered to Windows backend, status=%s", request_id, payload["status"])
        return request_id

    def _process_event(self, path: str, payload: dict) -> None:
        error = validate_event_payload(payload)
        if error:
            logger.warning("event file failed validation (%s), quarantining: %s", error, path)
            self._quarantine(path)
            return
        request_id = payload["request_id"]
        kind = payload["type"]
        if not self._store.is_pending(request_id):
            # Already answered or expired: a late status or question is moot.
            logger.info("request_id=%s not pending; discarding %s file", request_id, kind)
            self._remove(path)
            return

        if kind == "status":
            event = {"request_id": request_id, "type": "status", "text": payload["text"].strip()}
        else:
            event = {
                "request_id": request_id,
                "type": "approval",
                "approval_id": payload["approval_id"],
                "question": payload["question"].strip(),
            }
        try:
            self._post_muse_event(self._url, self._secret, event, self._timeout)
        except backend_client.BackendUnreachable as exc:
            if kind == "status":
                # Progress is best effort; the next status replaces it anyway.
                logger.warning("dropping status for request_id=%s (%s)", request_id, exc)
                self._remove(path)
            else:
                logger.warning("could not forward approval for request_id=%s (%s); will retry", request_id, exc)
            return
        self._store.touch(request_id)
        self._remove(path)
        logger.info("request_id=%s %s forwarded to Windows backend", request_id, kind)

    @staticmethod
    def _quarantine(path: str) -> None:
        try:
            os.replace(path, f"{path}.invalid")
        except OSError:
            pass

    @staticmethod
    def _remove(path: str) -> None:
        try:
            os.remove(path)
        except OSError:
            pass


class ExpirySweeper:
    """Requests Muse never answers are expired after expire_seconds, and the
    Windows backend is told so the glasses aren't left hanging forever."""

    def __init__(
        self,
        windows_backend_url: str,
        backend_reply_secret: str,
        store: PendingRequestStore,
        expire_seconds: float,
        timeout: float = 5.0,
        now: Callable[[], float] = time.time,
        post_muse_reply: Callable = backend_client.post_muse_reply,
    ):
        self._url = windows_backend_url
        self._secret = backend_reply_secret
        self._store = store
        self._expire_seconds = expire_seconds
        self._timeout = timeout
        self._now = now
        self._post_muse_reply = post_muse_reply

    def sweep_once(self) -> list:
        cutoff = self._now() - self._expire_seconds
        expired = []
        for request_id in self._store.pending_ids_older_than(cutoff):
            if not self._store.mark_expired(request_id):
                continue
            try:
                self._post_muse_reply(
                    self._url,
                    self._secret,
                    {"request_id": request_id, "status": "timeout", "text": "No reply in time."},
                    self._timeout,
                )
                expired.append(request_id)
                logger.info("request_id=%s expired after no Muse reply", request_id)
            except backend_client.BackendUnreachable as exc:
                logger.warning("could not notify Windows backend of expiry for request_id=%s (%s)", request_id, exc)
        return expired
