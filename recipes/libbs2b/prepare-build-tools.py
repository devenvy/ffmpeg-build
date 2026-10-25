"""Refresh GNU's canonicalization tools, preserving the released project inputs."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess


def refresh(source, installed):
    pairs = [(installed / name, source / 'build-aux' / name)
             for name in ['config.guess', 'config.sub']]
    for origin, destination in pairs:
        if not origin.is_file() or not destination.is_file():
            raise SystemExit('Missing GNU auxiliary tool: ' + str(origin) + ' -> ' + str(destination))
    for origin, destination in pairs:
        shutil.copy2(origin, destination)
        print('Native GNU tool ' + destination.name + ': sha256=' +
              hashlib.sha256(destination.read_bytes()).hexdigest(), flush=True)


if __name__ == '__main__':
    if os.name == 'nt':
        script = next((Path(directory) / 'automake' for directory in os.environ['PATH'].split(os.pathsep)
                       if (Path(directory) / 'automake').is_file()), None)
        if script is None:
            raise SystemExit('GNU Automake must be available in the MSYS2 build environment')
        command = ['perl', str(script), '--print-libdir']
    else:
        command = ['automake', '--print-libdir']
    directory = subprocess.check_output(command, text=True).strip()
    if os.name == 'nt':
        directory = subprocess.check_output(['cygpath', '-m', directory], text=True).strip()
    refresh(Path.cwd(), Path(directory))
