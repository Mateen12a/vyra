"""Watches the fal account balance so users never meet a half-started session when it runs dry.

New live sessions and clips are refused politely (before any credits are taken) once the balance can no longer
cover them; anything already running is left to finish. The operator gets an email well before that point.
"""
import json
import logging
import threading
import time
import urllib.error
import urllib.request

BALANCE_URL = "https://api.fal.ai/v1/account/billing?expand=credits"
CACHE_SECONDS = 60
ALERT_EVERY_SECONDS = 12 * 3600
BUSY_MESSAGE = "VYRANI is very busy right now. Please try again in a few minutes. You haven't been charged."


class ProviderGuard:
    def __init__(self, settings, notify=None, fetch=None):
        self.settings = settings
        self.notify = notify  # notify(subject, text) -> None; emails the operator
        self.fetch = fetch or self._fetch
        self.lock = threading.Lock()
        self.balance, self.checked_at, self.alerted_at = None, 0.0, 0.0

    def current(self):
        """The fal balance in USD, refreshed at most once a minute; None when it can't be read."""
        with self.lock:
            if time.monotonic() - self.checked_at < CACHE_SECONDS and self.checked_at:
                return self.balance
            self.checked_at = time.monotonic()
        balance = self.fetch()
        with self.lock:
            self.balance = balance
        if balance is not None:
            self._maybe_alert(balance)
        return balance

    def allows(self, kind):
        """True when a new `kind` ("live" or "clip") can start. Unknown balance never blocks users."""
        if not self.settings.fal_key:
            return True
        balance = self.current()
        floor = self.settings.fal_min_balance_live if kind == "live" else self.settings.fal_min_balance_clip
        if balance is not None and balance < floor:
            logging.warning("fal balance $%.2f is below the %s floor $%.2f; refusing a new %s", balance, kind, floor, kind)
            return False
        return True

    def _maybe_alert(self, balance):
        if balance >= self.settings.fal_alert_balance or not self.notify:
            return
        with self.lock:
            if self.alerted_at and time.monotonic() - self.alerted_at < ALERT_EVERY_SECONDS:
                return
            self.alerted_at = time.monotonic()
        live_min = self.settings.fal_min_balance_live
        try:
            self.notify(f"VYRANI: fal balance is low (${balance:.2f})",
                        f"Your fal balance is ${balance:.2f}. Below ${live_min:.2f}, new live sessions are paused and users "
                        f"see a 'very busy, try again' message instead of a failure.\n\nTop up at https://fal.ai/dashboard/billing "
                        f"and turn on auto top-up so this never reaches users.")
        except Exception:
            logging.exception("Could not send the low fal balance alert")

    def _fetch(self):
        if not self.settings.fal_key:
            return None
        request = urllib.request.Request(BALANCE_URL, headers={"Authorization": f"Key {self.settings.fal_key}",
                                                               "User-Agent": "vyrani-ai/0.3"})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                value = (json.loads(response.read()).get("credits") or {}).get("current_balance")
                return float(value) if value is not None else None
        except (urllib.error.URLError, TimeoutError, ValueError, TypeError):
            return None
