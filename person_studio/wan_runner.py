"""Resident Wan-Animate process. Runs inside the GPU model environment (WAN_PYTHON), not the app.

Loads the pipeline once and serves generation requests as JSON lines on stdin, replying on
the original stdout. Model output for each request goes to that request's log file.
Standalone on purpose: it imports nothing from person_studio.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import traceback


def redirect_output(path):
    sys.stdout.flush()
    sys.stderr.flush()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)


def write_video(video, path, fps):
    import torch
    # (C, N, H, W) in [-1, 1] -> raw RGB frames piped to FFmpeg; faster than the upstream grid writer.
    frames = ((video.clamp(-1, 1) + 1) * 127.5).round().to(torch.uint8).permute(1, 2, 3, 0).contiguous().cpu().numpy()
    count, height, width = frames.shape[:3]
    process = subprocess.Popen([
        "ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
        "-c:v", "libx264", "-crf", "14", "-preset", "fast", "-pix_fmt", "yuv420p", str(path)
    ], stdin=subprocess.PIPE)
    process.stdin.write(frames.tobytes())
    process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("FFmpeg could not write the generated video")
    return count


def merge_adapters(model):
    from peft.tuners.tuners_utils import BaseTunerLayer
    merged = 0
    for module in model.modules():
        if isinstance(module, BaseTunerLayer) and not module.merged:
            module.merge()
            merged += 1
    return merged


def apply_distill_lora(model, path, scale):
    """Merge a ComfyUI-format step-distill LoRA (lora_down/lora_up/diff/diff_b) into the weights."""
    import torch
    from safetensors import safe_open
    params = dict(model.named_parameters())

    def target(name):
        # Merged PEFT layers keep their weights under base_layer.
        for candidate in (name, name.replace(".weight", ".base_layer.weight").replace(".bias", ".base_layer.bias")):
            if candidate in params:
                return params[candidate]
        return None

    applied, skipped = 0, []
    with safe_open(path, "pt", device="cuda") as lora, torch.no_grad():
        keys = set(lora.keys())
        for key in sorted(keys):
            name = key.removeprefix("diffusion_model.")
            if key.endswith(".lora_down.weight"):
                base = key[:-len(".lora_down.weight")]
                down, up = lora.get_tensor(key).float(), lora.get_tensor(base + ".lora_up.weight").float()
                alpha = lora.get_tensor(base + ".alpha").item() if base + ".alpha" in keys else down.shape[0]
                delta = (up.flatten(1) @ down.flatten(1)) * (alpha / down.shape[0])
                param = target(name[:-len(".lora_down.weight")] + ".weight")
            elif key.endswith(".diff") or key.endswith(".diff_b"):
                delta = lora.get_tensor(key).float()
                param = target(name.rsplit(".", 1)[0] + (".weight" if key.endswith(".diff") else ".bias"))
            else:
                continue
            if param is None or param.numel() != delta.numel():
                skipped.append(name)
                continue
            param.add_((delta.reshape(param.shape) * scale).to(param.dtype))
            applied += 1
    return applied, skipped


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt_dir", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--t5_cpu", action="store_true")
    parser.add_argument("--no_merge_lora", action="store_true")
    parser.add_argument("--distill_lora")
    parser.add_argument("--distill_scale", type=float, default=1.0)
    args = parser.parse_args()

    # Keep the protocol channel private before model libraries print to stdout.
    channel = os.fdopen(os.dup(1), "w", buffering=1)
    redirect_output(args.log)

    def reply(**message):
        channel.write(json.dumps(message) + "\n")
        channel.flush()

    try:
        sys.path.insert(0, os.getcwd())
        import logging
        import torch
        import wan
        from wan.configs import WAN_CONFIGS
        logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                            format="[%(asctime)s] %(levelname)s: %(message)s")
        started = time.monotonic()
        config = WAN_CONFIGS["animate-14B"]
        pipeline = wan.WanAnimate(config=config, checkpoint_dir=args.ckpt_dir, device_id=0, rank=0,
                                  t5_cpu=args.t5_cpu, use_relighting_lora=True)
        merged = 0 if args.no_merge_lora else merge_adapters(pipeline.noise_model)
        distilled = 0
        if args.distill_lora:
            distilled, skipped = apply_distill_lora(pipeline.noise_model, args.distill_lora, args.distill_scale)
            logging.info("Distill LoRA: applied %s tensors, skipped %s: %s", distilled, len(skipped), skipped[:20])
        load_seconds = round(time.monotonic() - started, 1)
        logging.info("Resident pipeline ready in %ss, merged %s adapter layers", load_seconds, merged)
        reply(ready=True, load_seconds=load_seconds, merged_layers=merged, distill_tensors=distilled)
    except Exception:
        traceback.print_exc()
        reply(ready=False, error="The model could not be loaded. Check wan-runner.log on the processing server.")
        return

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            redirect_output(request["log"])
            logging.info("Generating %s with %s steps", request["src_root_path"], request["steps"])
            started = time.monotonic()
            video = pipeline.generate(
                src_root_path=request["src_root_path"], replace_flag=True, refert_num=1,
                clip_len=config.frame_num, shift=config.sample_shift, sample_solver="unipc",
                sampling_steps=request["steps"], guide_scale=1.0, input_prompt=request["prompt"],
                seed=request["seed"], offload_model=False)
            generate_seconds = time.monotonic() - started
            frames = write_video(video, request["save_file"], config.sample_fps)
            del video
            torch.cuda.synchronize()
            logging.info("Finished %s frames", frames)
            reply(ok=True, generate_seconds=round(generate_seconds, 2),
                  peak_vram_gb=round(torch.cuda.max_memory_allocated() / 2 ** 30, 1))
        except Exception:
            traceback.print_exc()
            reply(ok=False, error="The model worker failed. Check worker.log on the processing server.")
        finally:
            redirect_output(args.log)
            torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
