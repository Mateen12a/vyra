"""Checks a user's livestream destination before the server's FFmpeg is pointed at it.

Users paste their platform's ingest URL and stream key (YouTube, Twitch, Facebook, any RTMP/RTMPS server).
Only rtmp:// and rtmps:// to public internet addresses are accepted, so the relay can't be aimed at this
server's own network. Stream keys are secrets: they are never logged or stored.
"""
import ipaddress
import re
import socket
from urllib.parse import quote, urlsplit

KEY_RE = re.compile(r"^[A-Za-z0-9_\-.=?&/+]{1,256}$")


class DestinationError(ValueError):
    pass


def _public(host, allow_private):
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise DestinationError("That streaming server address couldn't be found. Check the URL.")
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not allow_private and not address.is_global:
            raise DestinationError("Stream to a public streaming service, not a private or local address.")


def destination(url, key="", allow_private=False):
    """Returns the full ingest URL (server URL plus key) after validating both parts."""
    url = (url or "").strip()
    key = (key or "").strip()
    if not url or len(url) > 300:
        raise DestinationError("Enter your streaming server URL.")
    parts = urlsplit(url)
    if parts.scheme not in {"rtmp", "rtmps"} or not parts.hostname:
        raise DestinationError("Use the RTMP or RTMPS server URL from your streaming platform.")
    if parts.username or parts.password or parts.fragment:
        raise DestinationError("The server URL can't contain a user name, password or #fragment.")
    if parts.port is not None and not 1 <= parts.port <= 65535:
        raise DestinationError("That streaming server port isn't valid.")
    if key and not KEY_RE.match(key):
        raise DestinationError("That stream key has characters it shouldn't. Copy it again from your platform.")
    _public(parts.hostname, allow_private)
    if not key:
        return url
    return url.rstrip("/") + "/" + quote(key, safe="_-.=?&/+")
