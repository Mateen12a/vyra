"""Email + password accounts with server-side sessions in HttpOnly cookies.

CSRF: cookies are SameSite=Lax and every state-changing request must carry an allowed Origin header
(checked in app.py), so another site cannot submit forms or fetches with the user's cookie.
"""
import hashlib
import re
import secrets
import smtplib
import urllib.error
import urllib.request
import json
from datetime import timedelta
from email.message import EmailMessage

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from .store import Store, utcnow

SESSION_COOKIE = "vyra_session"
SESSION_DAYS = 14
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")
ROLES = {"user", "admin"}


class AccountError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _digest(token):
    # Only hashes of session and email tokens are stored, so a database leak can't be replayed as logins.
    return hashlib.sha256(token.encode()).hexdigest()


class Accounts:
    def __init__(self, store: Store, mailer):
        self.store, self.mailer = store, mailer
        self.hasher = PasswordHasher()
        # Login against unknown emails still pays one argon2 verify, so timing doesn't reveal accounts.
        self._dummy_hash = self.hasher.hash(secrets.token_hex(16))

    @staticmethod
    def normalize(email):
        email = (email or "").strip().lower()
        if not EMAIL_RE.match(email):
            raise AccountError("Enter a valid email address.", 422)
        return email

    @staticmethod
    def check_password(password):
        if not isinstance(password, str) or not 10 <= len(password) <= 256:
            raise AccountError("Use a password of at least 10 characters.", 422)

    def can_remove_watermark(self, user):
        if not user:
            return False
        if user.get("role") == "admin" or user.get("watermark_unlocked"):
            return True
        return self.store.ledger.find_one({"user_id": user["_id"], "kind": "purchase"}) is not None

    def set_watermark_unlocked(self, user_id, unlocked: bool):
        self.store.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"watermark_unlocked": bool(unlocked)}})

    def public(self, user):
        return {"id": str(user["_id"]), "email": user["email"], "role": user["role"],
                "verified": user.get("verified", False), "google": bool(user.get("google_sub")),
                "has_password": bool(user.get("password")), "trial": user.get("trial"),
                "can_remove_watermark": self.can_remove_watermark(user)}

    def signup(self, email, password):
        email = self.normalize(email)
        self.check_password(password)
        try:
            user_id = self.store.users.insert_one({
                "email": email, "password": self.hasher.hash(password), "role": "user",
                "verified": False, "created_at": utcnow()}).inserted_id
        except DuplicateKeyError:
            raise AccountError("An account with this email already exists. Sign in instead.", 409)
        self.send_verification(user_id, email)
        return self.store.users.find_one({"_id": user_id})

    def login(self, email, password):
        email = self.normalize(email)
        user = self.store.users.find_one({"email": email})
        try:
            # Google-only accounts have no password; they still pay one verify so timing stays uniform.
            self.hasher.verify((user or {}).get("password") or self._dummy_hash, password or "")
            if user and not user.get("password"):
                user = None
        except (VerificationError, InvalidHashError):
            user = None
        if not user or user.get("disabled"):
            raise AccountError("Email or password is incorrect.", 401)
        if self.hasher.check_needs_rehash(user["password"]):
            self.store.users.update_one({"_id": user["_id"]}, {"$set": {"password": self.hasher.hash(password)}})
        return user

    def login_google(self, profile):
        """Sign in (or sign up) with a Google profile. Returns (user, newly_verified)."""
        if not profile.get("email_verified") or not profile.get("sub"):
            raise AccountError("Your Google account's email isn't verified.", 403)
        email = self.normalize(profile["email"])
        user = self.store.users.find_one({"google_sub": profile["sub"]}) or self.store.users.find_one({"email": email})
        if user and user.get("disabled"):
            raise AccountError("This account is disabled.", 403)
        if not user:
            try:
                user_id = self.store.users.insert_one({
                    "email": email, "password": None, "role": "user", "verified": True, "verified_at": utcnow(),
                    "google_sub": profile["sub"], "created_at": utcnow()}).inserted_id
            except DuplicateKeyError:  # another tab signed up with the same email at the same moment
                return self.login_google(profile)
            return self.store.users.find_one({"_id": user_id}), True
        # Google proved the email, so it also verifies an existing password account with that email.
        newly_verified = not user.get("verified")
        changes = {"google_sub": profile["sub"], "verified": True}
        if newly_verified:
            # Nobody ever proved they owned this email, so its password may belong to someone squatting on it.
            # Drop it and any sessions; the real owner can set a password later through "Forgot password".
            changes.update(verified_at=utcnow(), password=None)
            self.store.sessions.delete_many({"user_id": user["_id"]})
        self.store.users.update_one({"_id": user["_id"]}, {"$set": changes})
        return self.store.users.find_one({"_id": user["_id"]}), newly_verified

    def create_session(self, user):
        token = secrets.token_urlsafe(32)
        self.store.sessions.insert_one({"_id": _digest(token), "user_id": user["_id"], "created_at": utcnow(),
                                        "expires_at": utcnow() + timedelta(days=SESSION_DAYS)})
        return token

    def user_for(self, token):
        if not token:
            return None
        session = self.store.sessions.find_one({"_id": _digest(token), "expires_at": {"$gt": utcnow()}})
        if not session:
            return None
        user = self.store.users.find_one({"_id": session["user_id"]})
        return None if not user or user.get("disabled") else user

    def delete_account(self, user):
        """Erase a person's identity: email, password, Google link, sessions and one-time tokens go. The anonymous
        credit ledger stays (payment records must be kept), and the trial record keeps only a one-way hash."""
        uid = user["_id"]
        self.store.sessions.delete_many({"user_id": uid})
        self.store.tokens.delete_many({"user_id": uid})
        self.store.users.update_one({"_id": uid}, {"$set": {
            "email": f"deleted-{uid}@deleted.invalid", "password": None, "google_sub": None, "disabled": True,
            "deleted_at": utcnow(), "role": "user"}, "$unset": {"trial": ""}})
        self.store.audit(uid, "account_deleted")

    def logout(self, token):
        if token:
            self.store.sessions.delete_one({"_id": _digest(token)})

    def _issue(self, purpose, user_id, hours):
        token = secrets.token_urlsafe(32)
        self.store.tokens.insert_one({"_id": _digest(token), "purpose": purpose, "user_id": user_id,
                                      "expires_at": utcnow() + timedelta(hours=hours)})
        return token

    def _redeem(self, purpose, token):
        record = self.store.tokens.find_one_and_delete(
            {"_id": _digest(token or ""), "purpose": purpose, "expires_at": {"$gt": utcnow()}})
        if not record:
            raise AccountError("This link has expired or was already used.", 400)
        return record["user_id"]

    def send_verification(self, user_id, email):
        self.mailer.send(email, "verify", self._issue("verify", user_id, 48))

    def verify(self, token):
        """Returns the user id the first time an email is verified, else None."""
        user_id = self._redeem("verify", token)
        result = self.store.users.update_one({"_id": user_id, "verified": False},
                                             {"$set": {"verified": True, "verified_at": utcnow()}})
        return user_id if result.modified_count else None

    def request_reset(self, email):
        user = self.store.users.find_one({"email": self.normalize(email)})
        if user:  # same response either way, so the form doesn't reveal which emails have accounts
            self.mailer.send(user["email"], "reset", self._issue("reset", user["_id"], 1))

    def reset(self, token, password):
        self.check_password(password)
        user_id = self._redeem("reset", token)
        self.store.users.update_one({"_id": user_id}, {"$set": {"password": self.hasher.hash(password)}})
        self.store.sessions.delete_many({"user_id": user_id})  # sign out everywhere

    def set_role(self, user_id, role):
        if role not in ROLES:
            raise AccountError("Unknown role.", 422)
        self.store.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"role": role}})


class LogMailer:
    """Development mailer: prints links to the server console. Swap for a transactional provider before launch."""

    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.sent = []

    def notify(self, email, subject, text):
        """Operator alerts (plain text). The log mailer only prints them."""
        print(f"[mail] alert to {email}: {subject}", flush=True)

    def send(self, email, kind, token):
        link = f"{self.base_url}/{kind}?token={token}"  # /verify or /reset in the web app
        self.sent.append((email, kind, token))
        print(f"[mail] {kind} link for {email}: {link}", flush=True)


class SmtpMailer(LogMailer):
    """Standard-library SMTP mailer with console fallback if delivery fails in development."""

    def __init__(self, settings):
        super().__init__(settings.public_url)
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.user = settings.smtp_user
        self.password = settings.smtp_password
        self.sender = settings.smtp_from

    def send(self, email, kind, token):
        super().send(email, kind, token)
        if not self.host:
            return
        link = f"{self.base_url}/{kind}?token={token}"
        msg = EmailMessage()
        msg["Subject"] = "Verify your VYRANI AI email" if kind == "verify" else "Reset your VYRANI AI password"
        msg["From"] = self.sender
        msg["To"] = email
        body = (
            f"Welcome to VYRANI AI.\n\nClick the link below to {'verify your email and unlock your free live minute' if kind == 'verify' else 'choose a new password'}:\n\n{link}\n"
        )
        msg.set_content(body)
        try:
            with smtplib.SMTP(self.host, self.port, timeout=10) as smtp:
                smtp.ehlo()
                if self.port in (587, 2587):
                    smtp.starttls()
                if self.user and self.password:
                    smtp.login(self.user, self.password)
                smtp.send_message(msg)
        except OSError as exc:
            print(f"[mail] SMTP delivery warning for {email}: {exc}", flush=True)


class ResendMailer(LogMailer):
    """Transactional email through Resend's HTTPS API. The sender's domain must be verified in Resend."""

    def __init__(self, settings):
        super().__init__(settings.public_url)
        self.key = settings.resend_api_key
        self.sender = settings.smtp_from

    def notify(self, email, subject, text):
        super().notify(email, subject, text)
        self._post({"from": self.sender, "to": [email], "subject": subject, "text": text}, email)

    def _post(self, body, email):
        request = urllib.request.Request("https://api.resend.com/emails", data=json.dumps(body).encode(), method="POST",
                                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json",
                                                  "User-Agent": "vyrani/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read()
        except (OSError, urllib.error.HTTPError) as exc:
            print(f"[mail] Resend delivery warning for {email}: {exc}", flush=True)

    def send(self, email, kind, token):
        super().send(email, kind, token)
        link = f"{self.base_url}/{kind}?token={token}"
        verify = kind == "verify"
        action = "Verify my email" if verify else "Choose a new password"
        intro = "Confirm your email to unlock your free live minute." if verify else "Someone asked to reset your VYRANI password. If it wasn't you, ignore this email."
        html = (
            '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:32px;color:#111">'
            '<p style="font-size:22px;font-weight:600;margin:0 0 16px">VYRANI</p>'
            f'<p style="font-size:16px;line-height:1.5">{intro}</p>'
            f'<p style="margin:28px 0"><a href="{link}" style="background:#ff6b2b;color:#120700;padding:14px 22px;'
            f'border-radius:999px;text-decoration:none;font-weight:600">{action}</a></p>'
            f'<p style="font-size:13px;color:#666">Or paste this link: {link}</p></div>'
        )
        payload = json.dumps({
            "from": self.sender, "to": [email],
            "subject": "Verify your VYRANI email" if verify else "Reset your VYRANI password",
            "html": html, "text": f"{intro}\n\n{link}\n",
        }).encode()
        request = urllib.request.Request("https://api.resend.com/emails", data=payload, method="POST",
                                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json",
                                                  "User-Agent": "vyrani/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read()
        except (OSError, urllib.error.HTTPError) as exc:
            print(f"[mail] Resend delivery warning for {email}: {exc}", flush=True)


def pick_mailer(settings):
    if getattr(settings, "resend_api_key", ""):
        return ResendMailer(settings)
    return SmtpMailer(settings) if getattr(settings, "smtp_host", "") else LogMailer(settings.public_url)

