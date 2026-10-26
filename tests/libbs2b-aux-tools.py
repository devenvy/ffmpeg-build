"""GNU auxiliary-tool refresh must leave the project's build inputs and code intact."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).resolve().parents[1] / 'recipes/libbs2b/prepare-build-tools.py'
spec = importlib.util.spec_from_file_location('bs2b_tools', path)
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)


class NativeAuxiliaryTools(unittest.TestCase):
    def test_copies_unmodified_tools_without_editing_project_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            auxiliary = source / 'build-aux'
            installed = root / 'automake'
            auxiliary.mkdir(parents=True)
            installed.mkdir()
            protected = ['configure', 'configure.ac', 'Makefile.in', 'Makefile.am', 'src.c']
            for name in protected:
                (source / name).write_bytes(b'owned original project input\n')
            (auxiliary / 'ltmain.sh').write_bytes(b'owned original libtool input\n')
            for name in ['config.guess', 'config.sub']:
                (auxiliary / name).write_bytes(b'old auxiliary tool\n')
                (installed / name).write_bytes(b'owned current tool ' + name.encode() + b'\n')
            tools.refresh(source, installed)
            for name in ['config.guess', 'config.sub']:
                self.assertEqual((auxiliary / name).read_bytes(), (installed / name).read_bytes())
            for name in protected:
                self.assertEqual((source / name).read_bytes(), b'owned original project input\n')
            self.assertEqual((auxiliary / 'ltmain.sh').read_bytes(), b'owned original libtool input\n')

    def test_missing_native_tool_fails_before_changing_either_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            auxiliary = source / 'build-aux'
            installed = root / 'automake'
            auxiliary.mkdir(parents=True)
            installed.mkdir()
            for name in ['config.guess', 'config.sub']:
                (auxiliary / name).write_bytes(b'original\n')
            (installed / 'config.guess').write_bytes(b'current\n')
            with self.assertRaisesRegex(SystemExit, 'GNU auxiliary tool'):
                tools.refresh(source, installed)
            self.assertEqual((auxiliary / 'config.guess').read_bytes(), b'original\n')


if __name__ == '__main__':
    unittest.main()
