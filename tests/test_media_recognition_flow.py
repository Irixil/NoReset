from __future__ import annotations

from pathlib import Path

from backend.media_service import MediaRecognitionService
from backend.store import SQLiteStore


class _FileStore:
    def __init__(self, originals: dict[str, Path]) -> None:
        self.originals = originals

    def get_original_path(self, media_id: str) -> Path:
        return self.originals[media_id]


class _MediaStore:
    """Media-store adapter used until the parallel store slice lands."""

    def __init__(self, event_store: SQLiteStore, media: dict) -> None:
        self.event_store = event_store
        self.media = dict(media)
        self.attempt: dict | None = None
        self.event: dict | None = None
        self._claims: dict[str, str] = {}
        self._attempt_number = 0
        self.operations: list[str] = []

    def _result(self, action: str) -> dict:
        result = {
            "action": action,
            "accepted": True,
            "media": dict(self.media),
            "attempt": dict(self.attempt or {}),
        }
        if self.event is not None:
            result["event"] = dict(self.event)
            result["event_created"] = False
        return result

    def claim_media_recognition(
        self,
        media_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        actor: str,
    ) -> dict:
        assert media_id == self.media["media_id"]
        assert expected_version == self.media["version"]
        if idempotency_key in self._claims:
            return self._result("existing")
        if self.media["recognition_status"] == "succeeded":
            self._claims[idempotency_key] = self.attempt["attempt_id"]  # type: ignore[index]
            return self._result(
                "resume_link" if self.media["link_status"] == "link_failed" else "existing"
            )
        self._attempt_number += 1
        self.attempt = {
            "attempt_id": f"attempt_{self._attempt_number}",
            "status": "processing",
            "text": None,
        }
        self.operations.append("claim")
        self.media.update(recognition_status="processing", version=expected_version + 1)
        self._claims[idempotency_key] = self.attempt["attempt_id"]
        return self._result("claimed")

    def save_media_recognition_text(
        self,
        media_id: str,
        attempt_id: str,
        *,
        text: str,
        provider: str,
        model: str | None,
        is_mock: bool,
        actor: str,
    ) -> dict:
        assert self.attempt is not None
        assert (media_id, attempt_id) == (self.media["media_id"], self.attempt["attempt_id"])
        self.attempt.update(
            status="succeeded",
            text=text,
            provider=provider,
            model=model,
            is_mock=is_mock,
        )
        self.operations.append("save_text")
        self.media.update(recognition_status="succeeded", version=self.media["version"] + 1)
        return {
            "accepted": True,
            "media": dict(self.media),
            "attempt": dict(self.attempt),
        }

    def save_media_recognition_safety(
        self,
        media_id: str,
        attempt_id: str,
        *,
        safety: dict,
        actor: str,
    ) -> dict:
        assert self.attempt is not None and self.attempt["text"] is not None
        self.attempt["local_safety"] = dict(safety)
        self.operations.append("save_safety")
        return {"media": dict(self.media), "attempt": dict(self.attempt)}

    def save_media_recognition_failure(
        self,
        media_id: str,
        attempt_id: str,
        *,
        code: str,
        message: str,
        retryable: bool,
        actor: str,
    ) -> dict:
        assert self.attempt is not None
        assert (media_id, attempt_id) == (self.media["media_id"], self.attempt["attempt_id"])
        self.attempt.update(
            status="failed",
            error_code=code,
            error_message=message,
            retryable=retryable,
        )
        self.operations.append("save_failure")
        self.media.update(recognition_status="failed", version=self.media["version"] + 1)
        return {"accepted": True, "media": dict(self.media), "attempt": dict(self.attempt)}

    def create_and_link_media_event(
        self,
        media_id: str,
        attempt_id: str,
        *,
        payload: dict,
        idempotency_key: str,
        actor: str,
        household_id: str,
    ) -> dict:
        self.operations.append("link_event")
        self.event, created = self.event_store.create(
            payload,
            idempotency_key,
            actor=actor,
            household_id=household_id,
        )
        self.media.update(link_status="linked", record_id=self.event["record_id"])
        return {
            "media": dict(self.media),
            "attempt": dict(self.attempt or {}),
            "event": dict(self.event),
            "event_created": created,
        }


def _saved_audio(tmp_path: Path) -> tuple[dict, Path]:
    path = tmp_path / "original.wav"
    path.write_bytes(b"RIFF\x04\x00\x00\x00WAVE")
    return (
        {
            "media_id": "media_1",
            "kind": "audio",
            "content_type": "audio/wav",
            "save_status": "saved",
            "recognition_status": "not_started",
            "link_status": "not_linked",
            "version": 1,
            "household_id": "hh_local_default",
        },
        path,
    )


def _synthetic_recognizer(text: str):
    def recognize(_path, **kwargs):
        return {"text": text, "provider": "synthetic-test", "model": "fixture", "is_mock": False, "attempt_id": kwargs["attempt_id"]}
    return recognize


def test_saved_audio_is_recognized_scanned_and_linked_without_auto_confirmation(tmp_path):
    media, original = _saved_audio(tmp_path)
    original_bytes = original.read_bytes()
    store = _MediaStore(SQLiteStore(tmp_path / "events.sqlite3"), media)
    service = MediaRecognitionService(store, _FileStore({"media_1": original}), recognizer=_synthetic_recognizer("我头晕"))

    result = service.recognize_media(
        "media_1",
        expected_version=1,
        idempotency_key="recognize-1",
        actor="老人",
    )

    assert result["attempt"]["text"] == "我头晕"
    assert result["attempt"]["provider"] == "synthetic-test"
    assert result["attempt"]["is_mock"] is False
    assert result["attempt"]["local_safety"]["danger_detected"] is False
    assert result["media"]["recognition_status"] == "succeeded"
    assert result["media"]["link_status"] == "linked"
    assert result["event"]["raw_text"] == "我头晕"
    assert result["event"]["source_kind"] == "audio_transcript"
    assert result["event"]["state"] == "inbox"
    assert original.read_bytes() == original_bytes
    assert store.operations == ["claim", "save_text", "save_safety", "link_event"]


def test_mock_transcript_fails_without_saving_patient_text_or_creating_event(tmp_path):
    media, original = _saved_audio(tmp_path)
    original_bytes = original.read_bytes()
    store = _MediaStore(SQLiteStore(tmp_path / "events.sqlite3"), media)
    service = MediaRecognitionService(
        store,
        _FileStore({"media_1": original}),
        recognizer=lambda _path, **kwargs: {
            "text": "[Mock ASR] original.wav", "provider": "mock", "model": "fixture",
            "is_mock": True, "attempt_id": kwargs["attempt_id"],
        },
    )

    result = service.recognize_media("media_1", 1, "recognize-mock", "老人", provider="mock")

    assert result["media"]["recognition_status"] == "failed"
    assert result["attempt"]["error_code"] == "provider_mock"
    assert result["attempt"].get("text") is None
    assert result["media"]["link_status"] == "not_linked"
    assert store.event is None
    assert store.operations == ["claim", "save_failure"]
    assert original.read_bytes() == original_bytes


def test_recognition_failure_is_persisted_without_losing_original_or_creating_event(tmp_path):
    media, original = _saved_audio(tmp_path)
    original_bytes = original.read_bytes()
    store = _MediaStore(SQLiteStore(tmp_path / "events.sqlite3"), media)
    service = MediaRecognitionService(store, _FileStore({"media_1": original}))

    result = service.recognize_media(
        "media_1",
        expected_version=1,
        idempotency_key="recognize-unconfigured",
        actor="老人",
        provider="unconfigured",
    )

    assert result["media"]["recognition_status"] == "failed"
    assert result["attempt"]["error_code"] == "provider_not_configured"
    assert result["attempt"]["error_message"] == "识别服务未配置"
    assert result["attempt"]["retryable"] is False
    assert store.event is None
    assert original.read_bytes() == original_bytes


def test_dangerous_machine_text_is_persisted_and_scanned_before_event_link(tmp_path):
    media, original = _saved_audio(tmp_path)
    dangerous_original = original.with_name("voice.wav")
    original.rename(dangerous_original)
    store = _MediaStore(SQLiteStore(tmp_path / "events.sqlite3"), media)
    service = MediaRecognitionService(
        store, _FileStore({"media_1": dangerous_original}),
        recognizer=_synthetic_recognizer("今天胸闷，而且喘不上气。"),
    )

    result = service.recognize_media(
        "media_1",
        expected_version=1,
        idempotency_key="recognize-danger",
        actor="老人",
    )

    assert result["attempt"]["text"] == "今天胸闷，而且喘不上气。"
    assert result["attempt"]["local_safety"]["danger_detected"] is True
    assert result["attempt"]["local_safety"]["danger_reminder"]
    assert result["event"]["local_safety"]["danger_detected"] is True
    assert result["event"]["state"] == "inbox"
    assert store.operations == ["claim", "save_text", "save_safety", "link_event"]


def test_same_recognition_key_replays_one_attempt_and_one_event(tmp_path):
    media, original = _saved_audio(tmp_path)
    store = _MediaStore(SQLiteStore(tmp_path / "events.sqlite3"), media)
    calls = 0

    def counted_recognize(*args, **kwargs):
        nonlocal calls
        calls += 1
        return _synthetic_recognizer("我头晕")(*args, **kwargs)

    service = MediaRecognitionService(
        store,
        _FileStore({"media_1": original}),
        recognizer=counted_recognize,
    )

    first = service.recognize_media("media_1", 1, "same-key", "老人")
    replay = service.recognize_media(
        "media_1",
        first["media"]["version"],
        "same-key",
        "老人",
    )

    assert calls == 1
    assert replay["attempt"]["attempt_id"] == first["attempt"]["attempt_id"]
    assert replay["event"]["record_id"] == first["event"]["record_id"]
    assert len(store.event_store.list()) == 1
