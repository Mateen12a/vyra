"""Decides whether a newly verified account gets the free trial credits.

The trial costs real provider money, so it is given once per person as far as we can tell cheaply:
- throwaway email domains get none,
- one grant per mailbox, after folding Gmail dots and "+tags" (a.b+1@gmail.com is ab@gmail.com),
- at most TRIAL_PER_IP grants per network address in TRIAL_WINDOW_DAYS (households and offices share addresses).
The account itself always works; a refused trial just starts at zero credits.
"""
import hashlib
import ipaddress
from datetime import timedelta

from .store import utcnow

TRIAL_PER_IP = 2
TRIAL_WINDOW_DAYS = 30

# The most common disposable-mail providers. Not exhaustive: the per-address limit catches the rest.
DISPOSABLE = frozenset("""
10minutemail.com 10minutemail.net 20minutemail.com 33mail.com anonaddy.me burnermail.io byom.de
discard.email dispostable.com dropmail.me emailondeck.com fakeinbox.com fakemail.net getairmail.com
getnada.com guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net
guerrillamail.org guerrillamailblock.com harakirimail.com inboxkitten.com mail.tm mailcatch.com
maildrop.cc mailinator.com mailinator.net mailnesia.com mailpoof.com mailsac.com mintemail.com
moakt.com mohmal.com mytemp.email nada.email sharklasers.com spam4.me spamgourmet.com temp-mail.io
temp-mail.org tempail.com tempmail.com tempmail.net tempmailo.com tempr.email throwawaymail.com
tmail.ws tmpmail.net tmpmail.org trashmail.com trashmail.de trashmail.net yopmail.com yopmail.fr
yopmail.net emailfake.com fexpost.com fexbox.org grr.la pokemail.net spambox.us wegwerfmail.de
""".split())

GMAIL = {"gmail.com", "googlemail.com"}


def canonical_email(email):
    local, _, domain = (email or "").strip().lower().partition("@")
    local = local.split("+", 1)[0]
    if domain in GMAIL:
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}@{domain}"


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _public_ip(ip):
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def decide(store, email, ip):
    """Return None if the trial may be granted, or a short reason it may not."""
    domain = (email or "").rsplit("@", 1)[-1].lower()
    if domain in DISPOSABLE:
        return "disposable_email"
    if store.trial_grants.find_one({"mailbox": _digest(canonical_email(email))}):
        return "mailbox_used"
    since = utcnow() - timedelta(days=TRIAL_WINDOW_DAYS)
    if _public_ip(ip) and store.trial_grants.count_documents({"ip": _digest(ip), "at": {"$gte": since}}) >= TRIAL_PER_IP:
        return "address_limit"
    return None


def record(store, user_id, email, ip):
    store.trial_grants.insert_one({"user_id": user_id, "mailbox": _digest(canonical_email(email)),
                                   "ip": _digest(ip or "unknown"), "at": utcnow()})
