import unittest

from bridge.health import HealthMonitor


class HealthMonitorTest(unittest.TestCase):
    def setUp(self):
        self.clock = [0.0]
        self.alerts = []
        self.healthy_sequence = []

    def _monitor(self, cooldown_seconds=60):
        return HealthMonitor(
            windows_backend_url="http://backend.example",
            timeout=1.0,
            cooldown_seconds=cooldown_seconds,
            notify=self.alerts.append,
            check_health=lambda url, timeout: self.healthy_sequence.pop(0),
            now=lambda: self.clock[0],
        )

    def test_first_check_establishes_baseline_without_alerting(self):
        self.healthy_sequence = [True]
        monitor = self._monitor()
        monitor.check_once()
        self.assertEqual(self.alerts, [])

    def test_transition_to_unhealthy_alerts_once(self):
        self.healthy_sequence = [True, False, False, False]
        monitor = self._monitor()
        monitor.check_once()
        monitor.check_once()
        self.clock[0] += 1
        monitor.check_once()
        self.clock[0] += 1
        monitor.check_once()
        self.assertEqual(len(self.alerts), 1, "repeated unhealthy checks must not re-alert")
        self.assertIn("unavailable", self.alerts[0])

    def test_recovery_alert_reports_how_long_it_was_down(self):
        self.healthy_sequence = [True, False, True]
        monitor = self._monitor()
        monitor.check_once()
        monitor.check_once()
        self.clock[0] += 42
        monitor.check_once()
        self.assertEqual(len(self.alerts), 2)
        self.assertIn("recovered", self.alerts[1])
        self.assertIn("42", self.alerts[1])

    def test_recovery_right_after_a_down_alert_is_not_suppressed(self):
        # A clean down/up pair must always report both ends, even if the
        # recovery follows quickly - otherwise the chat is left thinking the
        # backend is still down.
        self.healthy_sequence = [True, False, True]
        monitor = self._monitor(cooldown_seconds=100)
        monitor.check_once()
        monitor.check_once()  # down alert
        self.clock[0] += 5
        monitor.check_once()  # recovery alert, despite being inside the down alert's cooldown
        self.assertEqual(len(self.alerts), 2)

    def test_cooldown_suppresses_repeats_of_the_same_direction_during_flapping(self):
        self.healthy_sequence = [True, False, True, False, True]
        monitor = self._monitor(cooldown_seconds=100)
        monitor.check_once()  # baseline: healthy
        monitor.check_once()  # down #1: alert
        self.clock[0] += 5
        monitor.check_once()  # up #1: alert
        self.clock[0] += 5
        monitor.check_once()  # down #2, within 100s of down #1: suppressed
        self.clock[0] += 5
        monitor.check_once()  # up #2, within 100s of up #1: suppressed
        self.assertEqual(len(self.alerts), 2)

    def test_alerts_resume_once_cooldown_has_elapsed(self):
        self.healthy_sequence = [True, False, True]
        monitor = self._monitor(cooldown_seconds=10)
        monitor.check_once()
        monitor.check_once()  # alert #1 (unhealthy)
        self.clock[0] += 20
        monitor.check_once()  # outside cooldown: alert #2 (recovered)
        self.assertEqual(len(self.alerts), 2)


if __name__ == "__main__":
    unittest.main()
