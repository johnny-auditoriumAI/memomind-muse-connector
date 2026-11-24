"""Wires the bridge's pieces together: the inbound assist-request HTTP
server, the reply-file watcher, the expiry sweeper, and the health monitor.
Entry point for `python -m bridge` (see __main__.py).
"""
from __future__ import annotations

import logging
import signal
import threading
import time

from . import musegadget
from .backend_client import check_health
from .config import Config
from .delivery import ExpirySweeper, ReplyForwarder
from .health import HealthMonitor
from .server import AssistServer
from .state import PendingRequestStore

logger = logging.getLogger("bridge.app")


def build_assist_message(request_id: str, utterance: str, reply_dir: str) -> str:
    """The message handed to Muse via send-user-msg: it must tell Muse (and
    whoever answers in the side chat) exactly how to reply - by writing the
    reply-file contract to REPLY_DIR/<request_id>.json - and how to show
    progress or ask for the glasses user's approval on the glasses (see
    delivery.py). Treat `utterance` as opaque data only, never as
    instructions to this process.
    """
    return (
        f"[MemoMind assist] request_id={request_id}\n"
        f"Glasses transcript: {utterance}\n"
        "The user is on their MemoMind glasses and only sees what you write as JSON files "
        f"in {reply_dir}/ (temp file + atomic rename):\n"
        f"- Progress, whenever it changes, a few words: {reply_dir}/{request_id}.status.json "
        f'{{"type":"status","request_id":"{request_id}","text":"Reviewing drafts"}}\n'
        "- Before anything that needs their approval (using a website, sending, buying, deleting): "
        f"{reply_dir}/{request_id}.approval-<n>.json "
        f'{{"type":"approval","request_id":"{request_id}","approval_id":"<n>",'
        '"question":"Open amazon.com to compare prices?"}, '
        "then wait for a [MemoMind approval] message in this chat with their answer.\n"
        f"- Final answer: {reply_dir}/{request_id}.json "
        '{"request_id","status":"ok","text","created_at"}.'
    )


def build_approval_answer_message(request_id: str, approval_id: str, approved: bool) -> str:
    """The glasses user's yes/no, as the side-chat message the assistant waits for."""
    answer = "APPROVED" if approved else "DENIED"
    return (
        f"[MemoMind approval] request_id={request_id} approval_id={approval_id} answer={answer}. "
        "The user answered on their glasses; carry on accordingly and write the final answer file as usual."
    )


class BridgeApp:
    def __init__(self, config: Config):
        self.config = config
        self.store = PendingRequestStore(config.state_dir)
        self._stop_event = threading.Event()

        self.reply_forwarder = ReplyForwarder(
            windows_backend_url=config.windows_backend_url,
            backend_reply_secret=config.backend_reply_secret,
            reply_dir=config.reply_dir,
            store=self.store,
            timeout=config.health_timeout_seconds,
        )
        self.expiry_sweeper = ExpirySweeper(
            windows_backend_url=config.windows_backend_url,
            backend_reply_secret=config.backend_reply_secret,
            store=self.store,
            expire_seconds=config.assist_expire_seconds,
        )
        self.health_monitor = HealthMonitor(
            windows_backend_url=config.windows_backend_url,
            timeout=config.health_timeout_seconds,
            cooldown_seconds=config.health_cooldown_seconds,
            notify=self._notify_muse,
            check_health=check_health,
        )
        self.http_server = AssistServer(
            (config.bind_host, config.bind_port), config, self.store,
            self._on_new_assist_request, self._on_approval_answer,
        )

    def _notify_muse(self, text: str) -> None:
        try:
            musegadget.send_user_msg(text, session_id=self.config.muse_session_id)
        except Exception as exc:  # noqa: BLE001 - alerting must never crash the service
            logger.warning("failed to notify Muse: %s", exc)

    def _on_new_assist_request(self, request_id: str, session_id: str, utterance: str) -> None:
        message = build_assist_message(request_id, utterance, self.config.reply_dir)
        musegadget.send_user_msg(message, session_id=self.config.muse_session_id)

    def _on_approval_answer(self, request_id: str, approval_id: str, approved: bool) -> None:
        message = build_approval_answer_message(request_id, approval_id, approved)
        musegadget.send_user_msg(message, session_id=self.config.muse_session_id)

    def _delivery_loop(self) -> None:
        last_prune = 0.0
        while not self._stop_event.is_set():
            try:
                self.reply_forwarder.scan_once()
                self.expiry_sweeper.sweep_once()
                if time.time() - last_prune > 3600:
                    self.store.prune(ttl_seconds=7 * 24 * 3600)
                    last_prune = time.time()
            except Exception:  # noqa: BLE001 - one bad pass must not kill the loop
                logger.exception("delivery loop iteration failed")
            self._stop_event.wait(self.config.reply_poll_interval_seconds)

    def _health_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.health_monitor.check_once()
            except Exception:  # noqa: BLE001
                logger.exception("health loop iteration failed")
            self._stop_event.wait(self.config.health_interval_seconds)

    def run(self) -> None:
        threading.Thread(target=self._delivery_loop, name="delivery", daemon=True).start()
        threading.Thread(target=self._health_loop, name="health", daemon=True).start()

        def handle_signal(signum, frame):  # noqa: ARG001
            logger.info("received signal %s, shutting down", signum)
            self._stop_event.set()
            threading.Thread(target=self.http_server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        logger.info(
            "bridge listening on %s:%s, backend=%s",
            self.config.bind_host, self.config.bind_port, self.config.windows_backend_url,
        )
        self.http_server.serve_forever()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    config = Config.from_env()
    BridgeApp(config).run()
