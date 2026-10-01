import hashlib

import pytest

from backend.store import Conflict, SQLiteStore


MEDIA_ID = "media_0123456789abcdef0123456789abcdef"
UPLOAD_ID = "upload_0123456789abcdef0123456789abcdef"


def upload_payload(**overrides):
    payload = {
        "kind": "audio",
        "content_type": "audio/wav",
        "original_filename": "voice.wav",
        "total_parts": 2,
        "actor_name": "老人",
        "occurred_time": "2026-09-12T08:30:00+08:00",
    }
    payload.update(overrides)
    return payload


def saved_media(store, *, parts=1, **overrides):
    payload = upload_payload(total_parts=parts, **overrides)
    media, _ = store.create_media_upload(
        payload,
        "upload-request-1",
        upload_id=UPLOAD_ID,
        media_id=MEDIA_ID,
    )
    for index in range(parts):
        content = f"part-{index}".encode()
        store.record_media_part(
            UPLOAD_ID,
            index,
            relative_path=f".uploads/upload-safe/parts/{index:08d}.part",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
        )
    return store.complete_media_upload(
        UPLOAD_ID,
        size_bytes=12,
        sha256=hashlib.sha256(b"RIFFWAVEdata").hexdigest(),
        relative_path=f"{MEDIA_ID}/original",
        content_type=payload["content_type"],
    )[0]


def test_trusted_file_ids_parts_and_completed_original_are_durable(tmp_path):
    database = tmp_path / "records.sqlite3"
    store = SQLiteStore(database)
    media, created = store.create_media_upload(
        upload_payload(),
        "upload-request-1",
        upload_id=UPLOAD_ID,
        media_id=MEDIA_ID,
    )

    assert created is True
    assert media["upload_id"] == UPLOAD_ID
    assert media["media_id"] == MEDIA_ID
    assert media["actor_name"] == "老人"
    assert media["occurred_time"] == "2026-09-12T08:30:00+08:00"

    first, first_created = store.record_media_part(
        UPLOAD_ID,
        0,
        relative_path=".uploads/upload-safe/parts/00000000.part",
        size_bytes=4,
        sha256=hashlib.sha256(b"RIFF").hexdigest(),
    )
    replay, replay_created = store.record_media_part(
        UPLOAD_ID,
        0,
        relative_path=".uploads/upload-safe/parts/00000000.part",
        size_bytes=4,
        sha256=hashlib.sha256(b"RIFF").hexdigest(),
    )

    assert first_created is True
    assert replay_created is False
    assert replay == first
    with pytest.raises(Conflict, match="^media_part_conflict$"):
        store.record_media_part(
            UPLOAD_ID,
            0,
            relative_path=".uploads/upload-safe/parts/00000000.part",
            size_bytes=5,
            sha256=hashlib.sha256(b"other").hexdigest(),
        )

    store.record_media_part(
        UPLOAD_ID,
        1,
        relative_path=".uploads/upload-safe/parts/00000001.part",
        size_bytes=8,
        sha256=hashlib.sha256(b"WAVEdata").hexdigest(),
    )
    digest = hashlib.sha256(b"RIFFWAVEdata").hexdigest()
    completed, completed_now = store.complete_media_upload(
        UPLOAD_ID,
        size_bytes=12,
        sha256=digest,
        relative_path=f"{MEDIA_ID}/original",
        content_type="audio/wav",
    )

    assert completed_now is True
    assert completed["save_status"] == "saved"
    assert completed["upload_status"] == "saved"
    assert completed["size_bytes"] == 12
    assert completed["sha256"] == digest
    assert completed["saved_at"]
    assert completed["version"] == 4
    assert "relative_path" not in completed

    reopened = SQLiteStore(database).get_media(MEDIA_ID)
    assert reopened == completed


def test_recognition_claim_is_idempotent_exclusive_and_restart_recoverable(tmp_path):
    database = tmp_path / "records.sqlite3"
    store = SQLiteStore(database)
    media = saved_media(store)

    first = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-1",
        actor="老人",
    )
    replay = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-1",
        actor="老人",
    )
    concurrent = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-concurrent",
        actor="老人",
    )

    assert first["action"] == "claimed"
    assert replay["action"] == "existing"
    assert concurrent["action"] == "existing"
    assert replay["attempt"]["attempt_id"] == first["attempt"]["attempt_id"]
    assert concurrent["attempt"]["attempt_id"] == first["attempt"]["attempt_id"]
    assert len(store.get_media(MEDIA_ID)["attempts"]) == 1

    reopened = SQLiteStore(database)
    interrupted = reopened.get_media(MEDIA_ID)
    assert interrupted["recognition_status"] == "interrupted"
    assert interrupted["latest_attempt"]["status"] == "interrupted"

    retry = reopened.claim_media_recognition(
        MEDIA_ID,
        expected_version=interrupted["version"],
        idempotency_key="recognize-2",
        actor="老人",
    )
    assert retry["action"] == "claimed"
    assert retry["attempt"]["attempt_id"] != first["attempt"]["attempt_id"]
    assert len(reopened.get_media(MEDIA_ID)["attempts"]) == 2

    with pytest.raises(Conflict, match="^stale_recognition_attempt$"):
        reopened.save_media_recognition_text(
            MEDIA_ID,
            first["attempt"]["attempt_id"],
            text="迟到的旧结果",
            provider="mock",
            model="mock-v1",
            is_mock=True,
            actor="老人",
        )


def test_full_text_safety_and_one_event_link_survive_human_revision(tmp_path):
    store = SQLiteStore(tmp_path / "records.sqlite3")
    media = saved_media(store)
    claim = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-danger",
        actor="老人",
    )
    attempt_id = claim["attempt"]["attempt_id"]
    original_text = "今天胸闷，而且喘不上气。"

    saved = store.save_media_recognition_text(
        MEDIA_ID,
        attempt_id,
        text=original_text,
        provider="mock",
        model="mock-recognition-v1",
        is_mock=False,
        actor="老人",
    )
    scanned = store.save_media_recognition_safety(
        MEDIA_ID,
        attempt_id,
        safety={
            "danger_detected": True,
            "escalation_level": "emergency",
            "review_role": "emergency_services",
            "danger_reminder": "will be verified against the local scanner",
            "matched_rules": ["chest", "breathing"],
            "safety_rule_version": "offline-danger-v1",
        },
        actor="老人",
    )
    linked = store.create_and_link_media_event(
        MEDIA_ID,
        attempt_id,
        payload={
            "raw_text": original_text,
            "source_kind": "audio_transcript",
            "actor_name": "不允许覆盖上传人",
            "occurred_time": None,
            "related_record_ids": [],
        },
        idempotency_key="media-event-1",
        actor="系统",
        household_id="hh_local_default",
    )
    replay = store.create_and_link_media_event(
        MEDIA_ID,
        attempt_id,
        payload={"raw_text": original_text},
        idempotency_key="media-event-replay",
        actor="系统",
        household_id="hh_local_default",
    )

    assert saved["attempt"]["text"] == original_text
    assert scanned["attempt"]["local_safety"]["danger_detected"] is True
    assert linked["event_created"] is True
    assert replay["event_created"] is False
    assert replay["event"]["record_id"] == linked["event"]["record_id"]
    assert linked["event"]["actor_name"] == "老人"
    assert linked["event"]["occurred_time"] == "2026-09-12T08:30:00+08:00"
    assert linked["event"]["local_safety"]["danger_detected"] is True
    assert len(store.list()) == 1

    revised = store.revise(
        linked["event"]["record_id"],
        1,
        {
            "raw_text": "人工核对后的文字",
            "source_kind": "audio_transcript",
            "actor_name": "家属",
            "occurred_time": "2026-09-12T08:30:00+08:00",
            "related_record_ids": [],
            "reason": "修正语音识别错字",
        },
        "家属",
    )
    assert revised["raw_text"] == "人工核对后的文字"
    assert store.get_media(MEDIA_ID)["latest_attempt"]["text"] == original_text


def test_failure_and_too_long_text_remain_queryable_without_fake_event(tmp_path):
    database = tmp_path / "records.sqlite3"
    store = SQLiteStore(database)
    media = saved_media(store)
    claim = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-failed",
        actor="老人",
    )
    failed = store.save_media_recognition_failure(
        MEDIA_ID,
        claim["attempt"]["attempt_id"],
        code="provider_timeout",
        message="vendor token and internal stack must not leak",
        retryable=True,
        actor="老人",
    )

    assert failed["media"]["recognition_status"] == "failed"
    assert failed["attempt"]["error_code"] == "provider_timeout"
    assert "vendor" not in failed["attempt"]["error_message"]
    assert failed["attempt"]["retryable"] is True

    retry = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=failed["media"]["version"],
        idempotency_key="recognize-retry",
        actor="老人",
    )
    text = "胸闷" + "症" * 10_001
    store.save_media_recognition_text(
        MEDIA_ID,
        retry["attempt"]["attempt_id"],
        text=text,
        provider="mock",
        model="mock-recognition-v1",
        is_mock=False,
        actor="老人",
    )
    safety = __import__("backend.safety", fromlist=["scan_danger"]).scan_danger(text)
    store.save_media_recognition_safety(
        MEDIA_ID,
        retry["attempt"]["attempt_id"],
        safety=safety,
        actor="老人",
    )
    pending = store.create_and_link_media_event(
        MEDIA_ID,
        retry["attempt"]["attempt_id"],
        payload={"raw_text": text},
        idempotency_key="media-event-too-long",
        actor="系统",
        household_id="hh_local_default",
    )

    assert pending["linked"] is False
    assert pending["media"]["link_status"] == "pending"
    assert pending["media"]["link_pending_reason"] == "raw_text_too_long"
    assert pending["attempt"]["text"] == text
    assert store.list() == []

    reopened = SQLiteStore(database).get_media(MEDIA_ID)
    assert reopened["link_status"] == "pending"
    assert reopened["latest_attempt"]["text"] == text
    assert reopened["local_safety"]["danger_detected"] is True


def test_mock_recognition_cannot_be_linked_as_a_patient_event(tmp_path):
    store = SQLiteStore(tmp_path / "records.sqlite3")
    media = saved_media(store)
    claim = store.claim_media_recognition(
        MEDIA_ID,
        expected_version=media["version"],
        idempotency_key="recognize-mock",
        actor="老人",
    )
    attempt_id = claim["attempt"]["attempt_id"]
    store.save_media_recognition_text(
        MEDIA_ID, attempt_id, text="[Mock ASR] voice.wav", provider="mock",
        model="mock-recognition-v1", is_mock=True, actor="老人",
    )
    store.save_media_recognition_safety(
        MEDIA_ID, attempt_id, safety={"danger_detected": False}, actor="老人",
    )

    with pytest.raises(Conflict, match="^mock_recognition_not_linkable$"):
        store.create_and_link_media_event(
            MEDIA_ID, attempt_id, payload={"raw_text": "[Mock ASR] voice.wav"},
            idempotency_key="link-mock", actor="系统", household_id="hh_local_default",
        )

    assert store.list() == []
