# Cost-conscious transformation options

Research and hardware inspection: 2026-10-10. Prices can change.

## What is free on the current laptop?

The laptop has 16 GB RAM, Intel UHD 620 and an NVIDIA MX250 with 2 GB VRAM.
Alter's browser capture, text/logo overlay, recording and basic region cleanup
can run locally without a generation API or rented GPU. Those operations do
not provide reference-guided full-person synthesis. The existing region cleanup
interpolates pixels; it is not a learned reconstruction model.

Neither an open-source license nor free model weights include free cloud compute.
Reliable full-person live generation is not established on this laptop.

## Candidate comparison

| Candidate | Relevant capability | Cost and limitation |
| --- | --- | --- |
| [FluxRT](https://github.com/tensorforger/FluxRT) with [FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) | Reference-guided webcam/video editing; experimental open-source live candidate | Self-hosted GPU cost, no per-frame API fee. Upstream advertises 20–40 FPS on RTX 5090 at 512 square; that is not our measurement or an identity guarantee. |
| [Wan2.2 Animate](https://github.com/Wan-Video/Wan2.2) | Character replacement preserving performance in a recorded clip | Open-source pipeline; substantially slower than live in the app's prior A100 tests. The existing BF16 resident runner needs more than this Pod's 32 GB VRAM; use offloading or a separately validated quantized implementation. |
| [Wan2GP](https://github.com/DeepBeepMeep/Wan2GP) | Optimized/quantized video inference including Wan Animate | A candidate for lower VRAM offline rendering; not validated in Alter. |
| [StreamDiffusion](https://github.com/cumulo-autumn/StreamDiffusion) | Fast image-to-image streaming | Useful for stylization; speed alone does not establish stable reference-person replacement. |
| [StreamDiffusionV2](https://github.com/chenfengxu714/StreamDiffusionV2) | Streaming video diffusion with better temporal modeling | Research candidate; reference-person replacement is not validated in Alter. |
| [EditaLive](https://github.com/GVCLab/EditaLive) | Causal character editing based on Wan Animate; separate reference image works for clips | Promising next test. Authors report 14.47 FPS on H100, not our 5090. FP8 CPU weight streaming may fit 32 GB; live UI needs uploaded references, portrait orientation and offloading support. README says academic research only despite Apache code license. See the [source audit and test configuration](editalive-assessment.md). |
| [fal Wan Animate Replace](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace) | Hosted recorded-video character replacement | Same model family as our offline worker. No evidence that changing the host alone improves identity quality. Charged per frame. |
| [fal Kling 3 Standard Motion Control](https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control) / [Pro](https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control) | Transfer the driving video's performance to a reference character | Independent paid model worth comparing for recorded clips, not live. Listed at $0.126/s Standard or $0.168/s Pro: approximately $0.882 / $1.176 for seven seconds. Motion transfer does not guarantee original background preservation; no quality comparison was purchased. |
| [fal Lucy 2.5 realtime](https://fal.ai/learn/tools/real-time-video-editing-with-ai) | Hosted live character editing | Uses Decart's model. This is a different host, not an independent open-source alternative. Listed at $0.04 per processed second ($2.40/minute). |

FLUX.2-klein **4B** weights carry Apache 2.0; do not assume that license applies
to every FLUX model or optional component. FluxRT itself lists the Unlicense.

FluxRT's [published benchmark](https://github.com/tensorforger/FluxRT/blob/main/benchmark.md)
uses `interpolation_exp=2` (four output frames per generation) and disables
reference conditioning. Its 100% dynamic-area result is 0.1829 seconds per
processing cycle, reported as 22.15 FPS: roughly 5.5 cycles per second before
interpolation. That table does **not** prove 22 distinct reference-conditioned
AI generations per second. This is why our test disables interpolation.

## This user's test

- Pod GPU verified through SSH: RTX 5090, 32,607 MiB VRAM; CUDA PyTorch 2.8.0+cu128.
- `/workspace` is on a 110 GB container overlay. Do not assume files survive recreation.
- Source: `WhatsApp Video 2026-10-09 at 23.53.35.mp4`, 7 seconds, 210 frames,
  30 FPS, displayed as portrait after rotation metadata is applied.
- Reference: `images.jpeg`, head-and-shoulders portrait. It cannot establish
  full-body clothing, hand, or leg fidelity.
- Source SHA256: `46202bb376173ef6f0077d97292be0eb5cb039b82102b7b52fb97848b93d68c6`.
- Reference SHA256: `f35f2d00ed2adc1cc956b8272c1bfb606fc0845318607a29de3a0ba8823f02d1`.
- Matching copies already exist at `/workspace/media/clip.mp4` and `ref.jpeg`.

At fal's published Wan Replace rates, the 210-frame input would cost approximately
**$0.525 at 480p**, **$0.7875 at 580p**, or **$1.05 at 720p**. Their billing formula
is `frames / 16 * resolution_rate`, not simply input seconds times rate.
No paid fal generation was submitted during this investigation.

The inference jobs are finished and GPU memory has returned to about 2 MiB;
the Pod is still running. Stopping an inference process does not stop RunPod
billing. Stop the Pod in the dashboard when it is no longer needed. This Pod's
`/workspace` resolves to `/` with filesystem type `overlay`, so treat model files
as temporary: [RunPod documents that container disk is cleared on stop/restart](https://docs.runpod.io/pods/storage/types).
The benchmark outputs and scripts have been saved locally. Exact GPU charges
were not inspected in the billing dashboard, and persistent storage may have its
own charge.

## Reproducible FluxRT benchmark

`scripts/download_fluxrt_weights.py` downloads only the required components,
pins each download to a resolved repository commit, validates byte ranges and
checks LFS SHA256 before publishing a weight file. It supports resuming completed
blocks and needs Linux (`os.pwrite`). Do not run two copies against the same folder.

Use `scripts/benchmark_fluxrt.py` inside a separate FluxRT GPU environment, from
the upstream checkout. It uses a multiprocessing main guard, caps first-frame
wait time, disables interpolation, records side-by-side output, and saves metrics.

```bash
PYTHONPATH=/workspace/FluxRT/src timeout 720 /workspace/fx/bin/python \
  /workspace/media/benchmark_fluxrt.py \
  --input /workspace/media/clip.mp4 --reference /workspace/media/ref.jpeg \
  --output /workspace/out/fluxrt-test.mp4 --seconds 7
```

The first run defaults to uncompiled inference to check correctness before
paying compilation time. Add `--compile` for a subsequent speed test. All model
components must already be downloaded; reference resolution is 256 square,
inference 320×576, and sampling is two steps.

Distinct displayed frames are an observed throughput measure, capped by the
30 FPS input sampler. Model period is measured separately. Neither metric is
capture-to-display latency. Interpolation and repeated output frames must not
be counted as generated frames.

Do not turn a single successful image into a claim of clean full-person video.
Review head turns, expressions, occlusion, background changes and flicker on the
whole clip before integrating a backend into Alter's Live mode.

## Measured results on this Pod

FluxRT revision: `32206e8255b085b9075e05d389781bcbc728d513`.
BF16 weights, 320×576 input/output, 256-square reference, seed 52, single 5090.
All required LFS files passed SHA256 verification. The isolated inference
environment passes `pip check`; its frozen package list is saved with the results.

| Configuration | First frame including load | Distinct generated FPS observed | Median model cycle | Reserved VRAM |
| --- | --- | --- | --- | --- |
| 2 steps, uncompiled | 14.28 s | 4.59 | 215.39 ms | 20,300 MiB |
| 2 steps, compiled | 24.94 s | 4.88 | 200.85 ms | 20,382 MiB |
| 4 steps, compiled | 43.70 s | 2.58 | 352.84 ms | 21,794 MiB |
| 2 steps, compiled, no spatial cache, explicit cape-removal prompt | 35.23 s | 4.88 | 206.34 ms | 19,372 MiB |

Every test feeds the actual source at 30 FPS for seven seconds; recordings also
have 210 frames, including repeated output frames. Interpolation is disabled.
The compiled runs logged recompilation/cache-limit warnings. Startup figures
include varying disk/compiler cache state, so they are not controlled cold-start
comparisons. These short tests do not establish long-session stability or cloud
capture-to-display delay.

Visual review of one-second samples across both initial outputs: the bald target
appearance and grey shirt are recognizable, but original cape patterns reappear,
clothes vary, background posters move, and output head direction sometimes
follows the front-facing reference instead of the source. Four steps does not
resolve those problems. This is a useful experimental upper-body editor, but it
does **not** pass Alter's clean full-person live goal. It has not replaced the
current Live backend.

An explicit cape-removal prompt with spatial caching disabled removed the cape
much more consistently in sampled frames, but lost the reference identity: the
source hair and face returned. Fixing clothing alone did not fix person replacement.

Results are stored locally under `.data/benchmarks/`: original model output,
side-by-side recordings, contact sheets, metrics, frozen dependencies, and H.264
review copies. `fluxrt-preview.mp4` restores the original source audio; the model
benchmark itself measures video only.
