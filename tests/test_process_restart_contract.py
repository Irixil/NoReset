import os
import socket
import subprocess
import sys
import time
import urllib.error
from contextlib import contextmanager
from pathlib import Path

from tests.http_support import HttpClient

ROOT = Path(__file__).resolve().parents[1]


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(base_url, method, path, body=None, headers=None):
    response = HttpClient(base_url).request(
        method,
        path,
        body,
        headers=headers,
        timeout=3,
    )
    return response.status, response.body


@contextmanager
def backend_process(database_path):
    port = unused_port()
    base_url = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "APP_MODE": "legacy",
        "API_HOST": "127.0.0.1",
        "API_PORT": str(port),
        "DB_PATH": str(database_path),
        "MODEL_PROVIDER": "mock",
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "backend.server"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if process.poll() is not None:
                stderr = process.stderr.read() if process.stderr else ""
                raise AssertionError(f"backend exited during startup: {stderr}")
            try:
                status, health = request(base_url, "GET", "/health")
                if status == 200:
                    yield base_url, health["session_token"]
                    break
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        else:
            raise AssertionError("backend did not become healthy before timeout")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        if process.stderr:
            process.stderr.close()


def test_restart_rotates_session_token_without_losing_saved_records(tmp_path):
    database = tmp_path / "restart.sqlite3"

    with backend_process(database) as (first_url, first_token):
        status, saved = request(
            first_url,
            "POST",
            "/api/events",
            {
                "raw_text": "重启前保存的记录",
                "source_kind": "elder",
                "actor_name": "老人",
            },
            {
                "Content-Type": "application/json",
                "Idempotency-Key": "restart-record",
                "X-Session-Token": first_token,
            },
        )
        assert status == 201
        record_id = saved["event"]["record_id"]

    with backend_process(database) as (second_url, second_token):
        assert second_token != first_token

        status, rejected = request(
            second_url,
            "POST",
            "/api/handoffs",
            {},
            {"Content-Type": "application/json", "X-Session-Token": first_token},
        )
        assert status == 403
        assert rejected == {"ok": False, "error": "csrf_or_origin_rejected"}

        status, detail = request(second_url, "GET", f"/api/events/{record_id}")
        assert status == 200
        assert detail["event"]["raw_text"] == "重启前保存的记录"

        status, created = request(
            second_url,
            "POST",
            "/api/handoffs",
            {},
            {"Content-Type": "application/json", "X-Session-Token": second_token},
        )
        assert status == 201
        assert created["handoff"]["items"][0]["record_id"] == record_id
