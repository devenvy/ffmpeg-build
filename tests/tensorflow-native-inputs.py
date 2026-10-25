"""Bazel 7's real path-fragment shape and strict native closure rejection."""
import importlib.util
import json
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


class NativeStaticPackaging(unittest.TestCase):
    def test_archive_bytes_and_registration_scope_survive_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source'
            deps = Path(temporary) / 'installed'
            (source / '.ffb_inputs').mkdir(parents=True)
            paths = ['bazel-out/owned.a', 'bazel-out/registrations.a']
            payloads = [b'!<arch>\nnative ordinary bytes\n', b'!<arch>\nnative registration bytes\n']
            for name, payload in zip(paths, payloads):
                target = source / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(payload)
            rows = [{'flags': ['-lm'], 'additional_inputs': [], 'libraries': [
                {'archive': paths[0], 'alwayslink': False},
                {'archive': paths[1], 'alwayslink': True},
            ]}]
            (source / '.ffb_inputs/native-link-closure.json').write_text(json.dumps(rows))
            header = source / 'tensorflow/c/c_api.h'
            header.parent.mkdir(parents=True)
            header.write_text('/* owned header */\n')

            def dependencies(arguments, **unused):
                Path(arguments[arguments.index('-MF') + 1]).write_text('c_api: ' + shlex.quote(header.as_posix()) + '\n')

            with patch.object(exporter.subprocess, 'run', side_effect=dependencies):
                exporter.install(source, deps)
            archives = list((deps / 'lib').glob('libffb_tensorflow_*.a'))
            self.assertCountEqual([archive.read_bytes() for archive in archives], payloads)
            arguments = shlex.split((deps / 'lib/ffb-tensorflow-static.rsp').read_text())
            self.assertNotIn(str(source), ' '.join(arguments))
            forced = arguments.index('-Wl,--whole-archive')
            self.assertEqual(arguments[forced + 2], '-Wl,--no-whole-archive')
            registration = next(archive.name for archive in archives if archive.read_bytes() == payloads[1])
            self.assertEqual(arguments[forced + 1], '-l:' + registration)
            self.assertNotIn(registration, (deps / 'lib/libtensorflow.a').read_text())
            self.assertGreater(arguments.index('-l:libstdc++.a'), forced + 2)
            self.assertEqual((deps / 'include/tensorflow/c/c_api.h').read_bytes(), header.read_bytes())

    def test_unhandled_linker_inputs_fail_before_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / '.ffb_inputs').mkdir()
            (source / '.ffb_inputs/native-link-closure.json').write_text(json.dumps([
                {'flags': [], 'additional_inputs': ['unhandled.lds'], 'libraries': []},
            ]))
            with self.assertRaisesRegex(SystemExit, 'additional native'):
                exporter.install(source, source / 'installed')


if __name__ == '__main__':
    unittest.main()
