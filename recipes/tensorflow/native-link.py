"""Audit Bazel 7 action-graph artifact paths against the bounded CcInfo closure."""
import json
from pathlib import Path
import sys


def link_inputs(query):
    fragments = {str(item['id']): item for item in query['pathFragments']}
    paths = {}
    active = set()

    def fragment_path(identifier):
        key = str(identifier)
        if key in paths:
            return paths[key]
        if key in active:
            raise ValueError('Native action graph path-fragment cycle')
        if key not in fragments:
            raise ValueError('Missing native action graph path fragment: ' + key)
        active.add(key)
        fragment = fragments[key]
        label = fragment['label']
        parent = fragment.get('parentId')
        path = fragment_path(parent) + '/' + label if parent else label
        active.remove(key)
        paths[key] = path
        return path

    artifacts = {str(item['id']): fragment_path(item['pathFragmentId'])
                 for item in query['artifacts']}
    sets = {str(item['id']): item for item in query['depSetOfFiles']}
    resolved = {}
    resolving = set()

    def inputs(identifier):
        key = str(identifier)
        if key in resolved:
            return resolved[key]
        if key in resolving:
            raise ValueError('Native action graph input-set cycle')
        resolving.add(key)
        item = sets[key]
        result = {artifacts[str(value)] for value in item.get('directArtifactIds', [])}
        for child in item.get('transitiveDepSetIds', []):
            result.update(inputs(child))
        resolving.remove(key)
        resolved[key] = result
        return result

    actions = [item for item in query.get('actions', []) if item['mnemonic'] == 'CppLink'
               and any(artifacts[str(key)].endswith('/libtensorflow.so.2.21.0')
                       for key in item.get('outputIds', []))]
    if len(actions) != 1:
        raise ValueError('Expected one actual native TensorFlow C shared link action')
    linked = set().union(*(inputs(key) for key in actions[0].get('inputDepSetIds', [])))
    return {path for path in linked
            if path.endswith(('.a', '.lo', '.o')) and path.startswith('bazel-out/')}


def audit(query, rows):
    if not rows or not any(row['libraries'] for row in rows):
        raise ValueError('Native TensorFlow shared closure inventory is empty')
    recorded = {item['archive'] for row in rows for item in row['libraries'] if item['archive']}
    recorded.update(path for row in rows for item in row['libraries'] for path in item['objects'])
    actual = link_inputs(query)
    if not actual or actual - recorded:
        raise ValueError('Review native TensorFlow shared link inputs missing from inventory: ' +
                         repr(sorted(actual - recorded)))
    return actual


def validate(source):
    query = json.loads((source / '.ffb_inputs/native-shared-link.json').read_text())
    rows = json.loads((source / '.ffb_inputs/native-link-closure.json').read_text())
    actual = audit(query, rows)
    print(f'Native TensorFlow shared link: all {len(actual)} actual archive/object inputs are recorded', flush=True)


if __name__ == '__main__':
    validate(Path(sys.argv[1]))
