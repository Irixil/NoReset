from __future__ import annotations

import copy
from io import BytesIO

import pytest

from backend import conversation, server
from tests.http_support import HttpClient, running_http_server
from backend.store import SQLiteStore, StoreError

PHRASE = "我右肩酸了两天，抬手时明显一些，放下手休息一会儿就会减轻。"
EXPECTED = "抬手时明显一些；放下手休息一会儿就会减轻。"
TURN = "turn_audio_20261018"
SUBJECT = "subject_self"
ORIGIN = "http://127.0.0.1:5173"


def payload(text=PHRASE):
    turns = [{"turn_id": TURN, "text": text, "version": 1,
              "responding_to": {"turn_id": "turn_opening_20261018", "text": "您今天最难受的是什么？"}}]
    controller = conversation._controller_state({}, turns, SUBJECT)
    state = {category: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []}
             for category in conversation.CATEGORIES}
    state["main_complaint"] = {"status": "known", "summary": "我右肩酸了两天，",
                               "evidence_turn_ids": [TURN], "context_ids": []}
    state["aggravating_relieving"] = {"status": "known", "summary": "放下手休息一会儿就会减轻。",
                                     "evidence_turn_ids": [TURN], "context_ids": []}
    state["onset_course"] = {"status": "unknown", "summary": "两天", "evidence_turn_ids": [TURN], "context_ids": []}
    return {"subject_id": SUBJECT, "turns": turns, "health_context": [], "controller": controller,
            "completeness": {"clinical_state": state, "complete": False}}


def test_reground_uses_literal_excerpt_and_preserves_nonknown_and_input():
    body = payload()
    before = copy.deepcopy(body)
    result = conversation.reground_report(body)
    assert result["clinical_state"]["aggravating_relieving"]["summary"] == EXPECTED
    assert result["clinical_state"]["main_complaint"]["summary"] == "我右肩酸了两天，"
    assert result["clinical_state"]["onset_course"] == before["completeness"]["clinical_state"]["onset_course"]
    assert result["clinical_state"]["aggravating_relieving"]["evidence_turn_ids"] == [TURN]
    assert body == before
    assert result["source_only"] is True
    assert result["algorithm_version"] == "literal-report-v129"


@pytest.mark.parametrize("text", [
    "右肩酸吗？",
    "如果我右肩酸，抬手时明显一些。",
    "别人右肩酸了两天。",
    "我不确定是不是右肩酸。",
])
def test_reground_refuses_question_conditional_third_party_or_uncertain_sources(text):
    body = payload(text)
    with pytest.raises(conversation.ConversationError):
        conversation.reground_report(body)


def test_reground_refuses_missing_or_stale_source_binding():
    body = payload()
    body["completeness"]["clinical_state"]["aggravating_relieving"]["evidence_turn_ids"] = ["turn_missing_20261018"]
    with pytest.raises(conversation.ConversationError):
        conversation.reground_report(body)


def test_reground_refuses_a_summary_still_citing_a_corrected_turn():
    body = payload()
    body["turns"].append({
        "turn_id": "turn_correction_20261018", "text": "更正一下，刚才说放下手休息一会儿不准确，放手休息一会儿就会减轻。",
        "version": 1,
    })
    body["controller"] = conversation._controller_state({}, body["turns"], SUBJECT)
    with pytest.raises(conversation.ConversationError):
        conversation.reground_report(body)
    body = payload()
    body["controller"]["session_id"] = "0" * 64
    with pytest.raises(conversation.ConversationError):
        conversation.reground_report(body)


def test_reground_excludes_a_validated_non_health_turn():
    body = payload("我右肩酸了两天，抬手时明显一些，放下手休息一会儿就会减轻。")
    marker = {"turn_id": TURN, "version": 1,
              "text_sha256": conversation._turn_text_sha256(body["turns"][0]),
              "responding_to_sha256": conversation._responding_to_sha256(body["turns"][0]),
              "session_id": body["controller"]["session_id"]}
    body["controller"]["non_health_sources"] = [marker]
    with pytest.raises(conversation.ConversationError):
        conversation.reground_report(body)


def test_report_route_uses_existing_json_body_limit():
    handler = object.__new__(server.Handler)
    handler.headers = {"Content-Length": "1000001"}
    handler.rfile = BytesIO()
    with pytest.raises(StoreError, match="body_too_large"):
        handler.body()


def test_http_reground_is_session_csrf_protected_and_never_uses_ai_scope(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_MODE", "local_first")
    monkeypatch.setenv("APP_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("APP_OWNER_PASSWORD", "a sufficiently long password")
    monkeypatch.setenv("APP_COOKIE_SECURE", "false")
    monkeypatch.setenv("APP_AUTO_BIND_LOOPBACK", "true")
    monkeypatch.setenv("ALLOWED_ORIGIN", ORIGIN)
    monkeypatch.setenv("MODEL_PROVIDER", "mock")
    monkeypatch.setattr(server, "STORE", SQLiteStore(tmp_path / "local.sqlite3"))

    class LimiterSpy:
        calls = 0
        def acquire(self, _key):
            self.calls += 1
            return None
        def release(self, _key):
            raise AssertionError("source-only endpoint must not acquire/release AI capacity")

    limiter = LimiterSpy()
    monkeypatch.setattr(server, "AI_REQUEST_LIMITER", limiter)
    monkeypatch.setattr(server, "conversation_turn", lambda *_: (_ for _ in ()).throw(AssertionError("model route called")))
    monkeypatch.setattr(server, "product_execution_scope", lambda: (_ for _ in ()).throw(AssertionError("provider scope entered")))

    with running_http_server(server.Handler) as base_url:
        client = HttpClient(base_url, {"Content-Type": "application/json", "Origin": ORIGIN})
        session = client.request("GET", "/api/app/session")
        cookie = session.headers["Set-Cookie"].split(";", 1)[0]
        csrf = session.body["csrf_token"]
        headers = {"Origin": ORIGIN, "Cookie": cookie, "X-CSRF-Token": csrf}
        body = payload()
        denied_auth = client.request("POST", "/api/reports/reground", body, headers={"Origin": ORIGIN})
        assert denied_auth.status == 401
        denied_csrf = client.request("POST", "/api/reports/reground", body,
                                     headers={"Origin": ORIGIN, "Cookie": cookie, "X-CSRF-Token": "wrong"})
        assert denied_csrf.status == 403
        denied_origin = client.request("POST", "/api/reports/reground", body,
                                       headers={"Origin": "https://untrusted.example", "Cookie": cookie,
                                                "X-CSRF-Token": csrf})
        assert denied_origin.status == 403
        assert denied_origin.body["error"] == "origin_rejected"
        ok = client.request("POST", "/api/reports/reground", body, headers=headers)

    assert ok.status == 200
    assert ok.body == {"ok": True, "clinical_state": ok.body["clinical_state"],
                       "source_only": True, "algorithm_version": "literal-report-v129"}
    assert ok.body["clinical_state"]["aggravating_relieving"]["summary"] == EXPECTED
    assert limiter.calls == 0
