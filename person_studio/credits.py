"""Credit ledger. Every balance change is one transaction: a conditional $inc plus an idempotent ledger row.

The balance can never go negative (the debit filter requires balance >= amount), and replaying the same
idem_key (Stripe event, live block, refund) never applies twice.
"""
import math
from datetime import timedelta

from bson import ObjectId
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from . import pricing
from .store import Store, utcnow


class InsufficientCredits(Exception):
    pass


class Ledger:
    def __init__(self, store: Store):
        self.store = store

    def balance(self, user_id):
        account = self.store.accounts.find_one({"_id": user_id})
        return account["balance"] if account else 0

    def apply(self, user_id, delta, kind, idem_key, **details):
        """Apply `delta` credits once. Returns the new balance, or None if idem_key was already applied."""
        if not isinstance(delta, int) or delta == 0:
            raise ValueError("Credit changes are whole, non-zero numbers.")

        def body(session):
            if self.store.ledger.find_one({"idem_key": idem_key}, session=session):
                return None
            if delta < 0:
                account = self.store.accounts.find_one_and_update(
                    {"_id": user_id, "balance": {"$gte": -delta}}, {"$inc": {"balance": delta}},
                    session=session, return_document=ReturnDocument.AFTER)
                if not account:
                    raise InsufficientCredits()
            else:
                account = self.store.accounts.find_one_and_update(
                    {"_id": user_id}, {"$inc": {"balance": delta}, "$setOnInsert": {"created_at": utcnow()}},
                    upsert=True, session=session, return_document=ReturnDocument.AFTER)
            self.store.ledger.insert_one({"user_id": user_id, "delta": delta, "kind": kind, "idem_key": idem_key,
                                          "balance_after": account["balance"], "at": utcnow(), **details},
                                         session=session)
            return account["balance"]

        with self.store.client.start_session() as session:
            try:
                return session.with_transaction(body)
            except DuplicateKeyError:
                return None

    def history(self, user_id, limit=50):
        rows = self.store.ledger.find({"user_id": user_id}, {"_id": 0, "user_id": 0, "idem_key": 0}) \
            .sort("at", -1).limit(limit)
        return [{key: value.isoformat() if key == "at" else str(value) if isinstance(value, ObjectId) else value
                 for key, value in row.items()} for row in rows]


class LiveMeter:
    """Live sessions are paid in prepaid blocks of LIVE_BLOCK_SECONDS, timed on the server clock.

    start() buys the first block. extend() (browser heartbeat) buys the next block once the paid time is
    nearly used, or tells the browser to stop when the balance can't cover it. end() refunds whole unused
    seconds of the last block. Sessions that never call end() keep their paid blocks (sweep()).
    """

    FREE_WARMUP = 20        # seconds of connecting before the first AI frame that aren't charged
    NO_VIDEO_WINDOW = 35    # a session ended this soon without any AI frame is refunded in full...
    NO_VIDEO_PER_DAY = 3    # ...at most this many times a day per person

    def __init__(self, store: Store, ledger: Ledger):
        self.store, self.ledger = store, ledger
        self.block = pricing.LIVE_BLOCK_SECONDS * pricing.LIVE_CREDITS_PER_SECOND

    def _billable(self, record, now):
        """Seconds to charge so far: from the session start, minus free warm-up once the first frame arrived."""
        elapsed = (now - record["started_at"]).total_seconds()
        video_at = record.get("video_at")
        if video_at:
            elapsed -= min(self.FREE_WARMUP, (video_at - record["started_at"]).total_seconds())
        return max(0.0, elapsed)

    def video_started(self, session_id, user_id):
        """The browser shows the first AI frame: charging for warm-up stops here (up to FREE_WARMUP)."""
        self.store.live_sessions.update_one({"_id": session_id, "user_id": user_id, "state": "live", "video_at": None},
                                            {"$set": {"video_at": utcnow()}})
        return self.status(session_id, user_id)

    def start(self, user_id, provider):
        self.sweep(user_id)
        if self.store.live_sessions.find_one({"user_id": user_id, "state": "live"}):
            raise RuntimeError("You already have a live session open. End it first.")
        now = utcnow()
        session_id = self.store.live_sessions.insert_one({
            "user_id": user_id, "provider": provider, "state": "live", "started_at": now,
            "last_heartbeat_at": now, "paid_seconds": 0, "blocks": 0, "video_at": None}).inserted_id
        try:
            self._buy_block(session_id, user_id, 0)
        except InsufficientCredits:
            self.store.live_sessions.delete_one({"_id": session_id})
            raise
        return self.status(session_id, user_id)

    def _buy_block(self, session_id, user_id, number):
        self.ledger.apply(user_id, -self.block, "live", f"live:{session_id}:{number}", session_id=str(session_id))
        self.store.live_sessions.update_one({"_id": session_id, "blocks": number},
                                            {"$inc": {"blocks": 1, "paid_seconds": pricing.LIVE_BLOCK_SECONDS}})

    def _get(self, session_id, user_id):
        record = self.store.live_sessions.find_one({"_id": session_id, "user_id": user_id})
        if not record:
            raise KeyError(session_id)
        return record

    def status(self, session_id, user_id):
        record = self._get(session_id, user_id)
        elapsed = self._billable(record, utcnow())
        return {"session_id": str(session_id), "state": record["state"], "elapsed": int(elapsed),
                "paid_seconds": record["paid_seconds"], "balance": self.ledger.balance(user_id)}

    def extend(self, session_id, user_id):
        record = self._get(session_id, user_id)
        if record["state"] != "live":
            return {**self.status(session_id, user_id), "stop": True}
        now = utcnow()
        self.store.live_sessions.update_one({"_id": session_id}, {"$set": {"last_heartbeat_at": now}})
        elapsed = self._billable(record, now)
        if elapsed > record["paid_seconds"] - 20:  # buy ahead so the stream never pauses on a block edge
            try:
                self._buy_block(session_id, user_id, record["blocks"])
            except InsufficientCredits:
                stop = elapsed >= record["paid_seconds"]
                if stop:
                    self.end(session_id, user_id)
                return {**self.status(session_id, user_id), "stop": stop, "low_balance": True}
        return {**self.status(session_id, user_id), "stop": False}

    def end(self, session_id, user_id):
        record = self.store.live_sessions.find_one_and_update(
            {"_id": session_id, "user_id": user_id, "state": "live"},
            {"$set": {"state": "ended", "ended_at": utcnow()}}, return_document=ReturnDocument.AFTER)
        if record:
            used = math.ceil(self._billable(record, record["ended_at"]))
            if not record.get("video_at") and used <= self.NO_VIDEO_WINDOW:
                since = record["ended_at"] - timedelta(days=1)
                if self.store.live_sessions.count_documents({"user_id": user_id, "no_video_refund": True,
                                                              "ended_at": {"$gte": since}}) < self.NO_VIDEO_PER_DAY:
                    used = 0  # nothing was ever shown: give it all back
                    self.store.live_sessions.update_one({"_id": session_id}, {"$set": {"no_video_refund": True}})
            unused = max(0, record["paid_seconds"] - used) * pricing.LIVE_CREDITS_PER_SECOND
            if unused:
                self.ledger.apply(user_id, unused, "live_refund", f"live:{session_id}:refund",
                                  session_id=str(session_id))
            self.store.live_sessions.update_one({"_id": session_id}, {"$set": {"used_seconds": used}})
        return self.status(session_id, user_id)

    def cancel(self, session_id, user_id):
        """The engine never connected: close the session and give back every credit it took."""
        record = self.store.live_sessions.find_one_and_update(
            {"_id": session_id, "user_id": user_id, "state": "live"},
            {"$set": {"state": "cancelled", "ended_at": utcnow(), "used_seconds": 0}})
        if record and record["paid_seconds"]:
            self.ledger.apply(user_id, record["paid_seconds"] * pricing.LIVE_CREDITS_PER_SECOND, "live_refund",
                              f"live:{session_id}:refund", session_id=str(session_id))

    def sweep(self, user_id=None):
        """Close sessions whose paid time ran out without a heartbeat.

        If a heartbeat timestamp was recorded before the browser disconnected, refund whole unused seconds
        after the heartbeat grace window (20 s) so crashed tabs don't lose an entire 60-second block.
        """
        query = {"state": "live", **({"user_id": user_id} if user_id else {})}
        for record in self.store.live_sessions.find(query):
            deadline = record["started_at"] + timedelta(seconds=record["paid_seconds"] + 30 + (self.FREE_WARMUP if record.get("video_at") else 0))
            if utcnow() > deadline:
                last_seen = record.get("last_heartbeat_at")
                if last_seen and last_seen > record["started_at"]:
                    active_secs = math.ceil((last_seen - record["started_at"]).total_seconds()) + 20
                    used = min(record["paid_seconds"], max(1, active_secs))
                else:
                    used = record["paid_seconds"]
                updated = self.store.live_sessions.find_one_and_update(
                    {"_id": record["_id"], "state": "live"},
                    {"$set": {"state": "expired", "ended_at": deadline, "used_seconds": used}},
                    return_document=ReturnDocument.AFTER)
                if updated:
                    unused = max(0, record["paid_seconds"] - used) * pricing.LIVE_CREDITS_PER_SECOND
                    if unused:
                        self.ledger.apply(record["user_id"], unused, "live_refund",
                                          f"live:{record['_id']}:refund", session_id=str(record["_id"]))
