"""Check the split never drops Node coverage or OS packaging validation."""
from pathlib import Path
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class CiContractTests(unittest.TestCase):
    def test_system_setup_and_packaging_run_once_and_node_matrix_remains(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/test.yml').read_text())['jobs']
        self.assertEqual([22, 24], jobs['validate']['strategy']['matrix']['node-version'])
        javascript = '\n'.join(step.get('run', '') for step in jobs['validate']['steps'])
        package = '\n'.join(step.get('run', '') for step in jobs['package']['steps'])
        self.assertIn('./tests/validate.sh javascript', javascript)
        self.assertNotIn('apt-get', javascript)
        self.assertNotIn('matrix', jobs['package'].get('strategy', {}))
        for check in ('apt-get update', 'shellcheck install.sh tests/validate.sh', './tests/validate.sh package'):
            self.assertIn(check, package)

    def test_unknown_mode_fails_instead_of_skipping_checks(self):
        result = subprocess.run(['./tests/validate.sh', 'typo'], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(2, result.returncode)
        self.assertIn('Unknown validation mode', result.stderr)


if __name__ == '__main__':
    unittest.main()
