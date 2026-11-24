"""All runtime configuration, read once from the environment (loaded from
/etc/memomind-muse-bridge.env by the systemd unit's EnvironmentFile=). Secrets
only ever come from here, never from a request body or the repository.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """A required setting is missing or invalid."""


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required but not set")
    return value


@dataclass(frozen=True)
class Config:
    bind_host: str
    bind_port: int
    windows_backend_url: str
    muse_session_id: str
    bridge_inbound_secret: str
    backend_reply_secret: str
    reply_dir: str
    state_dir: str
    health_interval_seconds: float
    health_cooldown_seconds: float
    health_timeout_seconds: float
    assist_expire_seconds: float
    reply_poll_interval_seconds: float
    max_utterance_chars: int
    transcript_forwarding_enabled: bool
    muse_side_chat_session_id: str
    assistant_name: str

    @staticmethod
    def from_env(env: dict | None = None) -> "Config":
        e = os.environ if env is None else env

        def get(name: str, default: str) -> str:
            return e.get(name, default).strip()

        def require(name: str) -> str:
            value = e.get(name, "").strip()
            if not value:
                raise ConfigError(f"{name} is required but not set")
            return value

        bind_host = require("BRIDGE_BIND_HOST")
        if bind_host in ("0.0.0.0", "::"):
            raise ConfigError(
                "BRIDGE_BIND_HOST must not be a public/all-interfaces address; "
                "use the mini PC's Tailscale address"
            )

        return Config(
            bind_host=bind_host,
            bind_port=int(require("BRIDGE_BIND_PORT")),
            windows_backend_url=require("WINDOWS_BACKEND_URL").rstrip("/"),
            muse_session_id=require("MUSE_SESSION_ID"),
            bridge_inbound_secret=require("BRIDGE_INBOUND_SECRET"),
            backend_reply_secret=require("BACKEND_REPLY_SECRET"),
            reply_dir=require("REPLY_DIR"),
            state_dir=get("STATE_DIR", "/var/lib/memomind-muse-bridge"),
            health_interval_seconds=float(get("HEALTH_INTERVAL_SECONDS", "20")),
            health_cooldown_seconds=float(get("HEALTH_COOLDOWN_SECONDS", "120")),
            health_timeout_seconds=float(get("HEALTH_TIMEOUT_SECONDS", "5")),
            assist_expire_seconds=float(get("ASSIST_EXPIRE_SECONDS", "600")),
            reply_poll_interval_seconds=float(get("REPLY_POLL_INTERVAL_SECONDS", "1")),
            max_utterance_chars=int(get("MAX_UTTERANCE_CHARS", "2000")),
            transcript_forwarding_enabled=get("TRANSCRIPT_FORWARDING_ENABLED", "false").lower() == "true",
            muse_side_chat_session_id=get("MUSE_SIDE_CHAT_SESSION_ID", ""),
            assistant_name=get("ASSISTANT_NAME", "Muse"),
        )
