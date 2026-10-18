import json
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: object
    body: object


class HttpClient:
    def __init__(self, base_url, default_headers=None):
        self.base_url = base_url
        self.default_headers = default_headers or {}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(
        self,
        method,
        path,
        body=None,
        *,
        headers=None,
        raw_body=None,
        timeout=5,
    ):
        request_headers = {**self.default_headers, **(headers or {})}
        request = urllib.request.Request(
            self.base_url + path,
            method=method,
            headers=request_headers,
            data=(
                raw_body
                if raw_body is not None
                else None
                if body is None
                else json.dumps(body).encode("utf-8")
            ),
        )
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            raw_response = response.read()
            payload = json.loads(raw_response) if raw_response else None
            return HttpResponse(response.status, response.headers, payload)


@contextmanager
def running_http_server(handler):
    from backend import text_trial
    operator_binding = Path(__file__).resolve().parents[1] / 'runtime/synthetic-trial/browser-metered-qa/current-text-trial.json'
    previous_binding = text_trial.BINDING_PATH
    isolated = previous_binding == operator_binding
    temporary = TemporaryDirectory(prefix='noreset-http-test-grants-') if isolated else None
    if isolated:
        # Keep explicit temporary native grants intact; ordinary HTTP fixtures
        # must never discover retained operator grants from another test run.
        text_trial.BINDING_PATH = Path(temporary.name) / 'current-text-trial.json'
    httpd = worker = None
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        if httpd is not None:
            if worker is not None and worker.ident is not None:
                httpd.shutdown()
            httpd.server_close()
        if worker is not None and worker.ident is not None:
            worker.join(timeout=2)
        if isolated:
            text_trial.BINDING_PATH = previous_binding
            temporary.cleanup()
