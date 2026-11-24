import json
import os
import tempfile
import unittest

from bridge.backend_client import BackendUnreachable
from bridge.delivery import ExpirySweeper, ReplyForwarder, validate_reply_payload
from bridge.state import PendingRequestStore


class ValidateReplyPayloadTest(unittest.TestCase):
    def test_valid_payload_passes(self):
        self.assertIsNone(validate_reply_payload({"request_id": "r1", "status": "ok", "text": "hi"}))

    def test_missing_field(self):
        self.assertIsNotNone(validate_reply_payload({"request_id": "r1", "status": "ok"}))

    def test_bad_status(self):
        self.assertIsNotNone(validate_reply_payload({"request_id": "r1", "status": "nope", "text": "hi"}))

    def test_text_too_long(self):
        self.assertIsNotNone(validate_reply_payload({"request_id": "r1", "status": "ok", "text": "x" * 5000}))


class ReplyForwarderTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.reply_dir = os.path.join(self._tmp.name, "replies")
        os.makedirs(self.reply_dir)
        self.state_dir = os.path.join(self._tmp.name, "state")
        self.store = PendingRequestStore(self.state_dir)
        self.posted = []

    def _write_reply(self, name, payload):
        with open(os.path.join(self.reply_dir, name), "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _forwarder(self, post_muse_reply=None):
        def default_post(url, secret, payload, timeout):
            self.posted.append((url, secret, payload, timeout))

        return ReplyForwarder(
            windows_backend_url="http://backend.example",
            backend_reply_secret="s3cret",
            reply_dir=self.reply_dir,
            store=self.store,
            post_muse_reply=post_muse_reply or default_post,
        )

    def test_forwards_a_valid_reply_and_removes_the_file(self):
        self.store.create("r1", "side-chat", "hello")
        self._write_reply("r1.json", {"request_id": "r1", "status": "ok", "text": "the answer"})

        handled = self._forwarder().scan_once()

        self.assertEqual(handled, ["r1"])
        self.assertEqual(self.store.get("r1")["status"], "delivered")
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.posted[0][2]["text"], "the answer")
        self.assertEqual(os.listdir(self.reply_dir), [])

    def test_unknown_request_id_is_quarantined_not_forwarded(self):
        self._write_reply("ghost.json", {"request_id": "ghost", "status": "ok", "text": "hi"})

        handled = self._forwarder().scan_once()

        self.assertEqual(handled, [])
        self.assertEqual(self.posted, [])
        self.assertTrue(os.path.exists(os.path.join(self.reply_dir, "ghost.json.invalid")))

    def test_invalid_payload_is_quarantined(self):
        self._write_reply("bad.json", {"request_id": "r1"})
        self.store.create("r1", "side-chat", "hello")

        self._forwarder().scan_once()

        self.assertTrue(os.path.exists(os.path.join(self.reply_dir, "bad.json.invalid")))

    def test_duplicate_reply_file_for_already_delivered_request_is_discarded(self):
        self.store.create("r1", "side-chat", "hello")
        self.store.mark_delivered("r1")
        self._write_reply("r1.json", {"request_id": "r1", "status": "ok", "text": "replay"})

        handled = self._forwarder().scan_once()

        self.assertEqual(handled, [])
        self.assertEqual(self.posted, [])
        self.assertEqual(os.listdir(self.reply_dir), [])

    def test_forward_failure_rolls_back_to_pending_and_keeps_the_file_for_retry(self):
        self.store.create("r1", "side-chat", "hello")
        self._write_reply("r1.json", {"request_id": "r1", "status": "ok", "text": "the answer"})

        def failing_post(url, secret, payload, timeout):
            raise BackendUnreachable("connection refused")

        handled = self._forwarder(post_muse_reply=failing_post).scan_once()

        self.assertEqual(handled, [])
        self.assertEqual(self.store.get("r1")["status"], "pending")
        self.assertIn("r1.json", os.listdir(self.reply_dir))


class ExpirySweeperTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.clock = [1000.0]
        self.store = PendingRequestStore(self._tmp.name, now=lambda: self.clock[0])
        self.posted = []

    def _sweeper(self, expire_seconds=60):
        return ExpirySweeper(
            windows_backend_url="http://backend.example",
            backend_reply_secret="s3cret",
            store=self.store,
            expire_seconds=expire_seconds,
            now=lambda: self.clock[0],
            post_muse_reply=lambda url, secret, payload, timeout: self.posted.append(payload),
        )

    def test_expires_old_pending_requests_and_notifies_backend(self):
        self.store.create("r1", "side-chat", "old question")
        self.clock[0] += 120

        expired = self._sweeper(expire_seconds=60).sweep_once()

        self.assertEqual(expired, ["r1"])
        self.assertEqual(self.store.get("r1")["status"], "expired")
        self.assertEqual(self.posted[0]["status"], "timeout")

    def test_does_not_touch_requests_still_within_the_window(self):
        self.store.create("r1", "side-chat", "fresh question")
        self.clock[0] += 10

        expired = self._sweeper(expire_seconds=60).sweep_once()

        self.assertEqual(expired, [])
        self.assertEqual(self.store.get("r1")["status"], "pending")


if __name__ == "__main__":
    unittest.main()
