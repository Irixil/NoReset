"""Serve only the user-facing frontend on its own port."""

from __future__ import annotations

import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]


class FrontendHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        if urlparse(self.path).path == "/service-worker.js":
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/runtime-config.js":
            api_base_url = os.getenv("BINGLI_API_BASE_URL", "").strip().rstrip("/")
            payload = (
                "globalThis.__BINGLI_CONFIG__ = "
                + json.dumps({"apiBaseUrl": api_base_url}, ensure_ascii=False, separators=(",", ":"))
                + ";\n"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


def serve(host: str, port: int, directory: Path) -> None:
    handler = partial(FrontendHandler, directory=str(directory))
    ThreadingHTTPServer((host, port), handler).serve_forever()


def main(argv: list[str] | None = None, *, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description="NoReset·内测版前端")
    parser.add_argument("--host", default=os.getenv("FRONTEND_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("FRONTEND_PORT", os.getenv("PORT", "5173"))))
    parser.add_argument("--directory", type=Path, default=root / "frontend")
    args = parser.parse_args(argv)
    print(f"请打开前端页面：http://{args.host}:{args.port}/", flush=True)
    try:
        serve(args.host, args.port, args.directory.resolve())
    except KeyboardInterrupt:
        print("\n前端服务已停止。")
    except OSError:
        print("前端启动失败：请检查端口是否被占用。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
