"""Bazel 7's real path-fragment shape and strict native closure rejection."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

path = Path(__file__).resolve().parents[1] / 'recipes/tensorflow/native-link.py'
spec = importlib.util.spec_from_file_location('native_link', path)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
spec = importlib.util.spec_from_file_location('native_toolchain', path.with_name('native-toolchain.py'))
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)


def fixture():
    return {
        'pathFragments': [
            {'id': 1, 'label': 'bazel-out'},
            {'id': 2, 'parentId': 1, 'label': 'cpu-opt'},
            {'id': 3, 'parentId': 2, 'label': 'bin'},
            {'id': 4, 'parentId': 3, 'label': 'tensorflow'},
            {'id': 5, 'parentId': 4, 'label': 'libtensorflow.so.2.21.0'},
            {'id': 6, 'parentId': 4, 'label': 'owned.a'},
            {'id': 7, 'parentId': 4, 'label': 'owned.o'},
        ],
        'artifacts': [
            {'id': 1, 'pathFragmentId': 5},
            {'id': 2, 'pathFragmentId': 6},
            {'id': 3, 'pathFragmentId': 7},
        ],
        'depSetOfFiles': [
            {'id': 1, 'directArtifactIds': [2]},
            {'id': 2, 'directArtifactIds': [3], 'transitiveDepSetIds': [1]},
        ],
        'actions': [{
            'mnemonic': 'CppLink', 'outputIds': [1], 'inputDepSetIds': [2],
        }],
    }


class NativeInventory(unittest.TestCase):
    def test_native_fragment_paths_and_transitive_sets(self):
        self.assertEqual(native.link_inputs(fixture()), {
            'bazel-out/cpu-opt/bin/tensorflow/owned.a',
            'bazel-out/cpu-opt/bin/tensorflow/owned.o',
        })

    def test_unrecorded_native_object_is_not_ignored(self):
        with self.assertRaisesRegex(ValueError, 'missing from inventory'):
            native.audit(fixture(), [{'libraries': [{
                'archive': 'bazel-out/cpu-opt/bin/tensorflow/owned.a', 'objects': [],
            }]}])

    def test_complete_native_inventory_passes(self):
        native.audit(fixture(), [{'libraries': [{
            'archive': 'bazel-out/cpu-opt/bin/tensorflow/owned.a',
            'objects': ['bazel-out/cpu-opt/bin/tensorflow/owned.o'],
        }]}])

    def test_cyclic_fragment_is_rejected(self):
        query = fixture()
        query['pathFragments'][0]['parentId'] = 2
        with self.assertRaisesRegex(ValueError, 'cycle'):
            native.link_inputs(query)

    def test_absent_fragment_is_rejected(self):
        query = fixture()
        query['artifacts'][0]['pathFragmentId'] = 99
        with self.assertRaisesRegex(ValueError, 'fragment'):
            native.link_inputs(query)

    def test_multiple_native_link_actions_are_rejected(self):
        query = fixture()
        query['actions'] *= 2
        with self.assertRaisesRegex(ValueError, 'one actual'):
            native.link_inputs(query)

    def test_empty_link_inventory_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'empty'):
            native.audit(fixture(), [])


class NativeCompilerRuntime(unittest.TestCase):
    def test_mode_changes_restore_the_shared_bazel_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            self.assertFalse(compiler.select(base, True))
            helper = base / 'external/rules_ml_toolchain/third_party/rules_cc_toolchain/features/features.bzl'
            helper.parent.mkdir(parents=True)
            helper.write_text('prefix\n' + compiler.ORIGINAL + 'suffix\n')
            for shared in [True, True, False, False, True]:
                self.assertTrue(compiler.select(base, shared))
                expected = compiler.STATIC if shared else compiler.ORIGINAL
                self.assertEqual(helper.read_text(), 'prefix\n' + expected + 'suffix\n')
            helper.write_text(compiler.ORIGINAL + compiler.ORIGINAL)
            with self.assertRaisesRegex(SystemExit, 'Review native'):
                compiler.select(base, True)
            helper.write_text('unreviewed new helper')
            with self.assertRaisesRegex(SystemExit, 'Review native'):
                compiler.select(base, True)

    def test_actual_link_requires_exact_archives_and_shared_unwinder(self):
        required = ['-l:libstdc++.a', '-l:libstdc++fs.a', '-lgcc_s']
        def query(arguments):
            return {'actions': [{'mnemonic': 'CppLink', 'arguments': arguments}]}
        compiler.verify(query(required))
        for flag in required:
            with self.subTest(missing=flag), self.assertRaisesRegex(SystemExit, r'exact C\+\+'):
                compiler.verify(query([item for item in required if item != flag]))
        for flag in ['-lstdc++', '-lstdc++fs', '-l:libstdc++.so', '-static-libgcc']:
            with self.subTest(forbidden=flag), self.assertRaisesRegex(SystemExit, r'exact C\+\+'):
                compiler.verify(query(required + [flag]))
        with self.assertRaisesRegex(SystemExit, 'one native'):
            compiler.verify({'actions': []})


if __name__ == '__main__':
    unittest.main()
