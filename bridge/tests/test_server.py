import json
import tempfile
import threading
import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib import error as urllib_error
from urllib import request as urllib_request

from bridge.server import AssistServer, validate_assist_payload
from bridge.state import PendingRequestStore


@dataclass
class _FakeConfig:
    bridge_inbound_secret: str = "inbound-secret"
    max_utterance_chars: int = 2000


class ValidateAssistPayloadTest(unittest.TestCase):
    def _payload(self, **overrides):
        base = {
            "request_id": "r1",
            "session_id": "s1",
            "utterance": "what time is it",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        base.update(overrides)
        return base

    def test_valid_payload_passes(self):
        self.assertIsNone(validate_assist_payload(self._payload(), 2000, now=datetime.now(timezone.utc)))

    def test_missing_field(self):
        payload = self._payload()
        del payload["utterance"]
        self.assertIsNotNone(validate_assist_payload(payload, 2000))

    def test_utterance_too_long(self):
        self.assertIsNotNone(validate_assist_payload(self._payload(utterance="x" * 10), 5))

    def test_stale_timestamp_rejected(self):
        stale = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        payload = self._payload(created_at=stale)
        self.assertIsNotNone(
            validate_assist_payload(payload, 2000, now=datetime.now(timezone.utc), max_skew_seconds=300)
        )

    def test_future_timestamp_rejected(self):
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        payload = self._payload(created_at=future)
        self.assertIsNotNone(
            validate_assist_payload(payload, 2000, now=datetime.now(timezone.utc), max_skew_seconds=300)
        )


class AssistServerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = PendingRequestStore(self._tmp.name)
        self.new_requests = []
        self.server = AssistServer(
            ("127.0.0.1", 0), _FakeConfig(), self.store,
            lambda request_id, session_id, utterance: self.new_requests.append((request_id, session_id, utterance)),
        )
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def _post(self, path, body, headers=None):
        data = json.dumps(body).encode("utf-8") if body is not None else b""
        req = urllib_request.Request(
            f"{self.base}{path}", data=data, method="POST",
            headers={"content-type": "application/json", **(headers or {})},
        )
        try:
            with urllib_request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib_error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_health_endpoint(self):
        with urllib_request.urlopen(f"{self.base}/health", timeout=5) as resp:
            body = json.loads(resp.read())
        self.assertEqual(resp.status, 200)
        self.assertEqual(body["status"], "ok")

    def test_assist_without_bearer_token_is_unauthorized(self):
        status, body = self._post("/v1/assist", {"request_id": "r1"})
        self.assertEqual(status, 401)

    def test_assist_accepts_a_valid_request_and_invokes_on_new_request(self):
        payload = {
            "request_id": "r1",
            "session_id": "s1",
            "utterance": "what time is it",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        status, body = self._post("/v1/assist", payload, headers={"authorization": "Bearer inbound-secret"})
        self.assertEqual(status, 202)
        self.assertEqual(body["accepted"], True)
        self.assertEqual(self.new_requests, [("r1", "s1", "what time is it")])
        self.assertEqual(self.store.get("r1")["status"], "pending")

    def test_duplicate_request_id_is_idempotent_not_an_error(self):
        payload = {
            "request_id": "r1",
            "session_id": "s1",
            "utterance": "hi",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        headers = {"authorization": "Bearer inbound-secret"}
        first = self._post("/v1/assist", payload, headers=headers)
        second = self._post("/v1/assist", payload, headers=headers)
        self.assertEqual(first[0], 202)
        self.assertEqual(second[0], 200)
        self.assertTrue(second[1].get("duplicate"))
        self.assertEqual(len(self.new_requests), 1, "on_new_request must not fire twice for a dup")

    def test_malformed_body_is_rejected(self):
        status, body = self._post(
            "/v1/assist", {"request_id": "r1"}, headers={"authorization": "Bearer inbound-secret"}
        )
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
