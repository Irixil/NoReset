"""Orchestrate recognition for immutable, already-saved media originals.

The module owns ordering and recovery policy, not files, SQL, HTTP, ASR, or
OCR.  Its store interface is the seam shared with the parallel media-store
slice; the store remains responsible for transactional compare-and-set,
idempotency, attempt freshness, and the unique media-to-Event constraint.
"""

from __future__ import annotations

from os import PathLike
from typing import Any, Callable, Mapping, Protocol

from .recognition import RecognitionError, recognize_file


class MediaRecognitionStore(Protocol):
    """Minimal persistence interface required by the orchestration module."""

    def claim_media_recognition(
        self,
        media_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        actor: str,
    ) -> Mapping[str, Any]: ...

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
    ) -> Mapping[str, Any]: ...

    def save_media_recognition_safety(
        self,
        media_id: str,
        attempt_id: str,
        *,
        safety: Mapping[str, Any],
        actor: str,
    ) -> Mapping[str, Any]: ...

    def save_media_recognition_failure(
        self,
        media_id: str,
        attempt_id: str,
        *,
        code: str,
        message: str,
        retryable: bool,
        actor: str,
    ) -> Mapping[str, Any]: ...

    def create_and_link_media_event(
        self,
        media_id: str,
        attempt_id: str,
        *,
        payload: Mapping[str, Any],
        idempotency_key: str,
        actor: str,
        household_id: str,
    ) -> Mapping[str, Any]: ...


class MediaFileStore(Protocol):
    """Resolve a server-owned media ID to its already-saved original."""

    def get_original_path(self, media_id: str) -> str | PathLike[str]: ...


class MediaRecognitionService:
    """Run recognition and Event linkage behind one narrow interface."""

    def __init__(
        self,
        store: MediaRecognitionStore,
        file_store: MediaFileStore,
        *,
        recognizer: Callable[..., Mapping[str, Any]] = recognize_file,
    ) -> None:
        self._store = store
        self._file_store = file_store
        self._recognizer = recognizer

    def recognize_media(
        self,
        media_id: str,
        expected_version: int,
        idempotency_key: str,
        actor: str,
        provider: str | None = None,
    ) -> dict[str, Any]:
        claim = dict(
            self._store.claim_media_recognition(
                media_id,
                expected_version=expected_version,
                idempotency_key=idempotency_key,
                actor=actor,
            )
        )
        if claim.get("action") != "claimed":
            return claim
        return self.process_claimed(claim, actor=actor, provider=provider)

    def process_claimed(
        self,
        claim: Mapping[str, Any],
        *,
        actor: str,
        provider: str | None = None,
    ) -> dict[str, Any]:
        """Finish a persisted claim without claiming or billing twice."""

        media = claim["media"]
        attempt = claim["attempt"]
        media_id = media["media_id"]
        attempt_id = attempt["attempt_id"]
        try:
            result = self._recognizer(
                self._file_store.get_original_path(media_id),
                kind=media["kind"],
                content_type=media["content_type"],
                attempt_id=attempt_id,
                provider=provider,
            )
        except RecognitionError as error:
            return dict(
                self._store.save_media_recognition_failure(
                    media_id,
                    attempt_id,
                    code=error.code,
                    message=error.message,
                    retryable=error.retryable,
                    actor=actor,
                )
            )
        except Exception:
            return dict(
                self._store.save_media_recognition_failure(
                    media_id,
                    attempt_id,
                    code="provider_unavailable",
                    message="识别服务暂时不可用，可稍后重试",
                    retryable=True,
                    actor=actor,
                )
            )
        if result.get("is_mock") is True:
            return dict(
                self._store.save_media_recognition_failure(
                    media_id,
                    attempt_id,
                    code="provider_mock",
                    message="模拟识别结果不能作为真实转写记录",
                    retryable=True,
                    actor=actor,
                )
            )
        saved = dict(
            self._store.save_media_recognition_text(
                media_id,
                attempt_id,
                text=result["text"],
                provider=result["provider"],
                model=result.get("model"),
                is_mock=result["is_mock"],
                actor=actor,
            )
        )
        # The orchestrator owns ordering; the persistence layer only stores
        # the scanner result supplied here.  This keeps one scanner execution
        # and prevents rules from drifting between layers.
        from .safety import scan_danger
        safety = scan_danger(result["text"])
        scanned = dict(
            self._store.save_media_recognition_safety(
                media_id,
                attempt_id,
                safety=safety,
                actor=actor,
            )
        )
        media = scanned.get("media", saved["media"])
        attempt = scanned.get("attempt", saved["attempt"])
        source_kind = "audio_transcript" if media["kind"] == "audio" else "document"
        return dict(
            self._store.create_and_link_media_event(
                media_id,
                attempt_id,
                payload={
                    "raw_text": attempt["text"],
                    "source_kind": source_kind,
                    "actor_name": media.get("actor_name") or actor,
                    "occurred_time": media.get("occurred_time"),
                    "related_record_ids": [],
                },
                idempotency_key=f"media-event:{media_id}:{attempt_id}",
                actor=actor,
                household_id=media.get("household_id", "hh_local_default"),
            )
        )
