"use strict";
// VYRANI voice shifter (PSOLA). It tracks the speaker's pitch, then re-lays one-period grains at a new
// spacing (pitch) and resamples each grain (formants: the size of the "voice box"). Changing both is
// what turns a voice male or female instead of just faster or slower. About 50 ms of delay, no network.
//
// processorOptions:
//   pitch    fixed pitch ratio (used when targetHz is 0)
//   targetHz glide the speaker's typical pitch to this frequency (Male ~115 Hz, Female ~215 Hz)
//   formant  formant ratio; 0 means "follow the pitch change" (ratio ** 0.25)
const MIN_HZ = 70, MAX_HZ = 450;

class VyraShift extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.fixedPitch = o.pitch || 1;
    this.targetHz = o.targetHz || 0;
    this.fixedFormant = o.formant || 0;
    const sr = sampleRate;
    this.size = 1 << 15; this.mask = this.size - 1;
    this.input = new Float32Array(this.size);
    this.acc = new Float32Array(this.size);
    this.weight = new Float32Array(this.size);
    this.t = 0; // samples received
    this.latency = Math.round(sr * 0.05); // > 2 periods + 1 grain half at the lowest pitch
    this.unvoiced = Math.round(sr * 0.01);
    // Pitch tracking runs on a ~12 kHz copy of the signal (YIN difference function).
    this.dec = Math.max(1, Math.round(sr / 12000)); this.decRate = sr / this.dec;
    this.decSize = 4096; this.decBuf = new Float32Array(this.decSize); this.decN = 0; this.decAcc = 0; this.decCount = 0;
    this.win = Math.round(this.decRate * 0.03);
    this.minLag = Math.floor(this.decRate / MAX_HZ); this.maxLag = Math.ceil(this.decRate / MIN_HZ);
    this.diff = new Float32Array(this.maxLag + 2);
    this.hop = Math.round(sr * 0.01); this.sinceTrack = 0;
    this.period = 0; // samples; 0 while unvoiced
    this.misses = 0;
    this.history = []; // recent voiced pitches (Hz) for the speaker's typical pitch
    this.ratio = this.targetHz ? this.targetHz / 140 : this.fixedPitch;
    this.syn = this.latency; this.ana = this.latency;
  }
  track() {
    const n = this.win + this.maxLag;
    if (this.decN < n) return;
    const x = (i) => this.decBuf[(this.decN - n + i) & (this.decSize - 1)];
    let energy = 0;
    for (let j = 0; j < this.win; j++) energy += x(j) * x(j);
    if (energy / this.win < 1e-5) { this.period = 0; return; }
    let running = 0, best = -1;
    for (let tau = 1; tau <= this.maxLag; tau++) {
      let d = 0;
      for (let j = 0; j < this.win; j++) { const v = x(j) - x(j + tau); d += v * v; }
      running += d;
      this.diff[tau] = running ? (d * tau) / running : 1;
    }
    for (let tau = this.minLag; tau < this.maxLag; tau++) {
      if (this.diff[tau] < 0.2) {
        while (tau + 1 < this.maxLag && this.diff[tau + 1] < this.diff[tau]) tau++;
        best = tau; break;
      }
    }
    // Brief tracking dropouts inside a vowel keep the last pitch, so grains stay pitch-synchronous.
    if (best < 0) { if (++this.misses > 3) this.period = 0; return; }
    this.misses = 0;
    const a = this.diff[best - 1], b = this.diff[best], c = this.diff[best + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    this.period = (best + Math.max(-0.5, Math.min(0.5, shift))) * this.dec;
    this.history.push(sampleRate / this.period);
    if (this.history.length > 250) this.history.shift();
    if (this.targetHz && this.history.length >= 20 && this.history.length % 10 === 0) {
      const sorted = [...this.history].sort((p, q) => p - q);
      const typical = sorted[sorted.length >> 1];
      const want = Math.min(2.5, Math.max(0.45, this.targetHz / typical));
      this.ratio += (want - this.ratio) * 0.5; // glide, so the voice never jumps
    }
  }
  sample(pos) {
    const i = Math.floor(pos), f = pos - i;
    const a = this.input[i & this.mask], b = this.input[(i + 1) & this.mask];
    return a + (b - a) * f;
  }
  grain(center, period, formant, at) {
    const half = period / formant;
    const start = Math.ceil(at - half), end = Math.floor(at + half);
    for (let s = start; s <= end; s++) {
      const k = s - at;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / half);
      const idx = s & this.mask;
      this.acc[idx] += this.sample(center + k * formant) * w;
      this.weight[idx] += w;
    }
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.length) return true;
    const out = output[0], len = out.length, start = this.t;
    for (let n = 0; n < len; n++) {
      const v = input ? input[n] : 0;
      this.input[(this.t + n) & this.mask] = v;
      this.decAcc += v; this.decCount++;
      if (this.decCount === this.dec) { this.decBuf[this.decN++ & (this.decSize - 1)] = this.decAcc / this.dec; this.decAcc = 0; this.decCount = 0; }
    }
    this.t += len;
    this.sinceTrack += len;
    if (this.sinceTrack >= this.hop) { this.sinceTrack = 0; this.track(); }

    const pitch = this.targetHz ? this.ratio : this.fixedPitch;
    const formant = this.fixedFormant || Math.min(1.25, Math.max(0.8, pitch ** 0.25));
    // Lay grains whose input is fully available; output trails input by `latency`.
    while (true) {
      const voiced = this.period > 0;
      const period = voiced ? this.period : this.unvoiced;
      if (this.syn + 2 * period + 1 > this.t) break;
      while (this.ana + period / 2 < this.syn) this.ana += period;
      if (this.ana - this.syn > period) this.ana = this.syn;
      this.grain(this.ana, period, formant, Math.round(this.syn));
      this.syn += voiced ? period / pitch : period;
    }
    for (let n = 0; n < len; n++) {
      const idx = (start + n - this.latency) & this.mask;
      const w = this.weight[idx];
      out[n] = start + n < this.latency ? 0 : this.acc[idx] / (w > 1 ? w : 1);
      this.acc[idx] = 0; this.weight[idx] = 0;
    }
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}
registerProcessor("vyra-shift", VyraShift);
