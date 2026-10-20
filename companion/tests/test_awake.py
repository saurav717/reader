"""awake.py: this computer kept from sleeping while a machine has a folder of it mounted, and let go after."""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from reader_companion import awake


class FakeProcess:
    def __init__(self, argv, **_):
        self.argv = argv
        self.ended = False

    def poll(self):
        return 0 if self.ended else None

    def terminate(self):
        self.ended = True

    def wait(self, *_):
        return 0


class AwakeTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        os.environ["READER_COMPANION_HOME"] = self.home
        self.addCleanup(os.environ.pop, "READER_COMPANION_HOME", None)
        self.started = []

        def popen(argv, **kwargs):
            process = FakeProcess(argv, **kwargs)
            self.started.append(process)
            return process

        self.popen = mock.patch.object(awake.subprocess, "Popen", side_effect=popen)
        self.popen.start()
        self.addCleanup(self.popen.stop)

    def on(self, system, tool):
        return mock.patch.multiple(awake, platform=mock.Mock(system=lambda: system), shutil=mock.Mock(which=lambda name: f"/usr/bin/{name}" if name == tool else None))

    def test_the_first_mount_holds_sleep_off_and_the_last_lets_go(self):
        with self.on("Darwin", "caffeinate"):
            hold = awake.Awake()
            hold.hold("/a")
            hold.hold("/b")
            self.assertEqual(len(self.started), 1)
            self.assertEqual(self.started[0].argv[:3], ["caffeinate", "-i", "-s"])
            self.assertEqual(self.started[0].argv[-1], str(os.getpid()))
            self.assertTrue(hold.holding())
            hold.release("/a")
            self.assertFalse(self.started[0].ended)
            hold.release("/b")
            self.assertTrue(self.started[0].ended)
            self.assertFalse(hold.holding())

    def test_linux_asks_systemd_and_it_ends_with_the_companion(self):
        with self.on("Linux", "systemd-inhibit"):
            hold = awake.Awake()
            hold.hold("/a")
            argv = self.started[0].argv
            self.assertEqual(argv[:2], ["systemd-inhibit", "--what=sleep:idle"])
            self.assertIn(f"--pid={os.getpid()}", argv)
            hold.release("/a")

    def test_turned_off_in_the_settings_or_with_no_way_to_it_holds_nothing(self):
        from reader_companion import state

        state.save_config({"keep_awake": False})
        with self.on("Darwin", "caffeinate"):
            hold = awake.Awake()
            hold.hold("/a")
            self.assertEqual(self.started, [])
            self.assertFalse(hold.holding())
        state.save_config({})
        with self.on("Linux", None):
            hold = awake.Awake()
            hold.hold("/a")
            self.assertFalse(hold.holding())


if __name__ == "__main__":
    unittest.main()
