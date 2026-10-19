"use strict";
// VYRA AI Virtual Camera Background Service Worker.
// Enforces strict origin verification on producer ports so only an authentic VYRA Studio tab can
// publish video/audio, and relays WebRTC SDP/ICE signaling between the verified VYRA Studio tab
// and supported calling tabs (WhatsApp Web, Google Meet, Zoom Web, Discord Web, Teams Web).

const DEFAULT_STUDIO_ORIGINS = [
  "http://127.0.0.1:8765",
  "http://localhost:8765",
  "http://127.0.0.1:8799",
  "http://localhost:8799",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "https://vyra.ai",
  "https://app.vyra.ai",
];

let studioState = {
  active: false,
  studioTabId: null,
  studioOrigin: null,
  forceAllSites: false,
  width: 1280,
  height: 720,
  lookLabel: "",
  allowedOrigins: [...DEFAULT_STUDIO_ORIGINS],
};

const consumerPorts = new Map(); // consumerId -> Port
let studioPort = null;
let nextConsumerSeq = 1;

chrome.storage?.local?.get(["vyraForceAllSites", "vyraAllowedStudioOrigins"], (res) => {
  if (res && typeof res.vyraForceAllSites === "boolean") {
    studioState.forceAllSites = res.vyraForceAllSites;
  }
  if (res && Array.isArray(res.vyraAllowedStudioOrigins) && res.vyraAllowedStudioOrigins.length > 0) {
    studioState.allowedOrigins = res.vyraAllowedStudioOrigins;
  }
});

function isAllowedStudioSender(sender) {
  const rawUrl = sender?.url || sender?.origin || "";
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (!studioState.allowedOrigins.includes(parsed.origin)) {
      return false;
    }
    // Must be on a VYRA Studio route (/app/studio or /studio)
    return parsed.pathname.startsWith("/app/studio") || parsed.pathname === "/studio";
  } catch {
    return false;
  }
}

function broadcastStatus() {
  const payload = {
    type: "vyra-cam:state",
    active: studioState.active && Boolean(studioPort),
    forceAllSites: studioState.forceAllSites,
    width: studioState.width,
    height: studioState.height,
    lookLabel: studioState.lookLabel,
    studioOrigin: studioState.studioOrigin,
  };
  for (const [id, port] of consumerPorts.entries()) {
    try {
      port.postMessage(payload);
    } catch {
      consumerPorts.delete(id);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "vyra-studio-producer") {
    // SECURITY: Verify chrome-verified sender.url origin & path before accepting producer connection.
    if (!isAllowedStudioSender(port.sender)) {
      try {
        port.postMessage({
          type: "vyra-cam:error",
          message: "Rejected: only an authorized VYRA Studio origin (/app/studio) can publish to the virtual camera.",
        });
        port.disconnect();
      } catch { /* ignore */ }
      return;
    }

    studioPort = port;
    studioState.active = true;
    studioState.studioTabId = port.sender?.tab?.id ?? null;
    try {
      studioState.studioOrigin = new URL(port.sender.url).origin;
    } catch {
      studioState.studioOrigin = null;
    }
    broadcastStatus();

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object" || studioPort !== port) return;

      if (msg.type === "vyra-cam:announce") {
        studioState.active = true;
        studioState.width = msg.width || 1280;
        studioState.height = msg.height || 720;
        studioState.lookLabel = msg.lookLabel || "";
        broadcastStatus();
      } else if (msg.type === "vyra-cam:stop") {
        studioState.active = false;
        broadcastStatus();
      } else if (msg.type === "vyra-cam:rtc-offer" || msg.type === "vyra-cam:rtc-ice") {
        // Relay WebRTC SDP offer / ICE candidate from verified Studio producer to specific consumer tab
        const target = consumerPorts.get(msg.consumerId);
        if (target) {
          try {
            target.postMessage(msg);
          } catch {
            consumerPorts.delete(msg.consumerId);
          }
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (studioPort === port) {
        studioPort = null;
        studioState.active = false;
        studioState.studioOrigin = null;
        broadcastStatus();
      }
    });
    return;
  }

  if (port.name === "vyra-cam-consumer") {
    const consumerId = `consumer-${nextConsumerSeq++}-${Date.now()}`;
    consumerPorts.set(consumerId, port);

    port.postMessage({
      type: "vyra-cam:state",
      consumerId,
      active: studioState.active && Boolean(studioPort),
      forceAllSites: studioState.forceAllSites,
      width: studioState.width,
      height: studioState.height,
      lookLabel: studioState.lookLabel,
      studioOrigin: studioState.studioOrigin,
    });

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (
        (msg.type === "vyra-cam:rtc-request" ||
          msg.type === "vyra-cam:rtc-answer" ||
          msg.type === "vyra-cam:rtc-ice") &&
        studioPort
      ) {
        try {
          studioPort.postMessage({ ...msg, consumerId });
        } catch {
          /* studio disconnected */
        }
      } else if (msg.type === "vyra-cam:set-force") {
        studioState.forceAllSites = Boolean(msg.forceAllSites);
        chrome.storage?.local?.set({ vyraForceAllSites: studioState.forceAllSites });
        broadcastStatus();
      } else if (msg.type === "vyra-cam:get-status") {
        port.postMessage({
          type: "vyra-cam:state",
          consumerId,
          active: studioState.active && Boolean(studioPort),
          forceAllSites: studioState.forceAllSites,
          width: studioState.width,
          height: studioState.height,
          lookLabel: studioState.lookLabel,
          studioOrigin: studioState.studioOrigin,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      consumerPorts.delete(consumerId);
      if (studioPort) {
        try {
          studioPort.postMessage({ type: "vyra-cam:consumer-closed", consumerId });
        } catch { /* ignore */ }
      }
    });
  }
});
