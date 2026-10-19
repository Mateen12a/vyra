# First GPU quality benchmark

The product goal remains **live, reference-guided full-person replacement**. A polished capture app and a successful clip generation do not establish that goal is achieved.

Use a single person, a fixed camera, even lighting, and a reference with a comparable visible body framing. Begin with one 6-second source clip and Preview mode. Record hardware, checkpoint revisions, source/reference filenames, options, processing duration, peak VRAM, and observations.

| Test | Look for |
| --- | --- |
| Still face, speaking, smiling | Target identity, stable eyes and teeth, mouth movement |
| Turn head left and right | Identity drift, changing hairline, profile failures |
| Raise both hands | Finger count, skin consistency, duplicated hands |
| Move hand across face | Correct occlusion order; no face pasted over the hand |
| Lean and turn torso | Outfit and body appearance consistency |
| Hair / shoulders near background | Clean boundaries, no leftover source silhouette |
| Moderate fast movement | Flicker, smearing, pose deviation |
| Remain still after motion | No gradual character or lighting drift |

Review original and result side by side, frame by frame where needed. Record failures with timestamps. Do not assume a visually attractive still frame means the clip passes.

After the clip model passes the agreed appearance checks, evaluate a streaming model with explicit reference conditioning. Candidates include StreamDiffusionV2 as a streaming foundation and Wan-Animate-2's streaming research, but neither has been validated in this app. A prompt-only restyling engine is insufficient to establish stable target-person replacement.

For the live phase, measure capture-to-display latency with visible source timestamps, generated frame throughput, dropped inputs, VRAM, 30-minute stability, and identity/occlusion quality. A **proposed acceptance target**, not a measured capability, is at least 24 generated FPS with a p95 delay below 500 ms for a single controlled scene at the selected resolution. Final targets depend on intended use and budget. Frame interpolation does not count as generated frame throughput.

Introduce a bounded latest-frame transport, session-specific temporal state, reference conditioning, cancellation, and GPU admission limits. Do not implement live video by repeatedly submitting independent clips: segment seams and multi-second buffering would misrepresent the live experience.
