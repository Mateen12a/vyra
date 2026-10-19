"use strict";
const $ = (id) => document.getElementById(id);
const state = { reference: null, video: null, stream: null, recorder: null, health: null,
  base: "", token: "", job: null, pollTimer: null, recordingTimer: null, recordStopTimer: null,
  urls: {}, busy: false, submitting: false, connecting: false, recording: false, checkingVideo: false, videoRevision: 0 };
const terminal = new Set(["completed", "failed", "cancelled"]);

function notice(message, info = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("info", info);
  $("notice").hidden = !message;
}
function setUrl(key, blob) {
  if (state.urls[key]) URL.revokeObjectURL(state.urls[key]);
  state.urls[key] = blob ? URL.createObjectURL(blob) : null;
  return state.urls[key];
}
function updateControls() {
  const hasInputs = state.reference && state.video;
  $("transformButton").disabled = !hasInputs || !state.health?.configured || state.busy || state.recording || state.checkingVideo;
  $("submitHint").textContent = state.busy ? "Your test is processing." : !state.health?.configured
    ? (state.health?.message || "Connect a GPU processor to generate.") : state.checkingVideo ? "Checking your source clip…" : !hasInputs
    ? "Add a reference image and source clip." : state.health?.provider === "fal"
    ? "Runs on a cloud GPU (fal). Expect a few minutes: a 3 s clip took about 5 min and cost $0.23 at Preview. Detail costs twice as much." : "Your files will be sent to the connected processor.";
  for (const id of ["referenceInput", "videoInput", "cameraButton", "appearance", "recordButton"]) $(id).disabled = state.busy;
  document.querySelectorAll('[name="quality"]').forEach((input) => { input.disabled = state.busy; });
  $("connectButton").disabled = state.submitting || state.connecting;
  $("recordButton").textContent = state.recording ? "■ Stop recording" : "● Record 6s";
}
async function api(path, options = {}, base = state.base, token = state.token) {
  let response;
  try {
    response = await fetch(base + path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      signal: options.signal || AbortSignal.timeout(120000) });
  } catch (error) {
    throw new Error(error.name === "TimeoutError" ? "The processor took too long to respond. Check its connection." :
      "Could not reach the processor. Check its URL, access token, and allowed origins.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = typeof payload.detail === "string" ? payload.detail : "The processor could not complete this request.";
    throw new Error(detail);
  }
  return response;
}
function showHealth(health) {
  state.health = health;
  $("connectionDot").className = `dot${health?.configured ? " ready" : ""}`;
  $("connectionLabel").textContent = health?.provider === "fal" && health?.configured ? "Cloud GPU ready · fal"
    : health?.configured ? "GPU processor configured" : "Connect GPU processor";
  updateControls();
}
async function checkHealth() {
  try { showHealth(await (await api("/api/health", { signal: AbortSignal.timeout(10000) })).json()); }
  catch { showHealth(null); }
}

async function setReference(file) {
  if (state.busy || !file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
    return notice("Choose a JPG, PNG, or WebP reference image under 8 MB.");
  }
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = imageUrl;
    await image.decode();
    if (Math.min(image.naturalWidth, image.naturalHeight) < 128 || image.naturalWidth * image.naturalHeight > 20000000)
      throw new Error("Choose a reference at least 128 pixels wide and tall, up to 20 megapixels.");
    state.reference = file;
    $("referencePreview").src = setUrl("reference", file);
    $("referencePreview").hidden = false;
    $("referencePlaceholder").hidden = true;
    $("changeReference").hidden = false;
    notice("");
  } catch (error) { notice(error.message || "This image could not be opened."); }
  finally { URL.revokeObjectURL(imageUrl); updateControls(); }
}

async function setVideo(file) {
  if (!file || state.busy) return;
  if (file.size > 32 * 1024 * 1024 || !file.type.startsWith("video/")) return notice("Choose a video under 32 MB.");
  const revision = ++state.videoRevision;
  state.checkingVideo = true; updateControls();
  const testUrl = URL.createObjectURL(file);
  try {
    const probe = document.createElement("video"); probe.preload = "metadata";
    const duration = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("This video could not be opened.")), 10000);
      probe.onloadedmetadata = () => { clearTimeout(timeout); resolve(probe.duration); };
      probe.onerror = () => { clearTimeout(timeout); reject(new Error("This video could not be opened.")); };
      probe.src = testUrl;
    });
    // Chromium's camera WebM has Infinity duration; ffprobe validates timestamps on the server.
    if (Number.isFinite(duration) && (duration < 0.5 || duration > 10.25)) throw new Error("Choose a clip between 0.5 and 10 seconds long.");
    if (revision !== state.videoRevision) return;
    stopCamera();
    state.video = file;
    $("compareButton").disabled = true;
    const video = $("sourceVideo");
    video.srcObject = null; video.src = setUrl("source", file); video.controls = true;
    video.hidden = false; $("sourceEmpty").hidden = true;
    $("sourceName").textContent = file.name;
    $("sourceBadge").textContent = "SOURCE";
    $("sourceInfo").textContent = Number.isFinite(duration) ? `${duration.toFixed(1)} second source clip` : "Recorded source clip";
    $("durationMetric").textContent = Number.isFinite(duration) ? `${duration.toFixed(1)} sec` : "–";
    notice("");
  } catch (error) { if (revision === state.videoRevision) notice(error.message); }
  finally {
    URL.revokeObjectURL(testUrl);
    if (revision === state.videoRevision) { state.checkingVideo = false; updateControls(); }
  }
}

function stopCamera() {
  if (state.recorder?.state === "recording") state.recorder.stop();
  clearTimeout(state.recordStopTimer); clearInterval(state.recordingTimer);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  $("sourceVideo").srcObject = null;
  $("recordButton").hidden = true; $("stopCameraButton").hidden = true;
  $("recordingOverlay").hidden = true;
  if (!state.video) { $("sourceVideo").hidden = true; $("sourceEmpty").hidden = false; }
  updateControls();
}
async function startCamera() {
  if (state.busy || state.recording) return;
  if (!navigator.mediaDevices?.getUserMedia) return notice("Camera access needs localhost or HTTPS. Open the app at http://127.0.0.1:8765.");
  $("cameraButton").disabled = true;
  try {
    stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }, audio: false });
    const video = $("sourceVideo"); video.removeAttribute("src"); video.srcObject = state.stream; video.controls = false;
    video.hidden = false; $("sourceEmpty").hidden = true; await video.play();
    state.video = null;
    $("compareButton").disabled = true;
    $("sourceBadge").textContent = "CAMERA"; $("sourceInfo").textContent = "Camera preview · record a short test";
    $("sourceName").textContent = "Camera ready. Record a 6-second movement clip.";
    $("recordButton").hidden = false; $("stopCameraButton").hidden = false; notice("");
  } catch (error) {
    stopCamera();
    notice(error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser, or upload a clip." :
      "Could not open the camera. Close other apps using it, or upload a clip.");
  } finally { updateControls(); }
}
function recordClip() {
  if (state.recording) { state.recorder?.stop(); return; }
  if (!state.stream || !window.MediaRecorder) return notice("Recording is unavailable in this browser. Upload a short clip instead.");
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
  const chunks = [];
  try {
    state.recorder = new MediaRecorder(state.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 2500000 });
    const recorder = state.recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(state.recordStopTimer); clearInterval(state.recordingTimer);
      state.recording = false; $("recordingOverlay").hidden = true;
      const type = recorder.mimeType || "video/webm";
      const file = new File(chunks, `camera-test.${type.includes("mp4") ? "mp4" : "webm"}`, { type });
      await setVideo(file); updateControls();
    };
    recorder.onerror = () => { notice("Recording failed. Try again or upload a clip."); stopCamera(); state.recording = false; updateControls(); };
    recorder.start(250); state.recording = true;
    $("recordingOverlay").hidden = false; $("recordingTime").textContent = "0:00";
    const start = performance.now();
    state.recordingTimer = setInterval(() => { $("recordingTime").textContent = `0:0${Math.min(6, Math.floor((performance.now() - start) / 1000))}`; }, 200);
    state.recordStopTimer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 6000);
    updateControls();
  } catch { notice("This browser could not start recording. Upload a clip instead."); }
}

function renderJob(job) {
  state.job = job;
  state.busy = !terminal.has(job.status);
  $("jobTitle").textContent = { queued: "Waiting to start", preparing: "Tracking your movement", transforming: "Creating your character",
    encoding: "Finishing your video", completed: "Transformation ready", failed: "Test needs attention", cancelled: "Test cancelled" }[job.status] || "Processing";
  $("jobMessage").textContent = job.message;
  $("jobIndicator").className = `dot ${job.status === "completed" ? "ready" : job.status === "failed" ? "failed" : state.busy ? "busy" : ""}`;
  const order = ["queued", "preparing", "transforming", "encoding"];
  const index = job.status === "completed" ? 4 : order.indexOf(job.status);
  document.querySelectorAll("[data-stage]").forEach((stage, i) => {
    stage.classList.toggle("current", i === index); stage.classList.toggle("done", i < index);
  });
  $("cancelButton").hidden = !state.busy;
  $("deleteButton").hidden = state.busy;
  $("resultOrb").classList.toggle("busy", state.busy);
  if (job.status !== "completed") {
    $("outputTitle").textContent = state.busy ? "Your transformation is taking shape" : "Ready for another test";
    $("outputDescription").textContent = job.message;
  }
  if (job.source) $("durationMetric").textContent = `${job.source.duration_seconds.toFixed(1)} sec`;
  if (job.metrics?.total_processing_seconds !== undefined) {
    $("processingMetric").textContent = `${job.metrics.total_processing_seconds.toFixed(1)} sec`;
    $("ratioMetric").textContent = `${job.metrics.processing_to_clip_ratio.toFixed(1)} ×`;
  }
  updateControls();
}
async function pollJob() {
  if (!state.job) return;
  try {
    const job = await (await api(`/api/jobs/${state.job.id}`, { signal: AbortSignal.timeout(15000) })).json();
    renderJob(job);
    if (job.status === "completed") {
      try {
        const result = await (await api(`/api/jobs/${job.id}/result`)).blob();
        const url = setUrl("result", result);
        $("resultVideo").src = url; $("resultVideo").hidden = false; $("resultEmpty").hidden = true;
        $("downloadButton").href = url; $("downloadButton").hidden = false;
        $("compareButton").disabled = !state.video;
        $("resultInfo").textContent = "AI-generated person replacement";
      } catch (error) { notice(`${error.message} The result is saved on the processor.`); }
    } else if (state.busy) state.pollTimer = setTimeout(pollJob, 2000);
    else if (job.status === "failed") notice(job.message);
  } catch (error) {
    notice(`${error.message} Checking again in a few seconds.`);
    state.pollTimer = setTimeout(pollJob, 5000);
  }
}
async function generate() {
  if ($("transformButton").disabled) return;
  notice(""); state.busy = true; state.submitting = true; updateControls();
  const form = new FormData(); form.append("reference", state.reference); form.append("video", state.video);
  form.append("quality", document.querySelector('[name="quality"]:checked').value);
  form.append("prompt", $("appearance").value.trim() || "A person moving naturally, realistic video, consistent appearance and lighting.");
  try {
    const job = await (await api("/api/jobs", { method: "POST", body: form })).json();
    clearTimeout(state.pollTimer);
    $("resultVideo").pause(); $("resultVideo").removeAttribute("src"); $("resultVideo").load();
    setUrl("result", null); $("resultVideo").hidden = true; $("resultEmpty").hidden = false;
    $("downloadButton").hidden = true; $("compareButton").disabled = true;
    $("processingMetric").textContent = "–"; $("ratioMetric").textContent = "–";
    renderJob(job); pollJob();
  } catch (error) { state.busy = false; notice(error.message); updateControls(); }
  finally { state.submitting = false; updateControls(); }
}

$("referenceInput").addEventListener("change", (event) => setReference(event.target.files[0]));
$("videoInput").addEventListener("change", (event) => setVideo(event.target.files[0]));
$("cameraButton").addEventListener("click", startCamera);
$("stopCameraButton").addEventListener("click", stopCamera);
$("recordButton").addEventListener("click", recordClip);
$("transformButton").addEventListener("click", generate);
for (const name of ["dragenter", "dragover"]) $("referenceDrop").addEventListener(name, (event) => { event.preventDefault(); $("referenceDrop").classList.add("dragging"); });
$("referenceDrop").addEventListener("dragleave", () => $("referenceDrop").classList.remove("dragging"));
$("referenceDrop").addEventListener("drop", (event) => { event.preventDefault(); $("referenceDrop").classList.remove("dragging"); setReference(event.dataTransfer.files[0]); });
$("connectButton").addEventListener("click", () => { $("serverUrl").value = state.base; $("serverToken").value = state.token; $("connectionError").hidden = true; $("connectionDialog").showModal(); });
$("closeDialog").addEventListener("click", () => $("connectionDialog").close());
$("connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault(); state.connecting = true; $("saveConnection").disabled = true; $("connectionError").hidden = true;
  try {
    let base = $("serverUrl").value.trim().replace(/\/$/, "");
    if (base) {
      const url = new URL(base);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("Enter only the server origin, such as https://your-worker.example.");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Use HTTPS for a remote worker, or connect through a localhost SSH tunnel.");
      if (location.protocol === "https:" && url.protocol === "http:") throw new Error("An HTTPS workspace needs an HTTPS processor.");
      base = url.origin;
    }
    const token = $("serverToken").value.trim();
    if (state.busy && base !== state.base) throw new Error("Keep the same processor while a test is running. You can update its access token.");
    const health = await (await api("/api/health", { signal: AbortSignal.timeout(10000) }, base, token)).json();
    state.base = base; state.token = token; window.vyraConnection = { base, token }; showHealth(health); $("connectionDialog").close();
    if (!health.configured) notice(health.message, true); else notice("Processor connected. Add your reference and a short clip to begin.", true);
  } catch (error) { $("connectionError").textContent = error.message; $("connectionError").hidden = false; }
  finally { state.connecting = false; $("saveConnection").disabled = false; updateControls(); }
});
$("cancelButton").addEventListener("click", async () => {
  if (!state.job) return;
  $("cancelButton").disabled = true;
  try { renderJob(await (await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" })).json()); }
  catch (error) { notice(error.message); }
  finally { $("cancelButton").disabled = false; }
});
$("deleteButton").addEventListener("click", async () => {
  if (!state.job || state.busy) return;
  try {
    await api(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    state.job = null; $("deleteButton").hidden = true;
    $("resultVideo").pause(); $("resultVideo").removeAttribute("src"); $("resultVideo").load(); setUrl("result", null);
    $("resultVideo").hidden = true; $("resultEmpty").hidden = false; $("downloadButton").hidden = true; $("compareButton").disabled = true;
    $("jobTitle").textContent = "Test files deleted"; $("jobMessage").textContent = "The test’s uploads and output were removed from the processor.";
    notice("Test files deleted from the processor.", true);
  } catch (error) { notice(error.message); }
});
$("compareButton").addEventListener("click", async () => {
  $("sourceVideo").currentTime = 0; $("resultVideo").currentTime = 0;
  const results = await Promise.allSettled([$("sourceVideo").play(), $("resultVideo").play()]);
  if (results.some((result) => result.status === "rejected")) notice("Use the play controls on each video if your browser blocks simultaneous playback.", true);
});
window.addEventListener("pagehide", () => { stopCamera(); clearTimeout(state.pollTimer); Object.values(state.urls).filter(Boolean).forEach(URL.revokeObjectURL); });
checkHealth();
