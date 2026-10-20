"use strict";
// VYRANI pixel art: ordered (Bayer) dithering drawn at low resolution and scaled up with crisp pixels.
// Used for the idle stage and for look placeholders until a real frame from the user's session exists.
(() => {
  const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((v) => (v + 0.5) / 64);
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // Ground, three accent steps and the text colour, read from the active palette.
  function palette() {
    const css = getComputedStyle(document.documentElement);
    const hex = (name, fallback) => {
      const m = /#([0-9a-f]{6})/i.exec(css.getPropertyValue(name)) || [null, fallback];
      return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    };
    const ground = hex("--ground", "0b0b0c"), accent = hex("--accent", "ff6b2b"), text = hex("--text", "f1eee8");
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return [ground, mix(ground, accent, 0.22), mix(ground, accent, 0.55), accent, text];
  }

  function paint(canvas, field, colours = palette()) {
    const { width: w, height: h } = canvas;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(w, h), px = image.data, steps = colours.length - 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = clamp(field(x / w, y / h, x, y)) * steps;
        const base = Math.floor(v);
        const c = colours[Math.min(steps, base + (v - base > BAYER[((y & 7) << 3) | (x & 7)] ? 1 : 0))];
        const i = (y * w + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  // A lit head-and-shoulders figure; a slow band sweeps across it and lifts the tones it passes,
  // as if the figure were being restyled line by line.
  function portrait(aspect, sweep, center) {
    return (u, v) => {
      const x = (u - center) * aspect, y = v;
      const head = Math.hypot(x / 0.14, (y - 0.4) / 0.18);
      const shoulders = Math.hypot(x / 0.4, (y - 0.98) / 0.3);
      const neck = Math.abs(x) < 0.055 && y > 0.52 && y < 0.7;
      const hair = head < 1.06 && y < 0.27 + Math.abs(x) * 0.7;
      const inside = head < 1 || shoulders < 1 || neck || hair;
      // Light from the upper left.
      const light = clamp(0.95 - Math.hypot(x + 0.12, y - 0.3) * 1.25);
      const rim = head < 1 ? clamp((head - 0.82) * 5) * 0.35 : 0;
      let value = hair ? 0.3 + light * 0.2 : inside ? 0.22 + light * 0.62 + rim : clamp(0.16 - Math.hypot(x, y - 0.55) * 0.18);
      if (sweep != null) {
        const d = u + v * 0.35 - sweep;
        if (d > -0.035 && d < 0.035) value = inside ? 1 : value + 0.18;
        else if (d < 0 && inside) value = Math.min(0.78, value + 0.12);
      }
      return value;
    };
  }

  function idle(canvas) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame = 0, timer = null;
    const draw = () => {
      // Match the canvas to the stage's shape (16:9 on desktop, 3:4 on phones) so the figure never stretches.
      const box = canvas.getBoundingClientRect();
      if (box.width && box.height) {
        const height = Math.max(60, Math.min(260, Math.round((160 * box.height) / box.width)));
        if (canvas.width !== 160 || canvas.height !== height) { canvas.width = 160; canvas.height = height; }
      }
      const t = (frame++ % 140) / 140;
      // On wide stages the figure stands right of centre, clear of the start card.
      const aspect = canvas.width / canvas.height;
      paint(canvas, portrait(aspect, reduce ? null : -0.2 + t * 1.8, aspect > 1.2 ? 0.66 : 0.5));
    };
    draw();
    return {
      redraw: draw,
      start() { draw(); if (!timer && !reduce) timer = setInterval(() => { if (!document.hidden && canvas.isConnected && canvas.offsetParent) draw(); }, 90); },
      stop() { clearInterval(timer); timer = null; },
    };
  }

  // A small abstract tile per look name, stable across visits.
  function tile(canvas, name) {
    let seed = 2166136261;
    for (const ch of name) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0) / 4294967296);
    const blobs = Array.from({ length: 4 }, () => ({ x: rand(), y: rand(), r: 0.18 + rand() * 0.35, k: 0.5 + rand() * 0.5 }));
    const tilt = rand() * 0.6 - 0.3;
    paint(canvas, (u, v) => {
      let value = 0.08 + (v + u * tilt) * 0.12;
      for (const b of blobs) value += b.k * clamp(1 - Math.hypot((u - b.x) * 1.7, v - b.y) / b.r) * 0.7;
      return value;
    });
  }

  // The chosen palette is applied before anything is drawn.
  const PALETTES = ["signal", "lime", "ice", "gold"];
  try { const saved = localStorage.getItem("vyra.palette"); if (PALETTES.includes(saved)) document.documentElement.dataset.palette = saved; } catch { /* storage blocked */ }

  // Before/after: the figure in camera tones, restyled into a look's colours behind a sweeping band.
  // `sweep` runs from about -0.2 (all camera) to 1.6 (all look). Colours are five [r, g, b] steps, dark to light.
  function transform(canvas, from, to, sweep, center = 0.5) {
    const aspect = canvas.width / canvas.height;
    const field = portrait(aspect, null, center);
    const { width: w, height: h } = canvas;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(w, h), px = image.data, steps = 4;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h;
        const d = u + v * 0.35 - sweep;
        const band = d > -0.03 && d < 0.03;
        const colours = d < 0 ? to : from;
        const value = clamp(field(u, v)) * steps;
        const base = Math.floor(value);
        const c = band ? to[4] : colours[Math.min(steps, base + (value - base > BAYER[((y & 7) << 3) | (x & 7)] ? 1 : 0))];
        const i = (y * w + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  window.VyraPixel = { paint, idle, tile, palette, transform, PALETTES };
})();
