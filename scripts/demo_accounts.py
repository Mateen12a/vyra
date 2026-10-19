"""Create (or reset) demo accounts for local testing: one admin, one user, both verified with credits.

Usage: python scripts/demo_accounts.py   (reads MONGO_URI and DB_NAME from .env)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from person_studio.__main__ import load_env_file  # noqa: E402

load_env_file(ROOT / ".env")

from argon2 import PasswordHasher  # noqa: E402

from person_studio.config import Settings  # noqa: E402
from person_studio.credits import Ledger  # noqa: E402
from person_studio.store import Store, utcnow  # noqa: E402

DEMO = [
    {"email": "admin@vyra.demo", "password": "VyraAdmin2026!", "role": "admin", "credits": 6000},
    {"email": "user@vyra.demo", "password": "VyraUser2026!", "role": "user", "credits": 600},
]


def main():
    settings = Settings()
    if not settings.mongo_uri:
        sys.exit("Set MONGO_URI in .env first.")
    store = Store(settings)
    store.ensure_indexes()
    ledger, hasher = Ledger(store), PasswordHasher()
    for account in DEMO:
        store.users.update_one({"email": account["email"]}, {
            "$set": {"password": hasher.hash(account["password"]), "role": account["role"], "verified": True},
            "$setOnInsert": {"created_at": utcnow(), "verified_at": utcnow()}}, upsert=True)
        user = store.users.find_one({"email": account["email"]})
        top_up = account["credits"] - ledger.balance(user["_id"])
        if top_up:
            ledger.apply(user["_id"], top_up, "admin", f"demo:{user['_id']}:{utcnow().timestamp()}",
                         reason="demo account balance")
        print(f"{account['role']:5}  {account['email']}  /  {account['password']}  ({ledger.balance(user['_id'])} credits)")


if __name__ == "__main__":
    main()
