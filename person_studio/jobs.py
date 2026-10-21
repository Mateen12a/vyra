import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from .engine import Cancelled

TERMINAL = {"completed", "failed", "cancelled"}


class Jobs:
    def __init__(self, settings, engine):
        self.settings, self.engine = settings, engine
        self.root = settings.data_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu-worker")
        self.slots = threading.BoundedSemaphore(settings.max_jobs)
        self.records = {}
        self.cancels = {}
        self.on_failed = None  # set by the app to refund credits: on_failed(record)
        self.on_voice_failed = None  # refunds only the voice part when the clip worked but the voice didn't
        for file in self.root.glob("*/job.json"):
            try:
                record = json.loads(file.read_text(encoding="utf-8"))
                if record["status"] not in TERMINAL:
                    record.update(status="failed", message="Processing server restarted. Submit the clip again.")
                self.records[record["id"]] = record
                self._save(record)
            except (ValueError, KeyError, OSError):
                logging.warning("Could not recover job metadata in %s", file.parent.name)

    def folder(self, job_id):
        # Only canonical UUIDs are accepted, never client-supplied filesystem paths.
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError("Invalid job ID")
        return self.root / job_id

    def _save(self, record):
        folder = self.folder(record["id"])
        temporary = folder / "job.json.tmp"
        temporary.write_text(json.dumps(record, indent=2), encoding="utf-8")
        temporary.replace(folder / "job.json")

    def create(self):
        if not self.slots.acquire(blocking=False):
            raise RuntimeError("The GPU queue is full. Wait for the current tests to finish.")
        job_id = str(uuid.uuid4())
        try:
            folder = self.folder(job_id)
            folder.mkdir()
            return job_id, folder
        except Exception:
            self.slots.release()
            raise

    def submit(self, job_id, options, metadata, owner=None):
        record = {"id": job_id, "owner": owner, "status": "queued", "message": "Waiting for the GPU",
                  "created_at": datetime.now(timezone.utc).isoformat(), "mode": "clip",
                  "quality": options["quality"], "source": metadata, "metrics": {},
                  "credits": options.get("credits"), "voice": options.get("voice") or None,
                  "voice_credits": options.get("voice_credits") or 0}
        with self.lock:
            self.records[job_id] = record
            self.cancels[job_id] = threading.Event()
            self._save(record)
        self.pool.submit(self._run, job_id, options)
        return self.get(job_id)

    def update(self, job_id, **changes):
        with self.lock:
            self.records[job_id].update(changes)
            self._save(self.records[job_id])

    def get(self, job_id):
        with self.lock:
            if job_id not in self.records:
                raise KeyError(job_id)
            return json.loads(json.dumps(self.records[job_id]))

    def _run(self, job_id, options):
        cancel = self.cancels[job_id]
        started = time.monotonic()
        try:
            if cancel.is_set():
                raise Cancelled()
            metrics = self.engine.run(self.folder(job_id), options,
                                      lambda state, message: self.update(job_id, status=state, message=message), cancel)
            if cancel.is_set():
                raise Cancelled()
            metrics["total_processing_seconds"] = round(time.monotonic() - started, 2)
            source_duration = self.get(job_id)["source"]["duration_seconds"]
            metrics["processing_to_clip_ratio"] = round(metrics["total_processing_seconds"] / source_duration, 2)
            voice_ok = metrics.get("voice") in (None, "applied")
            message = ("Your result is ready to review" if voice_ok else
                       "Your video is ready. It had no sound, so there was no voice to change; those credits were returned."
                       if metrics.get("voice") == "no_audio" else
                       "Your video is ready. The voice couldn't be changed, so it keeps the original sound; those credits were returned.")
            self.update(job_id, status="completed", metrics=metrics, message=message)
            if not voice_ok and self.on_voice_failed:
                try:
                    self.on_voice_failed(self.get(job_id))
                except Exception:
                    logging.exception("Could not refund the voice for job %s", job_id)
        except Cancelled:
            self.update(job_id, status="cancelled", message="Processing cancelled")
        except Exception as exc:
            logging.exception("Job %s failed", job_id)
            self.update(job_id, status="failed", message=str(exc) if isinstance(exc, RuntimeError) else
                        "Processing failed. Check the server logs and try again.")
            if self.on_failed:
                try:
                    self.on_failed(self.get(job_id))
                except Exception:
                    logging.exception("Could not refund failed job %s", job_id)
        finally:
            with self.lock:
                self.cancels.pop(job_id, None)
            self.slots.release()

    def cancel(self, job_id):
        with self.lock:
            record = self.get(job_id)
            if record["status"] not in TERMINAL and job_id in self.cancels:
                self.cancels[job_id].set()
                self.update(job_id, message="Stopping processing…")
            return self.get(job_id)

    def delete(self, job_id):
        # Client ID has been validated and the resolved path must stay under the jobs root.
        import shutil
        with self.lock:
            if self.get(job_id)["status"] not in TERMINAL or job_id in self.cancels:
                raise RuntimeError("Wait for processing to stop before deleting this test.")
            folder = self.folder(job_id).resolve()
            if folder.parent != self.root.resolve():
                raise ValueError("Invalid job path")
            shutil.rmtree(folder)
            del self.records[job_id]

    def close(self):
        with self.lock:
            for cancel in self.cancels.values():
                cancel.set()
        self.pool.shutdown(wait=True)

