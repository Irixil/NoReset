"""Offline protocol tests; no key, network call, or real-ASR claim."""
import json
import io
import queue
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import backend.recognition as recognition


def configure(monkeypatch, **values):
    defaults = {"MEDIA_ASR_PROVIDER": "dashscope_streaming", "MEDIA_ASR_URL": "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
                "MEDIA_ASR_MODEL": "qwen-audio-3.0-asr-flash-streaming", "MEDIA_ASR_API_KEY": "test-secret",
                "MEDIA_RECOGNITION_TIMEOUT_SECONDS": "1"}
    for name, value in {**defaults, **values}.items():
        monkeypatch.setenv(name, value)


class Socket:
    def __init__(self, finals=None, fail=None, empty=False, malformed=False):
        self.sent = []; self.incoming = queue.Queue(); self.closed = False
        self.finals = finals or [(2, "后来咳嗽。"), (1, "今天头晕。"), (1, "今天头晕。")]
        self.fail, self.empty, self.malformed = fail, empty, malformed

    def send(self, value):
        self.sent.append(value)
        if isinstance(value, bytes):
            return
        request = json.loads(value); task_id = request["header"]["task_id"]
        def put(event, payload=None, **header):
            self.incoming.put(json.dumps({"header": {"event": event, "task_id": task_id, **header}, "payload": payload or {}}, ensure_ascii=False))
        if request["header"]["action"] == "run-task":
            put("task-started")
        else:
            if self.fail:
                put("task-failed", error_code=self.fail, error_message="test-secret private response")
            elif self.malformed:
                self.incoming.put("private invalid json")
            elif not self.empty:
                put("result-generated", {"output": {"sentence": {"sentence_end": False, "text": "错误的临时猜测"}}})
                for sid, text in self.finals:
                    put("result-generated", {"output": {"sentence": {"sentence_id": sid, "sentence_end": True, "text": text}}})
            put("task-finished")

    def recv(self, timeout):
        try:
            return self.incoming.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError from None

    def close(self):
        self.closed = True


def convert_stub(monkeypatch, captured):
    monkeypatch.setattr(recognition.shutil, "which", lambda _: "/ffmpeg")
    def run(args, **kwargs):
        source = Path(args[args.index("-i") + 1]); output = Path(args[-1])
        captured.update(args=args, source=source, source_bytes=source.read_bytes(), output=output, kwargs=kwargs)
        output.write_bytes(b"\x00\x01" * 160)  # 10 ms of controlled PCM
    monkeypatch.setattr(recognition.subprocess, "run", run)


def test_webm_temporary_pcm_copy_and_complete_final_sentences(tmp_path, monkeypatch):
    configure(monkeypatch); captured = {}; convert_stub(monkeypatch, captured)
    original = tmp_path / "original"; original.write_bytes(b"\x1a\x45\xdf\xa3unchanged webm")
    before = original.stat(); socket = Socket()
    monkeypatch.setattr(recognition, "_connect_dashscope", lambda config: socket)
    result = recognition.recognize_file(original, kind="audio", content_type="audio/webm;codecs=opus", attempt_id="attempt-1")
    assert result == {"text": "今天头晕。后来咳嗽。", "provider": "dashscope_streaming", "model": "qwen-audio-3.0-asr-flash-streaming", "is_mock": False, "attempt_id": "attempt-1"}
    assert original.read_bytes() == captured["source_bytes"]
    assert original.stat().st_mtime_ns == before.st_mtime_ns
    assert not captured["source"].exists() and not captured["output"].exists()
    assert captured["args"][captured["args"].index("-protocol_whitelist") + 1] == "file,pipe"
    assert "-t" not in captured["args"] and "-fs" not in captured["args"]
    assert socket.closed
    start, finish = json.loads(socket.sent[0]), json.loads(socket.sent[-1])
    assert start["payload"]["model"] == "qwen-audio-3.0-asr-flash-streaming"
    assert start["payload"]["parameters"] == {"format": "pcm", "sample_rate": 16000}
    assert start["header"]["task_id"] == finish["header"]["task_id"]
    assert finish["header"]["action"] == "finish-task"
    assert b"".join(item for item in socket.sent if isinstance(item, bytes)) == b"\x00\x01" * 160


@pytest.mark.parametrize("url", ["ws://dashscope.aliyuncs.com/api-ws/v1/inference", "wss://evil.invalid/api-ws/v1/inference",
                              "wss://dashscope.aliyuncs.com.evil.invalid/api-ws/v1/inference", "wss://test-secret@dashscope.aliyuncs.com/api-ws/v1/inference",
                              "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", "wss://dashscope.aliyuncs.com/api-ws/v1/inference?token=x"])
def test_only_verified_secure_provider_urls_are_accepted(monkeypatch, url):
    configure(monkeypatch, MEDIA_ASR_URL=url)
    with pytest.raises(recognition.RecognitionError) as exc:
        recognition._config_for("audio", None)
    assert exc.value.code == "provider_not_configured"
    assert "test-secret" not in str(exc.value)


@pytest.mark.parametrize("hostname", ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "llm-test.cn-beijing.maas.aliyuncs.com", "llm-test.ap-southeast-1.maas.aliyuncs.com"])
def test_documented_provider_hosts_allowed(monkeypatch, hostname):
    configure(monkeypatch, MEDIA_ASR_URL=f"wss://{hostname}/api-ws/v1/inference")
    assert recognition._config_for("audio", None).name == "dashscope_streaming"


@pytest.mark.parametrize(("options", "code"), [({"fail": "InvalidApiKey"}, "provider_auth_failed"), ({"fail": "Throttling"}, "provider_rate_limited"),
                                              ({"fail": "RequestTimeout"}, "provider_timeout"), ({"fail": "InternalError"}, "provider_unavailable"),
                                              ({"empty": True}, "no_text_detected"), ({"malformed": True}, "invalid_provider_response")])
def test_safe_failure_categories_do_not_return_partial_text(tmp_path, monkeypatch, options, code):
    configure(monkeypatch); socket = Socket(**options)
    monkeypatch.setattr(recognition, "_connect_dashscope", lambda config: socket)
    pcm = tmp_path / "audio.pcm"; pcm.write_bytes(b"\x00\x01")
    with pytest.raises(recognition.RecognitionError) as exc:
        recognition._DashScopeStreamingProvider(recognition._config_for("audio", None))._transcribe(pcm)
    assert exc.value.code == code and "test-secret" not in str(exc.value)
    assert socket.closed


def test_timeout_closes_connection_and_never_claims_success(tmp_path, monkeypatch):
    configure(monkeypatch, MEDIA_RECOGNITION_TIMEOUT_SECONDS="0.02")
    socket = Socket(); socket.send = socket.sent.append  # no task-started
    monkeypatch.setattr(recognition, "_connect_dashscope", lambda config: socket)
    pcm = tmp_path / "audio.pcm"; pcm.write_bytes(b"\x00\x01")
    with pytest.raises(recognition.RecognitionError) as exc:
        recognition._DashScopeStreamingProvider(recognition._config_for("audio", None))._transcribe(pcm)
    assert exc.value.code == "provider_timeout" and socket.closed


def test_response_budget_and_conflicting_final_text_reject_partial_success(tmp_path, monkeypatch):
    pcm = tmp_path / "audio.pcm"; pcm.write_bytes(b"\x00\x01")
    for values, socket in [({"MEDIA_RECOGNITION_MAX_RESPONSE_BYTES": "100"}, Socket()), ({"MEDIA_RECOGNITION_MAX_RESPONSE_BYTES": "20000"}, Socket(finals=[(1, "甲"), (1, "乙")]))]:
        configure(monkeypatch, **values)
        monkeypatch.setattr(recognition, "_connect_dashscope", lambda config: socket)
        with pytest.raises(recognition.RecognitionError) as exc:
            recognition._DashScopeStreamingProvider(recognition._config_for("audio", None))._transcribe(pcm)
        assert exc.value.code == "invalid_provider_response" and socket.closed


def test_conversion_failure_preserves_original_and_cleans_temporary_files(tmp_path, monkeypatch):
    configure(monkeypatch); original = tmp_path / "original"; original.write_bytes(b"\x1a\x45\xdf\xa3bytes")
    monkeypatch.setattr(recognition.shutil, "which", lambda _: "/ffmpeg")
    captured = {}
    def fail(args, **kwargs):
        captured["source"] = Path(args[args.index("-i") + 1]); raise subprocess.CalledProcessError(1, args)
    monkeypatch.setattr(recognition.subprocess, "run", fail)
    with pytest.raises(recognition.RecognitionError) as exc:
        recognition.recognize_file(original, kind="audio", content_type="audio/webm", attempt_id="attempt-2")
    assert exc.value.code == "invalid_media"
    assert original.read_bytes() == b"\x1a\x45\xdf\xa3bytes"
    assert not captured["source"].exists()


def test_provider_override_key_fallback_and_original_http_provider(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setenv("MEDIA_RECOGNITION_PROVIDER", "mock")
    monkeypatch.delenv("MEDIA_ASR_API_KEY")
    monkeypatch.delenv("MEDIA_RECOGNITION_API_KEY", raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "fallback-test")
    config = recognition._config_for("audio", None)
    assert config.name == "dashscope_streaming" and config.api_key == "fallback-test"
    monkeypatch.setenv("MEDIA_OCR_PROVIDER", "openai_compatible")
    monkeypatch.setenv("MEDIA_OCR_URL", "https://recognizer.invalid/ocr")
    monkeypatch.setenv("MEDIA_OCR_MODEL", "ocr")
    monkeypatch.setenv("MEDIA_OCR_API_KEY", "ocr-test")
    assert recognition._config_for("image", None).name == "openai_compatible"


def test_explicit_provider_remains_authoritative_over_environment(monkeypatch):
    configure(monkeypatch)
    assert recognition._config_for("audio", "mock").name == "mock"
    monkeypatch.setenv("MEDIA_ASR_URL", "https://recognizer.invalid/asr")
    assert recognition._config_for("audio", "openai_compatible").name == "openai_compatible"


def test_default_backend_defers_provider_to_per_kind_environment(tmp_path, monkeypatch):
    from backend.media_backend import create_default_media_backend
    from backend.store import SQLiteStore
    configure(monkeypatch)
    monkeypatch.setenv("MEDIA_RECOGNITION_PROVIDER", "openai_compatible")
    backend = create_default_media_backend(SQLiteStore(tmp_path / "records.sqlite3"), root=tmp_path / "media")
    try:
        assert backend.recognition_provider is None
        assert recognition._config_for("audio", backend.recognition_provider).name == "dashscope_streaming"
    finally:
        backend._executor.shutdown()


def test_websocket_connection_rejects_redirect_without_forwarding_credentials(monkeypatch):
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response
    from websockets.datastructures import Headers
    import websockets.sync.client
    configure(monkeypatch)
    calls = []
    def connect(url, **options):
        calls.append((url, options)); raise InvalidStatus(Response(302, "Moved", Headers({"Location": "wss://evil.invalid"})))
    monkeypatch.setattr(websockets.sync.client, "connect", connect)
    with pytest.raises(recognition.RecognitionError) as exc:
        recognition._connect_dashscope(recognition._config_for("audio", None))
    assert exc.value.code == "invalid_provider_response" and len(calls) == 1
    assert calls[0][1]["proxy"] is None and calls[0][1]["max_size"] > 0


def test_http_asr_assigns_mime_extension_to_storage_original(monkeypatch):
    configure(monkeypatch, MEDIA_ASR_PROVIDER="openai_compatible", MEDIA_ASR_URL="https://recognizer.invalid/asr")
    provider = recognition._OpenAICompatibleProvider(recognition._config_for("audio", None))
    request = provider._audio_request(b"bytes", "audio/webm", "original")
    assert b'filename="original.webm"' in request.data


@pytest.mark.skipif(not recognition.ffmpeg_executable(), reason="ffmpeg runtime is unavailable")
def test_real_ffmpeg_decodes_webm_copy_to_complete_pcm(tmp_path, monkeypatch):
    configure(monkeypatch)
    original = tmp_path / "original.webm"
    subprocess.run([recognition.ffmpeg_executable(), "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
                    "-c:a", "libopus", "-y", str(original)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    before = original.read_bytes(); captured = {}
    def inspect_pcm(self, pcm):
        captured["pcm"] = pcm.read_bytes(); return "受控转换检查，不是真实识别"
    monkeypatch.setattr(recognition._DashScopeStreamingProvider, "_transcribe", inspect_pcm)
    result = recognition.recognize_file(original, kind="audio", content_type="audio/webm", attempt_id="conversion-check")
    # Actual ffmpeg decode: 0.2 s * 16000 samples/s * 2 bytes/sample.
    assert len(captured["pcm"]) == 6400
    assert original.read_bytes() == before
    assert result["text"] == "受控转换检查，不是真实识别"


@pytest.mark.parametrize("value", ["inf", "nan", "-1"])
def test_invalid_timeout_cannot_disable_deadline(monkeypatch, value):
    monkeypatch.setenv("MEDIA_RECOGNITION_TIMEOUT_SECONDS", value)
    assert recognition._read_float_env("MEDIA_RECOGNITION_TIMEOUT_SECONDS", 30) == 30


def test_http_recognition_does_not_follow_real_redirect(monkeypatch):
    hits = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            hits.append(self.path)
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/target")
            self.send_header("Content-Length", "0")
            self.end_headers()
        def do_GET(self):
            hits.append(self.path); self.send_response(200); self.end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        configure(monkeypatch, MEDIA_ASR_PROVIDER="openai_compatible", MEDIA_ASR_URL=f"http://127.0.0.1:{server.server_port}/source")
        provider = recognition._OpenAICompatibleProvider(recognition._config_for("audio", None))
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x01\x00" * 1600)
        with pytest.raises(recognition.RecognitionError) as exc:
            provider.recognize(audio.getvalue(), kind="audio", content_type="audio/wav", filename="original.wav")
        assert exc.value.code == "invalid_provider_response"
        assert hits == ["/source"]
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
