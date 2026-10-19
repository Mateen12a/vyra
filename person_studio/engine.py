"""Actual Wan-Animate CLI integration. No simulated transformation path."""
import json
import math
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from threading import Event
from typing import Callable

from .config import Settings

RUNNER = Path(__file__).resolve().parent / "wan_runner.py"


class Cancelled(Exception):
    pass


def stop_process(process):
    if process.poll() is None:
        if os.name == "nt":
            process.terminate()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()


class ResidentRunner:
    """Owns the long-lived wan_runner.py process that keeps the model in GPU memory."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.process = None
        self.replies = None
        self.state = "stopped"

    def _start(self):
        s = self.settings
        command = [s.wan_python, str(RUNNER), "--ckpt_dir", str(s.wan_checkpoint),
                   "--log", str(s.data_dir / "wan-runner.log")]
        if s.t5_cpu:
            command.append("--t5_cpu")
        if not s.merge_lora:
            command.append("--no_merge_lora")
        if s.distill_lora:
            command += ["--distill_lora", str(s.distill_lora), "--distill_scale", str(s.distill_scale)]
        self.process = subprocess.Popen(command, cwd=str(s.wan_repo), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, bufsize=1,
                                        start_new_session=os.name != "nt")
        self.replies = queue.Queue()
        process, replies = self.process, self.replies

        def read():
            for line in process.stdout:
                try:
                    replies.put(json.loads(line))
                except ValueError:
                    pass
            replies.put(None)
        threading.Thread(target=read, daemon=True, name="wan-runner-reader").start()
        self.state = "loading"

    def _wait(self, cancel: Event, deadline: float):
        while True:
            if cancel.is_set():
                self.stop()
                raise Cancelled()
            if time.monotonic() > deadline:
                self.stop()
                raise RuntimeError("Processing timed out. Try a shorter clip or a larger GPU.")
            try:
                message = self.replies.get(timeout=0.2)
            except queue.Empty:
                continue
            if message is None:
                self.stop()
                raise RuntimeError("The model worker stopped unexpectedly. Check wan-runner.log on the processing server.")
            return message

    def ensure_ready(self, cancel: Event, deadline: float):
        if self.process is None or self.process.poll() is not None:
            self._start()
        if self.state == "loading":
            message = self._wait(cancel, deadline)
            if not message.get("ready"):
                self.stop()
                raise RuntimeError(message.get("error", "The model could not be loaded."))
            self.state = "ready"

    def generate(self, request: dict, cancel: Event):
        deadline = time.monotonic() + self.settings.timeout
        # A background preload may hold the lock; stay cancellable while waiting for it.
        while not self.lock.acquire(timeout=0.2):
            if cancel.is_set():
                raise Cancelled()
        try:
            self.ensure_ready(cancel, deadline)
            self.state = "busy"
            self.process.stdin.write(json.dumps(request) + "\n")
            self.process.stdin.flush()
            message = self._wait(cancel, deadline)
            self.state = "ready"
            if not message.get("ok"):
                raise RuntimeError(message.get("error", "The model worker failed."))
            return message
        finally:
            self.lock.release()

    def preload(self):
        def load():
            try:
                with self.lock:
                    self.ensure_ready(Event(), time.monotonic() + self.settings.timeout)
            except Exception:
                pass
        threading.Thread(target=load, daemon=True, name="wan-runner-preload").start()

    def stop(self):
        if self.process is not None:
            if self.process.stdin:
                try:
                    self.process.stdin.close()
                except OSError:
                    pass
            stop_process(self.process)
        self.process = None
        self.state = "stopped"


class WanEngine:
    name = "Wan-Animate 14B · person replacement"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.runner = ResidentRunner(settings)
        # The resident runner keeps every model on the GPU, so offloading setups use per-job runs.
        self.resident = settings.resident and not settings.offload_model

    def start(self):
        if self.resident and self.settings.preload and self.status()["configured"]:
            self.runner.preload()

    def close(self):
        self.runner.stop()

    def status(self):
        s = self.settings
        reasons = []
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            reasons.append("FFmpeg and ffprobe are required on the processing server.")
        if not s.wan_repo or not (s.wan_repo / "generate.py").is_file():
            reasons.append("The Wan-Animate model environment is not configured.")
        elif not (s.wan_repo / "wan/modules/animate/preprocess/preprocess_data.py").is_file():
            reasons.append("The Wan-Animate preprocessing script is missing.")
        if not s.wan_checkpoint or not (s.wan_checkpoint / "config.json").is_file():
            reasons.append("Wan-Animate model weights are not configured.")
        else:
            pose = s.wan_checkpoint / "process_checkpoint/pose2d/vitpose_h_wholebody.onnx"
            if pose.is_dir():
                pose = pose / "end2end.onnx"
            if not pose.is_file() or not all((s.wan_checkpoint / "process_checkpoint" / p).is_file() for p in (
                "det/yolov10m.onnx", "sam2/sam2_hiera_large.pt"
            )):
                reasons.append("The person tracking and segmentation weights are missing.")
            if not all((s.wan_checkpoint / p).is_file() for p in (
                "diffusion_pytorch_model.safetensors.index.json", "Wan2.1_VAE.pth",
                "models_t5_umt5-xxl-enc-bf16.pth", "relighting_lora.ckpt"
            )):
                reasons.append("The generation or relighting checkpoint files are incomplete.")
        if s.distill_lora and not s.distill_lora.is_file():
            reasons.append("The configured distill LoRA file is missing.")
        if not shutil.which(s.wan_python) and not Path(s.wan_python).is_file():
            reasons.append("The GPU model's Python environment is missing.")
        # Configured means paths exist, not that GPU quality/performance has been verified.
        return {"configured": not reasons, "engine": self.name,
                "mode": "clip", "live_available": False,
                "model_state": self.runner.state if self.resident else "per-job",
                "message": "Ready to submit a GPU quality test." if not reasons else " ".join(reasons)}

    def validate_video(self, path: Path):
        try:
            result = subprocess.run([
                "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-show_streams", "-show_format", "-of", "json", str(path)
            ], capture_output=True, timeout=15, check=True)
            info = json.loads(result.stdout)
            stream = next(item for item in info["streams"] if item.get("codec_type") == "video")
            duration = float(info.get("format", {}).get("duration") or stream.get("duration") or 0)
            # MediaRecorder WebM often has no duration header. Decode packet timestamps instead.
            if not duration:
                packets = subprocess.run([
                    "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                    "-select_streams", "v:0", "-show_packets",
                    "-show_entries", "packet=pts_time,duration_time", "-of", "json", str(path)
                ], capture_output=True, timeout=15, check=True)
                timestamps = json.loads(packets.stdout)["packets"]
                start = min(float(p.get("pts_time", 0)) for p in timestamps)
                end = max(float(p.get("pts_time", 0)) + float(p.get("duration_time", 0)) for p in timestamps)
                duration = end - start
            if not math.isfinite(duration) or duration < 0.5 or duration > self.settings.max_duration + 0.25:
                raise ValueError("Choose a video between 0.5 and 10 seconds long.")
            width, height = int(stream["width"]), int(stream["height"])
            # Phone clips are often stored landscape with a rotation flag; FFmpeg will autorotate them.
            rotation = stream.get("tags", {}).get("rotate") or next(
                (item.get("rotation") for item in stream.get("side_data_list", []) if "rotation" in item), 0)
            if abs(int(float(rotation))) % 180 == 90:
                width, height = height, width
            if min(width, height) < 64 or max(width, height) > 4096:
                raise ValueError("Choose a video with dimensions between 64 and 4096 pixels.")
            return {"duration_seconds": round(duration, 3), "width": width, "height": height}
        except ValueError:
            raise
        except (OSError, subprocess.SubprocessError, KeyError, StopIteration, TypeError):
            raise ValueError("This video could not be read. Try an MP4 or a fresh camera recording.")

    def commands(self, folder: Path, options: dict):
        s = self.settings
        width, height = (832, 480) if options["quality"] == "preview" else (1280, 720)
        preprocess = [s.wan_python, str(s.wan_repo / "wan/modules/animate/preprocess/preprocess_data.py"),
                      "--ckpt_path", str(s.wan_checkpoint / "process_checkpoint"),
                      "--video_path", str(folder / "source.mp4"),
                      "--refer_path", str(folder / "reference.png"),
                      "--save_path", str(folder / "prepared"),
                      "--resolution_area", str(width), str(height), "--fps", "30", "--replace_flag",
                      "--iterations", "3", "--k", "7", "--w_len", "1", "--h_len", "1"]
        steps = s.preview_steps if options["quality"] == "preview" else s.steps
        generate = [s.wan_python, str(s.wan_repo / "generate.py"), "--task", "animate-14B",
                    "--size", "1280*720", "--ckpt_dir", str(s.wan_checkpoint),
                    "--src_root_path", str(folder / "prepared"), "--refert_num", "1",
                    "--replace_flag", "--use_relighting_lora", "--offload_model", str(s.offload_model),
                    "--sample_steps", str(steps),
                    "--base_seed", "42", "--prompt", options["prompt"],
                    "--save_file", str(folder / "generated.mp4")]
        if s.t5_cpu:
            generate.append("--t5_cpu")
        return preprocess, generate

    def run_command(self, command, cwd: Path, folder: Path, cancel: Event):
        if cancel.is_set():
            raise Cancelled()
        with (folder / "worker.log").open("ab") as log:
            process = subprocess.Popen(command, cwd=str(cwd), stdout=log, stderr=log,
                                       start_new_session=os.name != "nt")
            start = time.monotonic()
            try:
                while process.poll() is None:
                    if cancel.wait(0.2):
                        raise Cancelled()
                    if time.monotonic() - start > self.settings.timeout:
                        raise RuntimeError("Processing timed out. Try a shorter clip or a larger GPU.")
                if process.returncode != 0:
                    raise RuntimeError("The model worker failed. Check worker.log on the processing server.")
            finally:
                stop_process(process)

    def run(self, folder: Path, options: dict, progress: Callable, cancel: Event):
        s = self.settings
        # Decord expects seekable MP4 input; normalize browser WebM/MOV too.
        progress("preparing", "Preparing video and tracking the person")
        self.run_command([
            "ffmpeg", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", str(folder / "upload.video"),
            "-map", "0:v:0", "-map", "0:a?", "-vf",
            "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-t", str(s.max_duration), "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart", str(folder / "source.mp4")
        ], folder, folder, cancel)
        preprocess, generate = self.commands(folder, options)
        self.run_command(preprocess, s.wan_repo, folder, cancel)
        expected = ["src_ref.png", "src_pose.mp4", "src_face.mp4", "src_bg.mp4", "src_mask.mp4"]
        if not all((folder / "prepared" / name).is_file() for name in expected):
            raise RuntimeError("Person tracking did not produce all the required inputs. Try a clear single-person clip.")
        metrics = {}
        started = time.monotonic()
        if self.resident:
            progress("transforming", "Generating the new person" if self.runner.state == "ready"
                     else "Loading the model (first run only, a few minutes)")
            reply = self.runner.generate({
                "src_root_path": str(folder / "prepared"), "save_file": str(folder / "generated.mp4"),
                "log": str(folder / "worker.log"), "prompt": options["prompt"], "seed": 42,
                "steps": s.preview_steps if options["quality"] == "preview" else s.steps,
            }, cancel)
            # generate_seconds excludes any one-off model load counted in generation_seconds.
            metrics.update(model_seconds=reply["generate_seconds"], peak_vram_gb=reply["peak_vram_gb"])
        else:
            progress("transforming", "Generating the new person")
            self.run_command(generate, s.wan_repo, folder, cancel)
        metrics["generation_seconds"] = round(time.monotonic() - started, 2)
        progress("encoding", "Preparing your result")
        # Resident output is already H.264/yuv420p, so only remux it with the source audio.
        video_codec = ["-c:v", "copy"] if self.resident else ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
        # Trim audio to the generated video; -shortest drops trailing frames when copying video.
        length = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                 "format=duration", "-of", "csv=p=0", str(folder / "generated.mp4")],
                                capture_output=True, text=True, timeout=15).stdout.strip()
        self.run_command([
            "ffmpeg", "-nostdin", "-y", "-i", str(folder / "generated.mp4"),
            "-i", str(folder / "source.mp4"), "-map", "0:v:0", "-map", "1:a?",
            *video_codec, "-c:a", "aac",
            *(["-t", length] if length else ["-shortest"]), "-movflags", "+faststart", str(folder / "result.mp4")
        ], folder, folder, cancel)
        if cancel.is_set():
            raise Cancelled()
        if not (folder / "result.mp4").is_file() or (folder / "result.mp4").stat().st_size == 0:
            raise RuntimeError("The worker did not produce a playable result.")
        return metrics

