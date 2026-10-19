"""Realtime (live camera) sessions on Lucy through fal. The fal key never leaves this server.

Browsers receive a short-lived token per connect, scoped to the one Lucy app. fal tokens carry no session cap,
so the browser enforces the session limit and the server bills in prepaid blocks (credits.LiveMeter).
"""
import json
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .config import Settings

FAL_TOKEN_URL = "https://rest.fal.ai/tokens/"
USER_AGENT = "vyra-ai/0.3"
# fal is the only live engine. Standard (not fast) realtime rate per second of open session.
PROVIDERS = {
    "fal": {"name": "fal", "price_per_second": 0.02},
}


class LiveError(RuntimeError):
    pass


class LiveSessions:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.recent = []  # monotonic times of minted tokens, for rate limiting

    def configured(self, provider):
        return provider == "fal" and bool(self.settings.fal_key)

    def default_provider(self):
        return "fal"

    def status(self):
        s = self.settings
        providers = [{"id": p, "name": info["name"], "available": self.configured(p),
                      "price_per_second": info["price_per_second"]} for p, info in PROVIDERS.items()]
        available = any(p["available"] for p in providers)
        return {"available": available, "provider": "fal", "providers": providers,
                "model": s.live_model, "max_session_seconds": s.live_max_session_seconds,
                "message": "Live mode is ready." if available else "Live mode needs FAL_KEY on the server."}

    def mint(self, origin=None, provider=None):
        provider = provider or "fal"
        if provider not in PROVIDERS:
            raise LiveError("Unknown live engine.")
        if not self.configured(provider):
            raise LiveError("Live mode is not configured on this server.")
        now = time.monotonic()
        with self.lock:
            self.recent = [t for t in self.recent if now - t < 60]
            if len(self.recent) >= self.settings.live_tokens_per_minute:
                raise LiveError("Too many live connections in the last minute. Wait a moment and try again.")
            self.recent.append(now)
        session = self._mint_fal()
        self._record(provider, session.get("expires_at"))
        return {**session, "provider": provider, "max_session_seconds": self.settings.live_max_session_seconds,
                "price_per_second": PROVIDERS[provider]["price_per_second"]}

    def _mint_fal(self):
        s = self.settings
        alias = s.fal_live_app.split("/")[1]  # "decart/lucy-2-5/realtime" -> "lucy-2-5", as fal's client does
        data = self._post(FAL_TOKEN_URL, {"allowed_apps": [alias], "token_expiration": s.live_token_ttl_seconds},
                          {"Authorization": f"Key {s.fal_key}"})
        if isinstance(data, dict):  # older proxies wrapped the token
            data = data.get("detail")
        if not isinstance(data, str) or data.count(".") != 2:
            raise LiveError("The live service returned an incomplete session token.")
        return {"token": data, "url": f"wss://fal.run/{s.fal_live_app}", "app": s.fal_live_app,
                "expires_in": s.live_token_ttl_seconds}

    def _post(self, url, body, headers):
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
            **headers, "Content-Type": "application/json", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            raise LiveError("The live service refused to start a session." if exc.code in (401, 403)
                            else "The live service could not start a session. Try again shortly.")
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise LiveError("Could not reach the live service. Check this server's internet connection.")

    def _record(self, provider, expires_at):
        # Reserved seconds per mint; reconcile against the fal dashboard for billing.
        ledger = self.settings.data_dir / "live-usage.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as file:
            file.write(json.dumps({"minted_at": datetime.now(timezone.utc).isoformat(), "provider": provider,
                                   "expires_at": expires_at, "model": self.settings.live_model,
                                   "reserved_seconds": self.settings.live_max_session_seconds}) + "\n")
