import os
import pty
import time
import unittest

from reader_companion import jobs


def wait_for(check, seconds=5.0):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return True
        time.sleep(0.05)
    return False


class Drain:
    """Reads what the shell prints, so it never blocks on a full pty."""

    def __init__(self, fd):
        self.fd = fd
        self.text = b""

    def __call__(self):
        try:
            import select

            while select.select([self.fd], [], [], 0)[0]:
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                self.text += chunk
        except OSError:
            pass
        return self.text


@unittest.skipUnless(os.path.exists("/bin/bash"), "needs bash")
class TerminalJobsTest(unittest.TestCase):
    def setUp(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe("bash", ["bash", "--norc", "--noprofile", "-i"], {**os.environ, "PS1": "$ "})
        self.pid, self.fd = pid, fd
        self.drain = Drain(fd)
        self.assertTrue(wait_for(lambda: b"$ " in self.drain()), "the shell's prompt")

    def tearDown(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        os.close(self.fd)

    def test_at_the_prompt_nothing_runs(self):
        self.assertEqual(jobs.foreground(self.fd, self.pid), {"alive": True, "busy": False})

    def test_a_command_runs_and_ends(self):
        os.write(self.fd, b"sleep 30\n")
        self.assertTrue(wait_for(lambda: (self.drain(), jobs.foreground(self.fd, self.pid))[1]["busy"]), "sleep in the foreground")
        now = jobs.foreground(self.fd, self.pid)
        self.assertIn("sleep 30", now["command"])
        self.assertNotEqual(now["pid"], self.pid)
        os.write(self.fd, b"\x03")
        self.assertTrue(wait_for(lambda: not (self.drain(), jobs.foreground(self.fd, self.pid))[1]["busy"]), "back at the prompt after ^C")

    def test_by_name_from_the_terminal_manager(self):
        class Proc:
            def __init__(self, fd, pid):
                self.fd, self.pid = fd, pid

        class Term:
            def __init__(self, proc):
                self.ptyproc = proc

        class Manager:
            terminals = {"1": Term(Proc(self.fd, self.pid))}

        self.assertEqual(jobs.terminal_jobs(Manager()), {"1": {"alive": True, "busy": False}})
        self.assertEqual(jobs.terminal_jobs(None), {})


if __name__ == "__main__":
    unittest.main()
