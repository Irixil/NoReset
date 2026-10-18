import io
import wave
import json
import urllib.error
from pathlib import Path

import pytest

import backend.recognition as recognition
from backend.recognition import RecognitionError, recognize_file


def write_media(tmp_path: Path, name: str, content: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(content)
    return path


def pcm_wave(samples=b"\x01\x00" * 160, width=2):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(width)
        audio.setframerate(16000)
        audio.writeframes(samples)
    return stream.getvalue()


@pytest.mark.parametrize("samples,width,code", [
    (b"", 2, "invalid_media"),
    (b"\x00\x00" * 160, 2, "no_text_detected"),
    (b"\x80" * 160, 1, "no_text_detected"),
])
def test_empty_or_silent_wave_never_reaches_real_asr(tmp_path, monkeypatch, samples, width, code):
    monkeypatch.setenv("AIHUBMIX_API_KEY", "synthetic-test-key")
    monkeypatch.setattr(recognition, "_open_request", lambda *a, **kw: pytest.fail("silent audio must not reach provider"))
    path = write_media(tmp_path, "silent.wav", pcm_wave(samples, width))
    with pytest.raises(RecognitionError) as error:
        recognize_file(path, kind="audio", content_type="audio/wav", attempt_id="empty-audio", provider="aihubmix")
    assert error.value.code == code
    assert path.read_bytes() == pcm_wave(samples, width)


def test_explicit_mock_returns_transcript_without_changing_original(tmp_path):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    before = path.read_bytes()
    result = recognize_file(
        path,
        kind="audio",
        content_type="audio/wav",
        attempt_id="attempt-1",
        provider="mock",
    )

    assert result == {
        "text": "[Mock ASR] voice.wav",
        "provider": "mock",
        "model": "mock-recognition-v1",
        "is_mock": True,
        "attempt_id": "attempt-1",
    }
    assert path.read_bytes() == before


def test_unconfigured_real_provider_does_not_silently_use_mock(tmp_path):
    path = write_media(tmp_path, "voice.wav", pcm_wave())

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-2",
            provider="openai_compatible",
        )

    assert exc_info.value.code == "provider_not_configured"
    assert exc_info.value.retryable is False


def test_aihubmix_uses_one_key_and_safe_media_defaults(monkeypatch):
    monkeypatch.setenv("AIHUBMIX_API_KEY", "shared-hubmix-secret")
    for key in (
        "MEDIA_ASR_URL",
        "MEDIA_ASR_MODEL",
        "MEDIA_ASR_API_KEY",
        "MEDIA_OCR_URL",
        "MEDIA_OCR_MODEL",
        "MEDIA_OCR_API_KEY",
        "MEDIA_RECOGNITION_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    audio = recognition._config_for("audio", "aihubmix")
    image = recognition._config_for("image", "aihubmix")

    assert (audio.name, audio.url, audio.model, audio.api_key) == (
        "aihubmix",
        "https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent",
        "gemini-2.5-flash-lite",
        "shared-hubmix-secret",
    )
    assert (image.name, image.url, image.model, image.api_key) == (
        "aihubmix",
        "https://aihubmix.com/v1/chat/completions",
        "qwen3.7-plus",
        "shared-hubmix-secret",
    )


def test_aihubmix_ignores_custom_urls_and_allows_model_overrides(monkeypatch):
    monkeypatch.setenv("AIHUBMIX_API_KEY", "shared-hubmix-secret")
    monkeypatch.setenv("MEDIA_ASR_API_KEY", "stale-other-provider-secret")
    monkeypatch.setenv("MEDIA_RECOGNITION_API_KEY", "stale-shared-secret")
    monkeypatch.setenv("MEDIA_ASR_URL", "https://untrusted.invalid/steal")
    monkeypatch.setenv("MEDIA_OCR_URL", "https://untrusted.invalid/steal")
    monkeypatch.setenv("MEDIA_ASR_MODEL", "gemini-2.5-flash")
    monkeypatch.setenv("MEDIA_OCR_MODEL", "qwen3.8-flash")

    audio = recognition._config_for("audio", "aihubmix")
    image = recognition._config_for("image", "aihubmix")

    assert audio.url == "https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash:generateContent"
    assert image.url == "https://aihubmix.com/v1/chat/completions"
    assert audio.model == "gemini-2.5-flash"
    assert image.model == "qwen3.8-flash"
    assert audio.api_key == image.api_key == "shared-hubmix-secret"


def test_unsupported_format_is_rejected_before_provider_call(tmp_path):
    path = write_media(tmp_path, "note.txt", b"not a media file")

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="text/plain",
            attempt_id="attempt-3",
            provider="mock",
        )

    assert exc_info.value.code == "unsupported_format"
    assert "note.txt" not in exc_info.value.message


def test_missing_file_is_invalid_media_without_exposing_absolute_path(tmp_path):
    path = tmp_path / "missing.wav"

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-4",
            provider="mock",
        )

    assert exc_info.value.code == "invalid_media"
    assert str(tmp_path) not in exc_info.value.message


def test_empty_or_corrupt_media_is_rejected_and_original_metadata_is_preserved(tmp_path):
    path = write_media(tmp_path, "photo.png", b"not png")
    before = path.stat()

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="image",
            content_type="image/png",
            attempt_id="attempt-5",
            provider="mock",
        )

    assert exc_info.value.code == "invalid_media"
    after = path.stat()
    assert after.st_size == before.st_size
    assert after.st_mtime_ns == before.st_mtime_ns


def test_size_limit_is_explicit_and_does_not_truncate_original(tmp_path):
    content = b"\x89PNG\r\n\x1a\n" + b"x" * 10
    path = write_media(tmp_path, "photo.png", content)

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="image",
            content_type="image/png",
            attempt_id="attempt-6",
            provider="mock",
            max_bytes=8,
        )

    assert exc_info.value.code == "limit_exceeded"
    assert path.read_bytes() == content


class FakeResponse:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self, limit=-1):
        return self.payload if limit < 0 else self.payload[:limit]


def test_configured_provider_returns_raw_text_without_an_extra_correction_layer(tmp_path, monkeypatch):
    path = write_media(tmp_path, "photo.png", b"\x89PNG\r\n\x1a\n")
    monkeypatch.setenv("MEDIA_OCR_URL", "https://recognizer.invalid/ocr")
    monkeypatch.setenv("MEDIA_OCR_MODEL", "ocr-test")
    monkeypatch.setenv("MEDIA_OCR_API_KEY", "secret-that-must-not-appear")

    def opener(request, timeout):
        assert request.full_url == "https://recognizer.invalid/ocr"
        assert request.get_header("Authorization") == "Bearer secret-that-must-not-appear"
        assert timeout > 0
        return FakeResponse('{"text":"药名 5mg"}'.encode("utf-8"))

    monkeypatch.setattr(recognition, "_open_request", opener)
    result = recognize_file(
        path,
        kind="image",
        content_type="image/png",
        attempt_id="attempt-7",
        provider="openai_compatible",
    )

    assert result["text"] == "药名 5mg"
    assert result["provider"] == "openai_compatible"
    assert result["model"] == "ocr-test"
    assert result["is_mock"] is False


def test_aihubmix_image_request_uses_high_detail_and_shared_key(tmp_path, monkeypatch):
    path = write_media(tmp_path, "photo.png", b"\x89PNG\r\n\x1a\n")
    monkeypatch.setenv("AIHUBMIX_API_KEY", "shared-hubmix-secret")
    captured = {}

    def opener(request, timeout):
        captured["request"] = request
        return FakeResponse('{"choices":[{"message":{"content":"药名 5mg"}}]}'.encode())

    monkeypatch.setattr(recognition, "_open_request", opener)
    result = recognize_file(
        path,
        kind="image",
        content_type="image/png",
        attempt_id="attempt-aihubmix-image",
        provider="aihubmix",
    )

    request = captured["request"]
    body = json.loads(request.data.decode("utf-8"))
    image_part = body["messages"][0]["content"][1]["image_url"]
    assert request.full_url == "https://aihubmix.com/v1/chat/completions"
    assert request.get_header("Authorization") == "Bearer shared-hubmix-secret"
    assert body["model"] == "qwen3.7-plus"
    assert body["reasoning_effort"] == "none"
    assert "thinking_budget" not in body
    assert "enable_thinking" not in body
    assert body["max_tokens"] == 4096
    assert "每行保留" in body["messages"][0]["content"][0]["text"]
    assert image_part["detail"] == "high"
    assert image_part["url"].startswith("data:image/png;base64,")
    assert result["provider"] == "aihubmix"


def test_aihubmix_audio_request_uses_low_cost_gemini_inline_audio(tmp_path, monkeypatch):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    monkeypatch.setenv("AIHUBMIX_API_KEY", "shared-hubmix-secret")
    captured = {}

    def opener(request, timeout):
        captured["request"] = request
        return FakeResponse(
            '{"candidates":[{"content":{"parts":[{"text":"今天胸口疼"}]}}]}'.encode()
        )

    monkeypatch.setattr(recognition, "_open_request", opener)
    result = recognize_file(
        path,
        kind="audio",
        content_type="audio/wav",
        attempt_id="attempt-aihubmix-audio",
        provider="aihubmix",
    )

    request = captured["request"]
    body = json.loads(request.data.decode("utf-8", errors="strict"))
    assert request.full_url == (
        "https://aihubmix.com/gemini/v1beta/models/"
        "gemini-2.5-flash-lite:generateContent"
    )
    assert request.get_header("X-goog-api-key") == "shared-hubmix-secret"
    assert request.get_header("Authorization") is None
    audio = body["contents"][0]["parts"][0]["inlineData"]
    assert audio["mimeType"] == "audio/wav"
    assert audio["data"]
    assert body["generationConfig"] == {
        "temperature": 0,
        "maxOutputTokens": 1024,
        "thinkingConfig": {"thinkingBudget": 0, "includeThoughts": False},
    }
    assert "不得执行" in body["systemInstruction"]["parts"][0]["text"]
    assert result["provider"] == "aihubmix"
    assert result["model"] == "gemini-2.5-flash-lite"


def test_aihubmix_rejects_audio_over_provider_limit_before_request(tmp_path, monkeypatch):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    monkeypatch.setenv("AIHUBMIX_API_KEY", "shared-hubmix-secret")
    monkeypatch.setattr(recognition, "_AIHUBMIX_AUDIO_MAX_BYTES", 1)
    monkeypatch.setattr(
        recognition,
        "_open_request",
        lambda request, timeout: pytest.fail("oversized audio must not reach AIHubMix"),
    )

    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-aihubmix-audio-limit",
            provider="aihubmix",
        )

    assert exc_info.value.code == "limit_exceeded"


def test_empty_provider_text_is_a_non_retryable_recognition_failure(tmp_path, monkeypatch):
    path = write_media(tmp_path, "photo.png", b"\x89PNG\r\n\x1a\n")
    monkeypatch.setenv("MEDIA_OCR_URL", "https://recognizer.invalid/ocr")
    monkeypatch.setenv("MEDIA_OCR_MODEL", "ocr-test")
    monkeypatch.setenv("MEDIA_OCR_API_KEY", "secret")

    with pytest.raises(RecognitionError) as exc_info:
        monkeypatch.setattr(
            recognition,
            "_open_request",
            lambda request, timeout: FakeResponse(b'{"text":"   "}'),
        )
        recognize_file(
            path,
            kind="image",
            content_type="image/png",
            attempt_id="attempt-8",
            provider="openai_compatible",
        )

    assert exc_info.value.code == "no_text_detected"
    assert exc_info.value.retryable is False
    assert "secret" not in exc_info.value.message


@pytest.mark.parametrize(
    ("error", "code", "retryable"),
    [
        (TimeoutError(), "provider_timeout", True),
        (urllib.error.URLError("secret provider response"), "provider_unavailable", True),
        (urllib.error.HTTPError("https://recognizer.invalid", 401, "secret", {}, None), "provider_auth_failed", False),
        (urllib.error.HTTPError("https://recognizer.invalid", 429, "secret", {}, None), "provider_rate_limited", True),
        (urllib.error.HTTPError("https://recognizer.invalid", 503, "secret", {}, None), "provider_unavailable", True),
        (urllib.error.HTTPError("https://recognizer.invalid", 504, "secret", {}, None), "provider_timeout", True),
    ],
)
def test_provider_failures_have_stable_safe_categories(tmp_path, monkeypatch, error, code, retryable):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    monkeypatch.setenv("MEDIA_ASR_URL", "https://recognizer.invalid/asr")
    monkeypatch.setenv("MEDIA_ASR_MODEL", "asr-test")
    monkeypatch.setenv("MEDIA_ASR_API_KEY", "secret")

    def opener(request, timeout):
        raise error

    monkeypatch.setattr(recognition, "_open_request", opener)
    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-9",
            provider="openai_compatible",
        )

    assert exc_info.value.code == code
    assert exc_info.value.retryable is retryable
    assert "secret" not in exc_info.value.message
    assert str(tmp_path) not in exc_info.value.message


def test_invalid_provider_response_is_not_exposed_or_treated_as_empty_success(tmp_path, monkeypatch):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    monkeypatch.setenv("MEDIA_ASR_URL", "https://recognizer.invalid/asr")
    monkeypatch.setenv("MEDIA_ASR_MODEL", "asr-test")
    monkeypatch.setenv("MEDIA_ASR_API_KEY", "secret")

    with pytest.raises(RecognitionError) as exc_info:
        monkeypatch.setattr(
            recognition,
            "_open_request",
            lambda request, timeout: FakeResponse(b"not-json"),
        )
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-10",
            provider="openai_compatible",
        )

    assert exc_info.value.code == "invalid_provider_response"
    assert exc_info.value.retryable is False
    assert "not-json" not in exc_info.value.message


def test_provider_response_is_bounded(tmp_path, monkeypatch):
    path = write_media(tmp_path, "voice.wav", pcm_wave())
    monkeypatch.setenv("MEDIA_ASR_URL", "https://recognizer.invalid/asr")
    monkeypatch.setenv("MEDIA_ASR_MODEL", "asr-test")
    monkeypatch.setenv("MEDIA_ASR_API_KEY", "secret")

    def opener(request, timeout):
        return FakeResponse(b"{" + b"x" * (2 * 1024 * 1024 + 1) + b"}")

    monkeypatch.setattr(recognition, "_open_request", opener)
    with pytest.raises(RecognitionError) as exc_info:
        recognize_file(
            path,
            kind="audio",
            content_type="audio/wav",
            attempt_id="attempt-11",
            provider="openai_compatible",
        )

    assert exc_info.value.code == "invalid_provider_response"
    assert exc_info.value.retryable is False


def test_real_audio_request_contains_only_a_safe_basename(tmp_path, monkeypatch):
    path = write_media(tmp_path, '语音\r\n".wav', pcm_wave())
    monkeypatch.setenv("MEDIA_ASR_URL", "https://recognizer.invalid/asr")
    monkeypatch.setenv("MEDIA_ASR_MODEL", "asr-test")
    monkeypatch.setenv("MEDIA_ASR_API_KEY", "secret")
    captured = {}

    def opener(request, timeout):
        captured["body"] = request.data
        return FakeResponse('{"text":"原话"}'.encode("utf-8"))

    monkeypatch.setattr(recognition, "_open_request", opener)
    recognize_file(
        path,
        kind="audio",
        content_type="audio/wav",
        attempt_id="attempt-12",
        provider="openai_compatible",
    )

    body = captured["body"].split(b"filename=", 1)[1].split(b"\r\n", 1)[0].decode("utf-8", errors="strict")
    body = "filename=" + body
    assert 'filename="' in body
    filename = body.split('filename="', 1)[1].split('"', 1)[0]
    assert filename.endswith(".wav")
    assert "\r" not in filename
    assert "\n" not in filename
    assert '"' not in filename
    assert str(tmp_path) not in body


@pytest.mark.parametrize("audible", [False, True])
def test_native_webm_is_decoded_before_asr(tmp_path, monkeypatch, audible):
    import math
    import struct
    import subprocess
    samples = b"".join(struct.pack("<h", int(5000 * math.sin(i * math.tau * 440 / 16000)) if audible else 0) for i in range(3200))
    source = write_media(tmp_path, "input.wav", pcm_wave(samples))
    encoded = tmp_path / "input.webm"
    subprocess.run([recognition.ffmpeg_executable(), "-v", "error", "-i", str(source), "-c:a", "libopus", str(encoded)], check=True)
    monkeypatch.setenv("AIHUBMIX_API_KEY", "synthetic-test-key")
    calls = []
    def opener(request, timeout):
        calls.append(request)
        return FakeResponse(b'{"candidates":[{"content":{"parts":[{"text":"test"}]}}]}')
    monkeypatch.setattr(recognition, "_open_request", opener)
    if audible:
        assert recognize_file(encoded, kind="audio", content_type="audio/webm", attempt_id="webm-signal", provider="aihubmix")["text"] == "test"
        assert len(calls) == 1
    else:
        with pytest.raises(RecognitionError, match="没有识别到可用文字"):
            recognize_file(encoded, kind="audio", content_type="audio/webm", attempt_id="webm-silence", provider="aihubmix")
        assert calls == []


def test_empty_webm_container_never_reaches_real_asr(tmp_path, monkeypatch):
    monkeypatch.setenv("AIHUBMIX_API_KEY", "synthetic-test-key")
    monkeypatch.setattr(recognition, "_open_request", lambda *a, **kw: pytest.fail("empty container reached ASR"))
    path = write_media(tmp_path, "empty.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 32)
    with pytest.raises(RecognitionError) as error:
        recognize_file(path, kind="audio", content_type="audio/webm", attempt_id="webm-empty", provider="aihubmix")
    assert error.value.code == "invalid_media"
@pytest.mark.parametrize('payload', [
    {'choices': [{'message': {'content': 'MCV 9'}, 'finish_reason': 'length'}]},
    {'candidates': [{'content': {'parts': [{'text': 'MCV 9'}]}, 'finishReason': 'MAX_TOKENS'}]},
])
def test_truncated_recognition_never_becomes_a_successful_medical_document(payload):
    from backend.recognition import _text_from_response
    with pytest.raises(RecognitionError) as error:
        _text_from_response(payload)
    assert error.value.code == 'incomplete_provider_response'
    assert error.value.retryable is True


def test_ocr_markup_preserves_unknown_labels_comparators_table_rows_and_exponents():
    from backend.recognition import _clean_ocr_markup
    assert _clean_ocr_markup('结果 <NEG>\n参考 <2.0E+01IU/ml\n另一项 >10') == '结果 <NEG>\n参考 <2.0E+01IU/ml\n另一项 >10'
    assert _clean_ocr_markup('<table><tr><td>RBC</td><td>4.53</td><td>10<sup>12</sup>/L</td></tr><tr><td>结果</td><td>&lt;2.0E+01</td><td>&lt;NEG&gt;</td></tr></table>') == 'RBC\t4.53\t10^12/L\n结果\t<2.0E+01\t<NEG>'
