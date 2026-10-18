"""Start the online competition demo, or explicitly select offline regression."""
from __future__ import annotations

import argparse
from pathlib import Path

from scripts.demo_config import check_demo_configuration, prepare_demo_environment

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None, *, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description="NoReset：加载 .env 并启动同源前后端；默认使用真实接口。")
    parser.add_argument("--offline", action="store_true", help="显式使用文字及 ASR/OCR Mock，仅用于离线回归")
    parser.add_argument("--check-config", action="store_true", help="只检查本地配置，不连接供应商、不启动服务")
    args = parser.parse_args(argv)
    try:
        env = prepare_demo_environment(root, offline=args.offline)
    except (OSError, UnicodeError):
        print("无法读取项目 .env，请检查文件权限或 UTF-8 编码。")
        return 2
    issues = check_demo_configuration(env, offline=args.offline)
    print("模式：离线 Mock 回归（不调用真实 AI）" if args.offline else "模式：真实接口")
    for section, errors in issues.items():
        print(f"{section}：" + ("；".join(errors) if errors else "配置检查通过"))
    print("配置检查不等于接口连通性、识别质量或医学验收；本步骤未调用供应商。")
    if any(issues.values()):
        print("未启动服务，请补齐以上配置后重试。")
        return 2
    if args.check_config:
        return 0
    from backend.server import serve

    print(f"打开 http://localhost:{int(env['API_PORT'])}/（前端与后端同源，Ctrl-C 停止）", flush=True)
    try:
        serve()
    except KeyboardInterrupt:
        print("\n演示服务已停止，已保存记录仍保留在数据库。")
    except OSError:
        print("服务启动失败：请检查端口是否被占用及本地文件访问权限。")
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
