import subprocess
import unittest
from unittest import mock

from bridge import musegadget


class MusegadgetTest(unittest.TestCase):
    def test_resolve_raises_when_not_on_path(self):
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaises(musegadget.MusegadgetUnavailable):
                musegadget.resolve_musegadget_path()

    def test_send_user_msg_builds_the_expected_argv(self):
        with mock.patch("shutil.which", return_value="/usr/local/bin/musegadget"), \
             mock.patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess(args=[], returncode=0)
            musegadget.send_user_msg("hello there", session_id="side-chat-1")

        args, kwargs = run.call_args
        self.assertEqual(
            args[0],
            ["/usr/local/bin/musegadget", "send-user-msg", "--session-id", "side-chat-1", "hello there"],
        )
        self.assertTrue(kwargs["check"])

    def test_send_user_msg_without_session_id(self):
        with mock.patch("shutil.which", return_value="/usr/local/bin/musegadget"), \
             mock.patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess(args=[], returncode=0)
            musegadget.send_user_msg("hello there")

        args, _ = run.call_args
        self.assertEqual(args[0], ["/usr/local/bin/musegadget", "send-user-msg", "hello there"])

    def test_subprocess_failure_propagates(self):
        with mock.patch("shutil.which", return_value="/usr/local/bin/musegadget"), \
             mock.patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "musegadget")):
            with self.assertRaises(subprocess.CalledProcessError):
                musegadget.send_user_msg("hello")


if __name__ == "__main__":
    unittest.main()
