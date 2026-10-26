"""Bazel 7's real path-fragment shape and strict native closure rejection."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True

path = Path(__file__).resolve().parents[1] / 'recipes/tensorflow/native-link.py'
spec = importlib.util.spec_from_file_location('native_link', path)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
spec = importlib.util.spec_from_file_location('native_export', path.with_name('export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
spec = importlib.util.spec_from_file_location('native_restore', path.with_name('restore.py'))
restorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restorer)


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


class NativeSDKTemplate(unittest.TestCase):
    def test_native_platform_substitutions_preserve_template_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'rules-go.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('go/private/BUILD.sdk.bazel', b'{goos}\n{goarch}\n{exe}\n{rules_go_repo_name}\n')
            self.assertEqual(restorer.sdk_build(archive), b'linux\namd64\n\nio_bazel_rules_go\n')

    def test_changed_native_template_requires_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'rules-go.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('go/private/BUILD.sdk.bazel', b'changed template\n')
            with self.assertRaisesRegex(SystemExit, 'native rules_go SDK template'):
                restorer.sdk_build(archive)


class NativeSharedPackaging(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'The native Linux SDK uses ELF SONAME symlinks')
    def test_native_owner_bytes_headers_and_soname_links_survive_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source'
            deps = Path(temporary) / 'installed'
            (source / '.ffb_inputs').mkdir(parents=True)
            target = source / 'bazel-bin/tensorflow/libtensorflow.so.2.21.0'
            target.parent.mkdir(parents=True)
            payload = b'\x7fELF owned native shared bytes\n'
            target.write_bytes(payload)
            rows = [{'flags': ['-lm'], 'additional_inputs': [], 'libraries': [
                {'archive': 'bazel-out/owned.a', 'alwayslink': True},
            ]}]
            (source / '.ffb_inputs/native-link-closure.json').write_text(json.dumps(rows))
            header = source / 'tensorflow/c/c_api.h'
            header.parent.mkdir(parents=True)
            header.write_text('/* owned header */\n')

            def dependencies(arguments, **unused):
                if '-MF' in arguments:
                    Path(arguments[arguments.index('-MF') + 1]).write_text('c_api: ' + shlex.quote(header.as_posix()) + '\n')
                else:
                    self.assertTrue(arguments[1].endswith('native-link.py'))

            with patch.object(exporter.subprocess, 'run', side_effect=dependencies):
                exporter.install(source, deps)
            self.assertEqual((deps / 'lib/libtensorflow.so.2.21.0').read_bytes(), payload)
            self.assertEqual(os.readlink(deps / 'lib/libtensorflow.so.2'), 'libtensorflow.so.2.21.0')
            self.assertEqual(os.readlink(deps / 'lib/libtensorflow.so'), 'libtensorflow.so.2')
            self.assertFalse(list((deps / 'lib').glob('*.a')))
            self.assertFalse(list((deps / 'lib').glob('*.rsp')))
            self.assertEqual((deps / 'include/tensorflow/c/c_api.h').read_bytes(), header.read_bytes())
            self.assertEqual(json.loads((deps / 'share/ffmpeg-build/tensorflow-shared-closure.json').read_text()), rows)

    def test_empty_native_owner_inventory_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / '.ffb_inputs').mkdir()
            (source / '.ffb_inputs/native-link-closure.json').write_text(json.dumps([
                {'flags': [], 'additional_inputs': [], 'libraries': []},
            ]))
            with self.assertRaisesRegex(SystemExit, 'shared closure inventory is empty'):
                exporter.install(source, source / 'installed')

    def test_static_integration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            with self.assertRaisesRegex(SystemExit, 'Static TensorFlow integration'):
                exporter.install(source, source / 'installed', False)


if __name__ == '__main__':
    unittest.main()
