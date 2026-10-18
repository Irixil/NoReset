"""Exercise an already running local MVP over HTTP, without changing its config.

This command writes clearly marked synthetic records and uploads the two files
explicitly supplied by the operator. It never starts a server or selects a model.
Use only synthetic/authorized media. Default success requires real providers;
--allow-mock is an explicitly labelled offline integration regression.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import mimetypes
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence, TextIO


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")


def real_provider(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() not in {"", "none", "unconfigured", "unknown"} and "mock" not in value.lower()


def valid_base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"}):
        raise ValueError("base_url_must_be_local_http_origin")
    try:
        parsed.port
    except ValueError:
        raise ValueError("invalid_port") from None
    return value.rstrip("/")


class CheckFailed(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def response_summary(body: Any) -> dict[str, Any]:
    """Keep checkable protocol facts, never tokens, existing records or transcripts."""
    if not isinstance(body, dict):
        return {"json_type": type(body).__name__}
    keys = ("ok", "created", "accepted", "error", "failure_code", "provider", "model_id",
            "ai_failed", "raw_text_preserved", "attempt_id", "linked", "event_created")
    result = {key: body[key] for key in keys if key in body}
    for name, fields in {
        "event": ("record_id", "version", "state", "supersedes_id"),
        "media": ("media_id", "version", "save_status", "recognition_status", "link_status", "sha256"),
        "upload": ("upload_id", "media_id", "total_parts", "status"),
        "part": ("upload_id", "index", "size_bytes"),
        "handoff": ("handoff_id", "unresolved_count"),
    }.items():
        item = body.get(name)
        if isinstance(item, dict):
            result[name] = {key: item[key] for key in fields if key in item}
    media = body.get("media")
    recognition = media.get("recognition") if isinstance(media, dict) else None
    if isinstance(recognition, dict):
        result["recognition"] = {key: recognition[key] for key in
                                 ("attempt_id", "provider", "model", "is_mock", "error_code") if key in recognition}
    return result


class SelfTest:
    def __init__(self, base_url: str, *, audio: Path | None = None, image: Path | None = None,
                 allow_mock: bool = False, timeout: float = 90, recognition_timeout: float = 180,
                 poll_interval: float = 1, audio_expect: Sequence[str] = (), image_expect: Sequence[str] = ()):
        self.base_url = valid_base_url(base_url)
        self.files = {"audio": audio, "image": image}
        self.allow_mock, self.timeout = allow_mock, timeout
        self.recognition_timeout, self.poll_interval = recognition_timeout, poll_interval
        self.expected_text = {"audio": list(audio_expect), "image": list(image_expect)}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.token = ""
        self.run_id = "selftest_" + uuid.uuid4().hex
        self.report: dict[str, Any] = {
            "schema_version": "mvp-http-selftest-v1", "run_id": self.run_id,
            "started_at": datetime.now(timezone.utc).isoformat(), "base_url": self.base_url,
            "mode": "offline_regression_allow_mock" if allow_mock else "real_provider_required",
            "passed": False, "online_passed": False, "checks": [], "http_calls": [],
            "artifacts": {"records": [], "media": [], "handoffs": []}, "providers": {},
            "limitations": [
                "HTTP checks do not click browser buttons or verify recording pause/resume.",
                "Expected keywords check supplied sample content; they do not establish general recognition accuracy.",
                "This command does not restart the running server or verify physical microphone/camera capture.",
                "Synthetic records remain in the target database; no existing data is deleted.",
                "Software checks do not establish clinical safety.",
                "Image OCR stays pending source comparison; this script never impersonates human source review.",
            ],
        }
        if allow_mock:
            self.report["limitations"].append("--allow-mock never qualifies as online acceptance.")

    def check(self, name: str, condition: bool, **evidence: Any) -> None:
        self.report["checks"].append({"name": name, "passed": bool(condition), "evidence": evidence})
        if not condition:
            raise CheckFailed(name)

    def phase(self, name: str, action: Callable[[], None]) -> None:
        try:
            action()
        except CheckFailed:
            pass
        except Exception as error:
            # Exception strings can contain server text, URLs or local filenames.
            self.report["checks"].append({"name": name + ".unexpected_error", "passed": False,
                                           "evidence": {"exception_type": type(error).__name__}})

    def request(self, name: str, method: str, path: str, body: Any = None, *,
                raw: bytes | None = None, content_type: str | None = None,
                key: str | None = None, binary: bool = False) -> tuple[int, Any]:
        payload = raw if raw is not None else (None if body is None else json_bytes(body))
        headers = {"X-Session-Token": self.token} if self.token else {}
        if payload is not None:
            headers["Content-Type"] = content_type or "application/json"
        if key:
            headers["Idempotency-Key"] = key
        call: dict[str, Any] = {"name": name, "method": method, "path": path}
        if payload is not None:
            call["request"] = {"size_bytes": len(payload), "sha256": digest(payload),
                               "content_type": headers["Content-Type"]}
            if body is not None:
                call["request"]["body"] = body
        if key:
            call["idempotency_key"] = key
        self.report["http_calls"].append(call)
        started = time.monotonic()
        try:
            req = urllib.request.Request(self.base_url + path, data=payload, method=method, headers=headers)
            try:
                response = self.opener.open(req, timeout=self.timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                data = response.read()
                status = response.status
                call.update(status=status, response_bytes=len(data), response_sha256=digest(data))
            if binary:
                return status, data
            try:
                result = json.loads(data)
            except (ValueError, UnicodeError):
                self.check(name + ".json_response", False, http_status=status)
            call["response"] = response_summary(result)
            return status, result
        except (OSError, urllib.error.URLError) as error:
            call.update(status=None, transport_error=type(error).__name__)
            self.check(name + ".transport", False, exception_type=type(error).__name__)
        finally:
            call["duration_ms"] = round((time.monotonic() - started) * 1000, 2)

    def expect(self, name: str, method: str, path: str, body: Any = None, *,
               statuses: tuple[int, ...] = (200,), **kwargs: Any) -> Any:
        status, result = self.request(name, method, path, body, **kwargs)
        self.check(name + ".http", status in statuses, actual=status, expected=list(statuses))
        return result

    def preflight(self) -> None:
        health = self.expect("health", "GET", "/health")
        self.check("health.session", health.get("ok") is True and isinstance(health.get("session_token"), str)
                   and bool(health["session_token"]))
        self.token = health["session_token"]
        provider = health.get("provider")
        self.report["providers"]["health"] = provider
        self.check("health.real_provider", self.allow_mock or real_provider(provider), provider=provider)
        capabilities = self.expect("media.capabilities", "GET", "/api/media/capabilities")["capabilities"]
        self.check("media.enabled", capabilities.get("enabled") is True,
                   disabled_reason=capabilities.get("disabled_reason"))
        self.capabilities = capabilities
        self.samples: dict[str, tuple[bytes, str]] = {}
        for kind, path in self.files.items():
            self.phase("sample." + kind, lambda kind=kind, path=path: self.load_sample(kind, path))
        self.check("samples.ready", len(self.samples) == 2, supplied=list(self.samples))
        for kind in self.files:
            self.check(kind + ".expected_keywords_supplied", self.allow_mock or
                       bool(self.expected_text[kind]) and all(word.strip() for word in self.expected_text[kind]),
                       expected_keywords=self.expected_text[kind])

    def load_sample(self, kind: str, path: Path | None) -> None:
        self.check(kind + ".sample_supplied", path is not None)
        self.check(kind + ".sample_readable", path.is_file())
        size = path.stat().st_size
        limit = self.capabilities.get("max_total_bytes")
        self.check(kind + ".sample_size", type(limit) is int and 0 < size <= limit,
                   size_bytes=size, max_total_bytes=limit)
        content_type = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}.get(
            path.suffix.lower(), mimetypes.guess_type(path.name)[0])
        self.check(kind + ".sample_format", content_type in self.capabilities.get(kind + "_content_types", []),
                   content_type=content_type)
        data = path.read_bytes()
        self.check(kind + ".sample_read", len(data) == size, sha256=digest(data))
        self.samples[kind] = (data, content_type)

    def event_detail(self, name: str, rid: str) -> dict[str, Any]:
        return self.expect(name, "GET", f"/api/events/{rid}")["event"]

    def organize_review(self, name: str, event: dict[str, Any], text: str) -> dict[str, Any]:
        rid = event["record_id"]
        status, result = self.request(name + ".organize", "POST", f"/api/events/{rid}/organize",
                                      {"expected_version": event["version"]})
        # A failed provider must still leave its original and local safety queryable.
        if status == 422:
            current = self.event_detail(name + ".failure_original", rid)
            self.check(name + ".failure_preserves_original", current["raw_text"] == text and
                       result.get("raw_text_preserved") is True and
                       current["local_safety"] == result.get("local_safety"))
        self.check(name + ".organize_success", status == 200 and result.get("ok") is True,
                   http_status=status, failure_code=result.get("failure_code"), error=result.get("error"))
        provider = result.get("provider")
        self.report["providers"][name] = provider
        self.check(name + ".real_provider", self.allow_mock or real_provider(provider), provider=provider)
        event = result["event"]
        self.check(name + ".draft", event["raw_text"] == text and event["state"] == "draft"
                   and isinstance(event.get("draft"), dict) and result.get("raw_text_preserved") is True)
        reviewed = self.expect(name + ".review", "POST", f"/api/events/{rid}/review",
                               {"expected_version": event["version"], "action": "confirm",
                                "note": "自动化自测：仅验证记录核对接口，不代表老人或医生确认。"})["event"]
        self.check(name + ".reviewed", reviewed["state"] == "recorded" and reviewed["raw_text"] == text
                   and reviewed.get("confirmation_scope") == "record_accuracy")
        self.check(name + ".safety_preserved", reviewed["local_safety"] == event["local_safety"])
        return reviewed

    def handoff(self, name: str) -> dict[str, Any]:
        card = self.expect(name, "POST", "/api/handoffs", {}, statuses=(201,))["handoff"]
        self.report["artifacts"]["handoffs"].append(card["handoff_id"])
        return card

    def text_flow(self) -> None:
        text = f"【自动化自测 {self.run_id}，虚构资料】今天胸口疼，喘不上气，想询问复诊需要带哪些资料。"
        body = {"raw_text": text, "source_kind": "system", "actor_name": "MVP 自动化自测"}
        saved = self.expect("text.save", "POST", "/api/events", body, key=self.run_id + ":text", statuses=(201,))
        event = saved["event"]
        rid = event["record_id"]
        self.report["artifacts"]["records"].append(rid)
        self.check("text.saved", saved.get("created") is True and event["raw_text"] == text
                   and event["state"] == "inbox", record_id=rid)
        self.check("text.danger_saved", event["local_safety"].get("danger_detected") is True
                   and bool(event["local_safety"].get("danger_reminder")))
        repeated = self.expect("text.replay", "POST", "/api/events", body, key=self.run_id + ":text")
        self.check("text.idempotent", repeated.get("created") is False and repeated["event"]["record_id"] == rid)
        conflict = self.expect("text.changed_key", "POST", "/api/events", {**body, "raw_text": text + "修正"},
                               key=self.run_id + ":text", statuses=(409,))
        self.check("text.key_conflict", conflict.get("error") == "idempotency_key_payload_mismatch")
        event = self.organize_review("text", event, text)
        stale = self.expect("text.stale_version", "POST", f"/api/events/{rid}/organize",
                            {"expected_version": 1}, statuses=(409,))
        self.check("text.version_conflict", stale.get("error") == "stale_version")
        history = self.expect("text.history", "GET", f"/api/events/{rid}/history")["history"]
        self.check("text.history_actions", {"created", "organized", "review_confirm"}.issubset(
            {item["action"] for item in history}) and all(item["snapshot"]["raw_text"] == text for item in history))
        card = self.handoff("text.handoff_before_revision")
        self.check("text.handoff_contains_record", any(item["record_id"] == rid and item["raw_text"] == text
                                                      for item in card["items"]))
        self.check("text.danger_after_review", any(item["record_id"] == rid and
                   item["local_safety"]["danger_detected"] is True and
                   "local_danger_detected" in item["unresolved_reasons"] for item in card["items"]))
        new_text = text + " 自测修订：补充实际发生时间尚未确定。"
        revised = self.expect("text.revise", "POST", f"/api/events/{rid}/revise",
                              {**body, "raw_text": new_text, "expected_version": event["version"],
                               "reason": "自动化自测核验修订历史"}, statuses=(201,))["event"]
        new_id = revised["record_id"]
        self.report["artifacts"]["records"].append(new_id)
        self.check("text.revised", new_id != rid and revised["supersedes_id"] == rid and revised["raw_text"] == new_text)
        old = self.event_detail("text.old_original", rid)
        self.check("text.old_preserved", old["raw_text"] == text and old["state"] == "superseded")
        self.organize_review("revision", revised, new_text)
        for suffix, record_id, expected_action in (("old", rid, "superseded_by_revision"),
                                                    ("new", new_id, "revised_from")):
            revisions = self.expect("text.revision_history_" + suffix, "GET", f"/api/events/{record_id}/history")["history"]
            self.check("text.revision_history_" + suffix + ".linked", expected_action in
                       {item["action"] for item in revisions})
        old_card = self.expect("text.old_snapshot", "GET", "/api/handoffs/" + card["handoff_id"])["handoff"]
        self.check("text.snapshot_immutable", old_card == card)
        fresh = self.handoff("text.handoff_after_revision")
        ids = [item["record_id"] for item in fresh["items"]]
        self.check("text.handoff_latest", new_id in ids and rid not in ids)
        listing = self.expect("text.list", "GET", "/api/events")["events"]
        self.check("text.list_no_duplicate", sum(item["record_id"] == rid for item in listing) == 1 and
                   sum(item["record_id"] == new_id for item in listing) == 1)

    def multipart(self, fields: dict[str, Any] | None = None, file: bytes | None = None,
                  content_type: str = "application/octet-stream") -> tuple[bytes, str]:
        boundary = "selftest" + uuid.uuid4().hex
        parts = []
        for name, value in (fields or {}).items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        if file is not None:
            parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="selftest-part"\r\nContent-Type: {content_type}\r\n\r\n'.encode(), file, b"\r\n"])
        parts.append(f"--{boundary}--\r\n".encode())
        return b"".join(parts), "multipart/form-data; boundary=" + boundary

    def original(self, kind: str, media_id: str, data: bytes) -> None:
        original = self.expect(kind + ".original", "GET", f"/api/media/{media_id}/original", binary=True)
        self.check(kind + ".original_equal", original == data, size_bytes=len(original), sha256=digest(original))

    def media_flow(self, kind: str) -> None:
        data, content_type = self.samples[kind]
        chunk_size = self.capabilities["max_part_bytes"]
        total = math.ceil(len(data) / chunk_size)
        self.check(kind + ".parts_limit", total <= self.capabilities["max_parts"], total_parts=total)
        metadata = {"kind": kind, "content_type": content_type, "total_parts": total,
                    "expected_size": len(data), "expected_sha256": digest(data),
                    "original_filename": self.run_id + "-" + kind, "actor_name": "MVP 自动化自测"}
        payload, multipart_type = self.multipart(metadata)
        key = self.run_id + ":" + kind
        uploaded = self.expect(kind + ".create", "POST", "/api/media/uploads", raw=payload,
                               content_type=multipart_type, key=key + ":create", statuses=(201,))
        upload = uploaded["upload"]
        mid, uid = upload["media_id"], upload["upload_id"]
        self.report["artifacts"]["media"].append({"kind": kind, "media_id": mid, "upload_id": uid,
                                                   "sample_sha256": digest(data), "size_bytes": len(data)})
        replay = self.expect(kind + ".create_replay", "POST", "/api/media/uploads", raw=payload,
                             content_type=multipart_type, key=key + ":create")
        self.check(kind + ".create_idempotent", replay.get("created") is False and replay["upload"]["media_id"] == mid)
        for index in range(total):
            part, part_type = self.multipart(file=data[index * chunk_size:(index + 1) * chunk_size], content_type=content_type)
            path = f"/api/media/uploads/{uid}/parts/{index}"
            self.expect(f"{kind}.part_{index}", "POST", path, raw=part, content_type=part_type,
                        key=key + f":part:{index}", statuses=(201,))
            replay = self.expect(f"{kind}.part_{index}_replay", "POST", path, raw=part, content_type=part_type,
                                 key=key + f":part:{index}")
            self.check(f"{kind}.part_{index}_idempotent", replay.get("created") is False)
        path = f"/api/media/uploads/{uid}/complete"
        saved = self.expect(kind + ".complete", "POST", path, {}, key=key + ":complete", statuses=(201,))["media"]
        self.check(kind + ".saved", saved["save_status"] == "saved" and saved["sha256"] == digest(data))
        replay = self.expect(kind + ".complete_replay", "POST", path, {}, key=key + ":complete")
        self.check(kind + ".complete_idempotent", replay.get("created") is False and replay["media"]["media_id"] == mid)
        self.original(kind, mid, data)
        request = {"expected_version": saved["version"], "actor_name": "MVP 自动化自测"}
        result = self.expect(kind + ".recognize", "POST", f"/api/media/{mid}/recognize", request,
                             key=key + ":recognize", statuses=(200, 202))
        attempt_id = result.get("attempt_id")
        replay = self.expect(kind + ".recognize_replay", "POST", f"/api/media/{mid}/recognize", request,
                             key=key + ":recognize", statuses=(200, 202))
        self.check(kind + ".recognition_idempotent", bool(attempt_id) and replay.get("attempt_id") == attempt_id)
        deadline = time.monotonic() + self.recognition_timeout
        while True:
            media = self.expect(kind + ".poll", "GET", f"/api/media/{mid}")["media"]
            state = media["recognition_status"]
            if state in {"failed", "interrupted"} or state == "succeeded" and media["link_status"] != "pending":
                break
            self.check(kind + ".poll_deadline", time.monotonic() < deadline, recognition_status=state)
            time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
        recognition = media.get("recognition") or {}
        self.report["providers"][kind] = {k: recognition.get(k) for k in ("provider", "model", "is_mock", "error_code")}
        self.original(kind + ".after_recognition", mid, data)
        self.check(kind + ".recognition_success", state == "succeeded", recognition_status=state,
                   error_code=recognition.get("error_code"))
        replay = self.expect(kind + ".recognize_completed_replay", "POST", f"/api/media/{mid}/recognize", request,
                             key=key + ":recognize")
        self.check(kind + ".completed_attempt_reused", replay.get("attempt_id") == attempt_id and
                   replay["media"]["recognition_status"] == "succeeded")
        self.check(kind + ".real_recognition", self.allow_mock or recognition.get("is_mock") is False
                   and real_provider(recognition.get("provider")),
                   is_mock=recognition.get("is_mock"), provider=recognition.get("provider"))
        text = recognition.get("text")
        self.check(kind + ".recognized_text", isinstance(text, str) and bool(text.strip()),
                   text_sha256=digest(text.encode()) if isinstance(text, str) else None)
        for keyword in self.expected_text[kind]:
            self.check(kind + ".expected_keyword", keyword.casefold() in text.casefold(), keyword=keyword)
        link_body = {"expected_version": media["version"], "actor_name": "MVP 自动化自测"}
        linked = self.expect(kind + ".link", "POST", f"/api/media/{mid}/link", link_body,
                             key=key + ":link", statuses=(200, 201))
        media = linked["media"]
        rid = (media.get("event_link") or {}).get("record_id")
        self.check(kind + ".linked", media["link_status"] == "linked" and bool(rid))
        repeated_link = self.expect(kind + ".link_replay", "POST", f"/api/media/{mid}/link", link_body,
                                    key=key + ":link")
        self.check(kind + ".link_idempotent", (repeated_link["media"].get("event_link") or {}).get("record_id") == rid)
        self.report["artifacts"]["records"].append(rid)
        event = self.event_detail(kind + ".event", rid)
        self.check(kind + ".event_provenance", event["raw_text"] == text and
                   event["source_kind"] == ("audio_transcript" if kind == "audio" else "document"))
        if kind == 'image':
            denied = self.expect('image.unreviewed_organize_blocked', 'POST', f'/api/events/{rid}/organize', {'expected_version': event['version']}, statuses=(409,))
            self.check('image.source_review_required', denied.get('error') == 'document_source_review_required')
        else:
            self.organize_review(kind + "_event", event, text)
        card = self.handoff(kind + ".handoff")
        records = card.get('pending_documents', []) if kind == 'image' else card['items']
        self.check(kind + ".handoff_link", any(item["record_id"] == rid for item in records) and
                   any(item["media_id"] == mid and item["record_id"] == rid for item in card.get("media_attachments", [])))
        listing = self.expect(kind + ".list", "GET", "/api/media")["media"]
        self.check(kind + ".list_no_duplicate", sum(item["media_id"] == mid for item in listing) == 1)

    def run(self) -> dict[str, Any]:
        self.phase("preflight", self.preflight)
        if all(check["passed"] for check in self.report["checks"]):
            self.phase("text", self.text_flow)
            self.phase("audio", lambda: self.media_flow("audio"))
            self.phase("image", lambda: self.media_flow("image"))
        else:
            self.report["skipped"] = ["text_flow", "audio_flow", "image_flow"]
        checks = self.report["checks"]
        self.report["passed"] = bool(checks) and all(check["passed"] for check in checks)
        self.report["online_passed"] = self.report["passed"] and not self.allow_mock
        self.report["summary"] = {"total": len(checks), "passed": sum(c["passed"] for c in checks),
                                  "failed": sum(not c["passed"] for c in checks), "http_calls": len(self.report["http_calls"])}
        self.report["finished_at"] = datetime.now(timezone.utc).isoformat()
        return self.report


def positive(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be finite and greater than zero")
    return number


def main(argv: Sequence[str] | None = None, *, output: TextIO | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18768")
    parser.add_argument("--audio", type=Path, help="authorized/synthetic audio file to upload")
    parser.add_argument("--image", type=Path, help="authorized/synthetic image file to upload")
    parser.add_argument("--audio-expect", action="append", default=[], help="expected transcript keyword; repeatable, required for real acceptance")
    parser.add_argument("--image-expect", action="append", default=[], help="expected OCR keyword; repeatable, required for real acceptance")
    parser.add_argument("--allow-mock", action="store_true", help="explicit offline regression; online_passed remains false")
    parser.add_argument("--timeout", type=positive, default=90, help="timeout seconds per HTTP request")
    parser.add_argument("--recognition-timeout", type=positive, default=180, help="polling deadline seconds per media")
    parser.add_argument("--poll-interval", type=positive, default=1)
    parser.add_argument("--out", type=Path, default=Path("runtime/selftest-result.json"))
    args = parser.parse_args(argv)
    try:
        tester = SelfTest(args.base_url, audio=args.audio, image=args.image, allow_mock=args.allow_mock,
                          timeout=args.timeout, recognition_timeout=args.recognition_timeout, poll_interval=args.poll_interval,
                          audio_expect=args.audio_expect, image_expect=args.image_expect)
        report = tester.run()
    except ValueError as error:
        report = {"schema_version": "mvp-http-selftest-v1", "passed": False, "online_passed": False,
                  "checks": [{"name": "configuration", "passed": False, "error": str(error)}], "http_calls": []}
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    stream = output or sys.stdout
    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    except OSError:
        report["passed"] = report["online_passed"] = False
        report["report_write_error"] = "cannot_write_report"
        rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    stream.write(rendered)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
