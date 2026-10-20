"use strict";
// VYRANI voices: free, on-device voice effects built on the Web Audio API.
// The microphone never leaves the browser: it is not sent to fal or Decart, only mixed
// into recordings, delayed so the voice lines up with the AI video.
(() => {
  // Live voices, processed on this device. Male and Female adapt to the speaker's own pitch.
  const VOICES = [
    { id: "off", name: "Off", note: "Silent recording" },
    { id: "natural", name: "Natural", note: "Your own voice" },
    { id: "male", name: "Male", note: "Lower pitch and tone" },
    { id: "female", name: "Female", note: "Higher pitch and tone" },
    { id: "deep", name: "Deep", note: "Heavy and slow" },
    { id: "cartoon", name: "Cartoon", note: "Small and bright" },
    { id: "robot", name: "Robot", note: "Metallic machine" },
    { id: "radio", name: "Radio", note: "Walkie-talkie" },
    { id: "monster", name: "Monster", note: "Growling giant" },
    { id: "cave", name: "Cave", note: "Big echo" },
  ];
  const MAX_DELAY_S = 2;

  function softClip(amount) {
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  // Each effect is a small chain of nodes from `input` to `output`.
  function buildEffect(ctx, id, pitchReady) {
    const nodes = [], sources = [];
    const add = (node) => { nodes.push(node); return node; };
    const chain = (...list) => { for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]); return list; };
    const shift = (processorOptions) => add(pitchReady
      ? new AudioWorkletNode(ctx, "vyra-shift", { outputChannelCount: [1], processorOptions })
      : new GainNode(ctx)); // no worklet support: the effect keeps its tone shaping, without the pitch change
    const filter = (type, frequency, gain = 0, Q = 0.7) => add(new BiquadFilterNode(ctx, { type, frequency, gain, Q }));
    const gain = (value) => add(new GainNode(ctx, { gain: value }));
    const input = gain(1), output = gain(1);

    switch (id) {
      case "male":
        chain(input, shift({ targetHz: 115 }), filter("lowshelf", 200, 2), output); break;
      case "female":
        chain(input, shift({ targetHz: 215 }), filter("highshelf", 4000, 1.5), output); break;
      case "deep":
        chain(input, shift({ pitch: 0.75, formant: 0.86 }), filter("lowshelf", 220, 4), output); break;
      case "cartoon":
        chain(input, shift({ pitch: 1.6, formant: 1.3 }), output); break;
      case "monster":
        chain(input, shift({ pitch: 0.58, formant: 0.74 }), filter("lowshelf", 180, 6), add(new WaveShaperNode(ctx, { curve: softClip(3), oversample: "2x" })), gain(0.8), output); break;
      case "robot": {
        // Ring modulation (voice × 55 Hz sine) plus a short metallic comb.
        const ring = add(new GainNode(ctx, { gain: 0 }));
        const osc = new OscillatorNode(ctx, { type: "sine", frequency: 55 }); sources.push(osc);
        osc.connect(ring.gain); osc.start();
        const comb = add(new DelayNode(ctx, { delayTime: 0.009 })), feedback = gain(0.45);
        chain(input, ring, comb, feedback, comb); ring.connect(output); comb.connect(output);
        break;
      }
      case "radio":
        chain(input, filter("highpass", 450), filter("lowpass", 3200), filter("peaking", 1600, 7, 1.2),
          add(new WaveShaperNode(ctx, { curve: softClip(4) })), gain(0.7), output); break;
      case "cave": {
        const echo = add(new DelayNode(ctx, { delayTime: 0.24 })), feedback = gain(0.42), wet = gain(0.55), damp = filter("lowpass", 2400);
        input.connect(output);
        chain(input, echo, damp, feedback, echo); damp.connect(wet); wet.connect(output);
        break;
      }
      default:
        input.connect(output);
    }
    return { input, output, stop() { sources.forEach((s) => s.stop()); [...nodes, ...sources].forEach((n) => n.disconnect()); } };
  }

  class VoiceRig {
    constructor(ctx, mic, pitchReady, owned) {
      this.ctx = ctx; this.mic = mic; this.pitchReady = pitchReady; this.owned = owned; this.effect = null; this.id = null;
      this.source = new MediaStreamAudioSourceNode(ctx, { mediaStream: mic });
      this.analyser = new AnalyserNode(ctx, { fftSize: 1024 });
      this.levelData = new Float32Array(this.analyser.fftSize);
      this.bus = new DynamicsCompressorNode(ctx, { threshold: -20, ratio: 4, attack: 0.005, release: 0.15 });
      this.monitorGain = new GainNode(ctx, { gain: 0 });
      this.delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY_S, delayTime: 0 });
      this.recordGain = new GainNode(ctx, { gain: 1 });
      this.destination = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
      this.source.connect(this.analyser);
      // Hearing yourself is never delayed (delayed feedback makes speaking hard); the recording is.
      this.bus.connect(this.monitorGain).connect(ctx.destination);
      this.bus.connect(this.delay).connect(this.recordGain).connect(this.destination);
    }
    setEffect(id) {
      if (id === this.id) return;
      this.effect?.stop(); this.source.disconnect();
      this.source.connect(this.analyser);
      this.id = id;
      this.effect = buildEffect(this.ctx, id, this.pitchReady);
      this.source.connect(this.effect.input);
      this.effect.output.connect(this.bus);
    }
    setMuted(on) {
      this.recordGain.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
      if (on) this.monitorGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
    setMonitor(on) { this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.03); }
    setDelay(ms) {
      const seconds = Math.min(MAX_DELAY_S, Math.max(0, ms / 1000));
      this.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.25); // glide: no clicks
      this.delayMs = seconds * 1000;
    }
    level() {
      this.analyser.getFloatTimeDomainData(this.levelData);
      let sum = 0;
      for (const v of this.levelData) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / this.levelData.length) || 1e-6);
      return Math.min(1, Math.max(0, (db + 60) / 54)); // -60 dB (silence) to -6 dB (loud speech)
    }
    track() { return this.destination.stream.getAudioTracks()[0]; }
    resume() { return this.ctx.state === "suspended" ? this.ctx.resume() : Promise.resolve(); }
    close() {
      this.effect?.stop();
      [this.source, this.analyser, this.bus, this.monitorGain, this.delay, this.recordGain].forEach((n) => n.disconnect());
      this.mic.getTracks().forEach((t) => t.stop());
      if (this.owned) this.ctx.close().catch(() => {});
    }
  }

  // Pass a context created during the user's click: browsers start audio paused when it is created later.
  const loaded = new WeakMap();
  async function create(mic, shared) {
    const ctx = shared || new AudioContext({ latencyHint: "interactive" });
    if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule("/assets/voice-worklet.js").then(() => true, () => false));
    const pitchReady = await loaded.get(ctx); // false: effects still work, without the pitch change
    const rig = new VoiceRig(ctx, mic, pitchReady, !shared);
    await rig.resume();
    return rig;
  }

  // Measures how far the AI video trails the camera by matching motion in both:
  // every movement shows up in the camera first and in the AI output a moment later.
  class LagMeter {
    constructor(camVideo, aiVideo, { intervalMs = 33, windowS = 6, maxLagMs = 1500 } = {}) {
      this.cam = camVideo; this.ai = aiVideo; this.intervalMs = intervalMs;
      this.size = Math.round((windowS * 1000) / intervalMs); this.maxLag = Math.round(maxLagMs / intervalMs);
      this.canvas = document.createElement("canvas"); this.canvas.width = 32; this.canvas.height = 18;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.prev = { cam: null, ai: null }; this.camSeries = []; this.aiSeries = []; this.times = [];
      this.timer = null;
    }
    start() { this.stop(); this.timer = setInterval(() => this.sample(), this.intervalMs); return this; }
    stop() { clearInterval(this.timer); this.timer = null; }
    gray(video) {
      this.ctx.drawImage(video, 0, 0, 32, 18);
      const data = this.ctx.getImageData(0, 0, 32, 18).data, out = new Float32Array(32 * 18);
      for (let i = 0; i < out.length; i++) out[i] = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11;
      return out;
    }
    motion(key, video) {
      if (!video.videoWidth) return 0;
      const frame = this.gray(video), prev = this.prev[key];
      this.prev[key] = frame;
      if (!prev) return 0;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += Math.abs(frame[i] - prev[i]);
      return sum / frame.length;
    }
    sample() {
      try {
        this.camSeries.push(this.motion("cam", this.cam)); this.aiSeries.push(this.motion("ai", this.ai)); this.times.push(performance.now());
      } catch { return; }
      if (this.camSeries.length > this.size) { this.camSeries.shift(); this.aiSeries.shift(); this.times.shift(); }
    }
    estimate() {
      if (this.camSeries.length < this.size * 0.75) return null;
      const step = (this.times.at(-1) - this.times[0]) / (this.times.length - 1);
      const found = bestLag(this.camSeries, this.aiSeries, this.maxLag);
      return found && { ms: found.lag * step, confidence: found.r };
    }
  }

  // Lag (in samples) at which `late` best matches `early`, by Pearson correlation of smoothed series.
  function bestLag(early, late, maxLag) {
    const smooth = (s) => s.map((_, i) => (s[i - 1] ?? s[i]) / 4 + s[i] / 2 + (s[i + 1] ?? s[i]) / 4);
    const a = smooth(early), b = smooth(late);
    let best = null;
    for (let lag = 0; lag <= maxLag && lag < a.length - 30; lag++) {
      const n = a.length - lag;
      let sa = 0, sb = 0;
      for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i + lag]; }
      const ma = sa / n, mb = sb / n;
      let cov = 0, va = 0, vb = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i + lag] - mb; cov += x * y; va += x * x; vb += y * y; }
      if (!va || !vb) continue;
      const r = cov / Math.sqrt(va * vb);
      if (!best || r > best.r) best = { lag, r };
    }
    return best;
  }

  window.VyraVoice = { VOICES, create, buildEffect, LagMeter, bestLag };
})();
