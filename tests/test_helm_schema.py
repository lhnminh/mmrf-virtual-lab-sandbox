"""Keep Kubernetes Guppy's GraphQL schema aligned with seeded documents."""

from contextlib import redirect_stdout
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixture_generator', ROOT / 'synthetic/generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class HelmSchemaParity(unittest.TestCase):
    def test_chart_schema_matches_generated_graphql_contract(self):
        """Exercise the seeder without a server; detect stale chart field shapes."""
        def fake_search(request, timeout=None):
            url = urlsplit(request.full_url)
            self.assertEqual(url.netloc, 'elasticsearch:9200')
            data = {'_source': {'fingerprint': fingerprint}} if url.path == '/sandbox_seed_complete/_doc/ready' else {'errors': False}
            return io.BytesIO(json.dumps(data).encode())

        with tempfile.TemporaryDirectory() as directory:
            generator.generate(directory, count=20)
            fingerprint = hashlib.sha256(b''.join((Path(directory) / name).read_bytes()
                                                  for name in ('cases.json', 'files.json', 'variants.json'))).hexdigest()
            with patch.dict(os.environ, DATA_DIR=directory, GEN3_ES_ENDPOINT='http://elasticsearch:9200'), \
                    patch('urllib.request.urlopen', side_effect=fake_search), redirect_stdout(io.StringIO()):
                runpy.run_path(str(ROOT / 'synthetic/seed_es.py'), run_name='__main__')
            generated = json.loads((Path(directory) / 'guppy.json').read_text())
        chart = json.loads((ROOT / 'helm/files/guppy.json').read_text())
        self.assertEqual(chart, generated, 'Regenerate helm/files/guppy.json when fixture field shapes change')
        project_arrays = next(item['array'] for item in chart['arrayConfig'] if item['index'] == 'sandbox_project')
        self.assertTrue({'disease_type', 'primary_site', 'summary.data_categories',
                         'summary.experimental_strategies'}.issubset(project_arrays))


@unittest.skipUnless(shutil.which('helm'), 'helm is not installed')
class ChatRuntimeAccess(unittest.TestCase):
    ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-abc'

    def render(self, *args):
        return subprocess.run(['helm', 'template', 'sandbox', str(ROOT / 'helm'), *args], check=True,
                              capture_output=True, text=True).stdout

    def test_without_an_arn_identity_has_no_way_out(self):
        rendered = self.render()
        self.assertNotIn('AGENTCORE_RUNTIME_ARN', rendered)
        self.assertNotIn('0.0.0.0/0', rendered)
        self.assertNotIn('169.254.169.254', rendered)

    def test_with_an_arn_only_identity_gets_the_runtime_and_https_egress(self):
        rendered = self.render('--set', f'agentcore.runtimeArn={self.ARN}')
        self.assertIn(f'name: AGENTCORE_RUNTIME_ARN, value: "{self.ARN}"', rendered)
        policy = next(doc for doc in rendered.split('\n---') if 'name: identity-agentcore' in doc)
        self.assertIn('app.kubernetes.io/name: identity', policy)
        self.assertIn('169.254.169.254/32', policy)
        self.assertIn('0.0.0.0/0', policy)


if __name__ == '__main__':
    unittest.main()
