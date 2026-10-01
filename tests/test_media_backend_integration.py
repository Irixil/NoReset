import hashlib

from backend.media_backend import LocalMediaBackend, create_default_media_backend
from backend.store import SQLiteStore


PNG = b"\x89PNG\r\n\x1a\n" + b"integrated-media"


def backend(tmp_path):
    return LocalMediaBackend(
        SQLiteStore(tmp_path / "records.sqlite3"),
        tmp_path / "media",
        recognition_provider="mock",
    )


def test_default_backend_requires_explicit_recognition_provider(tmp_path, monkeypatch):
    monkeypatch.delenv("MEDIA_RECOGNITION_PROVIDER", raising=False)
    media_backend = create_default_media_backend(
        SQLiteStore(tmp_path / "records.sqlite3"), root=tmp_path / "media"
    )

    assert media_backend.recognition_provider is None


def upload_image(media_backend):
    upload, created = media_backend.create_upload(
        {
            "kind": "image",
            "content_type": "image/png",
            "total_parts": 1,
            "expected_size": len(PNG),
            "expected_sha256": hashlib.sha256(PNG).hexdigest(),
            "original_filename": "检查单.png",
            "actor_name": "老人",
        },
        "upload-image-1",
    )
    assert created is True
    media_backend.write_part(upload["upload_id"], 0, PNG, "part-image-1")
    media, completed = media_backend.complete_upload(
        upload["upload_id"], "complete-image-1"
    )
    assert completed is True
    return media


def test_default_backend_persists_original_and_survives_reopen(tmp_path):
    media_backend = backend(tmp_path)
    media = upload_image(media_backend)

    assert media["save_status"] == "saved"
    assert media["size_bytes"] == len(PNG)
    assert media["sha256"] == hashlib.sha256(PNG).hexdigest()
    assert "relative_path" not in media
    with media_backend.open_original(media["media_id"]) as original:
        assert original.read() == PNG


def test_upload_create_replay_reuses_persisted_integrity_declarations(tmp_path):
    media_backend = backend(tmp_path)
    payload = {
        "kind": "image",
        "content_type": "image/png",
        "total_parts": 1,
        "expected_size": len(PNG),
        "expected_sha256": hashlib.sha256(PNG).hexdigest(),
        "original_filename": "检查单.png",
        "actor_name": "老人",
    }
    first, created = media_backend.create_upload(payload, "same-upload")
    replay, replay_created = media_backend.create_upload(payload, "same-upload")
    assert created is True
    assert replay_created is False
    assert replay["upload_id"] == first["upload_id"]
    assert replay["media_id"] == first["media_id"]


def test_default_backend_mock_recognition_fails_without_creating_patient_event(tmp_path):
    media_backend = backend(tmp_path)
    media = upload_image(media_backend)

    first = media_backend.start_recognition(
        media["media_id"],
        media["version"],
        "recognize-image-1",
        actor="老人",
    )
    replay = media_backend.start_recognition(
        media["media_id"],
        media["version"],
        "recognize-image-1",
        actor="老人",
    )

    assert first["attempt"].get("text") is None
    assert first["attempt"]["is_mock"] is None
    assert first["attempt"]["status"] == "failed"
    assert first["attempt"]["error_code"] == "provider_mock"
    assert first["media"]["recognition_status"] == "failed"
    assert first["media"]["link_status"] == "not_linked"
    assert replay["attempt"]["attempt_id"] == first["attempt"]["attempt_id"]
    assert len(media_backend.event_store.list()) == 0


def test_unconfigured_recognition_keeps_saved_original(tmp_path):
    media_backend = LocalMediaBackend(
        SQLiteStore(tmp_path / "records.sqlite3"),
        tmp_path / "media",
        recognition_provider="unconfigured",
    )
    media = upload_image(media_backend)

    result = media_backend.start_recognition(
        media["media_id"],
        media["version"],
        "recognize-unconfigured",
        actor="老人",
    )

    assert result["media"]["recognition_status"] == "failed"
    assert result["attempt"]["error_code"] == "provider_not_configured"
    with media_backend.open_original(media["media_id"]) as original:
        assert original.read() == PNG


def test_pending_link_reuses_saved_text_without_recognizing_again(tmp_path):
    media_backend = backend(tmp_path)
    media = upload_image(media_backend)
    claim = media_backend.event_store.claim_media_recognition(
        media["media_id"],
        expected_version=media["version"],
        idempotency_key="claim-only",
        actor="老人",
    )
    attempt_id = claim["attempt"]["attempt_id"]
    text = "检查单显示胸闷，需要人工核对。"
    media_backend.event_store.save_media_recognition_text(
        media["media_id"],
        attempt_id,
        text=text,
        provider="mock",
        model="mock-recognition-v1",
        is_mock=False,
        actor="老人",
    )
    media_backend.event_store.save_media_recognition_safety(
        media["media_id"],
        attempt_id,
        safety={},
        actor="老人",
    )

    linked = media_backend.link_media(
        media["media_id"],
        "link-saved-text",
        actor="老人",
    )
    replay = media_backend.link_media(
        media["media_id"],
        "link-replay",
        actor="老人",
    )

    assert linked["event_created"] is True
    assert linked["event"]["raw_text"] == text
    assert linked["event"]["local_safety"]["danger_detected"] is True
    assert replay["event_created"] is False
    assert replay["event"]["record_id"] == linked["event"]["record_id"]


def test_handoff_snapshot_keeps_failed_media_without_an_event(tmp_path):
    media_backend = LocalMediaBackend(
        SQLiteStore(tmp_path / "records.sqlite3"),
        tmp_path / "media",
        recognition_provider="unconfigured",
    )
    media = upload_image(media_backend)
    media_backend.start_recognition(
        media["media_id"],
        media["version"],
        "recognize-failed-for-handoff",
        actor="老人",
    )

    handoff = media_backend.event_store.handoff()
    attachment = handoff["media_attachments"][0]
    assert attachment == {
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
        "unresolved_reasons": ["media_recognition_failed", "media_event_not_linked"],
    }
    saved_snapshot = media_backend.event_store.get_handoff(handoff["handoff_id"])
    assert saved_snapshot["media_attachments"] == [attachment]
