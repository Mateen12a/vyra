# EditaLive assessment for Alter

Checked 2026-10-10 against upstream revision
`9fe7fdb4ce3ff69305f026e8dec265aaf7a4196f` in `vendor/EditaLive`.

## Decision

EditaLive is a promising next experiment for reference-driven character video
transformation. Its architecture explicitly conditions on body pose and facial
motion and generates a sequence with historical context. That targets the motion
and appearance consistency problems observed in our FluxRT test. Better results
on our clip remain a hypothesis: no EditaLive inference has been run in Alter.

It is not yet a drop-in replacement for Alter Live. First validate an uploaded
clip, then adapt the live service if identity, motion and measured speed pass.

## Published results versus our hardware

The [authors' project page](https://huai-chang.github.io/EditaLive/) reports
14.47 generated FPS and 0.829 seconds average inter-chunk latency on one H100
at 384 x 672, using 81-frame clips. Flash-VAED raises reported throughput to
16.4 FPS. These are author measurements, not RTX 5090 measurements and not
camera-to-browser latency. Generation produces chunks; average throughput alone
does not describe how smoothly they arrive at a live viewer.

The [upstream README](https://github.com/GVCLab/EditaLive) reports these H100
memory figures with FP8, Flash-VAED, and compilation disabled:

| Mode | 384 x 672 | 480 x 832 |
| --- | --- | --- |
| Resident weights | 31.4 GiB | 38.4 GiB |
| CPU weight streaming | 17.5 GiB | 24.5 GiB |
| CPU weight and KV streaming | 14.4 GiB | 15.0 GiB |

The previously inspected Pod has 32,607 MiB (about 31.84 GiB) VRAM. Resident
inference leaves little margin even at the smaller size. Start with FP8,
`--low_vram weights`, CPU T5, Flash-VAED and no compilation. Compilation and
low-VRAM mode are mutually exclusive. CPU offloading also requires enough host
RAM, and speed depends on host-to-GPU transfers; H100 slowdown figures cannot
be assumed to hold on a rented 5090. Recheck Pod RAM and free disk before setup.

## Reference images and live integration

- `edit_streaming.py` supports `--video` plus an independent `--ref_image`.
  The project gallery explicitly demonstrates cross-character editing.
- `webcam/service.py` currently rejects a reference mode other than `camera`.
  The core pipeline's `stream_start(ref_image, ...)` already accepts an image,
  so uploaded-reference support can be implemented without retraining the model.
- `webcam/config.py` currently restricts orientation to landscape. It also
  does not expose low-VRAM mode or CPU T5. `webcam/workers.py` enables compilation
  and calls the resident model loader. Those settings need adapting for this Pod.
- Clip output orientation follows the reference image. Our source displays as
  portrait, while `images.jpeg` is a landscape head-and-shoulders image. Prepare
  and inspect a portrait reference without stretching the face before testing;
  padding alone does not establish full-body appearance.
- The inspected conditioning path consumes a reference image, pose video and
  face video, rather than original RGB background frames or replacement masks.
  Consequently, preserving the barbershop background with an unrelated portrait
  is not established. A source-scene reference or foreground compositing may be
  necessary. This is an inference from the code, not an observed EditaLive failure.

## Installation compatibility

Upstream pins Torch 2.6 / CUDA 12.4 and FlashAttention 2.7.2.post1. The existing
5090 environment was Torch 2.8 / CUDA 12.8. Use an isolated environment and
validate Blackwell-compatible dependencies before downloading checkpoints;
do not replace the working FluxRT environment with the upstream pins blindly.

The installer pins FastVideo revision
`b1d89eba1f177f2b096192c9b1e7ceb7096bea99`. Its
[sparse attention implementation](https://github.com/hao-ai-lab/FastVideo/blob/b1d89eba1f177f2b096192c9b1e7ceb7096bea99/fastvideo-kernel/python/fastvideo_kernel/block_sparse_attn.py)
selects an H100-specific SM90 kernel on Hopper and a Triton implementation on
other architectures. The latter offers a plausible 5090 route, but import,
numerical correctness and timing still need a real CUDA smoke test. EditaLive
also exposes `--vsa_backend sdpa` for a fallback test; do not extrapolate published
speed to that fallback.

## Bounded first test

After dependency smoke tests and selective checkpoint download, this is the
proposed seven-second clip configuration, run from the upstream checkout on
the Pod. `ref-portrait.png` must first be prepared and inspected; it does not
currently exist. This command has not been executed.

```bash
timeout 900 python edit_streaming.py \
  --ckpt_dir ./weights/Wan-Animate \
  --lora_paths ./weights/EditaLive/editalive_edit.safetensors \
    ./weights/EditaLive/lightx2v.safetensors \
    ./weights/EditaLive/editalive_streaming.safetensors \
  --video /workspace/media/clip.mp4 \
  --ref_image /workspace/media/ref-portrait.png \
  --prompt "Preserve the reference character's appearance and follow the driving motion." \
  --long_edge 672 --short_edge 384 \
  --preprocess_long_edge 672 --preprocess_short_edge 384 \
  --preprocess_fps 16 --fps 16 --frame_num -1 \
  --fp8 --low_vram weights --t5_cpu \
  --enable_compile False --fast_decode True \
  --fast_decoder_pth ./weights/Flash-VAED/Flash_VAED_Wan.pth \
  --save_dir /workspace/out/editalive-test
```

Measure setup time, preprocessing, model load, warmed generation throughput,
peak VRAM and chunk delivery separately. Review the full output for head turns,
identity, cape removal, expressions, occlusion, background and temporal flicker.
The current seven-second clip cannot prove hand, leg or full-body fidelity.
Only after this passes should we wire the streaming pipeline into Alter and
measure camera-to-display latency, audio synchronization and long-session drift.

## Cost and availability

Code and checkpoints are publicly available, so self-hosting avoids a separate
generation API bill. GPU runtime, downloads while a Pod runs, and storage can
still cost money. This investigation downloaded source code locally only; it
did not start a new paid GPU job or download EditaLive model weights.

The repository has an Apache-2.0 code license but the README also says the
project is for academic research only. Commercial product permission is therefore
not established by this audit; code, checkpoint and component terms need to be
resolved before calling it a fully open commercial backend.
