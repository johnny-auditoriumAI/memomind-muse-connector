import unittest

from bridge.config import Config, ConfigError

BASE_ENV = {
    "BRIDGE_BIND_HOST": "100.64.0.5",
    "BRIDGE_BIND_PORT": "8900",
    "WINDOWS_BACKEND_URL": "http://100.64.0.1:8800",
    "MUSE_SESSION_ID": "side-chat-1",
    "BRIDGE_INBOUND_SECRET": "secret-a",
    "BACKEND_REPLY_SECRET": "secret-b",
    "REPLY_DIR": "/var/lib/memomind-muse-bridge/replies",
}


class ConfigTest(unittest.TestCase):
    def test_loads_required_fields_with_defaults(self):
        config = Config.from_env(dict(BASE_ENV))
        self.assertEqual(config.bind_host, "100.64.0.5")
        self.assertEqual(config.bind_port, 8900)
        self.assertEqual(config.windows_backend_url, "http://100.64.0.1:8800")
        self.assertEqual(config.health_interval_seconds, 20)
        self.assertEqual(config.assist_expire_seconds, 600)
        self.assertEqual(config.assistant_name, "Muse")
        self.assertFalse(config.transcript_forwarding_enabled)

    def test_missing_required_field_raises(self):
        env = dict(BASE_ENV)
        del env["BRIDGE_INBOUND_SECRET"]
        with self.assertRaises(ConfigError):
            Config.from_env(env)

    def test_rejects_wildcard_bind_host(self):
        env = dict(BASE_ENV, BRIDGE_BIND_HOST="0.0.0.0")
        with self.assertRaises(ConfigError):
            Config.from_env(env)

    def test_overrides_are_applied(self):
        env = dict(BASE_ENV, HEALTH_INTERVAL_SECONDS="5", TRANSCRIPT_FORWARDING_ENABLED="true")
        config = Config.from_env(env)
        self.assertEqual(config.health_interval_seconds, 5)
        self.assertTrue(config.transcript_forwarding_enabled)


if __name__ == "__main__":
    unittest.main()
