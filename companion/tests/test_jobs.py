import os
import pty
import subprocess
import sys
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
        # Not pty.fork(): by now the test process has threads, and a fork of one can deadlock in the child on macOS.
        # A fresh Python, single-threaded, makes the terminal its own (setsid, then TIOCSCTTY) and becomes bash.
        fd, tty = pty.openpty()
        start = (
            "import os, sys, fcntl, termios\n"
            "os.setsid()\n"
            "t = os.open(sys.argv[1], os.O_RDWR)\n"
            "fcntl.ioctl(t, termios.TIOCSCTTY, 0)\n"
            "[os.dup2(t, n) for n in (0, 1, 2)]\n"
            "os.execvpe('bash', ['bash', '--norc', '--noprofile', '-i'], {**os.environ, 'PS1': '$ '})\n"
        )
        self.process = subprocess.Popen([sys.executable, "-c", start, os.ttyname(tty)], close_fds=True)
        os.close(tty)
        self.pid, self.fd = self.process.pid, fd
        self.drain = Drain(fd)
        self.assertTrue(wait_for(lambda: b"$ " in self.drain()), "the shell's prompt")

    def tearDown(self):
        try:
            os.kill(self.pid, 9)
        except OSError:
            pass
        self.process.wait()
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


class StoppingJobsGently(unittest.TestCase):
    """Before the Companion shuts down, the jobs under its kernels are asked to stop and given a moment."""

    def test_finds_the_processes_under_one_and_waits_for_them_to_go(self):
        import signal
        import subprocess
        import sys

        # A "kernel": a shell that runs a python child which leaves on SIGTERM after a moment, as the koios helper does.
        shell = subprocess.Popen(["sh", "-c", f"{sys.executable} -c 'import signal,time,sys; signal.signal(signal.SIGTERM, lambda *a: sys.exit(0)); time.sleep(30)' & wait"])
        try:
            self.assertTrue(wait_for(lambda: any("python" in jobs.command_of(p).lower() for p in jobs.descendants(shell.pid))))
            pythons = [p for p in jobs.descendants(shell.pid) if "python" in jobs.command_of(p).lower()]
            self.assertEqual(len(pythons), 1)
            jobs.ask_to_stop(pythons)
            self.assertEqual(jobs.wait_gone(pythons, seconds=5), [])
        finally:
            try:
                shell.send_signal(signal.SIGTERM)
                shell.wait(timeout=5)
            except Exception:
                pass

    def test_reads_kernel_pids_from_the_manager(self):
        class Provisioner:
            pid = 4242

        class Kernel:
            provisioner = Provisioner()

        class Manager:
            def list_kernel_ids(self):
                return ["k1"]

            def get_kernel(self, kernel_id):
                return Kernel()

        self.assertEqual(jobs.kernel_pids(Manager()), [4242])
