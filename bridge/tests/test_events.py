"""Status and approval files (delivery.py) and POST /v1/approval-answer (server.py)."""
import json
import os
import tempfile
import threading
import unittest
from urllib import error as urllib_error
from urllib import request as urllib_request

from bridge.app import build_approval_answer_message, build_assist_message
from bridge.backend_client import BackendUnreachable
from bridge.delivery import ExpirySweeper, ReplyForwarder, validate_event_payload
from bridge.server import AssistServer
from bridge.state import PendingRequestStore


class _FakeConfig:
    bridge_inbound_secret = "inbound-secret"
    max_utterance_chars = 2000


class EventFileTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.reply_dir = os.path.join(self._tmp.name, "replies")
        os.makedirs(self.reply_dir)
        self.clock = [1000.0]
        self.store = PendingRequestStore(os.path.join(self._tmp.name, "state"), now=lambda: self.clock[0])
        self.events = []
        self.replies = []

    def _write(self, name, payload):
        with open(os.path.join(self.reply_dir, name), "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _forwarder(self, post_muse_event=None):
        return ReplyForwarder(
            windows_backend_url="http://backend.example",
            backend_reply_secret="s3cret",
            reply_dir=self.reply_dir,
            store=self.store,
            post_muse_reply=lambda url, secret, payload, timeout: self.replies.append(payload),
            post_muse_event=post_muse_event or (lambda url, secret, payload, timeout: self.events.append(payload)),
        )

    def test_status_file_is_forwarded_and_removed_without_ending_the_request(self):
        self.store.create("r1", "chat", "hi")
        self._write("r1.status.json", {"type": "status", "request_id": "r1", "text": " Reviewing drafts "})

        self._forwarder().scan_once()

        self.assertEqual(self.events, [{"request_id": "r1", "type": "status", "text": "Reviewing drafts"}])
        self.assertEqual(self.replies, [])
        self.assertEqual(self.store.get("r1")["status"], "pending")
        self.assertEqual(os.listdir(self.reply_dir), [])

    def test_approval_file_is_forwarded(self):
        self.store.create("r1", "chat", "hi")
        self._write("r1.approval-1.json", {
            "type": "approval", "request_id": "r1", "approval_id": "1", "question": "Open amazon.com?",
        })

        self._forwarder().scan_once()

        self.assertEqual(self.events, [{
            "request_id": "r1", "type": "approval", "approval_id": "1", "question": "Open amazon.com?",
        }])

    def test_approval_is_kept_for_retry_when_backend_is_down(self):
        self.store.create("r1", "chat", "hi")
        self._write("r1.approval-1.json", {
            "type": "approval", "request_id": "r1", "approval_id": "1", "question": "Open amazon.com?",
        })

        def down(*args):
            raise BackendUnreachable("down")

        self._forwarder(post_muse_event=down).scan_once()
        self.assertEqual(os.listdir(self.reply_dir), ["r1.approval-1.json"])
        self._forwarder().scan_once()
        self.assertEqual(len(self.events), 1)

    def test_status_is_dropped_when_backend_is_down(self):
        self.store.create("r1", "chat", "hi")
        self._write("r1.status.json", {"type": "status", "request_id": "r1", "text": "Working"})

        def down(*args):
            raise BackendUnreachable("down")

        self._forwarder(post_muse_event=down).scan_once()
        self.assertEqual(os.listdir(self.reply_dir), [])

    def test_event_for_finished_request_is_discarded(self):
        self.store.create("r1", "chat", "hi")
        self.store.mark_delivered("r1")
        self._write("r1.status.json", {"type": "status", "request_id": "r1", "text": "Working"})

        self._forwarder().scan_once()

        self.assertEqual(self.events, [])
        self.assertEqual(os.listdir(self.reply_dir), [])

    def test_invalid_event_is_quarantined(self):
        self.store.create("r1", "chat", "hi")
        self._write("r1.approval-x.json", {"type": "approval", "request_id": "r1", "approval_id": "../x", "question": "?"})

        self._forwarder().scan_once()

        self.assertEqual(self.events, [])
        self.assertEqual(os.listdir(self.reply_dir), ["r1.approval-x.json.invalid"])

    def test_activity_pushes_back_expiry(self):
        self.store.create("r1", "chat", "hi")
        self.clock[0] += 50
        self._write("r1.status.json", {"type": "status", "request_id": "r1", "text": "Working"})
        self._forwarder().scan_once()
        self.clock[0] += 50  # 100 s since creation, 50 s since the status

        sweeper = ExpirySweeper(
            windows_backend_url="http://backend.example", backend_reply_secret="s", store=self.store,
            expire_seconds=60, now=lambda: self.clock[0],
            post_muse_reply=lambda *args: None,
        )
        self.assertEqual(sweeper.sweep_once(), [])
        self.clock[0] += 20
        self.assertEqual(sweeper.sweep_once(), ["r1"])

    def test_validate_event_payload(self):
        self.assertIsNone(validate_event_payload({"type": "status", "request_id": "r", "text": "ok"}))
        self.assertIsNotNone(validate_event_payload({"type": "status", "request_id": "r", "text": "x" * 500}))
        self.assertIsNotNone(validate_event_payload({"type": "other", "request_id": "r"}))


class ApprovalAnswerEndpointTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = PendingRequestStore(self._tmp.name)
        self.answers = []
        self.fail = False

        def on_answer(request_id, approval_id, approved):
            if self.fail:
                raise RuntimeError("musegadget down")
            self.answers.append((request_id, approval_id, approved))

        self.server = AssistServer(("127.0.0.1", 0), _FakeConfig(), self.store, lambda *a: None, on_answer)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        def stop():
            self.server.shutdown()
            thread.join(timeout=5)
            self.server.server_close()

        self.addCleanup(stop)

    def _post(self, body, secret="inbound-secret"):
        req = urllib_request.Request(
            f"{self.base}/v1/approval-answer", data=json.dumps(body).encode(), method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {secret}"},
        )
        try:
            with urllib_request.urlopen(req, timeout=5) as resp:
                return resp.status
        except urllib_error.HTTPError as exc:
            return exc.code

    def test_answer_reaches_muse(self):
        self.store.create("r1", "chat", "hi")
        self.assertEqual(self._post({"request_id": "r1", "approval_id": "1", "approved": True}), 202)
        self.assertEqual(self.answers, [("r1", "1", True)])

    def test_requires_auth(self):
        self.store.create("r1", "chat", "hi")
        self.assertEqual(self._post({"request_id": "r1", "approval_id": "1", "approved": True}, secret="no"), 401)

    def test_rejects_bad_body_and_finished_requests(self):
        self.store.create("r1", "chat", "hi")
        self.assertEqual(self._post({"request_id": "r1", "approval_id": "1", "approved": "yes"}), 400)
        self.assertEqual(self._post({"request_id": "nope", "approval_id": "1", "approved": False}), 409)
        self.assertEqual(self.answers, [])

    def test_muse_failure_is_reported(self):
        self.store.create("r1", "chat", "hi")
        self.fail = True
        self.assertEqual(self._post({"request_id": "r1", "approval_id": "1", "approved": False}), 502)


class MessageTest(unittest.TestCase):
    def test_ask_message_explains_status_and_approval_files(self):
        message = build_assist_message("req-1", "book a table", "/r")
        self.assertIn("/r/req-1.status.json", message)
        self.assertIn("/r/req-1.approval-<n>.json", message)
        self.assertIn("[MemoMind approval]", message)

    def test_answer_message(self):
        self.assertIn("answer=DENIED", build_approval_answer_message("r", "a", False))
        self.assertIn("answer=APPROVED", build_approval_answer_message("r", "a", True))


if __name__ == "__main__":
    unittest.main()
