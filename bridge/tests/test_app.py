import tempfile
import unittest

from bridge.app import BridgeApp, build_assist_message
from bridge.config import Config


class BridgeAppWiringTest(unittest.TestCase):
    def test_constructs_the_full_object_graph_without_starting_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Config.from_env({
                "BRIDGE_BIND_HOST": "127.0.0.1",
                "BRIDGE_BIND_PORT": "0",
                "WINDOWS_BACKEND_URL": "http://127.0.0.1:8800",
                "MUSE_SESSION_ID": "side-chat-1",
                "BRIDGE_INBOUND_SECRET": "a",
                "BACKEND_REPLY_SECRET": "b",
                "REPLY_DIR": f"{tmp}/replies",
                "STATE_DIR": f"{tmp}/state",
            })
            app = BridgeApp(config)
            try:
                self.assertEqual(app.store.size(), 0)
                self.assertTrue(app.http_server.server_port > 0)
            finally:
                app.http_server.server_close()

    def test_build_assist_message_includes_request_id_and_reply_path(self):
        message = build_assist_message("req-1", "what time is it", "/var/lib/memomind-muse-bridge/replies")
        self.assertIn("req-1", message)
        self.assertIn("what time is it", message)
        self.assertIn("/var/lib/memomind-muse-bridge/replies/req-1.json", message)


if __name__ == "__main__":
    unittest.main()
