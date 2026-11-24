"""Thin wrapper around the locally installed `musegadget` CLI. Resolved via
PATH lookup rather than an assumed path, per the spec.
"""
from __future__ import annotations

import shutil
import subprocess
from typing import Optional


class MusegadgetUnavailable(Exception):
    pass


def resolve_musegadget_path() -> str:
    path = shutil.which("musegadget")
    if not path:
        raise MusegadgetUnavailable("musegadget executable not found on PATH")
    return path


def send_user_msg(text: str, session_id: Optional[str] = None, timeout: float = 15.0) -> None:
    """Runs `musegadget send-user-msg [--session-id ID] TEXT`. Raises
    MusegadgetUnavailable or subprocess.CalledProcessError on failure; never
    silently swallows an error, so callers can tell alerts/forwards apart
    from a confirmed delivery."""
    path = resolve_musegadget_path()
    cmd = [path, "send-user-msg"]
    if session_id:
        cmd += ["--session-id", session_id]
    cmd.append(text)
    subprocess.run(cmd, check=True, timeout=timeout, capture_output=True)
