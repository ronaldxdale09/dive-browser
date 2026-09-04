"""Run isolated browser probes with external deadlines and retained output."""
import os
from pathlib import Path
import signal
import subprocess
import time


def stop_group(process):
    """Only signal the process group this harness created, never match app names."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=0.5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def run_probe(binary: Path, environment: dict, log: Path, timeout: float, observe=None, *, expected_exit_code: int = 0) -> float:
    """Watchdog termination or leftover helpers are never a successful run."""
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with log.open('wb') as output:
        process = subprocess.Popen([str(binary)], env=environment, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = started + timeout
            while process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(str(binary), timeout)
                if observe is not None:
                    observe(process.pid)
                try:
                    process.wait(timeout=min(0.1, remaining))
                except subprocess.TimeoutExpired:
                    pass
            if process.returncode != expected_exit_code:
                raise RuntimeError(f'probe exited {process.returncode}; log: {log}')
            # The browser may exit just ahead of a helper. Give that normal
            # teardown a short grace period, then fail instead of leaking it.
            drain_deadline = min(deadline, time.monotonic() + 1)
            while True:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= drain_deadline:
                    raise RuntimeError(f'probe left helper processes running; log: {log}')
                time.sleep(0.02)
        except BaseException:
            stop_group(process)
            raise
    return time.monotonic() - started
