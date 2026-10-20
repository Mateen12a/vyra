"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_PRICE_PER_SECOND = 0.02; // Lucy 2.5 standard realtime, 720p, on both engines
  const HIDDEN_GRACE_MS = 60000; // OBS and calls need the tab open; this only stops forgotten sessions
  const TOKEN_FRESH_MS = 12000; // server tokens live 20 s; leave headroom for the dial
  const FIRST_FRAME_TIMEOUT_MS = 40000; // connected but no video back: stop instead of paying for nothing
  const ENGINE_NAMES = { decart: "Decart", fal: "Lucy via fal" };
  // Decart: specific, descriptive prompts produce much stronger edits than generic ones.
  const LOOKS = [
    { name: "Claymation", note: "Stop-motion plasticine",
      prompt: "Transform the entire scene into stop-motion claymation: the person becomes a handmade plasticine figure with visible fingerprints and soft clay texture, warm studio lighting, miniature clay set behind them." },
    { name: "Anime", note: "90s cel animation",
      prompt: "Restyle the entire scene as a hand-drawn 1990s anime frame: bold black ink outlines, flat cel shading, vivid saturated colors; the person becomes an anime character with large expressive eyes." },
    { name: "Comic", note: "Ink and halftone",
      prompt: "Restyle the entire frame as a comic book panel: heavy black ink outlines, halftone dot shading, flat primary colors; the person is drawn as a comic book hero." },
    { name: "Oil painting", note: "Classical portrait",
      prompt: "Restyle the entire frame as a classical oil painting: thick visible brush strokes, rich warm palette, canvas texture, dramatic Rembrandt lighting on the person's face." },
    { name: "Gold statue", note: "Living metal",
      prompt: "Turn the person into a living statue of polished 24-karat gold: reflective metallic skin, hair and clothing with sharp specular highlights; keep the background unchanged." },
    { name: "Astronaut", note: "Space suit",
      prompt: "Dress the person in a bulky white NASA-style space suit with mission patches on the shoulders and chest and a metal helmet ring around the neck; keep the face visible." },
    { name: "Tuxedo", note: "Black tie",
      prompt: "Change only the person's clothing to a tailored black tuxedo jacket with satin lapels, a crisp white dress shirt and a black bow tie; keep the face and hair unchanged." },
    { name: "Cyber armor", note: "Matte plates, cyan light",
      prompt: "Dress the person in sleek matte-black futuristic armor plates with thin glowing cyan light lines along the chest and shoulders; keep the face visible." },
  ];
  const swapPrompt = (description) =>
    "Substitute the character in the video with the person in the reference image" +
    (description ? `: ${description.replace(/\.+$/, "")}` : "") +
    ". Keep their exact face shape, skin tone and hairstyle, and follow the original movement and expressions.";

  // Defined before `live`, which reads saved thumbnails and looks while it is built.
  const storage = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage full or blocked */ } },
  };
  const live = {
    status: null, provider: null, stream: null, client: null, rt: null, connectAbort: null, phase: "idle", camAspect: 16 / 9,
    seconds: 0, tickAt: 0, tickSeconds: 0, meter: null, hiddenTimer: null, stallTimer: null, firstFrame: false,
    character: null, characterDescription: "", look: null, mirrored: true, prefetched: null,
    crop: { image: null, scale: 1, x: 0, y: 0, ready: false }, fps: 0, frameCount: 0, fpsAt: 0, latency: null,
    thumbs: loadThumbs(), preflightDone: false, recorder: null, recordChunks: [], recordAt: 0,
    myLooks: loadMyLooks(), creating: false, describing: 0, describeTicket: 0, autoDescribed: false,
    voice: storage.get("vyra.voice", "natural"), rig: null, voicePending: null, micError: null, monitor: false,
    syncOffset: Number(storage.get("vyra.voiceSync", "0")) || 0, lagMeter: null, lagTimer: null, lagCam: null,
    lagReadings: [], measuredLag: null, estimatedLag: null, levelFrame: 0, converting: 0,
    net: { level: 0 }, netTesting: false, warnedEnd: false,
    sourceValue: "", sourceKind: "camera", fileVideo: null, fileURL: null,
    rules: loadRules(), rulesOn: storage.get("vyra.rulesOn", "0") === "1", sceneRunner: null, sceneState: "off",
    overlay: { visible: false, title: storage.get("vyra.overlayTitle", ""), sub: storage.get("vyra.overlaySub", ""), logo: storage.get("vyra.overlayLogo", "") || null },
    overlayImg: null, commandMode: storage.get("vyra.commandMode", "off"), commandTimer: null, streamer: null,
    billing: { sessionId: null, beat: null }, // the server-side paid session while accounts are on
  };

  // ---------- shell ----------
  function route() {
    const view = location.hash === "#clips" ? "clips" : "live";
    document.body.dataset.view = view;
    $("liveView").hidden = view !== "live";
    $("clipsView").hidden = view !== "clips";
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === view) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
  }
  window.addEventListener("hashchange", route);
  route();

  let noticeTimer = null;
  function notice(message, info = false) {
    clearTimeout(noticeTimer);
    $("notice").textContent = message;
    $("notice").classList.toggle("info", info);
    $("notice").hidden = !message;
    if (message && info) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4000);
  }
  const authHeaders = () => {
    const c = window.vyraConnection;
    return c && !c.base && c.token ? { Authorization: `Bearer ${c.token}` } : {};
  };
  // ---------- credits ----------
  const account = () => window.VyraAccount;
  const billingOn = () => Boolean(account()?.on);
  const setBalance = (balance) => account()?.setBalance(balance);
  const HEARTBEAT_MS = 15000;
  function startHeartbeat() {
    clearInterval(live.billing.beat);
    live.billing.beat = setInterval(heartbeat, HEARTBEAT_MS);
  }
  async function heartbeat() {
    const id = live.billing.sessionId;
    if (!id) return;
    try {
      const status = await postJson(`/api/live/meter/${encodeURIComponent(id)}/heartbeat`, {});
      if (id !== live.billing.sessionId) return;
      setBalance(status.balance);
      if (status.stop) {
        live.billing.sessionId = null;
        stopLive("You're out of credits, so the session ended. Add credits to keep going.");
        account()?.openCredits();
      } else if (status.low_balance && !live.billing.warned) {
        live.billing.warned = true;
        notice("Less than a minute of credits left. Add credits to keep going.", true);
      }
    } catch { /* a missed beat is fine; the next one buys ahead again */ }
  }
  function endBilling() {
    clearInterval(live.billing.beat); live.billing.beat = null;
    const id = live.billing.sessionId; live.billing.sessionId = null; live.billing.warned = false;
    if (!id) return;
    postJson(`/api/live/meter/${encodeURIComponent(id)}/end`, {})
      .then((status) => setBalance(status.balance)).catch(() => {});
  }
  const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function loadThumbs() {
    try { return JSON.parse(storage.get("vyra.thumbs", null) || storage.get("alter.thumbs", null) || "{}"); } catch { return {}; }
  }
  function saveThumbs() { storage.set("vyra.thumbs", JSON.stringify(live.thumbs)); }
  function loadMyLooks() {
    try {
      const list = JSON.parse(storage.get("vyra.myLooks", "[]"));
      return Array.isArray(list) ? list.filter((l) => l && typeof l.name === "string" && typeof l.prompt === "string").slice(0, 8) : [];
    } catch { return []; }
  }
  function saveMyLooks() { storage.set("vyra.myLooks", JSON.stringify(live.myLooks)); }
  function loadRules() {
    try {
      const list = JSON.parse(storage.get("vyra.rules", "[]"));
      return Array.isArray(list) ? list.filter((r) => r && typeof r.trigger === "string" && typeof r.action === "string").slice(0, 20) : [];
    } catch { return []; }
  }
  const assistOn = () => Boolean(live.status?.assist);
  async function postJson(url, body) {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(60000),
      headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "The request failed. Try again.");
    return payload;
  }

  // ---------- engines ----------
  function engines() {
    const s = live.status;
    if (!s) return [];
    if (Array.isArray(s.providers)) return s.providers;
    return [{ id: s.provider || "decart", name: ENGINE_NAMES[s.provider] || "Decart", available: Boolean(s.available), price_per_second: DEFAULT_PRICE_PER_SECOND }];
  }
  const engine = () => engines().find((e) => e.id === live.provider) || null;
  const clientLoaded = (id) => (id === "fal" ? Boolean(window.FalLucy && window.MessagePack) : Boolean(window.DecartSDK));
  const pricePerSecond = () => engine()?.price_per_second ?? DEFAULT_PRICE_PER_SECOND;
  function liveReady() { const e = engine(); return Boolean(e?.available) && clientLoaded(e.id); }
  function pickEngine() {
    const list = engines();
    const saved = storage.get("vyra.engine", "");
    const usable = (id) => list.some((e) => e.id === id && e.available);
    live.provider = usable(saved) ? saved : usable(live.status?.provider) ? live.status.provider : list.find((e) => e.available)?.id || list[0]?.id || null;
    $("engineSelect").replaceChildren(...list.map((e) => {
      const option = new Option(ENGINE_NAMES[e.id] || e.name, e.id);
      option.disabled = !e.available;
      return option;
    }));
    if (live.provider) $("engineSelect").value = live.provider;
    $("engineSelect").hidden = list.length < 2 || billingOn();
    $("sessionEngine").hidden = list.length >= 2; // the picker shows the engine itself
    $("engineRow").hidden = billingOn(); // customers never see which provider runs their session
  }
  function selectEngine(id) {
    if (live.rt || id === live.provider) return;
    live.provider = id; storage.set("vyra.engine", id);
    live.prefetched = null; live.preflightDone = false;
    resetNetwork();
    showStatus(); prefetchKey(); preflight();
  }

  // ---------- status ----------
  async function loadStatus() {
    try {
      const response = await fetch("/api/live/status", { headers: authHeaders(), signal: AbortSignal.timeout(10000) });
      live.status = response.ok ? await response.json() : null;
    } catch { live.status = null; }
    pickEngine();
    if (live.status) $("sessionCap").textContent = `/ ${clock(live.status.max_session_seconds)}`;
    if (live.status) $("sessionHint").textContent = `Stops after ${Math.round(live.status.max_session_seconds / 60)} min, or 60 s after this tab is hidden.` +
      (labelOn() ? " Output is labelled as AI." : "") + " Use only with consent.";
    $("streamButton").hidden = !live.status.streaming_available || !window.VyraStream;
    $("streamSetupHint").hidden = !live.status.streaming_available;
    renderVoices();
    showStatus();
  }
  function showStatus() {
    const e = engine();
    const ready = liveReady();
    $("liveStatusDot").className = `dot ${ready ? "ready" : "failed"}`;
    $("liveStatusText").textContent = ready ? (engines().length > 1 && !billingOn() ? `Live ready · ${ENGINE_NAMES[e.id] || e.name}` : "Live ready") :
      e?.available && !clientLoaded(e.id) ? "Live client failed to load" :
      live.status?.message || "Live service unavailable";
    render();
  }

  // ---------- render ----------
  function setPhase(phase) { live.phase = phase; render(); }
  function render() {
    const { phase } = live;
    if ($("streamButton")) {
      $("streamButton").hidden = !live.status?.streaming_available || !window.VyraStream;
      $("streamSetupHint").hidden = !live.status?.streaming_available;
      $("streamButton").textContent = live.streamer?.state === "live" ? "Stop stream" : live.streamer?.state === "connecting" ? "Connecting…" : "Start stream";
      $("streamButton").disabled = live.streamer?.state === "connecting" || phase !== "live";
    }
    const ready = liveReady();
    const hasLook = Boolean(live.character || live.look);
    const active = ["connecting", "warming", "live"].includes(phase);
    $("stage").dataset.state = phase;
    $("stageEmpty").hidden = phase !== "idle";
    $("aiLabel").hidden = !labelOn();
    if (phase === "idle") live.idleArt?.start(); else live.idleArt?.stop();
    $("warmup").hidden = !["connecting", "warming"].includes(phase);
    $("liveBadge").hidden = phase !== "live";
    $("liveRecordBadge").hidden = !live.recorder;
    $("camVideo").classList.toggle("mirrored", live.mirrored);
    $("mirrorButton").setAttribute("aria-pressed", String(live.mirrored));
    $("goLiveButton").classList.toggle("stop", active);
    $("goLiveButton").setAttribute("aria-label", active ? "Stop" : "Go live");
    $("goLiveLabel").textContent = active ? (phase === "live" ? "You're live" : "Starting…") : !ready ? "Live is unavailable" : !hasLook ? "Pick a look to start"
      : billingOn() ? `${account().creditsPerMinute} credits a minute` : "Ready";
    $("goLiveButton").disabled = phase === "stopping" || (!active && (!ready || !hasLook));
    $("engineSelect").disabled = active || phase === "stopping";
    $("liveRecordButton").disabled = phase !== "live" || !window.MediaRecorder;
    $("liveRecordButton").setAttribute("aria-pressed", String(Boolean(live.recorder)));
    $("liveRecordButton").setAttribute("aria-label", live.recorder ? "Stop recording" : "Record the AI output");
    $("applyCharacterButton").disabled = !live.crop.ready || !$("consentCheck").checked || live.describing > 0;
    $("promptButton").disabled = !$("promptInput").value.trim();
    $("createForm").hidden = !assistOn();
    $("createForm").dataset.busy = String(live.creating);
    $("createButton").disabled = live.creating || $("createInput").value.trim().length < 2;
    $("createButton").textContent = live.creating ? "Creating" : "Create";
    $("describeStatus").hidden = live.describing === 0;
    $("sessionCharacter").textContent = live.character ? "Character" : live.look?.name || "None";
    const e = engine();
    $("sessionEngine").textContent = e ? ENGINE_NAMES[e.id] || e.name : "–";
    renderVoice();
    document.querySelectorAll(".look").forEach((button) => {
      button.setAttribute("aria-pressed", String(!live.character && live.look?.name === button.dataset.name));
    });
    renderTelemetry();
  }
  function renderTelemetry() {
    const video = $("aiVideo");
    const parts = [];
    if (live.phase === "live" && video.videoWidth) parts.push(`${video.videoWidth}×${video.videoHeight}`, `${live.fps.toFixed(0)} fps`);
    if (live.phase === "live" && live.latency != null) parts.push(`${Math.round(live.latency)} ms`);
    $("telemetry").textContent = parts.join("   ");
    $("hudSignal").hidden = live.phase !== "live" || !live.net.level;
    $("hudSignal").dataset.level = String(live.net.level || 0);
    $("netFps").textContent = live.phase === "live" && live.fps ? `${live.fps.toFixed(0)} fps` : "–";
    $("netDelay").textContent = live.phase === "live" && videoLag() != null ? `${Math.round(videoLag())} ms` : "–";
  }

  // ---------- looks ----------
  const enhance = () => $("enhanceCheck").checked;
  function renderLooks() {
    const mine = live.myLooks.map((look) => ({ ...look, mine: true }));
    const names = new Set(mine.map((l) => l.name));
    $("presetGrid").replaceChildren(...[...mine, ...LOOKS.filter((l) => !names.has(l.name))].map((look) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button"; button.className = look.mine ? "look mine" : "look"; button.dataset.name = look.name;
      const text = document.createElement("span");
      const title = document.createElement("strong"); title.textContent = look.name;
      const note = document.createElement("small"); note.textContent = look.note;
      text.append(title, note);
      // A real frame from the user's own session once one exists; until then, a pixel tile for the look.
      const thumb = document.createElement(live.thumbs[look.name] ? "img" : window.VyraPixel ? "canvas" : "span");
      thumb.className = "thumb";
      if (live.thumbs[look.name]) { thumb.src = live.thumbs[look.name]; thumb.alt = ""; }
      else if (thumb.tagName === "CANVAS") { thumb.width = 48; thumb.height = 27; window.VyraPixel.tile(thumb, look.name); }
      button.append(text, thumb);
      button.addEventListener("click", () => applyLook(look));
      item.append(button);
      return item;
    }));
    render();
  }
  // Thumbnails are real frames from the user's own sessions, never stock art.
  function captureThumb(name) {
    setTimeout(() => {
      const video = $("aiVideo");
      if (live.phase !== "live" || !video.videoWidth || live.look?.name !== name || live.character) return;
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      canvas.getContext("2d").drawImage(video, 0, 0, 160, 90);
      live.thumbs[name] = canvas.toDataURL("image/jpeg", 0.7);
      saveThumbs(); renderLooks();
    }, 3000);
  }
  async function applyLook(look) {
    live.look = look; live.character = null;
    if (live.rt) {
      try { await live.rt.set({ image: null, prompt: look.prompt, enhance: enhance() }); captureThumb(look.name); }
      catch (error) { notice(error.message || "Could not apply that look."); }
    }
    render();
  }
  // A few words in, a full Lucy prompt out; the look is saved and applied straight away.
  async function createLook(event) {
    event.preventDefault();
    const idea = $("createInput").value.trim();
    if (idea.length < 2 || live.creating) return;
    live.creating = true; render();
    try {
      const made = await postJson("/api/assist/look", { idea });
      const look = { name: made.name, note: made.note, prompt: made.prompt };
      live.myLooks = [look, ...live.myLooks.filter((l) => l.name !== look.name)].slice(0, 8);
      saveMyLooks();
      $("createInput").value = "";
      $("promptInput").value = look.prompt; // visible and editable under "Write the prompt yourself"
      renderLooks();
      await applyLook(look);
      notice(live.rt ? `${look.name} is on.` : `${look.name} is ready. Press Go live.`, true);
    } catch (error) {
      notice(error.message || "Could not create that look.");
    } finally {
      live.creating = false; render();
    }
  }
  async function reapply() {
    if (!live.rt) return;
    try { await live.rt.set(currentState()); notice(enhance() ? "Prompt enhancement on." : "Prompt enhancement off: exact wording.", true); }
    catch (error) { notice(error.message || "Could not update the look."); }
  }

  // ---------- camera ----------
  // A live source is a camera, a video file (played on a loop) or a shared screen; Lucy only ever gets video.
  const SOURCE_FILE = "__file", SOURCE_SCREEN = "__screen";
  async function listCameras() {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId); }
    catch { /* labels need permission; the default camera still works */ }
    const select = $("cameraSelect"), current = select.value;
    const cameras = devices.length ? devices.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)) : [new Option("Default camera", "")];
    const extras = [new Option(live.fileURL ? `Video: ${live.fileName}` : "Video file…", SOURCE_FILE)];
    if (navigator.mediaDevices?.getDisplayMedia) extras.push(new Option("Share screen", SOURCE_SCREEN));
    select.replaceChildren(...cameras, ...extras);
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }
  async function fileStream() {
    if (!live.fileURL) throw new Error("Choose a video file first.");
    const video = live.fileVideo ||= Object.assign(document.createElement("video"), { muted: true, loop: true, playsInline: true });
    if (video.src !== live.fileURL) video.src = live.fileURL;
    await video.play();
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
    const track = (video.captureStream?.() || video.mozCaptureStream?.())?.getVideoTracks()[0];
    if (!track) throw new Error("This browser cannot stream a video file. Try Chrome or Edge.");
    return new MediaStream([track]);
  }
  async function screenStream() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 30 }, width: { ideal: 1280 } } });
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (live.stream !== stream) return;
      $("cameraSelect").value = ""; useSource();
      notice("Screen sharing ended. Back to your camera.", true);
    });
    return stream;
  }
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs localhost or HTTPS.");
    const value = $("cameraSelect").value;
    const kind = value === SOURCE_FILE ? "file" : value === SOURCE_SCREEN ? "screen" : "camera";
    const stream = kind === "file" ? await fileStream() : kind === "screen" ? await screenStream()
      : await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...(value ? { deviceId: { exact: value } } : {}),
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    const old = live.stream;
    live.stream = stream; live.sourceValue = value;
    if (kind !== live.sourceKind) live.mirrored = kind === "camera"; // only a camera preview is mirrored
    live.sourceKind = kind;
    old?.getTracks().forEach((t) => t.stop());
    if (kind !== "file") live.fileVideo?.pause();
    if (live.lagCam) live.lagCam.srcObject = stream;
    const settings = stream.getVideoTracks()[0].getSettings();
    if (settings.width && settings.height) live.camAspect = settings.width / settings.height;
    $("camVideo").srcObject = stream;
    await $("camVideo").play().catch(() => {});
    await listCameras();
    if (live.phase === "idle") setPhase("camera");
    render(); renderOverlay(); // the banner waits for a source before it shows
    prefetchKey();
    preflight();
    startScenes();
    return stream;
  }
  async function startCamera() {
    if (live.voice !== "off") audioContext(); // still inside the click
    try { await openCamera(); notice(""); ensureVoice(); }
    catch (error) {
      notice(error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings." :
        error.message || "Could not open the camera. Close other apps that are using it.");
    }
  }
  async function switchCamera() {
    if ($("cameraSelect").value === SOURCE_FILE) return $("sourceFileInput").click(); // the file picker continues below
    return useSource();
  }
  async function useSource() {
    try {
      const stream = await openCamera();
      if (live.rt) await live.rt.replaceVideoTrack(stream.getVideoTracks()[0]);
      notice("");
    } catch (error) {
      $("cameraSelect").value = live.sourceValue;
      if (error.name !== "NotAllowedError" || $("cameraSelect").value !== SOURCE_SCREEN) notice(error.message || "Could not switch the video source.");
    }
  }
  function pickSourceFile(file) {
    if (!file) { $("cameraSelect").value = live.sourceValue; return; }
    if (!/^video\//.test(file.type)) { $("cameraSelect").value = live.sourceValue; return notice("Choose a video file (MP4, WebM or MOV)."); }
    if (live.fileURL) URL.revokeObjectURL(live.fileURL);
    live.fileURL = URL.createObjectURL(file); live.fileName = file.name.length > 28 ? `${file.name.slice(0, 25)}…` : file.name;
    listCameras().then(() => { $("cameraSelect").value = SOURCE_FILE; useSource(); });
  }
  function resumePreview() { if (live.stream) $("camVideo").play().catch(() => {}); }

  // ---------- session tokens ----------
  async function requestSession(provider) {
    // Reconnects within one go-live reuse the paid session instead of starting (and charging) a new one.
    const body = { provider, ...(live.billing.sessionId ? { session_id: live.billing.sessionId } : {}) };
    const response = await fetch("/api/live/token", { method: "POST", signal: AbortSignal.timeout(20000),
      headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 402) account()?.openCredits();
    if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Could not start a live session.");
    if (payload.meter) {
      if (!live.billing.sessionId && live.phase !== "connecting") { // stopped while the token was on its way
        live.billing.sessionId = payload.meter.session_id; endBilling();
        throw new Error("Live session cancelled.");
      }
      live.billing.sessionId = payload.meter.session_id;
      setBalance(payload.meter.balance);
      if (!live.billing.beat) startHeartbeat();
    }
    return payload;
  }
  async function mintSession(provider) {
    const cached = live.prefetched;
    if (cached?.provider === provider) {
      let session = cached.session;
      if (!session && cached.promise) {
        try { session = await cached.promise; } catch { /* request a fresh token below */ }
      }
      if (live.prefetched === cached) live.prefetched = null;
      if (session && performance.now() - cached.at < TOKEN_FRESH_MS) return session;
    } else if (cached) live.prefetched = null;
    return requestSession(provider);
  }
  function prefetchKey() {
    if (billingOn()) return; // with credits on, a token starts a paid session, so only mint on Go Live
    const provider = live.provider;
    if (live.rt || !engine()?.available || (live.prefetched?.provider === provider &&
        (live.prefetched.promise || performance.now() - live.prefetched.at < TOKEN_FRESH_MS))) return;
    const cached = { at: performance.now(), provider, session: null, promise: null };
    live.prefetched = cached;
    cached.promise = requestSession(provider).then((session) => {
      if (live.prefetched === cached) { cached.session = session; cached.at = performance.now(); }
      return session;
    }).catch((error) => {
      if (live.prefetched === cached) live.prefetched = null;
      throw error;
    });
    // Prefetch is opportunistic; an unused failure must not become an unhandled rejection.
    cached.promise.catch(() => {});
  }
  const waitForRetry = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const done = (retry) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); resolve(retry); };
    const cancel = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  const mintDecartKey = async () => (await mintSession("decart")).api_key;
  function decartClient() {
    live.client ||= window.DecartSDK.createDecartClient({ apiKeyProvider: mintDecartKey, integration: "vyra-web" });
    return live.client;
  }
  // Free network check before going live (Decart engine), so slow uploads are explained up front.
  async function preflight() {
    if (live.preflightDone || live.provider !== "decart" || !window.DecartSDK || !engine()?.available) return;
    live.preflightDone = true;
    try {
      const report = await decartClient().realtime.checkConnectivity({ signal: AbortSignal.timeout(15000) });
      if (live.rt || live.provider !== "decart") return;
      const rtt = report.metrics.rttMs;
      showNetwork({ quality: report.quality, rttMs: rtt });
      // Never overwrite a message the user still needs to read (e.g. a failed go-live).
      if ((report.quality === "poor" || report.quality === "critical") && live.phase === "camera" && $("notice").hidden)
        notice("Your connection looks slow for live video. Expect lag; a wired or faster connection helps.", true);
    } catch { live.preflightDone = false; }
  }

  // ---------- session ----------
  function currentState() {
    if (live.character) return { image: live.character, prompt: swapPrompt(live.characterDescription), enhance: enhance() };
    return { image: null, prompt: live.look.prompt, enhance: enhance() };
  }
  function initialState() {
    const state = currentState();
    return { ...(state.image ? { image: state.image } : {}), prompt: { text: state.prompt, enhance: state.enhance } };
  }
  function startMeter(fromTime) {
    clearInterval(live.meter);
    live.tickAt = fromTime; live.tickSeconds = 0; live.frameCount = 0; live.fpsAt = performance.now();
    live.meter = setInterval(() => {
      if (live.phase !== "live") return;
      // Decart sends billed ticks every ~5 s; fal sends none, so time runs from the connection.
      live.seconds = Math.max(live.seconds, live.tickSeconds + (performance.now() - live.tickAt) / 1000);
      $("sessionTime").textContent = clock(live.seconds);
      $("sessionSummaryTime").textContent = clock(live.seconds);
      $("recTime").textContent = clock(live.seconds);
      $("sessionCost").textContent = billingOn() ? `${Math.ceil(live.seconds * account().creditsPerMinute / 60)} credits`
        : `$${(live.seconds * pricePerSecond()).toFixed(2)}`;
      if (live.recorder) $("liveRecordTime").textContent = clock((performance.now() - live.recordAt) / 1000);
      const elapsed = (performance.now() - live.fpsAt) / 1000;
      if (elapsed >= 1) { live.fps = live.frameCount / elapsed; live.frameCount = 0; live.fpsAt = performance.now(); renderTelemetry(); }
      // Decart enforces this cap server-side; fal does not, so the browser enforces it for both.
      const cap = live.status?.max_session_seconds;
      if (cap && cap > 120 && !live.warnedEnd && live.seconds >= cap - 60) { live.warnedEnd = true; notice("One minute left in this session.", true); }
      if (cap && live.seconds >= cap) stopLive(`Session limit reached (${clock(cap)}). Go live again to continue.`);
    }, 250);
    const video = $("aiVideo");
    const count = () => { live.frameCount++; if (live.phase === "live") video.requestVideoFrameCallback(count); };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(count);
  }
  const warmup = (text) => { $("warmupText").textContent = text; };
  const showOutput = (stream) => { $("aiVideo").srcObject = stream; $("aiVideo").play().catch(() => {}); };

  async function connectDecart() {
    return decartClient().realtime.connect(live.stream, {
      model: window.DecartSDK.models.realtime(live.status.model),
      initialState: initialState(),
      onRemoteStream: showOutput,
    });
  }
  // fal can retain its single live slot for up to two minutes after a session ends.
  // Eight attempts at 20-second intervals cover that cleanup window without spinning or flooding it.
  const FAL_BUSY_RETRIES = 7;
  const falRetryMs = (retry) => {
    const override = Number(window.VYRA_FAL_RETRY_MS);
    if (Number.isFinite(override) && override >= 0) return override;
    return Math.min(20000, 5000 * 2 ** (retry - 1));
  };
  async function connectFal(signal) {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted || live.phase !== "connecting") return null;
      const session = await mintSession("fal");
      if (signal.aborted || live.phase !== "connecting") return null;
      try {
        return await window.FalLucy.connect(live.stream, { url: session.url, token: session.token,
          initialState: initialState(), onRemoteStream: showOutput, signal });
      } catch (error) {
        if (signal.aborted || live.phase !== "connecting") return null;
        if (error.code !== "busy" || attempt >= FAL_BUSY_RETRIES) throw error;
        const retry = attempt + 1;
        warmup(`Previous session still closing · retrying (${retry}/${FAL_BUSY_RETRIES})`);
        if (!await waitForRetry(falRetryMs(retry), signal)) return null; // stop interrupts the wait immediately
        if (live.phase !== "connecting") return null;
        warmup("Connecting");
      }
    }
  }

  async function goLive() {
    if (live.rt || live.phase === "connecting" || live.phase === "warming") return stopLive("Session ended.");
    if (!liveReady()) return notice("The live client did not load. Refresh the page.");
    if (billingOn() && account().balance < account().creditsPerMinute) {
      account().openCredits();
      return notice("Going live needs at least 1 minute of credits.");
    }
    if (live.voice !== "off") audioContext(); // still inside the click
    try { if (!live.stream) await openCamera(); }
    catch (error) { return notice(error.message || "Start your camera first."); }
    ensureVoice();
    notice(""); live.firstFrame = false; live.seconds = 0; live.latency = null; live.warnedEnd = false; resetNetwork();
    $("sessionTime").textContent = "00:00"; $("recTime").textContent = "00:00"; $("sessionCost").textContent = billingOn() ? "0 credits" : "$0.00";
    setPhase("connecting"); warmup("Connecting");
    const provider = live.provider;
    const controller = new AbortController();
    live.connectAbort = controller;
    try {
      const rt = provider === "fal" ? await connectFal(controller.signal) : await connectDecart();
      if (live.phase !== "connecting" || !rt) { rt?.disconnect(); return; } // stopped while connecting
      live.rt = rt; live.connectedAt = performance.now();
      setPhase("warming"); warmup("Warming up");
      clearTimeout(live.stallTimer);
      live.stallTimer = setTimeout(() => {
        if (live.rt === rt && live.phase === "warming") stopLive("No video came back from the live service. Go live again.");
      }, FIRST_FRAME_TIMEOUT_MS);
      rt.on("connectionChange", (state) => {
        if (state === "reconnecting") warmup("Reconnecting");
        if (state === "disconnected" && live.rt === rt) stopLive("Live session disconnected.");
      });
      rt.on("generationTick", ({ seconds }) => { live.tickSeconds = seconds; live.tickAt = performance.now(); });
      rt.on("sessionEnded", ({ reason, message }) => { if (live.rt === rt) stopLive({
        session_limit: `Session limit reached (${clock(live.status.max_session_seconds)}). Go live again to continue.`,
        insufficient_credits: "The live service is out of credits. Top up the provider account.",
        moderation_violation: "The session was stopped by content moderation.",
        policy_violation: "The session was stopped for a policy violation.",
      }[reason] || message || "The live service ended the session."); });
      // Decart reports transient errors while it reconnects on its own; fal only reports rejected looks.
      rt.on("error", (error) => { if (live.phase !== "live" || provider === "fal") notice(error?.message || "Live error."); });
      rt.on("connectionQuality", (report) => {
        live.latency = report.metrics.g2gMs ?? report.metrics.rttMs;
        if (!report.warmingUp) showNetwork({ quality: report.quality, limit: report.limitingFactor, ...report.metrics });
        // Until the motion match measures the real video delay, estimate it from the network.
        const { g2gMs, rttMs, jitterMs } = report.metrics;
        live.estimatedLag = g2gMs ?? (rttMs == null ? null : rttMs + (jitterMs ?? 0) + VOICE_PROCESSING_MS);
        applyVoiceDelay();
        renderTelemetry();
      });
    } catch (error) {
      if (!controller.signal.aborted && live.phase === "connecting")
        await stopLive(error.message || "Could not start a live session.");
    } finally {
      if (live.connectAbort === controller) live.connectAbort = null;
    }
  }
  // The engine can deliver blank warm-up frames; only switch to live once a frame has real content.
  const probe = document.createElement("canvas"); probe.width = 32; probe.height = 18;
  function frameHasContent(video) {
    if (!video.videoWidth) return false;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, 32, 18);
    const data = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum / (data.length / 4) / 3 > 12;
  }
  function onFirstFrame() {
    if (live.firstFrame || live.phase !== "warming") return;
    const video = $("aiVideo");
    if (!frameHasContent(video)) {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFirstFrame); else setTimeout(onFirstFrame, 100);
      return;
    }
    live.firstFrame = true;
    clearTimeout(live.stallTimer);
    setPhase("live");
    startMeter(live.provider === "fal" ? live.connectedAt : performance.now());
    startLagMeter();
    if (live.look && !live.character) captureThumb(live.look.name);
  }
  async function stopLive(message) {
    const rt = live.rt; live.rt = null;
    const connecting = live.connectAbort; live.connectAbort = null; connecting?.abort();
    endBilling();
    if (live.streamer) { const stream = live.streamer; live.streamer = null; stream.stopDrawing?.(); await stream.stop(); $("streamHint").hidden = true; }
    clearInterval(live.meter); clearTimeout(live.hiddenTimer); clearTimeout(live.stallTimer);
    stopLagMeter();
    stopRecording();
    if (live.phase !== "idle") setPhase("stopping");
    try { rt?.disconnect(); } catch { /* already closed */ }
    $("aiVideo").srcObject = null;
    setPhase(live.stream ? "camera" : "idle");
    resumePreview();
    if (typeof message === "string" && message) notice(message, true);
  }

  // ---------- recording ----------
  function recordType(withAudio) {
    const types = withAudio
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
    return types.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
  }
  // The disclosure mark is only added outside explicit development mode.
  const labelOn = () => Boolean(live.status?.ai_label) && !live.status?.vyra_dev_mode;
  const cssColour = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function overlayColours() {
    const ground = cssColour("--ground") || "#0B0B0C";
    const n = parseInt(ground.slice(1), 16);
    return { accent: cssColour("--accent") || "#FF6B2B", text: cssColour("--text") || "#F1EEE8",
      box: `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.88)` };
  }
  // The banner as drawn on the stage, redrawn into recordings (scaled to the video).
  function drawOverlay(ctx, w, h, colours) {
    const o = live.overlay;
    if (!o.visible || !(o.title || o.sub || o.logo)) return;
    const k = h / 720, titleSize = Math.round(28 * k), subSize = Math.round(14 * k), pad = Math.round(14 * k), bar = Math.max(3, Math.round(6 * k));
    const sub = o.sub.toUpperCase();
    ctx.font = `700 ${titleSize}px "Segoe UI", system-ui, sans-serif`; const titleWidth = o.title ? ctx.measureText(o.title).width : 0;
    ctx.font = `600 ${subSize}px ui-monospace, Consolas, monospace`; const subWidth = sub ? ctx.measureText(sub).width : 0;
    const img = live.overlayImg, logoH = o.logo && img?.complete && img.naturalHeight ? Math.round(46 * k) : 0;
    const logoW = logoH ? (img.naturalWidth / img.naturalHeight) * logoH : 0;
    const textH = (o.title ? titleSize * 1.2 : 0) + (sub ? subSize * 1.5 : 0);
    const boxH = Math.max(logoH + pad, textH + pad * 1.3), boxW = bar + pad + (logoW ? logoW + pad : 0) + Math.max(titleWidth, subWidth) + pad * 1.2;
    const x = Math.round(w * 0.04), y = Math.round(h * 0.91 - boxH);
    ctx.fillStyle = colours.box; ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = colours.accent; ctx.fillRect(x, y, bar, boxH);
    let cx = x + bar + pad;
    if (logoW) { ctx.drawImage(img, cx, y + (boxH - logoH) / 2, logoW, logoH); cx += logoW + pad; }
    let cy = y + (boxH - textH) / 2;
    ctx.textBaseline = "top";
    if (o.title) { ctx.fillStyle = colours.text; ctx.font = `700 ${titleSize}px "Segoe UI", system-ui, sans-serif`; ctx.fillText(o.title, cx, cy); cy += titleSize * 1.2; }
    if (sub) { ctx.fillStyle = colours.accent; ctx.font = `600 ${subSize}px ui-monospace, Consolas, monospace`; ctx.fillText(sub, cx, cy + subSize * 0.25); }
    ctx.textBaseline = "alphabetic";
  }
  function drawLabelTo(ctx, width, height) {
    const size = Math.max(12, Math.round(Math.min(width, height) * 0.028));
    ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
    const text = "VYRANI · AI", pad = Math.round(size * 0.5), x = Math.round(size * 0.9), y = height - Math.round(size * 0.9);
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)"; ctx.fillRect(x - pad, y - size - pad / 2, textWidth + pad * 2, size + pad * 1.5);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)"; ctx.fillText(text, x, y);
  }
  function labelledStream(video) {
    const label = labelOn(), colours = overlayColours();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    let running = true;
    const draw = () => {
      if (!running) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      drawOverlay(ctx, canvas.width, canvas.height, colours);
      if (label && !live.status?.vyra_dev_mode) drawLabelTo(ctx, canvas.width, canvas.height);
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw); else requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(30);
    return { stream, stop: () => { running = false; stream.getTracks().forEach((t) => t.stop()); } };
  }
  function startRecording() {
    const video = $("aiVideo");
    if (!video.srcObject || !video.videoWidth || live.phase !== "live" || live.recorder) return;
    const source = labelledStream(video);
    // The voice track is already delayed to line up with the AI video (see applyVoiceDelay).
    const audio = live.rig && live.voice !== "off" ? live.rig.track() : null;
    const stream = audio ? new MediaStream([...source.stream.getVideoTracks(), audio]) : source.stream;
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: recordType(Boolean(audio)), videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 }); }
    catch { source.stop(); return notice("Recording is not supported in this browser."); }
    live.recordChunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) live.recordChunks.push(event.data); };
    const ai = audio ? aiVoice() : null; // fixed at the start, so switching mid-recording cannot mix voices
    recorder.onstop = () => { source.stop(); saveRecording(recorder.mimeType, ai); };
    recorder.start(1000);
    live.recorder = recorder; live.recordAt = performance.now();
    $("liveRecordTime").textContent = "00:00";
    render();
  }
  function stopRecording() {
    const recorder = live.recorder;
    live.recorder = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (live.voice === "off" && live.rig) closeVoice(); // the mic stayed open (muted) only for that recording
    render();
  }
  async function saveRecording(type, ai) {
    let blob = new Blob(live.recordChunks, { type: type || "video/webm" });
    live.recordChunks = [];
    if (!blob.size) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let name = `vyrani-${stamp}`, message = "";
    if (ai) {
      live.converting++; render();
      notice(`Applying the ${aiLabel(ai)} voice…`, true);
      try { blob = await withAiVoice(blob, ai); name += `-${ai.id}`; type = "video/mp4"; }
      catch (error) { message = `${error.message || "The AI voice could not be applied."} Saved with your own voice instead.`; }
      finally { live.converting--; render(); }
    }
    // In explicit dev mode, omit only VYRANI's own provenance tag. Provider-added marks remain untouched.
    if (!live.status?.vyra_dev_mode && (type || "").includes("mp4") && blob.size < 500 * 1024 * 1024) {
      try { blob = await withProvenance(blob); } catch { /* best effort: the recording is kept as recorded */ }
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name}.${(type || "").includes("mp4") ? "mp4" : "webm"}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    notice(message || `Saved ${link.download} to your downloads.`, !message);
  }

  // ---------- AI accent voices (applied to recordings) ----------
  // The recording already carries the natural voice, lined up with the video. That track goes to the server
  // (ElevenLabs' voice changer through fal) and the new voice replaces it in the MP4. The video is copied,
  // never re-encoded.
  const loadMedia = () => window.Mediabunny ? Promise.resolve(window.Mediabunny) : new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src: "/assets/vendor/mediabunny.js" });
    script.onload = () => (window.Mediabunny ? resolve(window.Mediabunny) : reject(new Error("The audio tools did not load.")));
    script.onerror = () => reject(new Error("The audio tools did not load."));
    document.head.append(script);
  });
  async function withAiVoice(blob, ai) {
    const M = await loadMedia();
    const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
    const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!videoTrack || !audioTrack) throw new Error("This recording has no voice to change.");
    const duration = await input.computeDuration();
    const most = live.status?.voice_max_seconds;
    if (most && duration > most + 10) throw new Error(`Accent voices work on recordings up to ${Math.round(most / 60)} minutes.`);
    // Decode the recorded voice into one mono track that starts at 0, like the video.
    const rate = audioTrack.sampleRate, mono = new Float32Array(Math.max(1, Math.ceil(duration * rate)));
    for await (const { buffer, timestamp } of new M.AudioBufferSink(audioTrack).buffers()) {
      const at = Math.max(0, Math.round(timestamp * rate)), data = buffer.getChannelData(0);
      mono.set(data.subarray(0, Math.max(0, Math.min(data.length, mono.length - at))), at);
    }
    const form = new FormData();
    form.append("audio", new Blob([await encodeWav(mono, rate, 16000)], { type: "audio/wav" }), "voice.wav");
    form.append("voice", ai.id);
    const response = await fetch("/api/voice/convert", { method: "POST", headers: authHeaders(), body: form, signal: AbortSignal.timeout(240000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(typeof payload.detail === "string" ? payload.detail : "The AI voice could not be applied.");
    }
    const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await response.arrayBuffer());
    // Exactly as long as the recording: the service keeps timing, but never let the voice outrun the video.
    const voice = new AudioBuffer({ length: Math.max(1, Math.round(duration * decoded.sampleRate)), numberOfChannels: 1, sampleRate: decoded.sampleRate });
    voice.copyToChannel(decoded.getChannelData(0).subarray(0, voice.length), 0);
    // Copy the video packets as they are and encode the new voice next to them.
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
    const videoSource = new M.EncodedVideoPacketSource(videoTrack.codec);
    output.addVideoTrack(videoSource, { rotation: videoTrack.rotation });
    const codec = (await M.canEncodeAudio("aac")) ? "aac" : "opus";
    const audioSource = new M.AudioBufferSource({ codec, quality: M.QUALITY_HIGH });
    output.addAudioTrack(audioSource);
    await output.start();
    const config = await videoTrack.getDecoderConfig();
    let first = true;
    for await (const packet of new M.EncodedPacketSink(videoTrack).packets()) {
      await videoSource.add(packet, first ? { decoderConfig: config } : undefined);
      first = false;
    }
    await audioSource.add(voice);
    videoSource.close(); audioSource.close();
    await output.finalize();
    return new Blob([output.target.buffer], { type: "video/mp4" });
  }
  const PROVENANCE = "Made with VYRANI AI. This video was transformed by AI and may show synthetic or altered people, voices or scenes.";
  async function withProvenance(blob) {
    const M = await loadMedia();
    const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS });
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
    const conversion = await M.Conversion.init({ input, output, showWarnings: false,
      tags: { title: "VYRANI AI recording", comment: PROVENANCE, description: PROVENANCE, date: new Date() } });
    if (!conversion.isValid) throw new Error("This recording could not be tagged.");
    await conversion.execute();
    return new Blob([output.target.buffer], { type: "video/mp4" });
  }
  async function encodeWav(samples, fromRate, toRate) {
    const length = Math.max(1, Math.round((samples.length / fromRate) * toRate));
    const source = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: fromRate });
    source.copyToChannel(samples, 0);
    const ctx = new OfflineAudioContext(1, length, toRate);
    const node = new AudioBufferSourceNode(ctx, { buffer: source });
    node.connect(ctx.destination); node.start();
    const data = (await ctx.startRendering()).getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + data.length * 2));
    const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + data.length * 2, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, toRate, true); view.setUint32(28, toRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 32767, true);
    return view.buffer;
  }

  // ---------- network ----------
  // What users see about their connection: four signal bars, plain words, the numbers, and one tip.
  // Live sessions report real WebRTC stats every 2 s; "Test my connection" measures this server before going live.
  const NEEDED_UPLOAD_KBPS = 3000; // the camera stream is capped at 2.5 Mbit/s, plus headroom
  const LEVELS = ["Not measured", "Poor", "Fair", "Good", "Excellent"];
  const QUALITY_LEVEL = { excellent: 4, good: 3, fair: 2, poor: 1, critical: 1 };
  function networkLevel(m) {
    let level = QUALITY_LEVEL[m.quality] || 3;
    if (m.rttMs != null) level = Math.min(level, m.rttMs < 150 ? 4 : m.rttMs < 250 ? 3 : m.rttMs < 400 ? 2 : 1);
    if (m.lossPct != null) level = Math.min(level, m.lossPct < 1 ? 4 : m.lossPct < 3 ? 3 : m.lossPct < 8 ? 2 : 1);
    if (m.limit === "bandwidth") level = Math.min(level, 2);
    if (m.uploadKbps != null) level = Math.min(level, m.uploadKbps >= 8000 ? 4 : m.uploadKbps >= NEEDED_UPLOAD_KBPS ? 3 : m.uploadKbps >= 1500 ? 2 : 1);
    return level;
  }
  function networkTip(m) {
    if (m.limit === "bandwidth" || (m.uploadKbps != null && m.uploadKbps < NEEDED_UPLOAD_KBPS))
      return "Your upload speed is limiting the video. Use a cable or move closer to the router, and pause other uploads or video calls.";
    if (m.lossPct != null && m.lossPct >= 3) return "Your connection is dropping data. Wi-Fi interference is the usual cause; a cable or a closer router helps.";
    if (m.rttMs != null && m.rttMs >= 400) return "The AI server is far away or your network is congested. Expect a short delay between you and the AI video.";
    if (m.limit === "cpu") return "This computer is struggling to encode the camera. Close other apps or lower the camera resolution.";
    return "";
  }
  function showNetwork(m) {
    live.net = { ...live.net, ...m, level: networkLevel({ ...live.net, ...m }) };
    const n = live.net;
    $("netLabel").textContent = LEVELS[n.level];
    $("netSignal").dataset.level = String(n.level);
    // Upload: the real send rate while live, the measured capacity from the test otherwise.
    $("netUpload").textContent = n.sendKbps != null && live.phase === "live" ? `${(n.sendKbps / 1000).toFixed(1)} Mbit/s`
      : n.uploadKbps != null ? `${(n.uploadKbps / 1000).toFixed(1)} Mbit/s` : "–";
    $("netLatency").textContent = n.rttMs != null ? `${Math.round(n.rttMs)} ms` : "–";
    $("netLoss").textContent = n.lossPct != null ? `${n.lossPct.toFixed(1)} %` : "–";
    const tip = networkTip(n);
    $("netTip").textContent = tip; $("netTip").hidden = !tip;
    renderTelemetry();
  }
  function resetNetwork() {
    live.net = { level: 0 };
    $("netLabel").textContent = LEVELS[0]; $("netSignal").dataset.level = "0";
    for (const id of ["netUpload", "netLatency", "netLoss", "netFps", "netDelay"]) $(id).textContent = "–";
    $("netTip").hidden = true;
  }
  async function testNetwork() {
    if (live.netTesting) return;
    live.netTesting = true; $("netTestButton").disabled = true; $("netTestButton").textContent = "Testing…";
    try {
      const pings = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await fetch(`/api/net/probe?t=${Date.now()}`, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) });
        pings.push(performance.now() - t);
      }
      const body = new Uint8Array(2 * 1024 * 1024);
      for (let i = 0; i < body.length; i += 65536) crypto.getRandomValues(body.subarray(i, i + 65536)); // incompressible
      let best = 0;
      for (let i = 0; i < 2; i++) {
        const t = performance.now();
        const response = await fetch("/api/net/probe", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
          body, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error("The network test is not available on this server.");
        best = Math.max(best, (body.length * 8) / (performance.now() - t)); // kbit/s
      }
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
      showNetwork({ rttMs: Math.min(...pings), uploadKbps: best, lossPct: null, quality: null });
      if (local) notice("This test reached VYRANI running on this computer, so it can't measure your internet. Go live to see your real connection, or test again once VYRANI is online.", true);
    } catch (error) {
      notice(error.name === "TimeoutError" ? "The network test timed out. Your connection may be too slow for live video." : error.message || "The network test failed.");
    } finally {
      live.netTesting = false; $("netTestButton").disabled = false; $("netTestButton").textContent = "Test my connection";
    }
  }

  // ---------- colour ----------
  const PALETTE_COLOURS = { signal: "#FF6B2B", lime: "#C8F031", ice: "#4FB8FF", gold: "#F2C14E" };
  function renderPalettes() {
    const current = document.documentElement.dataset.palette || "signal";
    $("paletteSwatches").replaceChildren(...Object.entries(PALETTE_COLOURS).map(([id, colour]) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.dataset.palette = id; b.title = id[0].toUpperCase() + id.slice(1);
      b.setAttribute("aria-label", `${b.title} colour theme`); b.setAttribute("aria-pressed", String(id === current));
      b.style.setProperty("--swatch", colour);
      b.addEventListener("click", () => setPalette(id));
      return b;
    }));
  }
  function setPalette(id) {
    document.documentElement.dataset.palette = id; storage.set("vyra.palette", id);
    renderPalettes(); renderLooks(); live.idleArt?.redraw();
  }

  // ---------- voice ----------
  // Effects run on this device (voice.js). The mic is never sent to the engine; it is only mixed into
  // recordings, delayed by however far the AI video trails the camera so lips and voice line up.
  const VOICE_PROCESSING_MS = 150; // rough engine time on top of the network, used until a measurement lands
  const LAG_CONFIDENCE = 0.5;
  const voices = () => window.VyraVoice?.VOICES || [];
  const aiVoices = () => (Array.isArray(live.status?.voices) ? live.status.voices : []);
  const aiVoice = () => (live.voice.startsWith("ai:") ? aiVoices().find((v) => `ai:${v.id}` === live.voice) || null : null);
  const aiLabel = (v) => `${v.accent} ${v.gender}`;
  const effectId = () => (live.voice.startsWith("ai:") ? "natural" : live.voice); // AI voices start from the natural voice
  const voiceName = () => { const ai = aiVoice(); return ai ? aiLabel(ai) : voices().find((v) => v.id === live.voice)?.name || "Off"; };
  function voiceButton(id, title, note) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "voice"; button.dataset.voice = id;
    const name = document.createElement("strong"); name.textContent = title;
    button.append(name);
    if (note) { const small = document.createElement("small"); small.textContent = note; button.append(small); }
    button.addEventListener("click", () => setVoice(id));
    return button;
  }
  function renderVoices() {
    $("voiceGrid").replaceChildren(...voices().map((v) => {
      const item = document.createElement("li");
      item.append(voiceButton(v.id, v.name, v.note));
      return item;
    }));
    // Accent voices: one row per accent, with male and female columns.
    const accents = [...new Set(aiVoices().map((v) => v.accent))];
    $("accentGroup").hidden = !accents.length;
    $("accentPrice").textContent = live.status?.voice_price_per_minute ? `$${live.status.voice_price_per_minute.toFixed(2)} / MIN` : "";
    $("accentGrid").replaceChildren(...accents.map((accent) => {
      const row = document.createElement("div"); row.className = "accent-row"; row.setAttribute("role", "row");
      const label = document.createElement("span"); label.className = "accent-name"; label.textContent = accent; label.setAttribute("role", "rowheader");
      row.append(label);
      for (const gender of ["male", "female"]) {
        const v = aiVoices().find((x) => x.accent === accent && x.gender === gender);
        const cell = v ? voiceButton(`ai:${v.id}`, gender === "male" ? "Male" : "Female")
          : Object.assign(document.createElement("span"), { className: "voice none", textContent: "–" });
        cell.setAttribute("role", "cell");
        row.append(cell);
      }
      return row;
    }));
    if (live.voice.startsWith("ai:") && live.status && !aiVoice()) live.voice = "natural"; // not offered on this server
    renderVoice();
  }
  function videoLag() { return live.phase === "live" ? live.measuredLag ?? live.estimatedLag : null; }
  function renderVoice() {
    if (!$("voiceGrid")) return;
    document.querySelectorAll(".voice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.voice === live.voice)));
    const lag = videoLag();
    $("voiceState").textContent = live.converting ? "Applying voice" : !window.VyraVoice ? "Unavailable" : live.voice === "off" ? "Mic off" :
      live.micError === "blocked" ? "Mic blocked" : live.micError ? "Mic error" : !live.rig ? (live.voicePending ? "Opening mic" : "Mic off") :
      lag != null ? `Sync ${Math.round(Math.max(0, lag + live.syncOffset))} ms` : `Mic on · ${voiceName()}`;
    $("accentHint").hidden = !aiVoice();
    $("sessionVoice").textContent = live.voice === "off" ? "Off" : live.rig ? voiceName() : live.micError ? "Mic blocked" : voiceName();
    $("syncValue").textContent = live.syncOffset ? `Auto ${live.syncOffset > 0 ? "+" : "−"}${Math.abs(live.syncOffset)}` : "Auto";
    $("monitorCheck").disabled = live.voice === "off";
  }
  function setVoice(id) {
    if (id !== "off") audioContext();
    live.voice = id; storage.set("vyra.voice", id);
    if (id === "off" && live.rig && live.recorder) live.rig.setMuted(true); // keep the recording's audio track alive
    else live.rig?.setMuted(false);
    ensureVoice();
    renderVoice();
  }
  // One audio context for the page, created and resumed inside a click so it never starts paused.
  function audioContext() {
    try { live.audioCtx ||= new AudioContext({ latencyHint: "interactive" }); } catch { return null; }
    if (live.audioCtx.state === "suspended") live.audioCtx.resume().catch(() => {});
    return live.audioCtx;
  }
  async function ensureVoice() {
    if (!window.VyraVoice) return;
    if (live.voice === "off") { if (!live.recorder) closeVoice(); return; }
    if (live.rig) { live.rig.setEffect(effectId()); live.rig.setMonitor(live.monitor); return live.rig.resume(); }
    if (live.voicePending) return live.voicePending;
    if (!navigator.mediaDevices?.getUserMedia) { live.micError = "failed"; return renderVoice(); }
    live.voicePending = (async () => {
      renderVoice();
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ video: false,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const rig = await window.VyraVoice.create(mic, audioContext());
        if (live.voice === "off") { rig.close(); return; }
        live.rig = rig; live.micError = null;
        rig.setEffect(effectId()); rig.setMonitor(live.monitor); applyVoiceDelay();
        meterLoop();
      } catch (error) {
        live.micError = error.name === "NotAllowedError" ? "blocked" : "failed";
        notice(live.micError === "blocked" ? "Microphone permission was denied. Allow it in your browser to record your voice." :
          "Could not open the microphone. Recordings will be silent.");
      } finally { live.voicePending = null; renderVoice(); }
    })();
    return live.voicePending;
  }
  function closeVoice() {
    live.rig?.close(); live.rig = null;
    cancelAnimationFrame(live.levelFrame);
    $("voiceLevel").style.setProperty("--level", "0");
    renderVoice();
  }
  function meterLoop() {
    cancelAnimationFrame(live.levelFrame);
    const tick = () => {
      if (!live.rig) return;
      $("voiceLevel").style.setProperty("--level", (Math.round(live.rig.level() * 24) / 24).toFixed(3));
      live.levelFrame = requestAnimationFrame(tick);
    };
    tick();
  }
  function applyVoiceDelay() {
    const lag = videoLag();
    live.rig?.setDelay(lag == null ? 0 : Math.max(0, lag + live.syncOffset));
    renderVoice();
  }
  // Measure the real delay by matching movement in the camera against movement in the AI video.
  function startLagMeter() {
    if (!window.VyraVoice) return;
    stopLagMeter();
    live.lagCam ||= Object.assign(document.createElement("video"), { muted: true, playsInline: true });
    live.lagCam.srcObject = live.stream; live.lagCam.play().catch(() => {});
    live.lagMeter = new window.VyraVoice.LagMeter(live.lagCam, $("aiVideo")).start();
    live.lagTimer = setInterval(() => {
      const reading = live.lagMeter?.estimate();
      if (!reading || reading.confidence < LAG_CONFIDENCE) return;
      live.lagReadings = [...live.lagReadings, reading.ms].slice(-5);
      const sorted = [...live.lagReadings].sort((a, b) => a - b);
      live.measuredLag = sorted[Math.floor(sorted.length / 2)];
      applyVoiceDelay();
    }, 2000);
  }
  function stopLagMeter() {
    live.lagMeter?.stop(); live.lagMeter = null; clearInterval(live.lagTimer);
    live.lagReadings = []; live.measuredLag = null; live.estimatedLag = null;
    if (live.lagCam) live.lagCam.srcObject = null;
    applyVoiceDelay();
  }
  window.vyraVoiceDebug = () => ({ voice: live.voice, open: Boolean(live.rig), delayMs: live.rig?.delayMs ?? null,
    measuredLag: live.measuredLag, estimatedLag: live.estimatedLag, offset: live.syncOffset });

  // ---------- overlay ----------
  function setOverlay(on) {
    if (on && !(live.overlay.title || live.overlay.sub || live.overlay.logo)) { notice("Add a banner title in Scenes first.", true); on = false; }
    live.overlay.visible = on; renderOverlay();
  }
  function renderOverlay() {
    const o = live.overlay;
    $("overlay").hidden = !(o.visible && (o.title || o.sub || o.logo) && live.stream);
    $("overlayTitleText").textContent = o.title; $("overlaySubText").textContent = o.sub;
    $("overlayLogoImage").hidden = !o.logo;
    if (o.logo && $("overlayLogoImage").src !== o.logo) $("overlayLogoImage").src = o.logo;
    if (o.logo && live.overlayImg?.src !== o.logo) live.overlayImg = Object.assign(new Image(), { src: o.logo });
    $("overlayToggle").textContent = o.visible ? "Hide" : "Show";
    $("overlayToggle").setAttribute("aria-pressed", String(o.visible));
    $("overlayLogoClear").hidden = !o.logo;
  }
  function pickOverlayLogo(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) || file.size > 1024 * 1024) return notice("Use a PNG, JPG, WebP or SVG logo under 1 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      live.overlay.logo = reader.result;
      if (reader.result.length < 400000) storage.set("vyra.overlayLogo", reader.result); // remembered when small
      renderOverlay();
    };
    reader.readAsDataURL(file);
  }

  // ---------- scene rules ----------
  // "When <trigger> do <action>", watched on this device (scenes.js). With "undo", the action reverses when
  // the trigger stops, e.g. a product banner that shows only while the product is in view.
  const triggers = () => window.VyraScenes?.TRIGGERS || [];
  const allLooks = () => [...live.myLooks, ...LOOKS.filter((l) => !live.myLooks.some((m) => m.name === l.name))];
  function actionOptions() {
    return [
      ...allLooks().map((l) => [`look:${l.name}`, `Switch to ${l.name}`]),
      ...voices().filter((v) => v.id !== "off").map((v) => [`voice:${v.id}`, `${v.name} voice`]),
      ["overlay:show", "Show the banner"], ["overlay:hide", "Hide the banner"], ["record:start", "Start recording"],
    ];
  }
  const actionLabel = (action) => actionOptions().find(([id]) => id === action)?.[1] || action;
  const triggerLabel = (id) => triggers().find((t) => t.id === id)?.name || id;
  function saveRules() { storage.set("vyra.rules", JSON.stringify(live.rules.map(({ undoState, ...rule }) => rule))); }
  function renderScenes() {
    const trigger = $("ruleTrigger").value, action = $("ruleAction").value;
    $("ruleTrigger").replaceChildren(...triggers().map((t) => new Option(t.name, t.id)));
    $("ruleAction").replaceChildren(...actionOptions().map(([id, name]) => new Option(name, id)));
    if (trigger) $("ruleTrigger").value = trigger;
    if (action && actionOptions().some(([id]) => id === action)) $("ruleAction").value = action;
    $("rulesEnabled").checked = live.rulesOn;
    $("rulesState").textContent = { off: "OFF", loading: "LOADING", watching: "WATCHING", idle: "WAITING FOR VIDEO", error: "ERROR" }[live.sceneState] || "OFF";
    const active = live.sceneRunner?.active || new Map();
    $("ruleList").replaceChildren(...live.rules.map((rule) => {
      const item = document.createElement("li");
      item.className = "rule"; item.dataset.active = String(Boolean(active.get(rule.trigger)) && rule.enabled);
      const toggle = Object.assign(document.createElement("input"), { type: "checkbox", checked: rule.enabled });
      toggle.setAttribute("aria-label", "Rule on");
      toggle.addEventListener("change", () => { rule.enabled = toggle.checked; saveRules(); live.sceneRunner?.setRules(live.rules); renderScenes(); });
      const text = document.createElement("p");
      const when = document.createElement("strong"); when.textContent = triggerLabel(rule.trigger);
      text.append(when, ` → ${actionLabel(rule.action)}${rule.undo ? " · undo after" : ""}`);
      text.title = text.textContent;
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: "Remove" });
      remove.addEventListener("click", () => { live.rules = live.rules.filter((r) => r !== rule); saveRules(); live.sceneRunner?.setRules(live.rules); renderScenes(); });
      const box = document.createElement("label"); box.className = "check"; box.append(toggle);
      item.append(box, text, remove);
      return item;
    }));
  }
  function addRule(event) {
    event.preventDefault();
    if (live.rules.length >= 20) return notice("Up to 20 rules. Remove one first.");
    live.rules.push({ id: `r${Date.now().toString(36)}`, trigger: $("ruleTrigger").value, action: $("ruleAction").value, undo: $("ruleUndo").checked, enabled: true });
    saveRules(); live.sceneRunner?.setRules(live.rules);
    if (!live.rulesOn) setRulesOn(true); else renderScenes();
  }
  function setRulesOn(on) {
    live.rulesOn = on; storage.set("vyra.rulesOn", on ? "1" : "0");
    if (on) startScenes(); else { live.sceneRunner?.stop(); live.sceneState = "off"; }
    renderScenes();
  }
  async function startScenes() {
    if (!live.rulesOn || !window.VyraScenes) return;
    if (!live.stream) { live.sceneState = "idle"; return renderScenes(); }
    live.sceneRunner ||= new window.VyraScenes.SceneRunner($("camVideo"), (rule, on) => fireRule(rule, on));
    live.sceneRunner.setRules(live.rules);
    if (live.sceneRunner.timer) return;
    live.sceneState = "loading"; renderScenes();
    try {
      await live.sceneRunner.start();
      live.sceneState = live.rulesOn ? "watching" : "off";
      if (!live.rulesOn) live.sceneRunner.stop();
    } catch {
      live.sceneState = "error";
      notice("The scene detector could not start in this browser. Voice commands and the banner still work.");
    }
    renderScenes();
  }
  function findLook(name, exact) {
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const want = norm(name), list = allLooks();
    return list.find((l) => norm(l.name) === want) || (exact ? null :
      list.find((l) => norm(l.name).startsWith(want) || want.startsWith(norm(l.name))) ||
      list.find((l) => norm(l.name).includes(want) || want.includes(norm(l.name))) || null);
  }
  async function fireRule(rule, on) {
    const [kind, ...rest] = rule.action.split(":"), value = rest.join(":");
    try {
      if (on) {
        rule.undoState = { look: live.look, character: live.character, voice: live.voice, overlay: live.overlay.visible };
        if (kind === "look") { const look = findLook(value, true); if (look) await applyLook(look); }
        else if (kind === "voice") setVoice(value);
        else if (kind === "overlay") setOverlay(value === "show");
        else if (kind === "record" && live.phase === "live" && !live.recorder) startRecording();
        toast(`${triggerLabel(rule.trigger)} → ${actionLabel(rule.action)}`);
      } else if (rule.undoState) {
        const before = rule.undoState; rule.undoState = null;
        if (kind === "look") {
          if (before.character) { live.character = before.character; live.look = before.look; if (live.rt) await live.rt.set(currentState()); render(); }
          else if (before.look) await applyLook(before.look);
        } else if (kind === "voice") setVoice(before.voice);
        else if (kind === "overlay") setOverlay(before.overlay);
        else if (kind === "record" && live.recorder) stopRecording();
      }
    } catch (error) { notice(error.message || "A scene rule could not run."); }
    renderScenes();
  }
  function toast(text) {
    clearTimeout(live.toastTimer);
    $("commandToast").textContent = text; $("commandToast").hidden = false;
    live.toastTimer = setTimeout(() => { $("commandToast").hidden = true; }, 2600);
  }

  // ---------- voice commands ----------
  // Simple commands run instantly here; anything else becomes an edit of the current look through the
  // prompt assistant ("make it snow" keeps the current look and adds snow).
  function showCommand(said, result) {
    $("commandLast").textContent = `“${said}” → ${result}`; $("commandLast").hidden = false;
    toast(`“${said}” → ${result}`);
  }
  async function runCommand(raw) {
    const said = raw.trim(), t = said.toLowerCase().replace(/[.!?]+$/, "").trim();
    if (!t) return;
    try {
      if (/^(start|begin) (the |a )?recording$/.test(t)) {
        if (live.phase !== "live") return showCommand(said, "go live first to record");
        startRecording(); return showCommand(said, "recording");
      }
      if (/^(stop|end) (the )?recording$/.test(t)) { stopRecording(); return showCommand(said, "recording saved"); }
      if (/^(go live|start (the )?(live|stream|streaming|session))$/.test(t)) { if (!live.rt) goLive(); return showCommand(said, "going live"); }
      if (/^(stop|end) (the )?(live|stream|streaming|session)$/.test(t)) { if (live.rt || live.phase === "connecting") stopLive("Session ended."); return showCommand(said, "stopped"); }
      if (/^(show|display|turn on) (the )?(overlay|banner|title|lower third)$/.test(t)) { setOverlay(true); return showCommand(said, live.overlay.visible ? "banner shown" : "no banner yet"); }
      if (/^(hide|remove|turn off) (the )?(overlay|banner|title|lower third)$/.test(t)) { setOverlay(false); return showCommand(said, "banner hidden"); }
      if (/^(mute|silence)( my voice| the voice)?$/.test(t)) { setVoice("off"); return showCommand(said, "voice off"); }
      const voiceName = (/^(?:switch to |use |change to |give me |make (?:it |me |my voice )?)?(?:a |an |my )?([a-z]+) voice$/.exec(t) || /^voice ([a-z]+)$/.exec(t))?.[1];
      const voice = voiceName && voices().find((v) => v.id === voiceName || v.name.toLowerCase() === voiceName ||
        ({ man: "male", men: "male", woman: "female", women: "female", normal: "natural", real: "natural" })[voiceName] === v.id);
      if (voice) { setVoice(voice.id); return showCommand(said, `${voice.name} voice`); }
      const lookName = (/^(?:switch|change|go|turn|swap) (?:it )?(?:to|into) (?:my |the |a |an )?(.+?)(?: preset| look| style| mode)?$/.exec(t) ||
        /^(?:apply|use|load|put on) (?:my |the |a |an )?(.+?)(?: preset| look| style| mode)?$/.exec(t))?.[1];
      const look = lookName && findLook(lookName);
      if (look) { await applyLook(look); return showCommand(said, `${look.name} on`); }
      if (live.character) {
        live.characterDescription = [live.characterDescription, said].filter(Boolean).join("; ");
        if (live.rt) await live.rt.set(currentState());
        return showCommand(said, "added to the character");
      }
      if (!assistOn()) { await applyLook({ name: "Voice edit", note: said, prompt: said }); return showCommand(said, "applied as said"); }
      showCommand(said, "working…");
      const base = live.look?.prompt || null;
      const made = await postJson("/api/assist/look", { idea: said, ...(base ? { base } : {}) });
      const edited = { name: made.name, note: made.note, prompt: made.prompt };
      live.myLooks = [edited, ...live.myLooks.filter((l) => l.name !== edited.name)].slice(0, 8);
      saveMyLooks(); renderLooks();
      await applyLook(edited);
      showCommand(said, `${edited.name} on`);
    } catch (error) {
      showCommand(said, error.message || "could not do that");
    }
  }
  function renderCommandState(state) {
    $("commandState").textContent = { unsupported: "Not in this browser", blocked: "Mic blocked", off: "Off", ready: "Hold V", listening: "Listening", starting: "Starting" }[state] || "Off";
    document.querySelectorAll("[data-command-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.commandMode === (live.commands?.mode || "off"))));
    $("commandButton").hidden = live.commands?.mode !== "hold";
    $("commandButton").dataset.listening = String(state === "listening");
    if (state === "blocked") notice("Microphone permission is needed for voice commands.");
  }
  function setCommandMode(mode) {
    if (!live.commands?.supported) { renderCommandState("unsupported"); return notice("Voice commands need Chrome, Edge or Safari."); }
    live.commandMode = mode; storage.set("vyra.commandMode", mode);
    live.commands.setMode(mode);
  }
  // Hold-to-talk keeps the command out of recordings: the recorded voice is muted for the held time,
  // shifted by the same delay that lines the voice up with the video.
  function commandPress() {
    if (live.commands?.mode !== "hold" || live.commands.holding) return;
    live.commands.press();
    clearTimeout(live.commandTimer);
    const lag = live.rig?.delayMs || 0;
    live.commandTimer = setTimeout(() => { if (live.voice !== "off") live.rig?.setMuted(true); }, lag);
  }
  function commandRelease() {
    if (!live.commands?.holding) return;
    live.commands.release();
    const lag = live.rig?.delayMs || 0;
    setTimeout(() => { if (live.voice !== "off" && !live.commands.holding) live.rig?.setMuted(false); }, lag + 600);
  }
  const typing = (el) => el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  window.vyraScenesDebug = () => ({ rules: live.rules.map(({ undoState, ...r }) => r), state: live.sceneState,
    active: Object.fromEntries(live.sceneRunner?.active || []), overlay: { ...live.overlay, logo: Boolean(live.overlay.logo) }, look: live.look?.name || null });

  // ---------- character framing ----------
  // The reference is framed to the camera's aspect ratio (Decart: match reference framing to the source).
  function drawCrop() {
    const canvas = $("cropCanvas"); const ctx = canvas.getContext("2d"); const { image, scale, x, y } = live.crop;
    canvas.height = Math.round(canvas.width / live.camAspect);
    $("cropBox").style.aspectRatio = String(live.camAspect);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!image) return;
    const base = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const w = image.naturalWidth * base * scale, h = image.naturalHeight * base * scale;
    ctx.drawImage(image, (canvas.width - w) / 2 + x, (canvas.height - h) / 2 + y, w, h);
    // Framing guide: where a webcam usually puts your head and shoulders.
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    const cx = canvas.width / 2, top = canvas.height * 0.14, headH = canvas.height * 0.42;
    ctx.beginPath(); ctx.ellipse(cx, top + headH / 2, headH * 0.36, headH / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - canvas.width * 0.3, canvas.height); ctx.quadraticCurveTo(cx - canvas.width * 0.24, top + headH * 1.05, cx, top + headH * 1.02);
    ctx.quadraticCurveTo(cx + canvas.width * 0.24, top + headH * 1.05, cx + canvas.width * 0.3, canvas.height); ctx.stroke();
    ctx.setLineDash([]);
  }
  function clampCrop() {
    const canvas = $("cropCanvas"); const { image, scale } = live.crop; if (!image) return;
    const base = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const maxX = Math.max(0, (image.naturalWidth * base * scale - canvas.width) / 2);
    const maxY = Math.max(0, (image.naturalHeight * base * scale - canvas.height) / 2);
    live.crop.x = Math.min(maxX, Math.max(-maxX, live.crop.x));
    live.crop.y = Math.min(maxY, Math.max(-maxY, live.crop.y));
  }
  async function pickCharacter(file) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024)
      return notice("Use a JPG, PNG or WebP image under 8 MB.");
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (Math.min(image.naturalWidth, image.naturalHeight) < 256) throw new Error("Use an image at least 256 px on each side; 512 px or more is best.");
      if (live.crop.url) URL.revokeObjectURL(live.crop.url);
      live.crop = { image, url, scale: 1, x: 0, y: 0, ready: true };
      $("cropZoom").value = "1";
      $("cropBox").dataset.empty = "false"; $("cropTools").hidden = false;
      drawCrop(); notice("");
      describeCharacter(file);
    } catch (error) { URL.revokeObjectURL(url); notice(error.message || "This image could not be opened."); }
    finally { render(); }
  }
  // The photo describes itself, so users never have to write a description (they can still edit it).
  async function describeCharacter(file) {
    const box = $("characterDescription");
    if (!assistOn() || (box.value.trim() && !live.autoDescribed)) return; // never overwrite the user's own words
    const ticket = ++live.describeTicket;
    live.describing++; box.value = ""; $("describeHint").hidden = true; render();
    try {
      const form = new FormData();
      form.append("image", file);
      const response = await fetch("/api/assist/describe", { method: "POST", headers: authHeaders(), body: form, signal: AbortSignal.timeout(60000) });
      const payload = await response.json().catch(() => ({}));
      if (ticket !== live.describeTicket) return; // a newer photo was picked meanwhile
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Could not describe this photo.");
      if (!box.value.trim()) { box.value = payload.description; live.autoDescribed = true; $("describeHint").hidden = false; }
    } catch (error) {
      if (ticket === live.describeTicket) notice(`${error.message || "Could not describe this photo."} You can type a description instead.`);
    } finally {
      live.describing--; render();
    }
  }
  function exportCrop() {
    const out = document.createElement("canvas");
    out.width = live.camAspect >= 1 ? 1280 : 720; out.height = Math.round(out.width / live.camAspect);
    const preview = $("cropCanvas"); const k = out.width / preview.width;
    const { image, scale, x, y } = live.crop;
    const base = Math.max(out.width / image.naturalWidth, out.height / image.naturalHeight);
    const w = image.naturalWidth * base * scale, h = image.naturalHeight * base * scale;
    const ctx = out.getContext("2d"); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(image, (out.width - w) / 2 + x * k, (out.height - h) / 2 + y * k, w, h);
    return new Promise((resolve) => out.toBlob((blob) => resolve(new File([blob], "character.jpg", { type: "image/jpeg" })), "image/jpeg", 0.9));
  }
  async function applyCharacter() {
    if (!live.crop.ready || !$("consentCheck").checked) return;
    live.character = await exportCrop();
    live.characterDescription = $("characterDescription").value.trim();
    if (!live.characterDescription) notice("Tip: describing skin tone, hair and clothing makes the likeness much stronger.", true);
    if (live.rt) {
      try { await live.rt.set(currentState()); notice("Character switched.", true); }
      catch (error) { notice(error.message || "Could not switch the character."); }
    } else if (live.characterDescription) notice("Character ready. Go live to transform.", true);
    render();
  }
  function setupCrop() {
    const canvas = $("cropCanvas"); let drag = null;
    canvas.addEventListener("pointerdown", (e) => { if (!live.crop.image) return; canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const k = canvas.width / canvas.getBoundingClientRect().width;
      live.crop.x += (e.clientX - drag.x) * k; live.crop.y += (e.clientY - drag.y) * k;
      drag = { x: e.clientX, y: e.clientY }; clampCrop(); drawCrop();
    });
    const end = () => { drag = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      if (!live.crop.image) return; e.preventDefault();
      live.crop.scale = Math.min(3, Math.max(1, live.crop.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
      $("cropZoom").value = String(live.crop.scale); clampCrop(); drawCrop();
    }, { passive: false });
    $("cropZoom").addEventListener("input", () => { live.crop.scale = Number($("cropZoom").value); clampCrop(); drawCrop(); });
    $("cropReplace").addEventListener("click", () => $("liveRefInput").click());
    const box = $("cropBox");
    for (const name of ["dragenter", "dragover"]) box.addEventListener(name, (e) => { e.preventDefault(); box.classList.add("dragging"); });
    box.addEventListener("dragleave", () => box.classList.remove("dragging"));
    box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("dragging"); pickCharacter(e.dataTransfer.files[0]); });
  }

  // ---------- inspector tabs ----------
  function selectTab(id) {
    for (const [tab, panel] of [["tabLooks", "panelLooks"], ["tabCharacter", "panelCharacter"], ["tabVoice", "panelVoice"], ["tabScenes", "panelScenes"]]) {
      $(tab).setAttribute("aria-selected", String(tab === id));
      $(panel).hidden = tab !== id;
    }
    if (id === "tabCharacter") drawCrop();
  }

  // ---------- clean view ----------
  function setClean(on) {
    document.body.classList.toggle("clean", on);
    $("exitCleanButton").hidden = !on;
    if (on) notice(""); else resumePreview();
  }

  // ---------- wiring ----------
  $("enhanceCheck").checked = storage.get("vyra.enhance", "1") !== "0";
  if (!voices().some((v) => v.id === live.voice) && !live.voice.startsWith("ai:")) live.voice = "natural";
  live.idleArt = window.VyraPixel?.idle($("idleArt"));
  $("syncRange").value = String(live.syncOffset);
  renderLooks();
  renderVoices();
  setupCrop();
  $("tabLooks").addEventListener("click", () => selectTab("tabLooks"));
  $("tabCharacter").addEventListener("click", () => selectTab("tabCharacter"));
  $("tabVoice").addEventListener("click", () => selectTab("tabVoice"));
  $("tabScenes").addEventListener("click", () => { selectTab("tabScenes"); renderScenes(); });
  $("sourceFileInput").addEventListener("change", (event) => { pickSourceFile(event.target.files[0]); event.target.value = ""; });
  $("sourceFileInput").addEventListener("cancel", () => pickSourceFile(null));
  $("ruleForm").addEventListener("submit", addRule);
  $("rulesEnabled").addEventListener("change", (event) => setRulesOn(event.target.checked));
  $("overlayToggle").addEventListener("click", () => setOverlay(!live.overlay.visible));
  $("overlayTitle").value = live.overlay.title; $("overlaySub").value = live.overlay.sub;
  for (const [id, key] of [["overlayTitle", "title"], ["overlaySub", "sub"]]) {
    $(id).addEventListener("input", (event) => { live.overlay[key] = event.target.value.trim(); storage.set(id === "overlayTitle" ? "vyra.overlayTitle" : "vyra.overlaySub", live.overlay[key]); renderOverlay(); });
  }
  $("overlayLogoInput").addEventListener("change", (event) => { pickOverlayLogo(event.target.files[0]); event.target.value = ""; });
  $("overlayLogoClear").addEventListener("click", () => { live.overlay.logo = null; live.overlayImg = null; storage.set("vyra.overlayLogo", ""); renderOverlay(); });
  live.commands = window.VyraScenes ? new window.VyraScenes.Commands(runCommand, renderCommandState) : null;
  document.querySelectorAll("[data-command-mode]").forEach((b) => b.addEventListener("click", () => setCommandMode(b.dataset.commandMode)));
  $("commandButton").addEventListener("pointerdown", (event) => { event.preventDefault(); commandPress(); });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) $("commandButton").addEventListener(type, commandRelease);
  document.addEventListener("keydown", (event) => { if (event.key.toLowerCase() === "v" && !event.repeat && !typing(event.target)) commandPress(); });
  document.addEventListener("keyup", (event) => { if (event.key.toLowerCase() === "v") commandRelease(); });
  if (live.commandMode !== "off" && live.commands?.supported) live.commands.setMode(live.commandMode); else renderCommandState(live.commands?.state() || "unsupported");
  renderOverlay(); renderScenes(); listCameras();
  $("netTestButton").addEventListener("click", testNetwork);
  renderPalettes();
  $("monitorCheck").addEventListener("change", (event) => { live.monitor = event.target.checked; live.rig?.setMonitor(live.monitor); });
  $("syncRange").addEventListener("input", (event) => {
    live.syncOffset = Number(event.target.value) || 0; storage.set("vyra.voiceSync", String(live.syncOffset)); applyVoiceDelay();
  });
  $("startCameraButton").addEventListener("click", startCamera);
  // Safety net: any later click or key press wakes a paused audio context.
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => { if (live.audioCtx?.state === "suspended") live.audioCtx.resume().catch(() => {}); }, true);
  $("cameraSelect").addEventListener("change", switchCamera);
  $("engineSelect").addEventListener("change", (event) => selectEngine(event.target.value));
  $("mirrorButton").addEventListener("click", () => { live.mirrored = !live.mirrored; render(); });
  $("goLiveButton").addEventListener("click", goLive);
  $("streamButton").addEventListener("click", async () => {
    if (live.streamer?.state === "live") { const current = live.streamer; live.streamer = null; current.stopDrawing?.(); await current.stop(); $("streamHint").hidden = true; render(); return; }
    if (live.phase !== "live") { notice("Go live before starting a livestream."); return; }
    let drawing = true;
    try {
      const streamCanvas = document.createElement("canvas");
      const aiVideo = $("aiVideo"); streamCanvas.width = aiVideo.videoWidth; streamCanvas.height = aiVideo.videoHeight;
      const ctx = streamCanvas.getContext("2d");
      const colours = overlayColours();
      const draw = () => {
        if (!drawing) return;
        ctx.drawImage(aiVideo, 0, 0, streamCanvas.width, streamCanvas.height);
        drawOverlay(ctx, streamCanvas.width, streamCanvas.height, colours);
        if (labelOn() && !live.status?.vyra_dev_mode) drawLabelTo(ctx, streamCanvas.width, streamCanvas.height);
        requestAnimationFrame(draw);
      };
      draw();
      const streamer = new window.VyraStream(streamCanvas, live.rig && live.voice !== "off" ? live.rig.track() : null);
      live.streamer = streamer;
      streamer.onChange(({ state, detail }) => {
        if (state === "live") $("streamHint").textContent = "Live stream is sending AI video to your configured RTMP destination. Keep VYRANI open.";
        else if (state === "error") $("streamHint").textContent = detail;
        $("streamHint").hidden = state === "idle";
        if (state === "error") { streamer.dispose(); if (live.streamer === streamer) live.streamer = null; }
        if (state === "idle" && live.streamer === streamer) live.streamer = null;
        render();
      });
      const stopDrawing = () => { drawing = false; };
      streamer.stopDrawing = stopDrawing;
      await streamer.start();
    } catch (error) {
      drawing = false; notice(error.message || "Livestream failed to start.");
      live.streamer?.dispose(); live.streamer = null; $("streamHint").hidden = true; render();
    }
  });
  $("goLiveButton").addEventListener("pointerenter", prefetchKey);
  $("goLiveButton").addEventListener("focus", prefetchKey);
  $("liveRecordButton").addEventListener("click", () => (live.recorder ? stopRecording() : startRecording()));
  $("cleanButton").addEventListener("click", () => setClean(true));
  $("exitCleanButton").addEventListener("click", () => setClean(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setClean(false); });
  $("aiVideo").addEventListener("loadeddata", onFirstFrame);
  $("aiVideo").addEventListener("playing", onFirstFrame);
  $("liveRefInput").addEventListener("change", (event) => { pickCharacter(event.target.files[0]); event.target.value = ""; });
  $("consentCheck").addEventListener("change", render);
  $("applyCharacterButton").addEventListener("click", applyCharacter);
  $("enhanceCheck").addEventListener("change", () => { storage.set("vyra.enhance", enhance() ? "1" : "0"); reapply(); });
  $("promptInput").addEventListener("input", render);
  $("createInput").addEventListener("input", render);
  $("createForm").addEventListener("submit", createLook);
  $("characterDescription").addEventListener("input", () => { live.autoDescribed = false; $("describeHint").hidden = true; });
  $("promptForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("promptInput").value.trim();
    if (text) applyLook({ name: "Custom", note: "Your prompt", prompt: text });
  });
  // Billing guard: stop sessions that keep running in a hidden tab.
  document.addEventListener("visibilitychange", () => {
    clearTimeout(live.hiddenTimer);
    if (document.hidden && live.rt) live.hiddenTimer = setTimeout(() => stopLive("Paused because the tab was hidden for 30 seconds."), HIDDEN_GRACE_MS);
  });
  document.addEventListener("vyra:notice", (event) => notice(event.detail, true));
  window.addEventListener("pagehide", () => {
    // Closing the tab mid-session still settles it, so unused seconds come back.
    if (live.billing.sessionId) navigator.sendBeacon?.(`/api/live/meter/${encodeURIComponent(live.billing.sessionId)}/end`); live.streamer?.stopDrawing?.(); live.streamer?.dispose(); live.rt?.disconnect(); live.stream?.getTracks().forEach((t) => t.stop()); live.rig?.close(); live.sceneRunner?.stop(); live.commands?.setMode("off"); });
  // With accounts on, nothing loads until the user has signed in.
  (account()?.ready || Promise.resolve()).then(() => {
    if (billingOn()) $("sessionCostLabel").textContent = "Used";
    else $("sessionDetails").open = true; // operators (shared-token mode) pick engines and read the numbers
    loadStatus();
    // A look picked on the landing page is ready when the app opens.
    let pending = null;
    try { pending = sessionStorage.getItem("vyra.pendingLook"); sessionStorage.removeItem("vyra.pendingLook"); } catch { /* storage blocked */ }
    const picked = pending && LOOKS.find((l) => l.name === pending);
    if (picked) applyLook(picked);
  });
})();
