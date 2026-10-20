# Notes

What we learned per milestone, especially measured numbers and device/browser quirks.

## Milestone 0 — ggwave spike (2026-10-20)

Environment: Node 24.19, `ggwave@0.4.0` (pinned), clean digital loopback (no channel impairments). Reproduce with `npm run spike` and `npm run spike:errors`.

### Binding behavior

- **Binary is clean.** `encode` takes a `Uint8Array` directly (embind's `std::string` accepts typed arrays and copies raw bytes). All 256 byte values, including `0x00`, round-trip. No base64 needed: the full 140 bytes per frame are usable.
- `encode` and `decode` return views into static WASM buffers. **Copy before the next call.**
- **More than 140 bytes is silently truncated to 140.** The adapter throws instead.
- **Max 4 live instances.** `init` past that returns an invalid handle, and the next `encode` aborts the WASM. The adapter frees before re-creating.
- **`decode` drops partial frames.** Each call must get a multiple of `samplesPerFrame` (1024) samples, or nothing ever decodes. The adapter buffers. (AudioWorklet delivers 128-sample quanta.)
- The binding `printf`s `n = ..., nActual = ...` on every encode; silenced by passing `{ print, printErr }` to the factory.
- The WASM is embedded as a base64 data URI in `ggwave.js`, so there is no separate `.wasm` to serve. Vite warns about `fs`/`path` externalization (Node-only branch); harmless.

### Sample rate

- 48 kHz → 48 kHz works, including with 500 ppm clock drift.
- **44.1 kHz input is fragile**: decoding succeeds or fails depending on chunk size (941 or 4096 OK, 1024 or 2048 fail), and even native 44.1k tx → 44.1k rx failed. Decision: create `AudioContext({ sampleRate: 48000 })` and let the browser resample the mic. *Needs confirming on real phones.*

### Airtime (48 kHz)

| Protocol | 33 B | 140 B |
|---|---|---|
| Normal (audible/ultrasound) | 3.75 s | 13.55 s |
| Fast | 2.73 s | 9.26 s |
| Fastest | 1.71 s | 4.97 s |
| DT Fast | 6.83 s | 26.15 s |
| DT Fastest | 3.75 s | 13.42 s |

On a full frame, Fastest moves ~28 B/s and Fast ~15 B/s. There is roughly 1 s of fixed marker overhead per transmission, which favors fuller frames.

### Reliability on clean loopback

25 random payloads per cell, random alignment against the 1024-sample grid; cells are "wrong data / nothing decoded":

| Protocol | 2 B | 3 B | 8 B | 16–140 B |
|---|---|---|---|---|
| audible-normal | 0/0 | 0/0 | 0/0 | ≤ 0/1 |
| audible-fast | 0/0 | 1/0 | 0/0 | ≤ 0/1 |
| audible-fastest | 4/0 | 8/0 | 0/0 | 0/0 |
| ultrasound-fastest | 4/0 | 8/0 | 0/0 | 0/0 |
| dt-fast | 2/0 | 0/0 | 1/2 | up to 0/7 |

- **ggwave can return wrong bytes (and wrong lengths) without signaling an error.** This happens mostly with 2–3 byte payloads, but an earlier fixed-alignment sweep also saw ~5% errors at 8–11 bytes on Fastest. Its Reed-Solomon parity is too short for tiny payloads. → Every frame needs our own integrity check, not only fountain messages.
- **DT_NORMAL never decodes**, so it's excluded from the protocol list. DT_FAST drops many frames.

## Manual test checklist (real devices)

- [ ] `AudioContext({ sampleRate: 48000 })` honored on Android Chrome / iOS Safari; decode works with the browser-resampled mic
- [ ] `getUserMedia` constraints actually applied (`track.getSettings()` shown in debug panel)
- [ ] Laptop → Android and Android → laptop, audible-fast, normal room
- [ ] iOS: ringer switch / silent mode effect on playback; `navigator.audioSession.type`
- [ ] iOS: output volume/routing while mic is active (matters for the v2 offer/answer)
