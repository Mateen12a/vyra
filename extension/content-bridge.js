"use strict";
// ISOLATED world content bridge.
// Only opens a producer port if the current document is on an allowed VYRANI Studio route (/app/studio or /studio),
// and the background service worker independently verifies `port.sender.url` against the allowed origin list.
(() => {
  let consumerPort = null;
  let producerPort = null;

  const isStudioRoute =
    location.pathname.startsWith("/app/studio") || location.pathname === "/studio";

  function ensureConsumerPort() {
    if (consumerPort) return consumerPort;
    try {
      consumerPort = chrome.runtime.connect({ name: "vyra-cam-consumer" });
      consumerPort.onMessage.addListener((msg) => {
        window.postMessage({ source: "vyra-ext-bridge-v2", payload: msg }, window.location.origin);
      });
      consumerPort.onDisconnect.addListener(() => {
        consumerPort = null;
      });
    } catch {
      consumerPort = null;
    }
    return consumerPort;
  }

  function ensureProducerPort() {
    if (!isStudioRoute) return null;
    if (producerPort) return producerPort;
    try {
      producerPort = chrome.runtime.connect({ name: "vyra-studio-producer" });
      producerPort.onMessage.addListener((msg) => {
        window.postMessage({ source: "vyra-ext-studio-in-v2", payload: msg }, window.location.origin);
      });
      producerPort.onDisconnect.addListener(() => {
        producerPort = null;
      });
    } catch {
      producerPort = null;
    }
    return producerPort;
  }

  // Studio publishes video; it must not start a second connection consuming its own output.
  if (!isStudioRoute) ensureConsumerPort();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin || !event.data || typeof event.data !== "object") {
      return;
    }
    const { source, payload } = event.data;
    if (source === "vyra-studio-page-v2") {
      if (!isStudioRoute) return;
      const port = ensureProducerPort();
      try {
        port?.postMessage(payload);
      } catch {
        producerPort = null;
      }
    } else if (source === "vyra-consumer-page-v2") {
      const port = ensureConsumerPort();
      try {
        port?.postMessage(payload);
      } catch {
        consumerPort = null;
      }
    }
  });
})();
