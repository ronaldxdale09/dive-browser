#!/usr/bin/env python3
"""Query macOS Seatbelt for an owned browser's renderers; flags are not proof.

Chromium's sandbox/mac/seatbelt.cc uses sandbox_check(pid, NULL, 0) to
determine whether a process has entered the sandbox. This is a read-only
private macOS API, used only by native verification, not the shipped app.
"""
import ctypes
import json
import subprocess
import sys

from memory_benchmark import process_tree


def is_sandboxed(pid):
    library = ctypes.CDLL('/usr/lib/system/libsystem_sandbox.dylib', use_errno=True)
    check = library.sandbox_check
    check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    check.restype = ctypes.c_int
    result = check(pid, None, 0)
    if result not in (0, 1):
        raise OSError(ctypes.get_errno(), f'could not query sandbox for process {pid}')
    return result == 1


def verify(pid, output=None, query=is_sandboxed):
    if output is None:
        output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='],
                                         text=True, timeout=2)
    tree = process_tree(pid, output)
    if not tree or not any(row['pid'] == pid for row in tree):
        raise RuntimeError('browser root is no longer running')
    renderers = [row for row in tree if row['role'] == 'renderer']
    if not renderers:
        raise RuntimeError('no live renderers to verify')
    receipts = [{'pid': row['pid'], 'sandboxed': query(row['pid'])}
                for row in renderers]
    return {'rootPid': pid, 'renderers': receipts,
            'allRenderersSandboxed': all(row['sandboxed'] for row in receipts)}


if __name__ == '__main__':
    if sys.platform != 'darwin':
        raise SystemExit('This verification requires macOS Seatbelt.')
    result = verify(int(sys.argv[1]))
    print(json.dumps(result))
    raise SystemExit(0 if result['allRenderersSandboxed'] else 1)
