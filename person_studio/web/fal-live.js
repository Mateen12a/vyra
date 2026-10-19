"use strict";
// Lucy 2.5 realtime through fal. fal relays the WebRTC signalling over a WebSocket
// (msgpack frames); the video itself flows directly between this browser and Decart.
// Exposes the same surface live.js uses for the Decart SDK: set(), replaceVideoTrack(),
// disconnect(), and connectionChange / sessionEnded / error / connectionQuality events.
(() => {
  const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
  const READY_FALLBACK_MS = 1000;   // "ready" without relay servers: fall back to STUN after this
  const HANDSHAKE_TIMEOUT_MS = 45000;
  const RECONNECT_GRACE_MS = 10000; // ICE "disconnected" often recovers on its own
  const MAX_REFERENCE_BYTES = 700 * 1024; // the reference travels inside a signalling message
  const MIN_REFERENCE_SIDE = 512;   // fal: reference images at least 512x512

  const textOf = (prompt) => (typeof prompt === "string" ? prompt : prompt?.text || "");
  const enhanceOf = (state) =>
    state.prompt && typeof state.prompt === "object" && "enhance" in state.prompt ? state.prompt.enhance : state.enhance ?? true;

  const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read the character image."));
    reader.readAsDataURL(blob);
  });

  async function fitReference(blob) {
    if (blob.size <= MAX_REFERENCE_BYTES) return blob;
    const bitmap = await createImageBitmap(blob);
    const floor = Math.min(1, MIN_REFERENCE_SIDE / Math.min(bitmap.width, bitmap.height));
    let scale = Math.max(floor, Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height)));
    let quality = 0.85;
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (out && out.size <= MAX_REFERENCE_BYTES) return out;
      if (quality > 0.6) quality -= 0.1; else scale = Math.max(floor, scale * 0.85);
    }
    throw new Error("The character image is too detailed to send. Try a simpler photo.");
  }

  const BUSY_PATTERNS = [
    /concurrent|\bbusy\b|resource[_ -]?locked/i,
    /another\s+(?:live\s+)?session|session\s+(?:is\s+)?(?:already\s+)?(?:active|running|open)/i,
    /already\s+(?:active|running|open|connected)|still\s+closing|one\s+(?:live\s+)?session/i,
  ];
  const isBusyMessage = (message) => {
    const seen = new Set();
    const collect = (value, depth = 0) => {
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
      seen.add(value);
      return Object.entries(value).map(([key, item]) => `${key} ${collect(item, depth + 1)}`).join(" ");
    };
    const text = collect(message);
    return BUSY_PATTERNS.some((pattern) => pattern.test(text));
  };
  function describe(message) {
    const raw = message?.error?.message || message?.error || message?.reason || message?.detail || message?.message || "";
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (isBusyMessage(message)) return "Another live session is still closing on this fal account. Close it in another tab or the fal playground, then try again.";
    if (/insufficient|balance|credit|payment|quota/i.test(text)) return "Your fal balance is too low for live mode. Top up at fal.ai.";
    if (/unauthori[sz]ed|forbidden|token/i.test(text)) return "fal rejected the live session token. Try again.";
    return text ? `Live service error: ${text}` : "The live service reported an error.";
  }
  // fal keeps an account's live slot busy for a minute or two after a session ends; callers retry these.
  function errorFrom(message) {
    const error = new Error(describe(message));
    if (isBusyMessage(message)) error.code = "busy";
    // fal's exact reply, for the console and for the final error, so a guessed "busy" can be checked.
    try { error.falMessage = typeof message === "string" ? message : JSON.stringify(message).slice(0, 400); } catch { /* keep the description */ }
    return error;
  }
  function closeText(event) {
    if (event.reason) return describe({ reason: event.reason });
    return event.code === 1000 ? "The live service closed the session." : "Lost the connection to the live service.";
  }

  function preferH264(transceiver) {
    try {
      const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs || [];
      const of = (type) => codecs.filter((c) => c.mimeType.toLowerCase() === type);
      const h264 = of("video/h264"), vp8 = of("video/vp8");
      if (!h264.length || !transceiver.setCodecPreferences) return;
      transceiver.setCodecPreferences([...h264, ...vp8, ...codecs.filter((c) => !h264.includes(c) && !vp8.includes(c))]);
    } catch { /* keep the browser's default codec order */ }
  }

  class FalLucySession {
    constructor() {
      this.handlers = {}; this.ws = null; this.pc = null; this.sender = null;
      this.closed = false; this.hasImage = false; this.remoteSet = false; this.pendingRemote = [];
      this.abortSignal = null; this.abortHandler = null;
      this.statsTimer = null; this.graceTimer = null;
      this.videoQuality = { maxBitrate: 2_500_000, maxFramerate: 30 };
    }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
    emit(event, data) {
      for (const fn of this.handlers[event] || []) { try { fn(data); } catch (error) { console.error(error); } }
    }
    send(message) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(window.MessagePack.encode(message));
    }
    async payload(state) {
      const out = { prompt: textOf(state.prompt), enable_prompt_expansion: Boolean(enhanceOf(state)) };
      if (state.image) {
        out.reference_image_url = await toDataUrl(await fitReference(state.image));
        this.hasImage = true;
      } else if (this.hasImage) {
        out.reference_image_url = null; // explicit removal; otherwise the old reference stays active
        this.hasImage = false;
      }
      return out;
    }
    // Same contract as the Decart SDK: the whole state is replaced.
    async set(state) {
      if (this.closed) throw new Error("The live session has ended.");
      this.send(await this.payload(state));
    }
    async replaceVideoTrack(track) { await this.sender?.replaceTrack(track); }
    async setVideoQuality({ maxBitrate, maxFramerate }) {
      if (this.closed) throw new Error("The live session has ended.");
      if (!(maxBitrate > 0) || !(maxFramerate > 0) || !Number.isFinite(maxBitrate) || !Number.isFinite(maxFramerate)) {
        throw new Error("Invalid upload quality.");
      }
      this.videoQuality = { maxBitrate, maxFramerate };
      if (!this.sender) return;
      const parameters = this.sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      Object.assign(parameters.encodings[0], this.videoQuality);
      await this.sender.setParameters(parameters);
    }
    connectionState(state) {
      if (this.closed) return;
      if (state === "connected") {
        clearTimeout(this.graceTimer); this.graceTimer = null;
        this.emit("connectionChange", "connected");
        this.startStats();
      } else if (state === "disconnected") {
        this.emit("connectionChange", "reconnecting");
        this.graceTimer ||= setTimeout(() => this.end("network", "The live connection dropped. Go live again."), RECONNECT_GRACE_MS);
      } else if (state === "failed") {
        this.end("network", "The live connection failed. Check your network and go live again.");
      }
    }
    startStats() {
      clearInterval(this.statsTimer);
      this.statsTimer = setInterval(async () => {
        if (!this.pc || this.closed) return;
        let rtt = null, limit = "none", sendFps = null, receiveFps = null, lost = 0, received = 0, jitter = null, sent = 0, got = 0;
        try {
          (await this.pc.getStats()).forEach((s) => {
            if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime * 1000;
            if (s.type === "outbound-rtp" && s.kind === "video") {
              sendFps = s.framesPerSecond ?? sendFps; sent += s.bytesSent || 0;
              if (s.qualityLimitationReason && s.qualityLimitationReason !== "none") limit = s.qualityLimitationReason;
            }
            if (s.type === "inbound-rtp" && s.kind === "video") {
              receiveFps = s.framesPerSecond ?? receiveFps; lost = s.packetsLost || 0; received = s.packetsReceived || 0; got += s.bytesReceived || 0;
              if (s.jitterBufferEmittedCount) jitter = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
            }
          });
        } catch { return; }
        const loss = received ? lost / (lost + received) : 0;
        // Bit rates from byte counters between two samples.
        const now = performance.now(), last = this.lastBytes;
        this.lastBytes = { now, sent, got };
        const rate = (bytes, before) => (last ? Math.max(0, ((bytes - before) * 8) / (now - last.now)) : null); // kbit/s
        const sendKbps = rate(sent, last?.sent), receiveKbps = rate(got, last?.got);
        const quality = rtt == null ? "good" : rtt > 400 || loss > 0.08 ? "poor" : rtt > 200 || loss > 0.03 || limit === "bandwidth" ? "fair" : "good";
        this.emit("connectionQuality", { quality, warmingUp: false, limitingFactor: limit, metrics: { rttMs: rtt, g2gMs: null, jitterMs: jitter, sendFps, receiveFps, sendKbps, receiveKbps, lossPct: loss * 100 } });
      }, 2000);
    }
    end(reason, message) {
      if (this.closed) return;
      this.disconnect();
      this.emit("sessionEnded", { reason, message });
    }
    disconnect() {
      if (this.closed) return;
      this.closed = true;
      if (this.abortSignal && this.abortHandler) this.abortSignal.removeEventListener("abort", this.abortHandler);
      this.abortSignal = null; this.abortHandler = null;
      clearInterval(this.statsTimer); clearTimeout(this.graceTimer);
      try { this.pc?.close(); } catch { /* already closed */ }
      try { if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000); } catch { /* already closed */ }
    }
  }

  async function connect(stream, { url, token, initialState, onRemoteStream, signal }) {
    if (!window.MessagePack) throw new Error("The fal live client did not load. Refresh the page.");
    if (signal?.aborted) throw new DOMException("The live connection was cancelled.", "AbortError");
    const track = stream?.getVideoTracks?.()[0];
    if (!track) throw new Error("Start your camera first.");
    const session = new FalLucySession();
    const first = await session.payload(initialState); // encode the reference before opening the paid session
    if (signal?.aborted) throw new DOMException("The live connection was cancelled.", "AbortError");

    return new Promise((resolve, reject) => {
      let settled = false, peerStarted = false, readyTimer = null;
      const timer = setTimeout(() => fail(new Error("The live service did not answer in time. Try again.")), HANDSHAKE_TIMEOUT_MS);
      function fail(error) {
        clearTimeout(timer); clearTimeout(readyTimer);
        signal?.removeEventListener("abort", onAbort);
        if (settled) return session.end("error", error.message);
        settled = true; session.disconnect(); reject(error);
      }
      function onAbort() { fail(new DOMException("The live connection was cancelled.", "AbortError")); }
      session.abortSignal = signal || null;
      session.abortHandler = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }

      async function startPeer(rawServers) {
        if (peerStarted) return;
        peerStarted = true; clearTimeout(readyTimer);
        const iceServers = Array.isArray(rawServers) && rawServers.some((s) => s?.urls) ? rawServers.filter((s) => s?.urls) : DEFAULT_ICE;
        const pc = new RTCPeerConnection({ iceServers });
        session.pc = pc;
        const transceiver = pc.addTransceiver(track, { direction: "sendrecv", streams: [stream],
          sendEncodings: [{ ...session.videoQuality }] });
        session.sender = transceiver.sender;
        preferH264(transceiver);
        pc.ontrack = (event) => onRemoteStream(event.streams[0] || new MediaStream([event.track]));
        pc.onconnectionstatechange = () => session.connectionState(pc.connectionState);
        // fal expects the browser ordering: the offer first, then trickled candidates, then null.
        let offerSent = false;
        const queued = [];
        pc.onicecandidate = (event) => {
          const c = event.candidate;
          const message = { type: "icecandidate", candidate: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null };
          if (offerSent) session.send(message); else queued.push(message);
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        session.send({ type: "offer", sdp: pc.localDescription.sdp });
        offerSent = true;
        for (const message of queued.splice(0)) session.send(message);
      }

      async function addRemoteCandidate(candidate) {
        if (candidate && candidate.candidate) await session.pc.addIceCandidate(candidate);
        else await session.pc.addIceCandidate();
      }

      async function handle(message) {
        const type = String(message.type || "").toLowerCase();
        const servers = message.iceServers ?? message.ice_servers ?? message.iceservers;
        if (type === "answer") {
          if (!session.pc) throw new Error("The live service answered before the offer.");
          if (!message.sdp) throw new Error("The live service sent an empty answer.");
          await session.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
          session.remoteSet = true;
          for (const candidate of session.pendingRemote.splice(0)) await addRemoteCandidate(candidate);
          if (!settled) {
            settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(session);
          }
        } else if (type === "icecandidate") {
          if (session.remoteSet) await addRemoteCandidate(message.candidate);
          else session.pendingRemote.push(message.candidate);
        } else if (type === "ready") {
          if (servers) await startPeer(servers);
          else readyTimer ||= setTimeout(() => startPeer(null).catch(fail), READY_FALLBACK_MS);
        } else if (type === "iceservers" || type === "ice_servers" || (!type && servers)) {
          await startPeer(servers);
        } else if (type === "ice-restart") {
          fail(new Error("The live connection needs a restart. Go live again."));
        } else if (type === "prompt_ack" || type === "set_image_ack") {
          if (message.success === false) session.emit("error", new Error(describe(message)));
        } else if (type === "error" || type === "x-fal-error" || message.status === "error") {
          if (message.error === "TIMEOUT") return; // fal's idle notice, not a failure
          fail(errorFrom(message));
        }
      }

      const ws = new WebSocket(`${url}?fal_jwt_token=${encodeURIComponent(token)}`);
      ws.binaryType = "arraybuffer";
      session.ws = ws;
      ws.onopen = () => session.send(first);
      ws.onmessage = (event) => {
        let message;
        try {
          message = typeof event.data === "string" ? JSON.parse(event.data) : window.MessagePack.decode(new Uint8Array(event.data));
        } catch {
          fail(new Error("The live service sent an unreadable response. Go live again."));
          return;
        }
        if (message && typeof message === "object") handle(message).catch(fail);
      };
      ws.onclose = (event) => {
        if (session.closed) return;
        if (!settled) fail(new Error(closeText(event))); else session.end("closed", closeText(event));
      };
    });
  }

  window.FalLucy = { connect };
})();
