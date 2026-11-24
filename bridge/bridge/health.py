"""Periodic health check against the Windows backend. Alerts via `notify`
only on a healthy<->unavailable state transition, with a cooldown so a
flapping backend cannot flood the chat. The very first check only
establishes a baseline; it never alerts (there was no prior known state).
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Optional

from . import backend_client

logger = logging.getLogger("bridge.health")


class HealthMonitor:
    def __init__(
        self,
        windows_backend_url: str,
        timeout: float,
        cooldown_seconds: float,
        notify: Callable[[str], None],
        check_health: Callable[[str, float], bool] = backend_client.check_health,
        now: Callable[[], float] = time.time,
    ):
        self._url = windows_backend_url
        self._timeout = timeout
        self._cooldown_seconds = cooldown_seconds
        self._notify = notify
        self._check_health = check_health
        self._now = now
        self._healthy: Optional[bool] = None
        # Cooldowns are tracked separately per direction: a clean down/up
        # pair must always report both ends (never leave the chat thinking
        # the backend is still down), even if it recovered quickly. The
        # cooldown only throttles repeated alerts of the *same* direction,
        # i.e. genuine flapping.
        self._last_down_alert_at = float("-inf")
        self._last_up_alert_at = float("-inf")
        self._went_unhealthy_at: Optional[float] = None

    @property
    def healthy(self) -> Optional[bool]:
        return self._healthy

    def check_once(self) -> bool:
        healthy = self._check_health(self._url, self._timeout)
        now = self._now()
        previous = self._healthy
        self._healthy = healthy

        if previous is None:
            if not healthy:
                self._went_unhealthy_at = now
            return healthy
        if previous == healthy:
            return healthy

        if healthy:
            unavailable_for = (now - self._went_unhealthy_at) if self._went_unhealthy_at is not None else None
            self._went_unhealthy_at = None
            if (now - self._last_up_alert_at) >= self._cooldown_seconds:
                message = (
                    f"MemoMind backend recovered after about {int(unavailable_for)}s unavailable."
                    if unavailable_for is not None
                    else "MemoMind backend recovered."
                )
                self._notify(message)
                self._last_up_alert_at = now
            else:
                logger.info("recovery alert suppressed by cooldown (repeated flapping)")
        else:
            self._went_unhealthy_at = now
            if (now - self._last_down_alert_at) >= self._cooldown_seconds:
                self._notify("MemoMind backend is unavailable (health check failed).")
                self._last_down_alert_at = now
            else:
                logger.info("down alert suppressed by cooldown (repeated flapping)")
        return healthy
