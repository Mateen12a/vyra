"""Accounts, credit ledger, live metering and Stripe webhooks against a throwaway MongoDB database.

Runs only when MONGO_URI points at a replica set (Atlas works); each run uses and drops its own database.
"""
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from person_studio import pricing
from person_studio.app import create_app
from person_studio.config import Settings
from person_studio.credits import InsufficientCredits, Ledger, LiveMeter
from person_studio.store import Store, utcnow

ORIGIN = "http://127.0.0.1:8765"
WEBHOOK_SECRET = "whsec_test_" + secrets.token_hex(8)


def env_value(name):
    if os.getenv(name):
        return os.environ[name]
    path = Path(__file__).resolve().parents[1] / ".env"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


MONGO_URI = env_value("MONGO_URI")
pytestmark = pytest.mark.skipif(not MONGO_URI, reason="Set MONGO_URI to run the accounts tests")


class Mailer:
    def __init__(self):
        self.sent = []

    def send(self, email, kind, token):
        self.sent.append((email, kind, token))

    def last(self, kind):
        return next(token for _, k, token in reversed(self.sent) if k == kind)


@pytest.fixture(scope="module")
def settings(tmp_path_factory):
    return Settings(data_dir=tmp_path_factory.mktemp("data"), mongo_uri=MONGO_URI,
                    db_name="vyra_test_" + secrets.token_hex(4), stripe_secret_key="sk_test_dummy",
                    stripe_webhook_secret=WEBHOOK_SECRET, fal_key="")


@pytest.fixture(scope="module")
def store(settings):
    store = Store(settings)
    store.ensure_indexes()
    yield store
    store.client.drop_database(settings.db_name)


@pytest.fixture
def mailer():
    return Mailer()


@pytest.fixture
def client(settings, store, mailer):
    store.rate_limits.delete_many({})  # each test starts under the signup/login limits
    app = create_app(settings, store=store, mailer=mailer)
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        yield client


def signup(client, mailer, verify=True):
    email = f"user{secrets.token_hex(4)}@example.com"
    response = client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery"})
    assert response.status_code == 200, response.text
    if verify:
        assert client.post("/api/auth/verify", json={"token": mailer.last("verify")}).status_code == 200
    return email


def user_id(store, email):
    return store.users.find_one({"email": email})["_id"]


def test_signup_verify_grants_free_credits_once(client, mailer, store):
    email = signup(client, mailer, verify=False)
    assert client.get("/api/auth/me").json()["balance"] == 0
    token = mailer.last("verify")
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 200
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 400  # single use
    me = client.get("/api/auth/me").json()
    assert me["user"]["verified"] and me["balance"] == pricing.FREE_CREDITS_ON_VERIFY
    assert store.users.find_one({"email": email})["password"].startswith("$argon2")


def test_login_logout_and_protected_routes(client, mailer):
    email = signup(client, mailer)
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/credits").status_code == 401
    assert client.get("/api/pricing").status_code == 401  # prices are for signed-in users only
    assert client.post("/api/auth/login", json={"email": email, "password": "wrong password!"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": email.upper(), "password": "correct horse battery"}).status_code == 200
    assert client.get("/api/credits").json()["balance"] == pricing.FREE_CREDITS_ON_VERIFY
    assert client.get("/api/pricing").status_code == 200


def test_resend_mailer_posts_to_resend(monkeypatch):
    from types import SimpleNamespace
    from person_studio import accounts
    sent = {}

    class Reply:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"{}"

    def fake_urlopen(request, timeout):
        sent["url"], sent["auth"], sent["body"] = request.full_url, request.headers["Authorization"], request.data
        return Reply()

    monkeypatch.setattr(accounts.urllib.request, "urlopen", fake_urlopen)
    settings = SimpleNamespace(resend_api_key="re_test", smtp_host="", smtp_from="VYRANI <a@b.c>", public_url="https://x.test")
    mailer = accounts.pick_mailer(settings)
    assert isinstance(mailer, accounts.ResendMailer)
    mailer.send("u@example.com", "verify", "tok123")
    assert sent["url"] == "https://api.resend.com/emails" and sent["auth"] == "Bearer re_test"
    assert b"https://x.test/verify?token=tok123" in sent["body"]


def test_session_cookie_is_httponly(client, mailer):
    email = f"cookie{secrets.token_hex(4)}@example.com"
    response = client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery"})
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_cross_origin_posts_are_rejected(client, mailer):
    signup(client, mailer)
    response = client.post("/api/auth/logout", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.get("/api/auth/me").status_code == 200


def test_duplicate_signup_and_weak_password(client):
    email = f"dup{secrets.token_hex(4)}@example.com"
    assert client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery"}).status_code == 200
    assert client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery"}).status_code == 409
    assert client.post("/api/auth/signup", json={"email": "x" + email, "password": "short"}).status_code == 422


def test_password_reset_signs_out_everywhere(client, mailer):
    email = signup(client, mailer)
    client.post("/api/auth/reset/request", json={"email": email})
    assert client.post("/api/auth/reset", json={"token": mailer.last("reset"), "password": "a brand new password"}).status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"email": email, "password": "a brand new password"}).status_code == 200


def test_ledger_never_goes_negative_and_is_idempotent(store):
    ledger = Ledger(store)
    uid = store.users.insert_one({"email": f"l{secrets.token_hex(4)}@example.com"}).inserted_id
    assert ledger.apply(uid, 100, "test", f"t:{uid}:1") == 100
    assert ledger.apply(uid, 100, "test", f"t:{uid}:1") is None  # replay
    with pytest.raises(InsufficientCredits):
        ledger.apply(uid, -101, "test", f"t:{uid}:2")
    assert ledger.apply(uid, -100, "test", f"t:{uid}:3") == 0
    assert ledger.balance(uid) == 0
    assert sum(row["delta"] for row in store.ledger.find({"user_id": uid})) == 0


def test_live_meter_blocks_and_refund(store, monkeypatch):
    monkeypatch.setattr(pricing, "LIVE_BLOCK_SECONDS", 60)  # block arithmetic below is written for 60 s blocks
    ledger = Ledger(store)
    meter = LiveMeter(store, ledger)
    uid = store.users.insert_one({"email": f"m{secrets.token_hex(4)}@example.com"}).inserted_id
    ledger.apply(uid, 150, "test", f"seed:{uid}")
    status = meter.start(uid, "fal")
    assert status["paid_seconds"] == 60 and ledger.balance(uid) == 90
    with pytest.raises(RuntimeError):
        meter.start(uid, "fal")  # one live session per user
    from bson import ObjectId
    sid = ObjectId(status["session_id"])
    # Pretend 50 s have passed: the heartbeat buys the next block ahead of time.
    store.live_sessions.update_one({"_id": sid}, {"$set": {"started_at": utcnow() - timedelta(seconds=50)}})
    assert meter.extend(sid, uid)["paid_seconds"] == 120 and ledger.balance(uid) == 30
    # At 110 s the next block can't be afforded; still inside paid time, so keep going with a warning.
    store.live_sessions.update_one({"_id": sid}, {"$set": {"started_at": utcnow() - timedelta(seconds=110)}})
    result = meter.extend(sid, uid)
    assert result["low_balance"] and not result["stop"]
    # Ending at ~110 s refunds the unused ~10 s of the paid 120 s.
    ended = meter.end(sid, uid)
    assert ended["state"] == "ended" and 30 <= ledger.balance(uid) <= 40  # slow networks add seconds


def test_live_meter_stops_when_out_of_credits(store, monkeypatch):
    monkeypatch.setattr(pricing, "LIVE_BLOCK_SECONDS", 60)  # block arithmetic below is written for 60 s blocks
    ledger = Ledger(store)
    meter = LiveMeter(store, ledger)
    uid = store.users.insert_one({"email": f"s{secrets.token_hex(4)}@example.com"}).inserted_id
    ledger.apply(uid, 60, "test", f"seed:{uid}")
    from bson import ObjectId
    sid = ObjectId(meter.start(uid, "fal")["session_id"])
    store.live_sessions.update_one({"_id": sid}, {"$set": {"started_at": utcnow() - timedelta(seconds=61)}})
    result = meter.extend(sid, uid)
    assert result["stop"] and result["state"] == "ended" and ledger.balance(uid) == 0


def test_live_token_needs_credits(client, mailer, store):
    email = signup(client, mailer, verify=False)
    assert client.post("/api/live/token").status_code == 402
    assert store.live_sessions.count_documents({"user_id": user_id(store, email)}) == 0


def test_live_token_refunds_when_engine_unavailable(client, mailer, store):
    email = signup(client, mailer)  # 60 free credits; no live engine configured in tests
    assert client.post("/api/live/token").status_code == 503
    assert client.get("/api/auth/me").json()["balance"] == pricing.FREE_CREDITS_ON_VERIFY
    assert store.live_sessions.find_one({"user_id": user_id(store, email)})["state"] == "cancelled"


def stripe_post(client, event):
    payload = json.dumps(event)
    stamp = str(int(time.time()))
    signature = hmac.new(WEBHOOK_SECRET.encode(), f"{stamp}.{payload}".encode(), hashlib.sha256).hexdigest()
    return client.post("/api/billing/webhook", content=payload,
                       headers={"stripe-signature": f"t={stamp},v1={signature}", "Content-Type": "application/json",
                                "Origin": ""})


def checkout_event(uid, pack="starter", amount=None, session_id=None):
    return {"id": "evt_" + secrets.token_hex(6), "object": "event", "type": "checkout.session.completed",
            "data": {"object": {"id": session_id or "cs_test_" + secrets.token_hex(6), "object": "checkout.session",
                                "payment_status": "paid", "currency": "usd",
                                "amount_total": pricing.PACKS[pack]["amount_cents"] if amount is None else amount,
                                "payment_intent": "pi_" + (session_id or "x"),
                                "metadata": {"user_id": str(uid), "pack": pack,
                                             "credits": str(pricing.PACKS[pack]["credits"])}}}}


def test_stripe_webhook_grants_once(client, mailer, store):
    email = signup(client, mailer)
    uid = user_id(store, email)
    assert client.get("/api/auth/me").json()["user"]["can_remove_watermark"] is False
    assert client.get("/api/live/status").json()["can_remove_watermark"] is False
    assert client.get("/api/live/status").json()["ai_label"] is True
    event = checkout_event(uid)
    assert stripe_post(client, event).status_code == 200
    assert stripe_post(client, event).status_code == 200  # Stripe retries must not double-grant
    me = client.get("/api/auth/me").json()
    assert me["balance"] == pricing.FREE_CREDITS_ON_VERIFY + 240
    assert me["user"]["can_remove_watermark"] is True
    status = client.get("/api/live/status").json()
    assert status["can_remove_watermark"] is True
    assert status["likeness_watermark_always"] is True


def test_live_meter_sweep_refunds_after_heartbeat(store, monkeypatch):
    monkeypatch.setattr(pricing, "LIVE_BLOCK_SECONDS", 60)  # block arithmetic below is written for 60 s blocks
    from bson import ObjectId
    ledger = Ledger(store)
    meter = LiveMeter(store, ledger)
    uid = store.users.insert_one({"email": f"sw{secrets.token_hex(4)}@example.com"}).inserted_id
    ledger.apply(uid, 60, "test", f"seed:{uid}")
    sid = ObjectId(meter.start(uid, "fal")["session_id"])
    started = utcnow() - timedelta(seconds=100)
    # Heartbeat occurred 15 s into the session before the tab crashed; 15 + 20s grace = 35s used -> 25 credits refunded
    store.live_sessions.update_one({"_id": sid}, {"$set": {"started_at": started, "last_heartbeat_at": started + timedelta(seconds=15)}})
    meter.sweep(uid)
    doc = store.live_sessions.find_one({"_id": sid})
    assert doc["state"] == "expired" and doc["used_seconds"] == 35
    assert ledger.balance(uid) == 25


def test_stripe_webhook_rejects_bad_signature_and_wrong_amount(client, mailer, store):
    email = signup(client, mailer)
    uid = user_id(store, email)
    bad = client.post("/api/billing/webhook", content=json.dumps(checkout_event(uid)),
                      headers={"stripe-signature": "t=1,v1=deadbeef", "Content-Type": "application/json"})
    assert bad.status_code == 400
    assert stripe_post(client, checkout_event(uid, amount=100)).status_code == 200
    assert client.get("/api/auth/me").json()["balance"] == pricing.FREE_CREDITS_ON_VERIFY


def test_admin_routes_need_admin(client, mailer, store):
    email = signup(client, mailer)
    assert client.get("/api/admin/users").status_code == 403
    store.users.update_one({"email": email}, {"$set": {"role": "admin"}})
    target = user_id(store, email)
    response = client.post(f"/api/admin/users/{target}/credits",
                           json={"amount": 25, "reason": "support goodwill", "key": secrets.token_hex(6)})
    assert response.status_code == 200 and response.json()["balance"] == pricing.FREE_CREDITS_ON_VERIFY + 25
    assert store.audit_log.find_one({"action": "admin_credits", "user_id": target})


def test_paid_tool_without_credits_is_refused(client, mailer):
    signup(client, mailer, verify=False)
    response = client.post("/api/assist/look", json={"idea": "pirate captain"})
    assert response.status_code == 402


def test_failed_clip_is_refunded_once(client, mailer, store):
    email = signup(client, mailer)
    uid = user_id(store, email)
    ledger = Ledger(store)
    job_id = "11111111-1111-4111-8111-" + secrets.token_hex(6)
    ledger.apply(uid, pricing.TOOLS["clip"], "test", f"seed:{job_id}")
    ledger.apply(uid, -pricing.TOOLS["clip"], "clip", f"clip:{job_id}")
    record = {"id": job_id, "owner": str(uid), "status": "failed"}
    client.app.state.jobs.on_failed(record)
    client.app.state.jobs.on_failed(record)  # a second report must not refund again
    assert ledger.balance(uid) == pricing.FREE_CREDITS_ON_VERIFY + pricing.TOOLS["clip"]  # seed came back once


def test_clips_are_private_to_their_owner(client, mailer, store):
    signup(client, mailer)
    jobs = client.app.state.jobs
    job_id, folder = jobs.create()
    jobs.slots.release()
    jobs.records[job_id] = {"id": job_id, "owner": "someone-else", "status": "completed"}
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_admin_stats_and_live_list(client, mailer, store):
    email = signup(client, mailer)
    store.users.update_one({"email": email}, {"$set": {"role": "admin"}})
    stats = client.get("/api/admin/stats").json()
    assert stats["users"] >= 1 and "revenue_cents" in stats
    assert isinstance(client.get("/api/admin/live").json(), list)


# ---------- Google sign-in (Google's HTTP endpoints are faked) ----------
from person_studio.google_oauth import STATE_COOKIE, GoogleSignIn  # noqa: E402


def google_client(settings, store, mailer, profile):
    calls = []

    def fake_http(url, data=None, headers=None):
        calls.append(url)
        return {"access_token": "at"} if "token" in url else profile

    google_settings = Settings(**{**settings.__dict__, "google_client_id": "cid", "google_client_secret": "secret"})
    app = create_app(google_settings, store=store, mailer=mailer, google=GoogleSignIn(google_settings, http=fake_http))
    return TestClient(app, headers={"Origin": ORIGIN}, follow_redirects=False), calls


def google_round_trip(client):
    start = client.get("/api/auth/google/start")
    assert start.status_code == 302 and start.headers["location"].startswith("https://accounts.google.com/")
    assert "code_challenge_method=S256" in start.headers["location"]
    state = start.headers["location"].split("state=")[1].split("&")[0]
    return client.get(f"/api/auth/google/callback?code=abc&state={state}")


def test_google_signup_is_verified_with_free_credits(settings, store, mailer):
    store.rate_limits.delete_many({})
    email = f"g{secrets.token_hex(4)}@gmail.com"
    client, calls = google_client(settings, store, mailer, {"sub": secrets.token_hex(8), "email": email, "email_verified": True})
    with client:
        assert client.get("/api/auth/providers").json() == {"google": True}
        done = google_round_trip(client)
        assert done.status_code == 302 and "auth_error" not in done.headers["location"]
        me = client.get("/api/auth/me").json()
        assert me["user"]["email"] == email and me["user"]["verified"] and me["balance"] == pricing.FREE_CREDITS_ON_VERIFY
        assert not me["user"]["has_password"]
        # A Google-only account can't be entered with any password.
        client.post("/api/auth/logout")
        assert client.post("/api/auth/login", json={"email": email, "password": "anything at all"}).status_code == 401


def test_google_callback_rejects_forged_state(settings, store, mailer):
    store.rate_limits.delete_many({})
    client, calls = google_client(settings, store, mailer, {"sub": "x", "email": "x@gmail.com", "email_verified": True})
    with client:
        client.get("/api/auth/google/start")
        response = client.get("/api/auth/google/callback?code=abc&state=forged")
        assert "auth_error=google" in response.headers["location"]
        assert not any("token" in url for url in calls)  # never even exchanged the code
        assert client.get("/api/auth/me").status_code == 401


def test_google_drops_password_of_unverified_squatter(settings, store, mailer):
    store.rate_limits.delete_many({})
    email = f"victim{secrets.token_hex(4)}@gmail.com"
    client, _ = google_client(settings, store, mailer, {"sub": secrets.token_hex(8), "email": email, "email_verified": True})
    with client:
        # Someone signs up with the victim's address but never verifies it.
        assert client.post("/api/auth/signup", json={"email": email, "password": "squatter password"}).status_code == 200
        client.cookies.clear()
        google_round_trip(client)  # the real owner arrives through Google
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"email": email, "password": "squatter password"}).status_code == 401
        assert store.users.find_one({"email": email})["verified"]


def test_google_unverified_email_is_refused(settings, store, mailer):
    store.rate_limits.delete_many({})
    client, _ = google_client(settings, store, mailer, {"sub": "y", "email": "y@example.com", "email_verified": False})
    with client:
        assert "auth_error=google" in google_round_trip(client).headers["location"]


def test_trial_rules(store):
    from person_studio import trial
    assert trial.canonical_email("A.B+promo@GoogleMail.com") == "ab@gmail.com"
    assert trial.canonical_email("a.b+x@outlook.com") == "a.b@outlook.com"
    assert trial.decide(store, "x@mailinator.com", "8.8.8.8") == "disposable_email"
    trial.record(store, "u1", "jane.doe@gmail.com", "8.8.4.4")
    assert trial.decide(store, "janedoe+2@gmail.com", "1.1.1.1") == "mailbox_used"
    trial.record(store, "u2", "other@example.com", "8.8.4.4")
    assert trial.decide(store, "third@example.com", "8.8.4.4") == "address_limit"
    assert trial.decide(store, "third@example.com", "127.0.0.1") is None  # local/dev addresses aren't limited


def test_disposable_signup_gets_no_trial(client, mailer, store):
    email = "farm@yopmail.com"
    client.post("/api/auth/signup", json={"email": email, "password": "correct horse battery"})
    assert client.post("/api/auth/verify", json={"token": mailer.last("verify")}).status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["balance"] == 0 and me["user"]["trial"] == "disposable_email"


def refund_event(intent, amount, refunded):
    return {"id": "evt_" + secrets.token_hex(6), "object": "event", "type": "charge.refunded",
            "data": {"object": {"id": "ch_" + secrets.token_hex(6), "object": "charge", "payment_intent": intent,
                                "amount": amount, "amount_refunded": refunded}}}


def test_refund_takes_back_credits_once_and_proportionally(client, mailer, store):
    email = signup(client, mailer)
    uid = user_id(store, email)
    sid = "cs_test_" + secrets.token_hex(6)
    assert stripe_post(client, checkout_event(uid, session_id=sid)).status_code == 200
    start = pricing.FREE_CREDITS_ON_VERIFY + 240
    intent, amount = "pi_" + sid, pricing.PACKS["starter"]["amount_cents"]
    half = refund_event(intent, amount, amount // 2)
    assert stripe_post(client, half).status_code == 200
    assert stripe_post(client, half).status_code == 200  # resent event: no second deduction
    assert client.get("/api/auth/me").json()["balance"] == start - 120
    assert stripe_post(client, refund_event(intent, amount, amount)).status_code == 200  # rest refunded
    assert client.get("/api/auth/me").json()["balance"] == start - 240


def test_refund_after_credits_were_spent_stops_at_zero(client, mailer, store):
    email = signup(client, mailer)
    uid = user_id(store, email)
    sid = "cs_test_" + secrets.token_hex(6)
    stripe_post(client, checkout_event(uid, session_id=sid))
    Ledger(store).apply(uid, -200, "live", f"spend:{sid}")
    amount = pricing.PACKS["starter"]["amount_cents"]
    assert stripe_post(client, refund_event("pi_" + sid, amount, amount)).status_code == 200
    assert client.get("/api/auth/me").json()["balance"] == 0
    assert store.audit_log.find_one({"action": "refund_shortfall", "payment_intent": "pi_" + sid})["missing"] == 240 - (pricing.FREE_CREDITS_ON_VERIFY + 40)
