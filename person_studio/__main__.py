import argparse
import os
from pathlib import Path

import uvicorn


def load_env_file(path):
    """Read KEY=VALUE lines from a local .env; variables already set in the shell win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value:
            os.environ.setdefault(key, value)


def main():
    parser = argparse.ArgumentParser(description="Start VYRA AI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--env-file", default=".env", help="Local settings file (default: .env)")
    args = parser.parse_args()
    load_env_file(Path(args.env_file))
    loopback = args.host in {"127.0.0.1", "localhost", "::1"}
    if not loopback and not (os.getenv("PERSON_API_TOKEN") or os.getenv("MONGO_URI")):
        parser.error("Set MONGO_URI (user accounts) or PERSON_API_TOKEN before binding to a network interface.")
    if not loopback and os.getenv("VYRA_DEV_MODE", "").strip().lower() in {"1", "true", "on", "yes"}:
        parser.error("VYRA_DEV_MODE is for local development only. Turn it off before binding to a network interface.")
    from .app import create_app
    uvicorn.run(create_app(), host=args.host, port=args.port, limit_concurrency=32)


if __name__ == "__main__":
    main()
