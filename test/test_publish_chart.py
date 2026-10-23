import hashlib
import io
import importlib.util
from pathlib import Path
import tempfile
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('publish_chart', Path(__file__).parents[1] / 'examples/publish-chart.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class FakeGitHub:
    def __init__(self):
        self.sha = None
        self.release = None
        self.creates = 0
        self.uploads = 0
        self.asset = None

    def tag(self, version):
        return self.sha

    def request(self, method, path, data=None, **kwargs):
        if method == 'GET':
            return self.asset if path.startswith('/releases/assets/') else self.release
        if path == '/releases':
            self.creates += 1
            self.sha = data['target_commitish']
            self.release = dict(data, assets=[], upload_url='https://uploads.github.com/upload{?name}', html_url='https://github.com/example/repo/releases/tag/v1.1.2-alpha1')
            return self.release
        self.uploads += 1
        self.asset = data
        self.release['assets'].append({'id': 1, 'name': 'chart.tgz', 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()})


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.package = Path(self.directory.name) / 'chart.tgz'
        self.package.write_bytes(b'chart archive fixture')
        self.api = FakeGitHub()

    def publish(self, **kwargs):
        params = dict(api=self.api, version='v1.1.2-alpha1', source='a' * 40, body='Reviewed changes', prerelease=True, latest=False, package=self.package)
        params.update(kwargs)
        return publisher.publish(**params)

    def test_prerelease_flags_are_set_at_creation_and_retry_reuses_identical_release_and_asset(self):
        self.publish()
        self.assertTrue(self.api.release['prerelease'])
        self.assertEqual(self.api.release['make_latest'], 'false')
        self.publish()
        self.assertEqual((self.api.creates, self.api.uploads), (1, 1))

    def test_existing_tag_different_source_is_never_overwritten(self):
        self.api.sha = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'different source'):
            self.publish()
        self.assertEqual(self.api.creates, 0)

    def test_release_notes_and_assets_are_not_overwritten_on_retry(self):
        self.publish()
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.publish(body='New unreviewed notes')
        self.package.write_bytes(b'different archive')
        with self.assertRaisesRegex(ValueError, 'different content'):
            self.publish()
        self.assertEqual(self.api.uploads, 1)

    def test_inconsistent_prerelease_flags_fail_before_publication(self):
        with self.assertRaisesRegex(ValueError, 'Inconsistent'):
            self.publish(latest=True)
        self.assertEqual(self.api.creates, 0)

    def test_rebuild_with_different_timestamps_reuses_published_bytes_for_index(self):
        def package(timestamp):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as archive:
                member = tarfile.TarInfo('chart/Chart.yaml')
                content = b'version: v1.1.2-alpha1\n'
                member.size = len(content)
                member.mtime = timestamp
                archive.addfile(member, io.BytesIO(content))
            return output.getvalue()
        original = package(1)
        self.package.write_bytes(original)
        self.publish()
        self.package.write_bytes(package(2))
        self.publish()
        self.assertEqual(self.package.read_bytes(), original)
        self.assertEqual(self.api.uploads, 1)

    def test_binary_retry_preserves_release_metadata_and_refuses_changed_bytes(self):
        self.publish()
        self.api.release['assets'] = []
        metadata = {key: value for key, value in self.api.release.items() if key != 'assets'}
        self.package.write_bytes(b'native executable')
        publisher.publish_binary(self.api, 'v1.1.2-alpha1', 'a' * 40, self.package)
        publisher.publish_binary(self.api, 'v1.1.2-alpha1', 'a' * 40, self.package)
        self.assertEqual(self.api.uploads, 2)
        self.assertEqual({key: value for key, value in self.api.release.items() if key != 'assets'}, metadata)
        self.package.write_bytes(b'changed native executable')
        with self.assertRaisesRegex(ValueError, 'different content'):
            publisher.publish_binary(self.api, 'v1.1.2-alpha1', 'a' * 40, self.package)
        self.assertEqual(self.api.uploads, 2)

    def test_binary_upload_requires_existing_release_at_same_source(self):
        with self.assertRaisesRegex(ValueError, 'binary source'):
            publisher.publish_binary(self.api, 'v1.1.2-alpha1', 'a' * 40, self.package)
        self.api.sha = 'a' * 40
        with self.assertRaisesRegex(ValueError, 'before uploading'):
            publisher.publish_binary(self.api, 'v1.1.2-alpha1', 'a' * 40, self.package)
        self.assertEqual((self.api.creates, self.api.uploads), (0, 0))


if __name__ == '__main__':
    unittest.main()
