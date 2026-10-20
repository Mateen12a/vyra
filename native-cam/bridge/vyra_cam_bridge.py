"""VYRANI Native Virtual Camera Bridge (Windows & macOS, Zero OBS).

Listens on ws://127.0.0.1:29876/vyra-cam for live 1280x720 frames from VYRANI AI Studio,
verifies the browser Origin header against VYRANI's allowed origins (plus optional shared token),
decodes frames into raw BGR24/RGB24 pixels, and writes them into a shared-memory buffer
read by the VYRANI Windows Virtual Camera and macOS Camera Extension at 30 fps.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import mmap
import os
import struct
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from PIL import Image

HOST = "127.0.0.1"
PORT = int(os.getenv("VYRA_CAM_PORT", "29876"))
WIDTH = 1280
HEIGHT = 720
CHANNELS = 3  # RGB24 / BGR24
FRAME_BYTES = WIDTH * HEIGHT * CHANNELS
HEADER_MAGIC = b"VYRA"  # Four-byte legacy wire marker; independent of the product name.
HEADER_FMT = "<4sIIIIQ"  # magic(4), width(4), height(4), stride(4), seq(4), timestamp_ms(8) = 28 bytes
HEADER_SIZE = struct.calcsize(HEADER_FMT)
SHM_SIZE = HEADER_SIZE + FRAME_BYTES
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_ALLOWED_ORIGINS = (
    "http://127.0.0.1:8765",
    "http://localhost:8765",
    "http://127.0.0.1:8799",
    "http://localhost:8799",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://vyrani.blackhevents.com",
)


def get_allowed_origins() -> set[str]:
    raw = os.getenv("VYRA_CAM_ALLOWED_ORIGINS") or os.getenv("PERSON_ALLOWED_ORIGINS") or ""
    custom = {o.strip().rstrip("/") for o in raw.split(",") if o.strip()}
    return custom if custom else set(DEFAULT_ALLOWED_ORIGINS)


def is_origin_allowed(origin: str, allowed: set[str]) -> bool:
    if not origin:
        return False
    return origin.strip().rstrip("/") in allowed


def is_token_valid(request_target: str, headers: dict[str, str], required_token: str) -> bool:
    if not required_token:
        return True
    query_params = parse_qs(urlsplit(request_target).query)
    candidate = (
        query_params.get("token", [""])[0]
        or headers.get("x-vyra-cam-token", "")
    )
    return bool(candidate) and hmac.compare_digest(candidate, required_token)


class SharedFrameBuffer:
    """Cross-platform shared memory region for 1280x720 RGB24/BGR24 frames."""

    def __init__(self):
        self.seq = 0
        if os.name == "nt":
            # Named shared memory in current user session: Local\VyraCamSharedMem
            self.file = None
            self.mm = mmap.mmap(-1, SHM_SIZE, tagname="Local\\VyraCamSharedMem", access=mmap.ACCESS_WRITE)
        else:
            shm_path = Path("/tmp/vyra_cam.shm")
            fd = os.open(str(shm_path), os.O_CREAT | os.O_RDWR, 0o600)
            os.ftruncate(fd, SHM_SIZE)
            self.file = fd
            self.mm = mmap.mmap(fd, SHM_SIZE, access=mmap.ACCESS_WRITE)
        self.write_standby()

    def write_rgb(self, rgb_bytes: bytes):
        if len(rgb_bytes) != FRAME_BYTES:
            return
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        header = struct.pack(HEADER_FMT, HEADER_MAGIC, WIDTH, HEIGHT, WIDTH * CHANNELS, self.seq, int(time.time() * 1000))
        self.mm.seek(0)
        self.mm.write(header)
        self.mm.write(rgb_bytes)

    def write_standby(self):
        img = Image.new("RGB", (WIDTH, HEIGHT), (9, 9, 11))
        self.write_rgb(img.tobytes())

    def decode_and_write(self, jpeg_bytes: bytes):
        with Image.open(io.BytesIO(jpeg_bytes)) as img:
            img = img.convert("RGB")
            if img.size != (WIDTH, HEIGHT):
                img = img.resize((WIDTH, HEIGHT), Image.Resampling.BILINEAR)
            # DirectShow bottom-up BGR24 on Windows, top-down RGB24 on macOS
            if os.name == "nt":
                r, g, b = img.split()
                bgr = Image.merge("RGB", (b, g, r)).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                self.write_rgb(bgr.tobytes())
            else:
                self.write_rgb(img.tobytes())


async def read_ws_frame(reader: asyncio.StreamReader):
    head = await reader.readexactly(2)
    b1, b2 = head[0], head[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", await reader.readexactly(8))[0]
    if length > 8 * 1024 * 1024:
        raise ValueError("Frame too large")
    mask = await reader.readexactly(4) if masked else b""
    payload = bytearray(await reader.readexactly(length))
    if masked:
        for i in range(length):
            payload[i] ^= mask[i & 3]
    return opcode, bytes(payload)


async def send_ws_text(writer: asyncio.StreamWriter, text: str):
    data = text.encode("utf-8")
    n = len(data)
    header = bytearray([0x81])
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack(">H", n))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", n))
    writer.write(bytes(header) + data)
    await writer.drain()


async def send_http_error(writer: asyncio.StreamWriter, status_line: str, message: str):
    body = json.dumps({"ok": False, "detail": message}).encode("utf-8")
    writer.write(
        f"HTTP/1.1 {status_line}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n".encode("latin1")
        + body
    )
    await writer.drain()


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    shm: SharedFrameBuffer,
    allowed_origins: set[str] | None = None,
    required_token: str | None = None,
):
    allowed = allowed_origins if allowed_origins is not None else get_allowed_origins()
    token = required_token if required_token is not None else os.getenv("VYRA_CAM_TOKEN", "")
    try:
        raw_headers = await reader.readuntil(b"\r\n\r\n")
        header_text = raw_headers.decode("latin1", errors="replace")
        lines = header_text.split("\r\n")
        request_line = lines[0] if lines else ""
        parts = request_line.split(" ")
        request_target = parts[1] if len(parts) >= 2 else "/"

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        origin = headers.get("origin", "")
        if not is_origin_allowed(origin, allowed):
            await send_http_error(writer, "403 Forbidden", "Origin is not allowed to access the VYRANI Virtual Camera bridge.")
            return

        if not is_token_valid(request_target, headers, token):
            await send_http_error(writer, "401 Unauthorized", "Invalid or missing VYRANI Virtual Camera bridge token.")
            return

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            # Authenticated HTTP status check: echo back only the validated Origin (never wildcard *)
            body = json.dumps({"ok": True, "service": "vyra-native-cam", "seq": shm.seq}).encode("utf-8")
            writer.write(
                (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/json\r\n"
                    f"Access-Control-Allow-Origin: {origin}\r\n"
                    "Vary: Origin\r\n"
                    f"Content-Length: {len(body)}\r\n\r\n"
                ).encode("latin1")
                + body
            )
            await writer.drain()
            return

        accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode()).digest()).decode()
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode("latin1")
        )
        await writer.drain()
        await send_ws_text(writer, json.dumps({"type": "ready", "device": "VYRANI AI Camera", "width": WIDTH, "height": HEIGHT}))

        while True:
            opcode, payload = await read_ws_frame(reader)
            if opcode == 0x8:  # close
                break
            if opcode == 0x2 and payload:  # binary JPEG frame
                shm.decode_and_write(payload)
            elif opcode == 0x1 and payload:  # JSON / DataURL frame
                msg = json.loads(payload.decode("utf-8", errors="ignore"))
                data_url = msg.get("dataUrl", "")
                if "," in data_url:
                    shm.decode_and_write(base64.b64decode(data_url.split(",", 1)[1]))
    except (asyncio.IncompleteReadError, ConnectionError, ValueError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except OSError:
            pass


async def main():
    shm = SharedFrameBuffer()
    allowed = get_allowed_origins()
    server = await asyncio.start_server(lambda r, w: handle_client(r, w, shm, allowed), HOST, PORT)
    print(f"[VYRANI Cam] Native Virtual Camera bridge listening on ws://{HOST}:{PORT}/vyra-cam (allowed origins: {sorted(allowed)})", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
