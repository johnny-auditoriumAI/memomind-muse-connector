import tempfile
import unittest

from bridge.state import PendingRequestStore


class PendingRequestStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.clock = [1000.0]
        self.store = PendingRequestStore(self.dir, now=lambda: self.clock[0])

    def test_create_then_mark_delivered_happy_path(self):
        self.assertTrue(self.store.create("r1", "s1", "hello"))
        self.assertTrue(self.store.mark_delivered("r1"))
        self.assertEqual(self.store.get("r1")["status"], "delivered")

    def test_create_is_idempotent_on_duplicate_request_id(self):
        self.assertTrue(self.store.create("r1", "s1", "hello"))
        self.assertFalse(self.store.create("r1", "s1", "hello again"))
        self.assertEqual(self.store.get("r1")["utterance"], "hello")

    def test_mark_delivered_twice_is_not_a_second_delivery(self):
        self.store.create("r1", "s1", "hi")
        self.assertTrue(self.store.mark_delivered("r1"))
        self.assertFalse(self.store.mark_delivered("r1"))

    def test_mark_expired_only_applies_to_pending(self):
        self.store.create("r1", "s1", "hi")
        self.store.mark_delivered("r1")
        self.assertFalse(self.store.mark_expired("r1"))

    def test_mark_pending_again_allows_a_retry_after_a_failed_forward(self):
        self.store.create("r1", "s1", "hi")
        self.store.mark_delivered("r1")
        self.assertTrue(self.store.mark_pending_again("r1"))
        self.assertEqual(self.store.get("r1")["status"], "pending")
        self.assertTrue(self.store.mark_delivered("r1"))

    def test_survives_reload_from_disk(self):
        self.store.create("r1", "s1", "hi")
        self.store.mark_delivered("r1")
        self.store.create("r2", "s1", "still pending")

        reloaded = PendingRequestStore(self.dir, now=lambda: self.clock[0])
        self.assertEqual(reloaded.get("r1")["status"], "delivered")
        self.assertEqual(reloaded.get("r2")["status"], "pending")
        # Dedup survives the restart too.
        self.assertFalse(reloaded.create("r1", "s1", "replay"))
        self.assertFalse(reloaded.mark_delivered("r1"))

    def test_pending_ids_older_than_cutoff(self):
        self.store.create("r1", "s1", "old")
        self.clock[0] += 1000
        self.store.create("r2", "s1", "new")
        old_ones = self.store.pending_ids_older_than(self.clock[0] - 500)
        self.assertEqual(old_ones, ["r1"])

    def test_prune_drops_old_non_pending_only(self):
        self.store.create("r1", "s1", "a")
        self.store.mark_delivered("r1")
        self.store.create("r2", "s1", "b")  # stays pending
        self.clock[0] += 10000
        dropped = self.store.prune(ttl_seconds=100)
        self.assertEqual(dropped, 1)
        self.assertIsNone(self.store.get("r1"))
        self.assertIsNotNone(self.store.get("r2"))


if __name__ == "__main__":
    unittest.main()
