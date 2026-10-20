"use strict";
(() => {
  const badge = document.getElementById("statusBadge");
  const lookText = document.getElementById("lookText");
  const forceCheck = document.getElementById("forceCheck");

  const port = chrome.runtime.connect({ name: "vyra-cam-consumer" });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "vyra-cam:state") return;
    badge.textContent = msg.active ? "Live" : "Standby";
    badge.className = `badge${msg.active ? " live" : ""}`;
    lookText.textContent = msg.active
      ? `Streaming ${msg.width || 1280}×${msg.height || 720}${msg.lookLabel ? " · " + msg.lookLabel : ""}`
      : "Open VYRANI Studio and turn on Virtual Camera.";
    forceCheck.checked = Boolean(msg.forceAllSites);
  });

  forceCheck.addEventListener("change", () => {
    port.postMessage({ type: "vyra-cam:set-force", forceAllSites: forceCheck.checked });
  });

  port.postMessage({ type: "vyra-cam:get-status" });
})();
