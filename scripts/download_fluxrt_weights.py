"""Download the required BF16 FluxRT components with bounded HTTP concurrency.

Linux only (os.pwrite). Range responses and LFS SHA256 are validated before
publishing a weight file. Existing complete files are checksum-verified.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(repo, revision, item, root, workers):
    destination = root / item["path"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected = item.get("lfs", {}).get("oid")
    if destination.exists() and destination.stat().st_size == item["size"]:
        if expected is None or sha256(destination) == expected:
            return
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{item['path']}"
    if item["size"] < 8 * 1024 * 1024:
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read()
        if len(data) != item["size"]:
            raise ValueError("Unexpected file size: " + item["path"])
        if expected and hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Checksum mismatch: " + item["path"])
        destination.write_bytes(data)
        return
    partial = destination.with_suffix(destination.suffix + ".parallel-part")
    marker = partial.with_suffix(partial.suffix + ".json")
    block = 64 * 1024 * 1024
    saved = json.loads(marker.read_text()) if marker.exists() else {}
    completed = set(saved.get("done", [])) if saved.get("sha") == expected else set()
    if not partial.exists() or partial.stat().st_size != item["size"]:
        completed.clear()
    fd = os.open(partial, os.O_RDWR | os.O_CREAT, 0o600)
    os.ftruncate(fd, item["size"])
    blocks = (item["size"] + block - 1) // block

    def part(index):
        start, end = index * block, min((index + 1) * block, item["size"]) - 1
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(request, timeout=90) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{item['size']}":
                        raise ValueError("Server returned an incorrect byte range")
                    position = start
                    while position <= end:
                        chunk = response.read(min(1024 * 1024, end - position + 1))
                        if not chunk:
                            raise IOError("Truncated range")
                        written = 0
                        while written < len(chunk):
                            n = os.pwrite(fd, chunk[written:], position + written)
                            if n <= 0:
                                raise IOError("Could not write weight block")
                            written += n
                        position += len(chunk)
                return index
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    started = time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(part, i) for i in range(blocks) if i not in completed]
            for future in concurrent.futures.as_completed(futures):
                completed.add(future.result())
                marker.write_text(json.dumps({"sha": expected, "done": sorted(completed)}))
                if len(completed) % 8 == 0 or len(completed) == blocks:
                    print(f"{item['path']} {len(completed)}/{blocks} blocks ({time.monotonic()-started:.0f}s)", flush=True)
        os.fsync(fd)
    finally:
        os.close(fd)
    if not expected or sha256(partial) != expected:
        marker.unlink(missing_ok=True)
        raise ValueError("Checksum verification failed: " + item["path"])
    partial.replace(destination)
    marker.unlink(missing_ok=True)
    print("VERIFIED " + item["path"], flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        parser.error("workers must be between 1 and 32")
    repos = [("TensorForger/RIFE-safetensors", "RIFE-safetensors", ()),
             ("black-forest-labs/FLUX.2-klein-4B", "FLUX.2-klein-4B",
              ("scheduler/", "text_encoder/", "tokenizer/", "transformer/", "vae/"))]
    tasks = []
    for repo, directory, prefixes in repos:
        revision = fetch_json(f"https://huggingface.co/api/models/{repo}")["sha"]
        items = fetch_json(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true&expand=false")
        for item in items:
            if item["type"] != "file":
                continue
            path = item["path"]
            include = path == "flownet.safetensors" if not prefixes else path.startswith(prefixes) or path in {"model_index.json", "LICENSE.md"}
            if include:
                tasks.append((repo, revision, item, Path(args.root) / directory, args.workers))
    # At most three files in flight; each file has a bounded range worker pool.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(download, *task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    print("DOWNLOAD_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
