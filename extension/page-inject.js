"use strict";
// VYRANI AI Virtual Camera & Microphone — MAIN-world WebRTC Loopback MediaDevices shim.
//
// Security & Performance Design:
// 1. Runs ONLY on supported calling sites (WhatsApp Web, Google Meet, Zoom Web, Discord Web, Teams Web)
//    and VYRANI Studio origins as declared in manifest.json.
// 2. Never accepts unauthenticated cross-window frames; only accepts signaling relayed by the
//    extension background service worker from a Chrome-verified VYRANI Studio tab (`port.sender.url`).
// 3. Uses native WebRTC `RTCPeerConnection` loopback (`addTrack` -> `ontrack`) instead of JPEG polling.
//    A stable canvas output switches from standby to received video without changing the caller's track.
(() => {
  // If an older copy of the extension is also installed, the newest copy takes over the page. Messages use a
  // versioned channel ("v2") so two copies never read each other's signalling.
  const SHIM_VERSION = 2;
  if (window.__VYRA_VIRTUAL_CAM_INSTALLED__ && (window.__VYRA_VIRTUAL_CAM_VERSION__ || 1) >= SHIM_VERSION) return;
  window.__VYRA_VIRTUAL_CAM_INSTALLED__ = true;
  window.__VYRA_VIRTUAL_CAM_VERSION__ = SHIM_VERSION;

  const VYRA_CAM_ID = "vyra-virtual-cam";
  const VYRA_MIC_ID = "vyra-virtual-mic";
  const VYRA_GROUP_ID = "vyra-ai-virtual-devices";

  const state = {
    consumerId: null,
    active: false,
    forceAllSites: false,
    width: 1280,
    height: 720,
    lookLabel: "",
    remoteVideoTrack: null,
    remoteVideo: null,
    remoteAudioTrack: null,
    pc: null,
    requesting: false,
    requestedAt: 0,
    canvas: null,
    ctx: null,
    drawingStandby: false,
    audioCtx: null,
    audioDest: null,
  };

  // Studio-side producer state (used only when running inside VYRANI Studio itself)
  const producerPeers = new Map(); // consumerId -> RTCPeerConnection
  const pendingConsumers = new Set(); // calls that asked for video before the studio had any
  let studioStream = null;

  function sendToExtensionConsumer(payload) {
    window.postMessage({ source: "vyra-consumer-page-v2", payload }, window.location.origin);
  }

  function sendToExtensionProducer(payload) {
    window.postMessage({ source: "vyra-studio-page-v2", payload }, window.location.origin);
  }

  // ---------- Consumer WebRTC PeerConnection ----------
  function requestWebRtcStream() {
    if (!state.active) return;
    if (state.pc && (state.pc.connectionState === "connected" || state.pc.connectionState === "connecting")) {
      return;
    }
    // A request can go unanswered (e.g. the studio was reloading and had no video yet): allow another after 2 s.
    if (state.requesting && Date.now() - state.requestedAt < 2000) return;
    state.requesting = true;
    state.requestedAt = Date.now();
    sendToExtensionConsumer({ type: "vyra-cam:rtc-request" });
  }

  // Watchdog: while the studio is active but no video is arriving, keep asking. Recovers from a studio reload,
  // a dropped connection, or a studio that started sending after the call opened the camera.
  setInterval(() => {
    if (!state.active) return;
    const pcOk = state.pc && ["connected", "connecting", "new"].includes(state.pc.connectionState);
    const trackOk = state.remoteVideoTrack && state.remoteVideoTrack.readyState === "live";
    if (!pcOk || !trackOk) requestWebRtcStream();
  }, 2000);

  async function handleConsumerOffer(msg) {
    try {
      if (state.pc) {
        try { state.pc.close(); } catch { /* ignore */ }
      }
      const pc = new RTCPeerConnection({ iceServers: [] });
      state.pc = pc;
      pc.onconnectionstatechange = () => {
        if (["connected", "failed", "closed", "disconnected"].includes(pc.connectionState)) state.requesting = false;
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendToExtensionConsumer({
            type: "vyra-cam:rtc-ice",
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (ev) => {
        const track = ev.track;
        if (track.kind === "video") {
          state.remoteVideoTrack = track;
          track.onended = () => {
            if (state.remoteVideoTrack === track) state.remoteVideoTrack = null;
          };
        } else if (track.kind === "audio") {
          state.remoteAudioTrack = track;
          track.onended = () => {
            if (state.remoteAudioTrack === track) state.remoteAudioTrack = null;
          };
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendToExtensionConsumer({
        type: "vyra-cam:rtc-answer",
        sdp: pc.localDescription.toJSON(),
      });
    } catch {
      state.requesting = false;
      /* fallback standby canvas remains active */
    }
  }

  async function handleConsumerIce(msg) {
    if (!state.pc || !msg.candidate) return;
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch { /* ignore */ }
  }

  // ---------- Producer WebRTC PeerConnection (Runs only inside VYRANI Studio) ----------
  async function handleProducerRequest(consumerId) {
    if (!consumerId) return;
    const oldPc = producerPeers.get(consumerId);
    if (oldPc && !["closed", "failed", "disconnected"].includes(oldPc.connectionState)) return;
    if (oldPc) {
      try { oldPc.close(); } catch { /* ignore */ }
      producerPeers.delete(consumerId);
    }
    const stream = studioStream || window.__VYRA_LIVE_OUTPUT_STREAM__;
    if (!(stream instanceof MediaStream)) { pendingConsumers.add(consumerId); return; } // answered when video starts
    pendingConsumers.delete(consumerId);

    const pc = new RTCPeerConnection({ iceServers: [] });
    producerPeers.set(consumerId, pc);

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendToExtensionProducer({
          type: "vyra-cam:rtc-ice",
          consumerId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        if (producerPeers.get(consumerId) === pc) producerPeers.delete(consumerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendToExtensionProducer({
      type: "vyra-cam:rtc-offer",
      consumerId,
      sdp: pc.localDescription.toJSON(),
    });
  }

  async function handleProducerAnswer(msg) {
    const pc = producerPeers.get(msg.consumerId);
    if (!pc || !msg.sdp) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch { /* ignore */ }
  }

  async function handleProducerIce(msg) {
    const pc = producerPeers.get(msg.consumerId);
    if (!pc || !msg.candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch { /* ignore */ }
  }

  // Listen only to messages from our own window origin bridged by content-bridge.js
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || !event.data) return;
    const { source, payload } = event.data;
    if (source === "vyra-ext-bridge-v2" && payload) {
      if (payload.type === "vyra-cam:state") {
        const becameActive = !state.active && Boolean(payload.active);
        state.active = Boolean(payload.active);
        if (!state.active) {
          state.requesting = false;
          state.pc?.close();
          state.pc = null;
          state.remoteVideoTrack = null;
          state.remoteAudioTrack = null;
        }
        if (payload.consumerId) state.consumerId = payload.consumerId;
        if (typeof payload.forceAllSites === "boolean") state.forceAllSites = payload.forceAllSites;
        if (payload.width) state.width = payload.width;
        if (payload.height) state.height = payload.height;
        if (payload.lookLabel !== undefined) state.lookLabel = payload.lookLabel;
        if (becameActive) { state.requesting = false; requestWebRtcStream(); }
        else if (state.active) requestWebRtcStream();
      } else if (payload.type === "vyra-cam:rtc-offer") {
        handleConsumerOffer(payload);
      } else if (payload.type === "vyra-cam:rtc-ice") {
        handleConsumerIce(payload);
      }
    } else if (source === "vyra-ext-studio-in-v2" && payload) {
      if (payload.type === "vyra-cam:rtc-request") {
        handleProducerRequest(payload.consumerId);
      } else if (payload.type === "vyra-cam:rtc-answer") {
        handleProducerAnswer(payload);
      } else if (payload.type === "vyra-cam:rtc-ice") {
        handleProducerIce(payload);
      } else if (payload.type === "vyra-cam:consumer-closed") {
        const pc = producerPeers.get(payload.consumerId);
        if (pc) {
          try { pc.close(); } catch { /* ignore */ }
          producerPeers.delete(payload.consumerId);
        }
      }
    }
  });

  function ensureStandbyCanvas() {
    if (!state.canvas) {
      state.canvas = document.createElement("canvas");
      state.canvas.width = state.width || 1280;
      state.canvas.height = state.height || 720;
      state.ctx = state.canvas.getContext("2d", { alpha: false });
    }
    if (!state.drawingStandby) {
      state.drawingStandby = true;
      const tick = () => {
        if (!state.drawingStandby) return;
        if (state.ctx && state.canvas) {
          const track = state.remoteVideoTrack;
          if (track && track.readyState === "live") {
            if (!state.remoteVideo) {
              state.remoteVideo = document.createElement("video");
              state.remoteVideo.muted = true;
              state.remoteVideo.playsInline = true;
            }
            if (state.remoteVideo.srcObject?.getVideoTracks()[0] !== track) {
              state.remoteVideo.srcObject = new MediaStream([track]);
              state.remoteVideo.play().catch(() => {});
            }
          }
          if (track?.readyState === "live" && state.remoteVideo?.readyState >= 2) {
            state.ctx.drawImage(state.remoteVideo, 0, 0, state.canvas.width, state.canvas.height);
          } else {
            drawStandbySlate(state.ctx, state.canvas.width, state.canvas.height);
          }
        }
        setTimeout(tick, 1000 / 30);
      };
      tick();
    }
    return state.canvas;
  }

  function drawStandbySlate(ctx, w, h) {
    ctx.fillStyle = "#0b0b0c";
    ctx.fillRect(0, 0, w, h);

    // Nothing else is drawn: the other people on the call see a plain dark frame (like a camera that's off), never
    // text or a brand, until the studio goes live.
  }

  function createVirtualDeviceInfo(deviceId, kind, label) {
    const proto = typeof InputDeviceInfo !== "undefined" ? InputDeviceInfo.prototype
      : typeof MediaDeviceInfo !== "undefined" ? MediaDeviceInfo.prototype : Object.prototype;
    const obj = Object.create(proto);
    Object.defineProperties(obj, {
      deviceId: { value: deviceId, enumerable: true },
      kind: { value: kind, enumerable: true },
      label: { value: label, enumerable: true },
      groupId: { value: VYRA_GROUP_ID, enumerable: true },
      toJSON: {
        value: () => ({ deviceId, kind, label, groupId: VYRA_GROUP_ID }),
      },
      getCapabilities: {
        value: () => (kind === "videoinput"
          ? {
              deviceId,
              groupId: VYRA_GROUP_ID,
              width: { min: 320, max: 1920 },
              height: { min: 240, max: 1080 },
              aspectRatio: { min: 0.5, max: 2.0 },
              frameRate: { min: 1, max: 60 },
              facingMode: ["user"],
              resizeMode: ["none", "crop-and-scale"],
            }
          : {
              deviceId,
              groupId: VYRA_GROUP_ID,
              autoGainControl: [true, false],
              echoCancellation: [true, false],
              noiseSuppression: [true, false],
              channelCount: { min: 1, max: 2 },
              sampleRate: { min: 16000, max: 48000 },
            }),
      },
    });
    return obj;
  }

  function extractRequestedDeviceId(constraint) {
    if (!constraint || typeof constraint !== "object") return null;
    const dev = constraint.deviceId;
    if (!dev) return null;
    if (typeof dev === "string") return dev;
    if (Array.isArray(dev)) return dev[0] || null;
    if (typeof dev === "object") {
      if (typeof dev.exact === "string") return dev.exact;
      if (Array.isArray(dev.exact)) return dev.exact[0] || null;
      if (typeof dev.ideal === "string") return dev.ideal;
      if (Array.isArray(dev.ideal)) return dev.ideal[0] || null;
    }
    return null;
  }

  function decorateVideoTrack(track, width = 1280, height = 720) {
    if (!track) return null;
    try {
      Object.defineProperty(track, "label", { value: "VYRANI AI Virtual Camera", configurable: true });
    } catch { /* read-only in some engines */ }
    const origSettings = track.getSettings ? track.getSettings.bind(track) : () => ({});
    track.getSettings = () => ({
      ...origSettings(),
      deviceId: VYRA_CAM_ID,
      groupId: VYRA_GROUP_ID,
      width,
      height,
      frameRate: 30,
      aspectRatio: width / height,
      facingMode: "user",
    });
    return track;
  }

  function createVirtualVideoTrack() {
    if (window.__VYRA_LIVE_OUTPUT_STREAM__ instanceof MediaStream) {
      const direct = window.__VYRA_LIVE_OUTPUT_STREAM__.getVideoTracks()[0];
      if (direct && direct.readyState === "live") {
        return decorateVideoTrack(direct.clone(), state.width, state.height);
      }
    }
    // Keep the returned track alive while signaling connects or Studio replaces its stream.
    // A standby-only track would strand calls opened before Studio is ready.
    requestWebRtcStream();
    const canvas = ensureStandbyCanvas();
    const stream = canvas.captureStream(30);
    return decorateVideoTrack(stream.getVideoTracks()[0], canvas.width, canvas.height);
  }

  function createVirtualAudioTrack() {
    if (window.__VYRA_LIVE_OUTPUT_STREAM__ instanceof MediaStream) {
      const directAudio = window.__VYRA_LIVE_OUTPUT_STREAM__.getAudioTracks()[0];
      if (directAudio && directAudio.readyState === "live") {
        return directAudio.clone();
      }
    }
    if (state.remoteAudioTrack && state.remoteAudioTrack.readyState === "live") {
      return state.remoteAudioTrack.clone();
    }
    requestWebRtcStream();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!state.audioCtx && AudioCtx) {
      state.audioCtx = new AudioCtx();
      state.audioDest = state.audioCtx.createMediaStreamDestination();
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(state.audioDest);
      osc.start();
    }
    const track = state.audioDest?.stream.getAudioTracks()[0];
    if (track) {
      try {
        Object.defineProperty(track, "label", { value: "VYRANI AI Virtual Microphone", configurable: true });
      } catch { /* ignore */ }
    }
    return track?.clone() || null;
  }

  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) return;

  const origEnumerateDevices = mediaDevices.enumerateDevices
    ? mediaDevices.enumerateDevices.bind(mediaDevices)
    : async () => [];
  const origGetUserMedia = mediaDevices.getUserMedia
    ? mediaDevices.getUserMedia.bind(mediaDevices)
    : async () => { throw new DOMException("getUserMedia is not supported", "NotSupportedError"); };

  mediaDevices.enumerateDevices = async function () {
    let realDevices = [];
    try {
      realDevices = await origEnumerateDevices();
    } catch {
      realDevices = [];
    }
    const filtered = realDevices.filter(
      (d) => d.deviceId !== VYRA_CAM_ID && d.deviceId !== VYRA_MIC_ID
    );
    if (location.pathname.startsWith("/app/studio") || location.pathname === "/studio") {
      return filtered;
    }
    return [
      createVirtualDeviceInfo(VYRA_CAM_ID, "videoinput", "VYRANI AI Virtual Camera"),
      createVirtualDeviceInfo(VYRA_MIC_ID, "audioinput", "VYRANI AI Virtual Microphone"),
      ...filtered,
    ];
  };

  mediaDevices.getUserMedia = async function (constraints = {}) {
    const wantsVideo = Boolean(constraints && constraints.video);
    const wantsAudio = Boolean(constraints && constraints.audio);
    const videoId = wantsVideo ? extractRequestedDeviceId(constraints.video) : null;
    const audioId = wantsAudio ? extractRequestedDeviceId(constraints.audio) : null;

    const isVyraStudioPage = Boolean(
      document.querySelector("[data-vyra-studio]") ||
      location.pathname.startsWith("/app/studio") ||
      location.pathname === "/studio"
    );
    const useVirtualVideo = wantsVideo && (videoId === VYRA_CAM_ID || (!isVyraStudioPage && state.forceAllSites && !videoId));
    const useVirtualAudio = wantsAudio && (audioId === VYRA_MIC_ID || (!isVyraStudioPage && state.forceAllSites && !audioId));

    if (!useVirtualVideo && !useVirtualAudio) {
      return origGetUserMedia(constraints);
    }

    const tracks = [];
    if (useVirtualVideo) {
      const vTrack = createVirtualVideoTrack();
      if (vTrack) tracks.push(vTrack);
    } else if (wantsVideo) {
      const realV = await origGetUserMedia({ video: constraints.video, audio: false });
      tracks.push(...realV.getVideoTracks());
    }

    if (useVirtualAudio) {
      const aTrack = createVirtualAudioTrack();
      if (aTrack) tracks.push(aTrack);
    } else if (wantsAudio) {
      try {
        const realA = await origGetUserMedia({ video: false, audio: constraints.audio });
        tracks.push(...realA.getAudioTracks());
      } catch {
        const fallbackA = createVirtualAudioTrack();
        if (fallbackA) tracks.push(fallbackA);
      }
    }

    return new MediaStream(tracks);
  };

  window.VyraVirtualCam = {
    VYRA_CAM_ID,
    VYRA_MIC_ID,
    getState: () => ({ ...state }),
    publishStream(stream, width = 1280, height = 720, lookLabel = "") {
      studioStream = stream;
      window.__VYRA_LIVE_OUTPUT_STREAM__ = stream;
      sendToExtensionProducer({
        type: "vyra-cam:announce",
        width,
        height,
        lookLabel,
      });
      for (const id of [...pendingConsumers]) handleProducerRequest(id);
      // Update any existing WebRTC consumer peer connections with the latest tracks
      for (const pc of producerPeers.values()) {
        const senders = pc.getSenders();
        for (const track of stream.getTracks()) {
          const sender = senders.find((s) => s.track && s.track.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track).catch(() => {});
          } else {
            pc.addTrack(track, stream);
          }
        }
      }
    },
    stop() {
      studioStream = null;
      for (const pc of producerPeers.values()) {
        try { pc.close(); } catch { /* ignore */ }
      }
      producerPeers.clear();
      sendToExtensionProducer({ type: "vyra-cam:stop" });
    },
  };
})();
