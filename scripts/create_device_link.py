"""Create a short-lived family/admin link that binds one browser device."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from urllib.parse import quote

from backend import app_access
from scripts.start_app import ROOT, prepare_app_environment


def create_link(frontend_url: str, *, root: Path = ROOT) -> tuple[str, int]:
    env, _ = prepare_app_environment(root, environ=dict(os.environ))
    os.environ.update(env)
    token, expires_at = app_access.issue_device_activation()
    return f"{frontend_url.rstrip('/')}/#bind={quote(token, safe='')}", expires_at


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成NoReset设备绑定链接")
    parser.add_argument(
        "--frontend-url",
        default=os.getenv("APP_FRONTEND_URL") or os.getenv("ALLOWED_ORIGIN") or "http://127.0.0.1:5173",
        help="使用者打开的前端地址",
    )
    args = parser.parse_args(argv)
    try:
        link, expires_at = create_link(args.frontend_url)
    except (app_access.AccessConfigurationError, OSError, UnicodeError) as error:
        print(f"无法生成绑定链接：{error}")
        return 2
    print(link)
    print(f"此链接为短时设备绑定链接，到期时间戳：{expires_at}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
