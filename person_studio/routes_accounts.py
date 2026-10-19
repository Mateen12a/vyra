"""Account, credit, billing and admin routes (only mounted when MONGO_URI is configured)."""
import re

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from . import pricing
from .accounts import SESSION_COOKIE, SESSION_DAYS, AccountError
from .billing import BillingError
from .google_oauth import STATE_COOKIE, GoogleError, GoogleSignIn
from .credits import InsufficientCredits


def build_router(settings, store, accounts, ledger, billing, current_user, require_admin, google=None):
    router = APIRouter(prefix="/api")
    google = google or GoogleSignIn(settings)
    secure_cookie = settings.public_url.startswith("https://")

    async def body_of(request):
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(422, "Invalid request body.")
        if not isinstance(body, dict):
            raise HTTPException(422, "Invalid request body.")
        return body

    def limit(request, name, count, window):
        ip = request.client.host if request.client else "unknown"
        if not store.hit(f"{name}:{ip}", count, window):
            raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")

    def me_payload(user):
        return {"user": accounts.public(user), "balance": ledger.balance(user["_id"])}

    def start_session(response, user):
        response.set_cookie(SESSION_COOKIE, accounts.create_session(user), max_age=SESSION_DAYS * 86400,
                            httponly=True, secure=secure_cookie, samesite="lax", path="/")

    @router.post("/auth/signup")
    async def signup(request: Request, response: Response):
        limit(request, "signup", 5, 3600)
        body = await body_of(request)
        try:
            user = accounts.signup(body.get("email"), body.get("password"))
        except AccountError as exc:
            raise HTTPException(exc.status, str(exc))
        store.audit(user["_id"], "signup")
        start_session(response, user)
        return me_payload(user)

    @router.post("/auth/login")
    async def login(request: Request, response: Response):
        limit(request, "login", 10, 900)
        body = await body_of(request)
        try:
            user = accounts.login(body.get("email"), body.get("password"))
        except AccountError as exc:
            raise HTTPException(exc.status, str(exc))
        start_session(response, user)
        return me_payload(user)

    def grant_free(user_id):
        ledger.apply(user_id, pricing.FREE_CREDITS_ON_VERIFY, "free", f"free:{user_id}")

    @router.get("/auth/providers")
    def providers():
        return {"google": google.available()}

    @router.get("/auth/google/start")
    def google_start(request: Request):
        if not google.available():
            raise HTTPException(404, "Google sign-in is not configured.")
        limit(request, "google", 30, 900)
        url, cookie = google.start()
        response = RedirectResponse(url, status_code=302)
        response.set_cookie(STATE_COOKIE, cookie, max_age=600, httponly=True, secure=secure_cookie,
                            samesite="lax", path="/api/auth/google")
        return response

    @router.get("/auth/google/callback")
    def google_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        base = settings.public_url.rstrip("/")
        home = base + "/app"
        response = RedirectResponse(home, status_code=302)
        response.delete_cookie(STATE_COOKIE, path="/api/auth/google")
        if error:  # the user closed or declined Google's screen
            response.headers["location"] = base + "/signin?auth_error=cancelled"
            return response
        try:
            profile = google.finish(code, state, request.cookies.get(STATE_COOKIE))
            user, newly_verified = accounts.login_google(profile)
        except (GoogleError, AccountError):
            response.headers["location"] = base + "/signin?auth_error=google"
            return response
        if newly_verified:
            grant_free(user["_id"])
        store.audit(user["_id"], "google_login")
        start_session(response, user)
        return response

    @router.post("/auth/logout")
    def logout(request: Request, response: Response):
        accounts.logout(request.cookies.get(SESSION_COOKIE))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @router.get("/auth/me")
    def me(user=Depends(current_user)):
        return me_payload(user)

    @router.post("/auth/verify")
    async def verify(request: Request):
        limit(request, "verify", 20, 3600)
        try:
            user_id = accounts.verify((await body_of(request)).get("token"))
        except AccountError as exc:
            raise HTTPException(exc.status, str(exc))
        if user_id:  # free starter credits, once per account
            grant_free(user_id)
        return {"verified": True}

    @router.post("/auth/resend")
    def resend(request: Request, user=Depends(current_user)):
        limit(request, "resend", 3, 3600)
        if not user.get("verified"):
            accounts.send_verification(user["_id"], user["email"])
        return {"ok": True}

    @router.post("/auth/reset/request")
    async def reset_request(request: Request):
        limit(request, "reset", 5, 3600)
        try:
            accounts.request_reset((await body_of(request)).get("email"))
        except AccountError as exc:
            raise HTTPException(exc.status, str(exc))
        return {"ok": True}

    @router.post("/auth/reset")
    async def reset(request: Request):
        limit(request, "reset", 10, 3600)
        body = await body_of(request)
        try:
            accounts.reset(body.get("token"), body.get("password"))
        except AccountError as exc:
            raise HTTPException(exc.status, str(exc))
        return {"ok": True}

    @router.get("/credits")
    def credits(user=Depends(current_user)):
        return {"balance": ledger.balance(user["_id"]), "history": ledger.history(user["_id"]),
                **pricing.public_catalogue(), "payments": billing.available()}

    @router.get("/pricing")
    def catalogue():
        return pricing.public_catalogue()

    @router.post("/billing/checkout")
    async def checkout(request: Request, user=Depends(current_user)):
        if not user.get("verified"):
            raise HTTPException(403, "Verify your email before buying credits.")
        try:
            return billing.checkout(user, (await body_of(request)).get("pack"), settings.public_url.rstrip("/"))
        except BillingError as exc:
            raise HTTPException(exc.status, str(exc))

    @router.post("/billing/webhook")
    async def webhook(request: Request):
        try:
            return billing.webhook(await request.body(), request.headers.get("stripe-signature", ""))
        except BillingError as exc:
            raise HTTPException(exc.status, str(exc))

    def object_id(value):
        try:
            return ObjectId(value)
        except (InvalidId, TypeError):
            raise HTTPException(404, "User not found.")

    @router.get("/admin/users")
    def admin_users(q: str = "", admin=Depends(require_admin)):
        query = {"email": {"$regex": "^" + re.escape(q.lower())}} if q else {}
        users = list(store.users.find(query).sort("created_at", -1).limit(100))
        return [{**accounts.public(u), "balance": ledger.balance(u["_id"])} for u in users]

    @router.post("/admin/users/{user_id}/credits")
    async def admin_grant(user_id: str, request: Request, admin=Depends(require_admin)):
        body = await body_of(request)
        amount, reason, key = body.get("amount"), body.get("reason"), body.get("key")
        if not isinstance(amount, int) or amount == 0 or not isinstance(reason, str) or not reason.strip() \
                or not isinstance(key, str) or not 8 <= len(key) <= 64:
            raise HTTPException(422, "Give a whole credit amount, a reason, and a unique request key.")
        target = object_id(user_id)
        try:
            balance = ledger.apply(target, amount, "admin", f"admin:{key}", reason=reason.strip()[:200],
                                   admin_id=admin["_id"])
        except InsufficientCredits:
            raise HTTPException(409, "That would take the balance below zero.")
        store.audit(admin["_id"], "admin_credits", user_id=target, amount=amount, reason=reason)
        return {"balance": ledger.balance(target), "applied": balance is not None}

    @router.post("/admin/users/{user_id}/role")
    async def admin_role(user_id: str, request: Request, admin=Depends(require_admin)):
        body = await body_of(request)
        role = body.get("role")
        target_id = str(object_id(user_id))
        if role is not None:
            try:
                accounts.set_role(target_id, role)
            except AccountError as exc:
                raise HTTPException(exc.status, str(exc))
            store.audit(admin["_id"], "set_role", user_id=user_id, role=role)
        if "watermark_unlocked" in body:
            accounts.set_watermark_unlocked(target_id, bool(body.get("watermark_unlocked")))
            store.audit(admin["_id"], "set_watermark", user_id=user_id, unlocked=bool(body.get("watermark_unlocked")))
        return {"ok": True}

    @router.get("/admin/stats")
    def admin_stats(admin=Depends(require_admin)):
        def total(match, field="delta"):
            rows = list(store.ledger.aggregate([{"$match": match}, {"$group": {"_id": None, "n": {"$sum": f"${field}"}}}]))
            return rows[0]["n"] if rows else 0
        live_used = -total({"kind": "live"}) - total({"kind": "live_refund"})
        return {
            "users": store.users.count_documents({}),
            "verified": store.users.count_documents({"verified": True}),
            "revenue_cents": total({"kind": "purchase"}, "amount_cents"),
            "purchases": store.ledger.count_documents({"kind": "purchase"}),
            "credits_sold": total({"kind": "purchase"}),
            "credits_outstanding": sum(a["balance"] for a in store.accounts.find({}, {"balance": 1})),
            "live_minutes": round(live_used / pricing.LIVE_CREDITS_PER_SECOND / 60, 1),
            "live_now": store.live_sessions.count_documents({"state": "live"}),
        }

    @router.get("/admin/live")
    def admin_live(admin=Depends(require_admin)):
        rows = list(store.live_sessions.find().sort("started_at", -1).limit(50))
        emails = {u["_id"]: u["email"] for u in store.users.find({"_id": {"$in": [r["user_id"] for r in rows]}}, {"email": 1})}
        return [{"id": str(r["_id"]), "email": emails.get(r["user_id"], "?"), "state": r["state"],
                 "provider": r.get("provider"), "started_at": r["started_at"].isoformat(),
                 "paid_seconds": r["paid_seconds"], "used_seconds": r.get("used_seconds")} for r in rows]

    @router.get("/admin/users/{user_id}/ledger")
    def admin_ledger(user_id: str, admin=Depends(require_admin)):
        return ledger.history(object_id(user_id), limit=500)

    return router
