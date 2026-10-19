"""Google sign-in: OAuth 2.0 authorization code flow with PKCE, done entirely on the server.

The browser is sent to Google with a random `state` and PKCE challenge; both secrets live in a short-lived
HttpOnly cookie, so a callback that didn't start in this browser is rejected. The profile comes from
Google's userinfo endpoint over TLS using the access token we just exchanged, so it is trusted as-is.
"""
import base64
import hashlib
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
STATE_COOKIE = "vyra_oauth"


class GoogleError(Exception):
    pass


def _http(url, data=None, headers=None):
    request = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                     headers={"User-Agent": "vyra-ai", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise GoogleError("Google sign-in failed. Try again.")


class GoogleSignIn:
    def __init__(self, settings, http=_http):
        self.settings, self.http = settings, http

    def available(self):
        return bool(self.settings.google_client_id and self.settings.google_client_secret)

    @property
    def redirect_uri(self):
        return self.settings.public_url.rstrip("/") + "/api/auth/google/callback"

    def start(self):
        """Returns (google_url, cookie_value)."""
        state, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        query = urllib.parse.urlencode({
            "client_id": self.settings.google_client_id, "redirect_uri": self.redirect_uri,
            "response_type": "code", "scope": "openid email", "state": state, "prompt": "select_account",
            "code_challenge": challenge, "code_challenge_method": "S256"})
        return f"{AUTH_URL}?{query}", f"{state}.{verifier}"

    def finish(self, code, state, cookie):
        """Exchange the code and return Google's profile ({sub, email, email_verified})."""
        expected, _, verifier = (cookie or "").partition(".")
        if not code or not state or not expected or not secrets.compare_digest(state, expected):
            raise GoogleError("Sign-in expired or came from another browser. Try again.")
        tokens = self.http(TOKEN_URL, {
            "code": code, "client_id": self.settings.google_client_id,
            "client_secret": self.settings.google_client_secret, "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code", "code_verifier": verifier})
        if not isinstance(tokens, dict) or "access_token" not in tokens:
            raise GoogleError("Google sign-in failed. Try again.")
        profile = self.http(USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"})
        if not isinstance(profile, dict) or not profile.get("sub") or not profile.get("email"):
            raise GoogleError("Google didn't share an email address.")
        return profile
