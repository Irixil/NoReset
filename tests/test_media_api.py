import hashlib
import io
import json
import urllib.error
import urllib.request
from contextlib import contextmanager

import pytest

from backend import server
from backend.media_backend import LocalMediaBackend
from backend.store import Conflict, NotFound, StoreError
from backend.store import SQLiteStore
from tests.http_support import HttpClient, HttpResponse, running_http_server


PNG = b"\x89PNG\r\n\x1a\n" + b"media-api-payload"
ORIGIN = "http://localhost:5173"


def multipart(fields=None, files=None):
    boundary = "----bingli-media-test-boundary"
    body = bytearray()
    for name, value in (fields or {}).items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        )
        body.extend(str(value).encode())
        body.extend(b"\r\n")
    for name, filename, content_type, payload in files or []:
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            (
                f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'
            ).encode()
        )
        body.extend(payload)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


class FakeMediaBackend:
    def __init__(self):
        self.uploads = {}
        self.media = {}
        self.keys = {}
        self.recognition_calls = []

    def _claim(self, operation, key, fingerprint):
        if not key:
            raise StoreError("idempotency_key_required")
        identity = (operation, key)
        previous = self.keys.get(identity)
        if previous is not None and previous != fingerprint:
            raise Conflict("idempotency_key_payload_mismatch")
        repeated = previous is not None
        self.keys[identity] = fingerprint
        return not repeated

    def create_upload(self, metadata, idempotency_key, household_id=None):
        fingerprint = json.dumps(metadata, sort_keys=True, ensure_ascii=False)
        created = self._claim("create", idempotency_key, fingerprint)
        upload_id = "upload_1"
        if created:
            self.uploads[upload_id] = {
                "upload_id": upload_id,
                "media_id": "media_1",
                "kind": metadata["kind"],
                "content_type": metadata["content_type"],
                "total_parts": metadata["total_parts"],
                "status": "uploading",
            }
        return self.uploads[upload_id], created

    def write_part(
        self, upload_id, index, payload, idempotency_key, household_id=None
    ):
        if upload_id not in self.uploads:
            raise NotFound("upload_not_found")
        created = self._claim(
            f"part:{upload_id}:{index}",
            idempotency_key,
            hashlib.sha256(payload).hexdigest(),
        )
        self.uploads[upload_id].setdefault("parts", {})[index] = payload
        return {
            "upload_id": upload_id,
            "index": index,
            "size_bytes": len(payload),
        }, created

    def complete_upload(self, upload_id, idempotency_key, household_id=None):
        if upload_id not in self.uploads:
            raise NotFound("upload_not_found")
        created = self._claim(f"complete:{upload_id}", idempotency_key, upload_id)
        upload = self.uploads[upload_id]
        parts = upload.get("parts", {})
        if len(parts) != upload["total_parts"]:
            raise Conflict("upload_incomplete")
        original = b"".join(parts[index] for index in range(upload["total_parts"]))
        media_id = upload["media_id"]
        if created:
            self.media[media_id] = {
                "media_id": media_id,
                "kind": upload["kind"],
                "content_type": upload["content_type"],
                "size_bytes": len(original),
                "sha256": hashlib.sha256(original).hexdigest(),
                "save_status": "saved",
                "recognition_status": "not_started",
                "link_status": "not_linked",
                "version": 1,
                "original": original,
            }
        return self.public_media(media_id), created

    def public_media(self, media_id):
        return {
            key: value
            for key, value in self.media[media_id].items()
            if key != "original"
        }

    def list_media(self, household_id=None):
        return [self.public_media(media_id) for media_id in sorted(self.media)]

    def get_media(self, media_id, household_id=None):
        if media_id not in self.media:
            raise NotFound("media_not_found")
        return self.public_media(media_id)

    @contextmanager
    def open_original(self, media_id, household_id=None):
        if media_id not in self.media:
            raise NotFound("media_not_found")
        yield io.BytesIO(self.media[media_id]["original"])

    def start_recognition(
        self,
        media_id,
        expected_version,
        idempotency_key,
        *,
        actor,
        household_id=None,
    ):
        if media_id not in self.media:
            raise NotFound("media_not_found")
        media = self.media[media_id]
        created = self._claim(
            f"recognize:{media_id}", idempotency_key, str(expected_version)
        )
        if created and expected_version != media["version"]:
            raise Conflict("stale_version")
        if created:
            media["recognition_status"] = "processing"
            media["version"] += 1
            self.recognition_calls.append(media_id)
        return {
            "accepted": True,
            "attempt_id": "attempt_1",
            "media": self.public_media(media_id),
        }


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_BYTES", "1048576")
    monkeypatch.setenv("MEDIA_UPLOAD_PART_MAX_BYTES", "1048576")
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_PARTS", "16")
    backend = FakeMediaBackend()
    monkeypatch.setattr(server, "MEDIA_BACKEND", backend, raising=False)
    monkeypatch.setattr(server, "ALLOWED_ORIGIN", ORIGIN)
    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url)

        def request(method, path, *, body=None, raw_body=None, headers=None):
            request_headers = {
                "X-Session-Token": server.SESSION_TOKEN,
                "Origin": ORIGIN,
                **(headers or {}),
            }
            return client.request(
                method,
                path,
                body,
                raw_body=raw_body,
                headers=request_headers,
            )

        def request_raw(method, path, *, headers=None):
            req = urllib.request.Request(
                base_url + path,
                method=method,
                headers={
                    "X-Session-Token": server.SESSION_TOKEN,
                    "Origin": ORIGIN,
                    **(headers or {}),
                },
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                response = opener.open(req, timeout=5)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                return response.status, response.headers, response.read()

        yield backend, request, request_raw


@pytest.fixture
def real_media_api(tmp_path, monkeypatch):
    """HTTP seam backed by the durable media implementation.

    These tests intentionally mock no media state.  The recognition provider
    is the only replaceable external dependency in the backend; the upload,
    persistence, and link behavior must be exercised through real SQLite and
    filesystem state.
    """
    store = SQLiteStore(tmp_path / "records.sqlite3")
    backend = LocalMediaBackend(
        store,
        tmp_path / "media",
        recognition_provider="mock",
        background=False,
    )
    monkeypatch.setattr(server, "STORE", store)
    monkeypatch.setattr(server, "MEDIA_BACKEND", backend)
    monkeypatch.setattr(server, "ALLOWED_ORIGIN", ORIGIN)
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_BYTES", str(1024 * 1024))
    monkeypatch.setenv("MEDIA_UPLOAD_PART_MAX_BYTES", str(1024 * 1024))
    monkeypatch.setenv("MEDIA_UPLOAD_MAX_PARTS", "4")

    # The test fixture models an explicitly enabled local deployment.
    # Production/local startup without these settings must remain disabled.

    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url)

        def request(method, path, *, body=None, raw_body=None, headers=None):
            request_headers = {
                "X-Session-Token": server.SESSION_TOKEN,
                "Origin": ORIGIN,
                **(headers or {}),
            }
            return client.request(
                method,
                path,
                body,
                raw_body=raw_body,
                headers=request_headers,
            )

        yield backend, request


def create_upload(request, *, key="create-1"):
    payload, content_type = multipart(
        {
            "kind": "image",
            "content_type": "image/png",
            "total_parts": 1,
            "expected_size": len(PNG),
            "expected_sha256": hashlib.sha256(PNG).hexdigest(),
            "original_filename": "检查单.png",
        }
    )
    return request(
        "POST",
        "/api/media/uploads",
        raw_body=payload,
        headers={"Content-Type": content_type, "Idempotency-Key": key},
    )


def upload_part(request, *, payload=PNG, key="part-1"):
    body, content_type = multipart(
        files=[("file", "part.bin", "application/octet-stream", payload)]
    )
    return request(
        "POST",
        "/api/media/uploads/upload_1/parts/0",
        raw_body=body,
        headers={"Content-Type": content_type, "Idempotency-Key": key},
    )


def complete_upload(request, *, key="complete-1"):
    return request(
        "POST",
        "/api/media/uploads/upload_1/complete",
        body={},
        headers={"Content-Type": "application/json", "Idempotency-Key": key},
    )


def create_real_upload(request, *, key, payload=PNG):
    body, content_type = multipart(
        {
            "kind": "image",
            "content_type": "image/png",
            "total_parts": 1,
            "expected_size": len(payload),
            "expected_sha256": hashlib.sha256(payload).hexdigest(),
            "original_filename": "检查单.png",
        }
    )
    response = request(
        "POST",
        "/api/media/uploads",
        raw_body=body,
        headers={"Content-Type": content_type, "Idempotency-Key": key},
    )
    assert response.status == 201
    return response.body["upload"]


def save_real_media(request, *, prefix="real", payload=PNG, complete_key=None):
    upload = create_real_upload(request, key=f"{prefix}-create", payload=payload)
    part_body, part_content_type = multipart(
        files=[("file", "part.bin", "application/octet-stream", payload)]
    )
    part = request(
        "POST",
        f"/api/media/uploads/{upload['upload_id']}/parts/0",
        raw_body=part_body,
        headers={
            "Content-Type": part_content_type,
            "Idempotency-Key": f"{prefix}-part",
        },
    )
    assert part.status == 201
    completed = request(
        "POST",
        f"/api/media/uploads/{upload['upload_id']}/complete",
        body={},
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": complete_key or f"{prefix}-complete",
        },
    )
    assert completed.status == 201
    return completed.body["media"]


def saved_media(request):
    assert create_upload(request).status == 201
    assert upload_part(request).status == 201
    completed = complete_upload(request)
    assert completed.status == 201
    return completed.body["media"]


def test_chunked_multipart_upload_completes_before_media_is_published(api):
    backend, request, _ = api

    created = create_upload(request)
    assert created.status == 201
    assert created.body["created"] is True
    assert created.body["upload"]["upload_id"] == "upload_1"
    assert request("GET", "/api/media").body == {"ok": True, "media": []}

    part = upload_part(request)
    assert part.status == 201
    assert part.body == {
        "ok": True,
        "created": True,
        "part": {"upload_id": "upload_1", "index": 0, "size_bytes": len(PNG)},
    }

    completed = complete_upload(request)
    assert completed.status == 201
    assert completed.body["media"]["save_status"] == "saved"
    assert completed.body["media"]["sha256"] == hashlib.sha256(PNG).hexdigest()
    assert "original" not in completed.body["media"]
    assert backend.media["media_1"]["original"] == PNG


def test_upload_and_part_replays_are_idempotent_but_changed_payload_conflicts(api):
    _, request, _ = api
    assert create_upload(request, key="same-create").status == 201
    replay = create_upload(request, key="same-create")
    assert replay.status == 200
    assert replay.body["created"] is False

    assert upload_part(request, key="same-part").status == 201
    replay = upload_part(request, key="same-part")
    assert replay.status == 200
    assert replay.body["created"] is False

    changed = upload_part(request, payload=PNG + b"changed", key="same-part")
    assert changed.status == 409
    assert changed.body == {
        "ok": False,
        "error": "idempotency_key_payload_mismatch",
    }


def test_media_list_detail_and_original_use_ids_without_exposing_paths(api):
    _, request, request_raw = api
    media = saved_media(request)

    listing = request("GET", "/api/media")
    detail = request("GET", "/api/media/media_1")
    status, headers, original = request_raw("GET", "/api/media/media_1/original")

    assert listing.status == 200
    assert listing.body == {"ok": True, "media": [media]}
    assert detail.status == 200
    assert detail.body == {"ok": True, "media": media}
    assert all("path" not in key for key in detail.body["media"])
    assert status == 200
    assert headers["Content-Type"] == "image/png"
    assert headers["Accept-Ranges"] == "bytes"
    assert original == PNG

    status, headers, partial = request_raw(
        "GET", "/api/media/media_1/original", headers={"Range": "bytes=1-4"}
    )
    assert status == 206
    assert headers["Content-Range"] == f"bytes 1-4/{len(PNG)}"
    assert partial == PNG[1:5]


@pytest.mark.parametrize(
    "path",
    [
        "/api/media/../server.py/original",
        "/api/media/%2e%2e%2fserver.py/original",
        "/api/media/media_missing/original",
    ],
)
def test_original_endpoint_cannot_read_arbitrary_paths(api, path):
    _, _, request_raw = api
    status, headers, payload = request_raw("GET", path)
    assert status == 404
    assert headers["Content-Type"].startswith("application/json")
    result = json.loads(payload)
    assert result["ok"] is False
    assert result["error"] in {"media_not_found", "not_found"}
    assert "/Users/" not in payload.decode()


def test_recognition_is_accepted_once_and_status_is_read_from_media_detail(api):
    backend, request, _ = api
    media = saved_media(request)
    body = {"expected_version": media["version"]}
    headers = {"Content-Type": "application/json", "Idempotency-Key": "recognize-1"}

    started = request(
        "POST", "/api/media/media_1/recognize", body=body, headers=headers
    )
    replay = request(
        "POST", "/api/media/media_1/recognize", body=body, headers=headers
    )
    detail = request("GET", "/api/media/media_1")

    assert started.status == 202
    assert started.body["accepted"] is True
    assert started.body["attempt_id"] == "attempt_1"
    assert replay.status == 202
    assert replay.body["attempt_id"] == "attempt_1"
    assert backend.recognition_calls == ["media_1"]
    assert detail.body["media"]["recognition_status"] == "processing"


def test_mock_recognition_replay_returns_existing_failure(real_media_api):
    _, request = real_media_api
    media = save_real_media(request, prefix="recognize-success")
    headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": "recognize-success-first",
    }

    first = request(
        "POST",
        f"/api/media/{media['media_id']}/recognize",
        body={"expected_version": media["version"]},
        headers=headers,
    )
    current = request("GET", f"/api/media/{media['media_id']}").body["media"]
    replay = request(
        "POST",
        f"/api/media/{media['media_id']}/recognize",
        body={"expected_version": media["version"]},
        headers=headers,
    )

    assert first.status == 202
    assert current["recognition_status"] == "failed"
    assert current["recognition"]["error_code"] == "provider_mock"
    assert replay.status == 202
    assert replay.body["attempt_id"] == first.body["attempt_id"]
    assert replay.body["media"]["recognition_status"] == "failed"
    assert replay.body["media"]["recognition"]["error_code"] == "provider_mock"


def test_media_writes_keep_existing_session_and_origin_protection(api):
    _, request, _ = api
    payload, content_type = multipart(
        {"kind": "image", "content_type": "image/png", "total_parts": 1}
    )

    no_token = request(
        "POST",
        "/api/media/uploads",
        raw_body=payload,
        headers={
            "Content-Type": content_type,
            "Idempotency-Key": "no-token",
            "X-Session-Token": "wrong",
        },
    )
    wrong_origin = request(
        "POST",
        "/api/media/uploads",
        raw_body=payload,
        headers={
            "Content-Type": content_type,
            "Idempotency-Key": "wrong-origin",
            "Origin": "https://unexpected.example",
        },
    )

    assert no_token.status == 403
    assert no_token.body == {"ok": False, "error": "csrf_or_origin_rejected"}
    assert wrong_origin.status == 403
    assert wrong_origin.body == {"ok": False, "error": "csrf_or_origin_rejected"}


def test_multipart_request_has_an_explicit_transport_protection_limit(api, monkeypatch):
    _, request, _ = api
    monkeypatch.setattr(server, "MAX_MEDIA_REQUEST_BYTES", 32, raising=False)
    payload, content_type = multipart(
        files=[("file", "part.bin", "application/octet-stream", PNG)]
    )

    response = request(
        "POST",
        "/api/media/uploads/upload_1/parts/0",
        raw_body=payload,
        headers={"Content-Type": content_type, "Idempotency-Key": "too-large"},
    )

    assert response.status == 413
    assert response.body == {"ok": False, "error": "request_too_large"}


def test_recognition_failure_does_not_hide_the_saved_original(api):
    backend, request, request_raw = api
    saved_media(request)

    def fail_recognition(*_args, **_kwargs):
        backend.media["media_1"]["recognition_status"] = "failed"
        backend.media["media_1"]["error"] = {
            "code": "provider_timeout",
            "message": "识别服务超时，可稍后重试",
            "retryable": True,
        }
        raise StoreError("provider_timeout")

    backend.start_recognition = fail_recognition
    response = request(
        "POST",
        "/api/media/media_1/recognize",
        body={"expected_version": 1},
        headers={"Content-Type": "application/json", "Idempotency-Key": "failure"},
    )

    assert response.status == 400
    assert response.body == {"ok": False, "error": "provider_timeout"}
    detail = request("GET", "/api/media/media_1")
    assert detail.body["media"]["recognition_status"] == "failed"
    assert detail.body["media"]["error"]["retryable"] is True
    assert request_raw("GET", "/api/media/media_1/original")[2] == PNG


def test_media_capabilities_publish_configured_protection_boundaries(real_media_api):
    _, request = real_media_api

    response = request("GET", "/api/media/capabilities")

    assert response.status == 200
    capabilities = response.body["capabilities"]
    assert response.body["ok"] is True
    assert capabilities["enabled"] is True
    assert capabilities["disabled_reason"] is None
    assert capabilities["max_total_bytes"] == 1024 * 1024
    assert capabilities["max_part_bytes"] == 1024 * 1024
    assert capabilities["max_parts"] == 4
    assert capabilities["max_audio_duration_seconds"] is None
    assert capabilities["max_image_pixels"] is None
    assert capabilities["multipart_upload"] is True
    assert capabilities["resumable_parts"] is True
    assert "audio/wav" in capabilities["audio_content_types"]
    assert "image/png" in capabilities["image_content_types"]


@pytest.mark.parametrize(
    "limits",
    [
        {},
        {
            "MEDIA_UPLOAD_MAX_BYTES": "0",
            "MEDIA_UPLOAD_PART_MAX_BYTES": "1048576",
            "MEDIA_UPLOAD_MAX_PARTS": "4",
        },
        {
            "MEDIA_UPLOAD_MAX_BYTES": "1048576",
            "MEDIA_UPLOAD_PART_MAX_BYTES": "not-a-number",
            "MEDIA_UPLOAD_MAX_PARTS": "4",
        },
        {
            "MEDIA_UPLOAD_MAX_BYTES": "1048576",
            "MEDIA_UPLOAD_PART_MAX_BYTES": "1048576",
            "MEDIA_UPLOAD_MAX_PARTS": "-1",
        },
    ],
)
def test_media_write_is_disabled_without_valid_protection_boundaries(
    real_media_api, monkeypatch, limits
):
    _, request = real_media_api
    for name in (
        "MEDIA_UPLOAD_MAX_BYTES",
        "MEDIA_UPLOAD_PART_MAX_BYTES",
        "MEDIA_UPLOAD_MAX_PARTS",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in limits.items():
        monkeypatch.setenv(name, value)

    body, content_type = multipart(
        {
            "kind": "image",
            "content_type": "image/png",
            "total_parts": 1,
            "expected_size": len(PNG),
            "expected_sha256": hashlib.sha256(PNG).hexdigest(),
            "original_filename": "检查单.png",
        }
    )
    response = request(
        "POST",
        "/api/media/uploads",
        raw_body=body,
        headers={"Content-Type": content_type, "Idempotency-Key": "limits-off"},
    )

    assert response.status == 503
    assert response.body == {"ok": False, "error": "media_limits_not_configured"}


def test_complete_upload_replay_is_idempotent_and_key_reuse_conflicts(
    real_media_api,
):
    _, request = real_media_api
    first = save_real_media(request, prefix="complete-first")

    replay = request(
        "POST",
        "/api/media/uploads/" + first["upload_id"] + "/complete",
        body={},
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": "complete-first-complete",
        },
    )
    assert replay.status == 200
    assert replay.body["created"] is False
    assert replay.body["media"]["media_id"] == first["media_id"]

    second = create_real_upload(request, key="complete-second-create")
    part_body, part_content_type = multipart(
        files=[("file", "part.bin", "application/octet-stream", PNG)]
    )
    part = request(
        "POST",
        f"/api/media/uploads/{second['upload_id']}/parts/0",
        raw_body=part_body,
        headers={
            "Content-Type": part_content_type,
            "Idempotency-Key": "complete-second-part",
        },
    )
    assert part.status == 201

    conflict = request(
        "POST",
        f"/api/media/uploads/{second['upload_id']}/complete",
        body={},
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": "complete-first-complete",
        },
    )
    assert conflict.status == 409
    assert conflict.body == {
        "ok": False,
        "error": "idempotency_key_payload_mismatch",
    }


def test_link_rejects_an_expired_expected_version(real_media_api):
    backend, request = real_media_api
    media = save_real_media(request, prefix="link-version")

    claim = backend.event_store.claim_media_recognition(
        media["media_id"],
        expected_version=media["version"],
        idempotency_key="link-version-recognize",
        actor="老人",
    )
    attempt_id = claim["attempt"]["attempt_id"]
    backend.event_store.save_media_recognition_text(
        media["media_id"],
        attempt_id,
        text="胸闷，需要人工核对。",
        provider="mock",
        model="mock-recognition-v1",
        is_mock=True,
        actor="老人",
    )
    backend.event_store.save_media_recognition_safety(
        media["media_id"],
        attempt_id,
        safety={},
        actor="老人",
    )
    current = backend.event_store.get_media(media["media_id"])

    response = request(
        "POST",
        f"/api/media/{media['media_id']}/link",
        body={"expected_version": current["version"] - 1},
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": "link-version-stale",
        },
    )

    assert response.status == 409
    assert response.body == {"ok": False, "error": "stale_version"}


def test_handoff_snapshot_includes_failed_media_for_authenticated_household(
    real_media_api,
):
    backend, request = real_media_api
    household = backend.event_store.create_household("失败媒体家庭", "老人")
    session = backend.event_store.login(
        user_id=household["user_id"], household_id=household["household_id"]
    )

    def household_request(method, path, *, body=None, raw_body=None, headers=None):
        return request(
            method,
            path,
            body=body,
            raw_body=raw_body,
            headers={"X-Auth-Token": session["token"], **(headers or {})},
        )

    media = save_real_media(household_request, prefix="handoff-failed")
    backend.recognition_provider = "unconfigured"
    failed = household_request(
        "POST",
        f"/api/media/{media['media_id']}/recognize",
        body={"expected_version": media["version"]},
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": "handoff-failed-recognize",
        },
    )
    assert failed.status == 202
    assert failed.body["media"]["recognition_status"] == "failed"

    handoff = household_request("POST", "/api/handoffs", body={})

    assert handoff.status == 201
    attachments = handoff.body["handoff"]["media_attachments"]
    assert attachments == [
        {
            "media_id": media["media_id"],
            "kind": "image",
            "save_status": "saved",
            "recognition_status": "failed",
            "is_mock": None,
            "link_status": "not_linked",
            "record_id": None,
            "pending_reason": "provider_not_configured",
            "has_text": False,
            "local_safety": None,
            "unresolved": True,
            "unresolved_reasons": [
                "media_recognition_failed",
                "media_event_not_linked",
            ],
        }
    ]
