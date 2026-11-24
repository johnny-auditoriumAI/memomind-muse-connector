"""Outbound HTTP calls from the bridge to the Windows MemoMind backend, over
Tailscale only (windows_backend_url is never a public address). Stdlib-only
(urllib), matching the Windows side's no-framework style.
"""
from __future__ import annotations

import json
from urllib import error as urllib_error
from urllib import request as urllib_request


class BackendUnreachable(Exception):
    """The Windows backend could not be reached or returned a non-2xx status."""


def check_health(base_url: str, timeout: float) -> bool:
    """GET /health. Returns False on any error; never raises."""
    try:
        req = urllib_request.Request(f"{base_url}/health", method="GET")
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except (urllib_error.URLError, OSError, TimeoutError, ValueError):
        return False


def _post_json(base_url: str, path: str, secret: str, payload: dict, timeout: float) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        f"{base_url}{path}",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {secret}",
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            if not (200 <= resp.status < 300):
                raise BackendUnreachable(f"HTTP {resp.status}")
    except urllib_error.HTTPError as exc:
        raise BackendUnreachable(f"HTTP {exc.code}") from exc
    except (urllib_error.URLError, OSError, TimeoutError) as exc:
        raise BackendUnreachable(str(exc)) from exc


def post_muse_reply(base_url: str, secret: str, payload: dict, timeout: float) -> None:
    """POST /v1/muse-reply. Raises BackendUnreachable on any failure so the
    caller can retry rather than silently assume delivery."""
    _post_json(base_url, "/v1/muse-reply", secret, payload, timeout)


def post_muse_event(base_url: str, secret: str, payload: dict, timeout: float) -> None:
    """POST /v1/muse-event: a status update or approval question from the assistant
    for a request that is still pending. Raises BackendUnreachable."""
    _post_json(base_url, "/v1/muse-event", secret, payload, timeout)
