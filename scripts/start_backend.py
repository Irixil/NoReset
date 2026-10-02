"""只启动NoReset后端 API。"""

from scripts.start_app import main


if __name__ == "__main__":
    raise SystemExit(main())
