# Cloud GPU worker setup

This adapter is for the original **Wan2.2-Animate-14B replacement pipeline**, not Wan-Animate-2 or ordinary Wan text-to-video. GPU inference has not been run in this workspace. These are setup instructions for the first benchmark, not a claim that the environment is already validated.

Use a Linux NVIDIA/CUDA development image with Python 3.11, FFmpeg/ffprobe, git, enough disk for the full checkpoint plus inputs/outputs, and an SSH service. Choose GPU memory after inspecting the upstream requirements; do not buy a long rental based on an assumed real-time result. Large-memory hardware is a conservative first benchmark choice, not a proven minimum.

## Install in separate environments

From a checkout of this project on the server:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -e .

mkdir -p vendor models
git clone https://github.com/Wan-Video/Wan2.2.git vendor/Wan2.2
git -C vendor/Wan2.2 checkout 1ea34ff48f87168174e12956e200b1d908b1c5ff
python3.11 -m venv .wan-venv
.wan-venv/bin/python -m pip install --upgrade pip setuptools wheel
```

Install CUDA-compatible PyTorch in `.wan-venv` using the command for your chosen image from [PyTorch](https://pytorch.org/get-started/locally/). Then install upstream dependencies and the preprocessing dependencies omitted from the main requirements:

```bash
.wan-venv/bin/python -m pip install -r vendor/Wan2.2/requirements.txt
.wan-venv/bin/python -m pip install 'diffusers>=0.35,<0.36' 'moviepy==1.0.3' 'librosa==0.11.0' 'decorator<5' decord loguru scipy 'onnxruntime-gpu==1.22.0' peft pandas matplotlib sentencepiece 'huggingface_hub<1'
.wan-venv/bin/python -m pip install 'git+https://github.com/facebookresearch/sam2.git'
.wan-venv/bin/python -c "import torch, diffusers, decord, onnxruntime, sam2; from diffusers import FluxKontextPipeline; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0)); print(onnxruntime.get_available_providers())"
```

Use `onnxruntime-gpu==1.22.0` with CUDA 12 PyTorch builds. Newer onnxruntime-gpu wheels target CUDA 13; with a CUDA 12 Torch they cannot load `libcublasLt.so.13`, and pose detection then runs silently on the CPU (the worker log shows `Failed to create CUDAExecutionProvider`).

`flash_attn` may require a matching CUDA toolkit, compiler, and `--no-build-isolation`, as discussed by upstream. SAM2 also has PyTorch constraints. If installation changes Torch, recheck CUDA availability and ONNX CUDA execution provider compatibility before attempting a generation. Freeze a working environment after the benchmark; the model dependency versions here are not a fully tested lockfile.

Download the model with the CLI installed in that environment:

```bash
.wan-venv/bin/huggingface-cli download Wan-AI/Wan2.2-Animate-14B --local-dir models/Wan2.2-Animate-14B --exclude 'process_checkpoint/FLUX.1-Kontext-dev/*'
```

Replacement mode does not use the optional Flux image editor. It does need the detector, pose, SAM2, and relighting model files distributed with Wan-Animate. Inspect auxiliary checkpoint licenses separately. Check that these files exist:

```text
models/Wan2.2-Animate-14B/config.json
models/Wan2.2-Animate-14B/process_checkpoint/det/yolov10m.onnx
models/Wan2.2-Animate-14B/process_checkpoint/pose2d/vitpose_h_wholebody.onnx/end2end.onnx
models/Wan2.2-Animate-14B/process_checkpoint/sam2/sam2_hiera_large.pt
models/Wan2.2-Animate-14B/relighting_lora.ckpt
```

### Optional: 4-step distillation LoRA

The lightx2v I2V-14B 480p step-distill LoRA merges cleanly into Wan-Animate (all 1,261 tensors) and cut Preview generation from 8 steps to 4 with comparable output in our A100 test. It is a community LoRA trained for Wan2.1 I2V, not an official Animate release; review its license and judge quality on your own clips.

```bash
.wan-venv/bin/python -c "from huggingface_hub import hf_hub_download; hf_hub_download('Kijai/WanVideo_comfy', 'Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', local_dir='models/distill')"
export WAN_DISTILL_LORA="$PWD/models/distill/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"
export WAN_PREVIEW_STEPS=4 WAN_STEPS=6
```

## Start the worker

```bash
export WAN_REPO="$PWD/vendor/Wan2.2"
export WAN_CHECKPOINT="$PWD/models/Wan2.2-Animate-14B"
export WAN_PYTHON="$PWD/.wan-venv/bin/python"
export PERSON_DATA_DIR="$PWD/.data"
export PERSON_API_TOKEN='replace-with-a-long-random-token'
export PERSON_ALLOWED_ORIGINS='http://127.0.0.1:8765,http://localhost:8765'
# 80 GB GPUs: keep everything on the GPU and load the model when the server starts.
export WAN_OFFLOAD_MODEL=false WAN_T5_CPU=false WAN_PRELOAD=true
.venv/bin/python -m person_studio --host 127.0.0.1 --port 8765
```

By default the model stays loaded in a resident process (`WAN_RESIDENT=true`), so only the first job pays the ~4.5 minute load; its log is `$PERSON_DATA_DIR/wan-runner.log`. It holds about 38 GB of GPU memory while idle. Set `WAN_RESIDENT=false` to launch `generate.py` per job instead (needed on GPUs too small to keep the model loaded).

Measured on one A100-SXM4-80GB with a 7-second portrait phone clip (210 frames):

| Setup | Total | Generation |
| --- | --- | --- |
| Original: per-job load, 8 steps | 733 s | 628 s incl. load |
| Resident + merged relighting LoRA, 8 steps | 385 s | 274 s |
| Resident + distill LoRA, Preview 4 steps (464×832) | 276 s | 163 s |
| Resident + distill LoRA, Detail 6 steps (720×1264) | 846 s | 724 s, peak 66 GB |

The worker serves the interface too. You can open the forwarded worker interface directly, or connect the local interface to it. Use a dedicated API token; no provider API key is needed.

On the laptop, keep an SSH tunnel open (replace the SSH port and host with your provider's values):

```powershell
ssh -N -L 8766:127.0.0.1:8765 -p SSH_PORT USER@GPU_HOST
```

In the local interface's **Connect GPU processor** dialog, enter `http://127.0.0.1:8766` and the same worker token. Start with a short Preview test. Inspect `.data/jobs/<job-id>/worker.log` if the upstream model fails; logs stay server-side. A public worker needs HTTPS and a matching allowed origin. Binding beyond localhost without a token is refused by the launcher.

RunPod's `ssh.runpod.io` proxy supports an interactive shell but may reject TCP forwarding. If that happens, expose HTTP port `8765` in the Pod's connection settings and use `https://POD_ID-8765.proxy.runpod.net` as the processor URL. Keep `PERSON_API_TOKEN` enabled because the proxy URL is internet-reachable.

On RunPod's PyTorch image, `/start.sh` executes `/pre_start.sh` when the container starts. A launcher works across restarts only if its files persist. [RunPod's storage documentation](https://docs.runpod.io/pods/storage/types) says container disk is cleared on stop/restart; a mounted volume disk survives stops until the Pod is deleted. Verify `/workspace` with `findmnt -T /workspace`: on the new RTX 5090 Pod it is an overlay, not a persistent volume. Back up needed files before stopping or editing the Pod. The test outputs and environment record have been copied to this laptop; public model weights can be downloaded again. A persistent volume also has a storage charge.

Keep the server private. The current single-owner service has no account system, billing controls, global storage quota, or automatic cleanup. Set your provider's runtime budget and stop the rental when testing is done. Delete test files through the interface when you no longer need them.
