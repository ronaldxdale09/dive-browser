#!/usr/bin/env python3
"""macOS physical footprint of an owned browser tree, distinct from RSS."""
import ctypes
import json
import struct
import subprocess
import sys

from memory_benchmark import process_tree


def footprint(pid):
    # rusage_info_v2 in the macOS SDK's sys/resource.h: UUID is 16 bytes,
    # followed by seven uint64 counters before ri_phys_footprint at offset 72.
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.proc_pid_rusage.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(1024)
    if library.proc_pid_rusage(pid, 2, ctypes.byref(buffer)) != 0:
        raise OSError(ctypes.get_errno(), f'could not measure process {pid}')
    return struct.unpack_from('Q', buffer, 72)[0], struct.unpack_from('Q', buffer, 64)[0]


def state(pid):
    return subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True,
                          text=True, timeout=2).stdout.strip()


def sample(pid, output=None, read=footprint, status=state):
    if output is None:
        output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='],
                                         text=True, timeout=2)
    rows = process_tree(pid, output)
    if not rows:
        raise RuntimeError('browser root is no longer running')
    measured, retired = [], []
    for row in rows:
        child = row['pid']
        try:
            physical, resident = read(child)
        except OSError:
            current = status(child)
            if child != pid and (not current or current.startswith('Z')):
                retired.append({'pid': child, 'state': current or 'exited'})
                continue
            raise
        measured.append({'pid': child, 'ppid': row['ppid'], 'role': row['role'],
                         'physicalFootprintBytes': physical, 'residentBytes': resident})
    return {'physicalFootprintBytes': sum(row['physicalFootprintBytes'] for row in measured),
            'residentBytes': sum(row['residentBytes'] for row in measured),
            'processes': measured, 'retiredDuringSample': retired}


if __name__ == '__main__':
    if sys.platform != 'darwin':
        raise SystemExit('This metric requires macOS proc_pid_rusage; do not substitute RSS.')
    print(json.dumps(sample(int(sys.argv[1]))))
