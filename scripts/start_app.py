"""Start the local-first internal beta without storing health records server-side."""

from __future__ import annotations

import argparse
import ipaddress
import os
import secrets
from pathlib import Path
from typing import MutableMapping
from urllib.parse import urlsplit

from scripts.demo_config import check_demo_configuration, prepare_demo_environment


ROOT = Path(__file__).resolve().parents[1]


def _loopback_host(host: str) -> bool:
    value = host.strip().strip("[]").lower().rstrip(".")
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _loopback_origin(origin: str):
    try:
        parsed = urlsplit(origin.strip().rstrip("/"))
        _ = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or not _loopback_host(parsed.hostname)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return None
    return parsed


def prepare_app_environment(root: Path = ROOT, *, environ: MutableMapping[str, str] | None = None) -> tuple[MutableMapping[str, str], bool]:
    env = prepare_demo_environment(root, environ=os.environ if environ is None else environ)
    env["APP_MODE"] = "local_first"
    env.setdefault("FRONTEND_PORT", "5173")
    env.setdefault("ALLOWED_ORIGIN", f"http://127.0.0.1:{env['FRONTEND_PORT']}")
    env.setdefault("APP_AI_MEDIA_MAX_BYTES", str(20 * 1024 * 1024))
    api_host = env.get("API_HOST", "127.0.0.1") or "127.0.0.1"
    origin = _loopback_origin(env["ALLOWED_ORIGIN"])
    local_loopback = _loopback_host(api_host) and origin is not None
    secret_generated = False
    if local_loopback:
        if len(env.get("APP_SESSION_SECRET", "").encode("utf-8")) < 32:
            env["APP_SESSION_SECRET"] = secrets.token_urlsafe(48)
            secret_generated = True
        # The session endpoint still checks both the connecting IP and exact Origin.
        env["APP_AUTO_BIND_LOOPBACK"] = "true"
        if origin.scheme == "http":
            env["APP_COOKIE_SECURE"] = "false"
    else:
        # Public binds must never inherit a permissive local-development switch.
        env["APP_AUTO_BIND_LOOPBACK"] = "false"
    return env, secret_generated


def main(argv: list[str] | None = None, *, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description="病历不归零·内测版：本地加密主数据 + 无状态 AI 接口")
    parser.add_argument("--check-config", action="store_true", help="只检查配置，不启动、不调用 AI")
    args = parser.parse_args(argv)
    try:
        env, _ = prepare_app_environment(root)
    except (OSError, UnicodeError):
        print("无法读取项目 .env，请检查文件权限或 UTF-8 编码。")
        return 2
    issues = check_demo_configuration(env)
    print("模式：内测版（健康资料加密保存在浏览器）")
    for section, errors in issues.items():
        print(f"{section}：" + ("；".join(errors) if errors else "配置检查通过"))
    print("AI 调用：需要签名会话和 CSRF；仅本地回环前端可静默建立临时会话。")
    print("配置检查不会调用外部模型，也不证明真实识别质量。")
    if args.check_config:
        return 0 if not any(issues.values()) else 2
    from backend.server import serve

    print(f"后端 API：http://127.0.0.1:{int(env['API_PORT'])}/（不是使用者页面）", flush=True)
    try:
        serve()
    except KeyboardInterrupt:
        print("\n本地服务已停止；浏览器中的加密资料保留。")
    except OSError:
        print("服务启动失败：请检查端口是否被占用。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
