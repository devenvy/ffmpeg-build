import fcntl
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import termios
import threading

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
original = termios.tcgetattr(slave)
os.set_blocking(master, False)
collected = bytearray()
done = threading.Event()


def drain():
    with selectors.DefaultSelector() as selection:
        selection.register(master, selectors.EVENT_READ)
        while not done.is_set():
            for key, _ in selection.select(0.1):
                try:
                    data = os.read(key.fd, 65536)
                except (BlockingIOError, OSError):
                    continue
                collected.extend(data)


reader = threading.Thread(target=drain)
reader.start()
process = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=subprocess.PIPE,
                           env=dict(os.environ, TERM='xterm', LANG='C.UTF-8', LC_ALL='C.UTF-8'))
try:
    _, errors = process.communicate(timeout=30)
    assert process.returncode == 0, errors.decode(errors='replace')
    assert termios.tcgetattr(slave) == original, 'Program must restore the recipient terminal settings'
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    done.set()
    reader.join()
    os.close(master)
    os.close(slave)
Path(sys.argv[1]).write_bytes(collected)
print('PTY: program succeeded on an owned24x80terminal and restored exact termios settings; captured', len(collected), 'bytes')
