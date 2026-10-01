"""Exercise the actual CI demo command, including its document-source boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys


def test_demo_cli_keeps_public_documents_unreviewed(tmp_path):
    report_path = tmp_path / 'demo.json'
    result = subprocess.run(
        [sys.executable, '-m', 'scripts.demo', '--out', str(report_path)],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, 'APP_MODE': 'legacy', 'MEDIA_ROOT': str(tmp_path / 'media')},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text())
    assert report['passed'] and report['database_reopen_checked']
    assert report['provider'] == 'mock'
    assert report['patients'] == 1 and report['extracts'] == 3
    assert report['unreviewed_documents_quarantined']
    assert report['source_review_performed'] is False
    assert report['record_confirmation_performed'] is False
    assert all(row['state'] == 'inbox' and row['organize_blocked']
               and row['confirmation_blocked'] for row in report['rows'])
