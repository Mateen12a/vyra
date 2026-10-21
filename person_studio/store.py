"""MongoDB access. Credit changes run in transactions, so the cluster must be a replica set (Atlas is)."""
import time
from datetime import datetime, timedelta, timezone

from pymongo import ASCENDING, MongoClient
from pymongo.errors import AutoReconnect, DuplicateKeyError

from .config import Settings


def utcnow():
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, settings: Settings, client=None):
        self.client = client or MongoClient(settings.mongo_uri, serverSelectionTimeoutMS=30000, retryWrites=True, retryReads=True, tz_aware=True)
        self.db = self.client[settings.db_name]
        for name in ("users", "sessions", "accounts", "ledger", "live_sessions", "rate_limits",
                     "tokens", "stripe_events", "audit_log", "trial_grants"):
            setattr(self, name, self.db[name])

    def ensure_indexes(self, attempts=4):
        # Atlas can be without a primary for a few seconds during maintenance or failover; retry instead of exiting.
        for attempt in range(attempts):
            try:
                return self._create_indexes()
            except AutoReconnect:
                if attempt == attempts - 1:
                    raise
                time.sleep(5 * (attempt + 1))

    def _create_indexes(self):
        self.users.create_index("email", unique=True)
        self.sessions.create_index("expires_at", expireAfterSeconds=0)
        self.tokens.create_index("expires_at", expireAfterSeconds=0)
        self.rate_limits.create_index("expires_at", expireAfterSeconds=0)
        self.rate_limits.create_index([("key", ASCENDING), ("at", ASCENDING)])
        # The unique key makes every credit change idempotent: a replayed webhook or retry is a no-op.
        self.ledger.create_index("idem_key", unique=True)
        self.ledger.create_index([("user_id", ASCENDING), ("at", ASCENDING)])
        self.ledger.create_index("payment_intent", sparse=True)
        self.live_sessions.create_index([("user_id", ASCENDING), ("state", ASCENDING)])
        self.audit_log.create_index("at")
        self.trial_grants.create_index("mailbox")
        self.trial_grants.create_index([("ip", ASCENDING), ("at", ASCENDING)])

    def audit(self, actor, action, **details):
        self.audit_log.insert_one({"at": utcnow(), "actor": actor, "action": action, **details})

    def hit(self, key, limit, window_seconds):
        """Database-backed rate limit; returns False once `limit` hits land inside the window."""
        now = utcnow()
        since = now - timedelta(seconds=window_seconds)
        if self.rate_limits.count_documents({"key": key, "at": {"$gt": since}}) >= limit:
            return False
        self.rate_limits.insert_one({"key": key, "at": now, "expires_at": now + timedelta(seconds=window_seconds)})
        return True


__all__ = ["Store", "utcnow", "DuplicateKeyError"]
