# Bundled third-party code

`decart-sdk.js` is an esbuild IIFE bundle (global `DecartSDK`) of:

- `@decartai/sdk` 0.2.8 — MIT License, Decart
- `livekit-client` ~2.20 — Apache License 2.0, LiveKit Inc.
- `zod`, `jose`, `mitt`, `p-retry` — MIT License

Rebuild with `npm run build:live-sdk`.

`msgpack.js` is an esbuild IIFE bundle (global `MessagePack`) of:

- `@msgpack/msgpack` 3.1.3 — ISC License, The MessagePack community

It encodes the fal realtime signalling frames used by `fal-live.js`.

`mediabunny.js` is an esbuild IIFE bundle (global `Mediabunny`) of:

- `mediabunny` 1.60.0 — Mozilla Public License 2.0, Vanilagy

It puts an AI accent voice into a recorded MP4 without re-encoding the video, and loads only when that is used.
Rebuild with `npm run build:media`.

`mediapipe/vision.js` is an esbuild IIFE bundle (global `MPVision`) of `@mediapipe/tasks-vision` 1.0.1
(Apache License 2.0, Google LLC). `mediapipe/wasm/` holds its WebAssembly runtime from the same package.
`mediapipe/models/` holds Google's MediaPipe models (Apache License 2.0), downloaded on 2026-10-11 from
storage.googleapis.com/mediapipe-models:

- `gesture_recognizer.task` (float16, v1) — sha256 97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482
- `efficientdet_lite0.tflite` (int8, v1) — sha256 0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb

They power scene rules on the user's device and load only when rules are switched on. Rebuild with `npm run build:vision`.
