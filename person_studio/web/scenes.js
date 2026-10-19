"use strict";
// VYRA scene rules and voice commands.
// Scene rules watch the camera on this device (MediaPipe hand gestures and object detection, free and
// private) and fire actions: "when I raise my hand, switch the look". Voice commands turn speech into
// text with the browser's speech service and hand it to the page to act on.
(() => {
  const BASE = "/assets/vendor/mediapipe";
  const TRIGGERS = [
    { id: "gesture:Open_Palm", name: "You raise an open hand" },
    { id: "gesture:Thumb_Up", name: "You give a thumbs up" },
    { id: "gesture:Victory", name: "You make a peace sign" },
    { id: "gesture:Pointing_Up", name: "You point up" },
    { id: "gesture:Closed_Fist", name: "You make a fist" },
    { id: "object:cell phone", name: "A phone appears" },
    { id: "object:bottle", name: "A bottle appears" },
    { id: "object:cup", name: "A cup appears" },
    { id: "object:book", name: "A book appears" },
    { id: "object:laptop", name: "A laptop appears" },
    { id: "absent:person", name: "You leave the frame" },
  ];

  const loadScript = (src, global) => window[global] ? Promise.resolve(window[global]) : new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src });
    script.onload = () => (window[global] ? resolve(window[global]) : reject(new Error("The scene detector did not load.")));
    script.onerror = () => reject(new Error("The scene detector did not load."));
    document.head.append(script);
  });

  let models = null;
  function loadModels() {
    models ||= (async () => {
      const V = await loadScript(`${BASE}/vision.js`, "MPVision");
      const fileset = await V.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      const [gestures, objects] = await Promise.all([
        V.GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${BASE}/models/gesture_recognizer.task`, delegate: "CPU" }, runningMode: "VIDEO", numHands: 2 }),
        V.ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${BASE}/models/efficientdet_lite0.tflite`, delegate: "CPU" }, runningMode: "VIDEO",
          scoreThreshold: 0.45, maxResults: 8 }),
      ]);
      return { gestures, objects };
    })().catch((error) => { models = null; throw error; });
    return models;
  }

  // Everything visible in one frame, as trigger ids.
  async function signals(video, now) {
    if (Array.isArray(window.__vyraSceneSignals)) return new Set(window.__vyraSceneSignals); // tests drive this directly
    const { gestures, objects } = await loadModels();
    const seen = new Set();
    const g = gestures.recognizeForVideo(video, now);
    for (const hand of g.gestures || []) {
      const top = hand[0];
      if (top && top.score >= 0.6 && top.categoryName !== "None") seen.add(`gesture:${top.categoryName}`);
    }
    let person = false;
    for (const d of objects.detectForVideo(video, now).detections || []) {
      const name = d.categories?.[0]?.categoryName;
      if (name === "person") person = true;
      else if (name) seen.add(`object:${name}`);
    }
    if (!person) seen.add("absent:person");
    return seen;
  }

  // Runs rules against the camera. A trigger turns on when seen in 3 of the last 5 checks and off after
  // 1.5 s unseen, so a flicker never fires anything. Each rule waits 3 s before it can fire again.
  class SceneRunner {
    constructor(video, onFire, { intervalMs = 150 } = {}) {
      this.video = video; this.onFire = onFire; this.intervalMs = intervalMs;
      this.rules = []; this.history = new Map(); this.active = new Map(); this.lastFire = new Map();
      this.timer = null; this.busy = false; this.error = null;
    }
    setRules(rules) { this.rules = rules; }
    async start() {
      this.stop();
      await loadModels(); // surface loading errors to the caller
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    stop() { clearInterval(this.timer); this.timer = null; this.active.clear(); this.history.clear(); }
    async tick() {
      if (this.busy || !this.video.videoWidth || this.video.readyState < 2) return;
      this.busy = true;
      try {
        const now = performance.now();
        const seen = await signals(this.video, now);
        for (const trigger of new Set(this.rules.filter((r) => r.enabled).map((r) => r.trigger))) {
          const h = this.history.get(trigger) || { recent: [], lastSeen: 0 };
          h.recent = [...h.recent, seen.has(trigger)].slice(-5);
          if (seen.has(trigger)) h.lastSeen = now;
          this.history.set(trigger, h);
          const was = this.active.get(trigger) || false;
          const on = was ? now - h.lastSeen < 1500 : h.recent.filter(Boolean).length >= 3;
          if (on !== was) { this.active.set(trigger, on); this.changed(trigger, on, now); }
        }
      } catch (error) {
        this.error = error;
      } finally {
        this.busy = false;
      }
    }
    changed(trigger, on, now) {
      for (const rule of this.rules.filter((r) => r.enabled && r.trigger === trigger)) {
        if (on) {
          if (now - (this.lastFire.get(rule.id) || -Infinity) < 3000) continue;
          this.lastFire.set(rule.id, now);
          this.onFire(rule, true);
        } else if (rule.undo) {
          this.onFire(rule, false);
        }
      }
    }
  }

  // Speech to text through the browser (Chrome and Edge use Google's speech service; Safari uses Apple's).
  // "hold" listens only while a key or button is held; "handsfree" listens continuously for "Vyra, ...".
  class Commands {
    constructor(onCommand, onState) {
      this.onCommand = onCommand; this.onState = onState; this.mode = "off"; this.listening = false; this.holding = false;
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.supported = Boolean(Recognition);
      if (!Recognition) return;
      this.rec = new Recognition();
      this.rec.lang = navigator.language || "en-US";
      this.rec.interimResults = false;
      this.rec.maxAlternatives = 1;
      this.rec.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (!event.results[i].isFinal) continue;
          const text = event.results[i][0].transcript.trim();
          if (this.mode === "handsfree") {
            const match = /^(?:hey |ok |okay )?(?:vyra|vera|veera|vira|viera)\b[,.!]?\s*(.*)$/i.exec(text);
            if (match && match[1]) this.onCommand(match[1]);
          } else if (text) this.onCommand(text);
        }
      };
      this.rec.onstart = () => { this.listening = true; this.onState(this.state()); };
      this.rec.onend = () => {
        this.listening = false;
        if (this.mode === "handsfree") setTimeout(() => this.listen(), 300); // keep hands-free alive
        this.onState(this.state());
      };
      this.rec.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") { this.mode = "off"; this.blocked = true; }
        this.onState(this.state());
      };
    }
    state() {
      if (!this.supported) return "unsupported";
      if (this.blocked) return "blocked";
      if (this.mode === "off") return "off";
      return this.listening ? "listening" : this.mode === "hold" ? "ready" : "starting";
    }
    setMode(mode) {
      this.mode = mode; this.blocked = false;
      this.rec && (this.rec.continuous = mode === "handsfree");
      if (mode === "handsfree") this.listen(); else this.halt();
      this.onState(this.state());
    }
    listen() {
      if (!this.rec || this.listening || this.mode === "off") return;
      try { this.rec.start(); } catch { /* already starting */ }
    }
    halt() { if (this.rec && this.listening) { try { this.rec.stop(); } catch { /* not running */ } } }
    press() { if (this.mode !== "hold" || this.holding) return; this.holding = true; this.listen(); }
    release() { if (!this.holding) return; this.holding = false; setTimeout(() => this.halt(), 400); } // let the last word finish
  }

  window.VyraScenes = { TRIGGERS, SceneRunner, Commands, loadModels, signals };
})();
