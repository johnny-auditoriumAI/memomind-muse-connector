"""Durable pending-request bookkeeping for the assist request/reply loop.

Backed by a single JSON file written with a temp-file-plus-atomic-rename, so a
restart mid-request neither loses nor duplicates a delivery: `create` and
`mark_delivered` are both idempotent (a second call for the same request_id
is a no-op that returns False), which is what callers rely on for dedup.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Callable, Optional

PENDING = "pending"
DELIVERED = "delivered"
EXPIRED = "expired"


class PendingRequestStore:
    def __init__(self, state_dir: str, now: Callable[[], float] = time.time):
        self._path = os.path.join(state_dir, "pending_requests.json")
        self._lock = threading.Lock()
        self._now = now
        self._records: dict = self._load()

    def _load(self) -> dict:
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_locked(self) -> None:
        directory = os.path.dirname(self._path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp_path = f"{self._path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self._records, f)
        os.replace(tmp_path, self._path)

    def create(self, request_id: str, session_id: str, utterance: str) -> bool:
        """Registers a new pending request. Returns False (no-op) if
        request_id was already registered, by a prior call or a prior
        process before a restart."""
        with self._lock:
            if request_id in self._records:
                return False
            self._records[request_id] = {
                "status": PENDING,
                "session_id": session_id,
                "utterance": utterance,
                "created_at": self._now(),
                "last_activity_at": None,
                "delivered_at": None,
            }
            self._save_locked()
            return True

    def mark_delivered(self, request_id: str) -> bool:
        """Transitions pending -> delivered. Returns False if the request is
        unknown or already delivered/expired (the caller must not re-forward
        in that case)."""
        with self._lock:
            record = self._records.get(request_id)
            if record is None or record["status"] != PENDING:
                return False
            record["status"] = DELIVERED
            record["delivered_at"] = self._now()
            self._save_locked()
            return True

    def mark_expired(self, request_id: str) -> bool:
        with self._lock:
            record = self._records.get(request_id)
            if record is None or record["status"] != PENDING:
                return False
            record["status"] = EXPIRED
            self._save_locked()
            return True

    def mark_pending_again(self, request_id: str) -> bool:
        """Rolls a delivery attempt back to pending after a failed forward to
        the Windows backend, so the next scan retries it."""
        with self._lock:
            record = self._records.get(request_id)
            if record is None or record["status"] != DELIVERED:
                return False
            record["status"] = PENDING
            record["delivered_at"] = None
            self._save_locked()
            return True

    def touch(self, request_id: str) -> bool:
        """Records that the assistant is still working on a pending request (a status
        update, an approval question or its answer), so the expiry window
        counts from the latest activity rather than from creation."""
        with self._lock:
            record = self._records.get(request_id)
            if record is None or record["status"] != PENDING:
                return False
            record["last_activity_at"] = self._now()
            self._save_locked()
            return True

    def is_pending(self, request_id: str) -> bool:
        with self._lock:
            record = self._records.get(request_id)
            return record is not None and record["status"] == PENDING

    def get(self, request_id: str) -> Optional[dict]:
        with self._lock:
            record = self._records.get(request_id)
            return dict(record) if record is not None else None

    def pending_ids_older_than(self, cutoff_timestamp: float) -> list:
        with self._lock:
            return [
                rid for rid, r in self._records.items()
                if r["status"] == PENDING
                and max(r["created_at"], r.get("last_activity_at") or 0) < cutoff_timestamp
            ]

    def prune(self, ttl_seconds: float) -> int:
        """Drops old non-pending records so the state file stays small.
        Returns how many were dropped."""
        with self._lock:
            cutoff = self._now() - ttl_seconds
            to_delete = [
                rid for rid, r in self._records.items()
                if r["status"] != PENDING and r["created_at"] < cutoff
            ]
            for rid in to_delete:
                del self._records[rid]
            if to_delete:
                self._save_locked()
            return len(to_delete)

    def size(self) -> int:
        with self._lock:
            return len(self._records)
