"""Bounded headless FluxRT benchmark; run inside its Linux GPU environment.

Interpolation is disabled so interpolated frames cannot inflate throughput.
Run from the FluxRT checkout with --input, --reference and --output paths.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path


def main():
    import cv2
    import numpy as np
    from fluxrt import StreamProcessor
    from fluxrt.utils import crop_maximal_rectangle

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=576)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--seconds", type=float, default=7)
    parser.add_argument("--ready-timeout", type=float, default=600)
    parser.add_argument("--compile", action="store_true")
    parser.add_argument("--int8", action="store_true")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--prompt", help="Override the benchmark's reference-person instruction")
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    prompt = args.prompt or ("Replace the person in the first image with the man from the reference image. "
              "Match the reference man's face, bald head, skin tone and grey shirt. "
              "Preserve the first image's head pose, facial expression, body position, "
              "camera angle and background. Photorealistic.")
    config = json.loads(Path("configs/config_with_reference.json").read_text())
    config.update(default_prompt=prompt, default_steps=args.steps,
                  resolution={"height": args.height, "width": args.width},
                  reference_image_path=str(Path(args.reference).resolve()),
                  reference_image_resolution={"height": 256, "width": 256},
                  interpolation_exp=0, compile_models=args.compile,
                  enable_int8_quantization=args.int8,
                  enable_spatial_cache=not args.no_cache, logging=False)
    config_path = output.with_suffix(".config.json")
    config_path.write_text(json.dumps(config, indent=2))
    cap = cv2.VideoCapture(args.input)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or not np.isfinite(fps):
        raise ValueError("Source has no valid frame rate")
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(crop_maximal_rectangle(frame, args.height, args.width))
    cap.release()
    if not frames:
        raise ValueError("Source video contains no readable frames")
    processor = StreamProcessor(str(config_path))
    inp, outp = processor.get_input_tensor(), processor.get_output_tensor()
    inp.copy_from(frames[0])
    writer = side = None
    started = time.monotonic()
    try:
        processor.start()
        while not processor.is_ready():
            child = processor.model_inference_subprocess.process
            if child is not None and child.exitcode is not None:
                raise RuntimeError(f"Inference child exited: {child.exitcode}")
            if time.monotonic() - started > args.ready_timeout:
                raise TimeoutError("Model load/first frame exceeded the budget")
            time.sleep(0.1)
        ready_s = time.monotonic() - started
        print(f"FIRST_FRAME {ready_s:.2f}s", flush=True)
        # Give reference/prompt state a moment to settle before recording.
        time.sleep(2)
        writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps,
                                (args.width, args.height))
        side = cv2.VideoWriter(str(output.with_name(output.stem + "_side.mp4")),
                              cv2.VideoWriter_fourcc(*"mp4v"), fps,
                              (args.width * 2, args.height))
        if not writer.isOpened() or not side.isOpened():
            raise RuntimeError("Could not open video encoder")
        samples, changes, previous = [], 0, None
        clock = time.monotonic()
        count = int(round(args.seconds * fps))
        for i in range(count):
            delay = clock + i / fps - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            src = frames[i % len(frames)]
            inp.copy_from(src)
            frame = outp.to_numpy().copy()
            digest = hashlib.sha256(frame.tobytes()).digest()
            if digest != previous:
                changes += 1
                previous = digest
            writer.write(frame)
            side.write(np.hstack((src, frame)))
            samples.append(processor.get_last_processing_time() * 1000)
        elapsed = time.monotonic() - clock
        # API reports MB, not bytes. Display FPS counts may miss updates above input FPS.
        result = dict(source_frames=len(frames), source_fps=fps, recorded_frames=count,
                      resolution=[args.width, args.height], steps=args.steps,
                      interpolation=False, compiled=args.compile, int8=args.int8,
                      spatial_cache=not args.no_cache, prompt=prompt,
                      first_frame_seconds=round(ready_s, 2), wall_seconds=round(elapsed, 2),
                      observed_distinct_frames_per_second=round(max(0, changes - 1) / elapsed, 2),
                      model_period_ms_median=round(float(np.median(samples)), 2),
                      reserved_vram_mib=processor.get_reserved_memory(),
                      capture_to_display_latency="not measured", output=str(output))
        output.with_suffix(".metrics.json").write_text(json.dumps(result, indent=2))
        print("RESULT " + json.dumps(result), flush=True)
    finally:
        if writer:
            writer.release()
        if side:
            side.release()
        processor.stop()


if __name__ == "__main__":
    # Required: FluxRT uses multiprocessing spawn; top-level inference recurses.
    main()
