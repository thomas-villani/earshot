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

### First over-the-air test (2026-10-20)

Laptop (Chrome) → Android phone (Chrome), audible-fast, 18-byte text, 1.83 s airtime: decoded byte-exact on the first try.

Android Chrome `track.getSettings()`: `echoCancellation`, `noiseSuppression`, `autoGainControl`, `voiceIsolation` all `false`; `sampleRate: 48000`, `sampleSize: 16`, `channelCount: 1`, `latency: 0.04`. Both AudioContexts reported 48000.

## Milestone 2 — channel simulator (2026-10-20)

`npm run sim -- [--trials N] [--only A,B,C,D,E]`. Chain: speaker low-pass → room impulse response (exponential noise tail, RT60 + direct-to-reverberant ratio) → ambient noise (white/pink) → mic high-pass → gain/clip → clock drift. Captured audio is fed to the modem in 2048-sample chunks, like the AudioWorklet. Numbers below are 30 trials per cell, so roughly ±9% sampling error.

**SNR convention:** broadband power of the *transmitted* signal vs ambient noise. A first version measured SNR after the speaker filter, which silently scaled noise down whenever the speaker attenuated the signal and made band-limiting free. Fixed.

### "Living room" SNR sweep (32 B; phone device, RT60 0.4 s, DRR 0 dB, pink noise, 50 ppm drift)

| protocol \ SNR dB | 10 | 0 | −5 | −10 | −15 |
|---|---|---|---|---|---|
| audible-normal | 100% | 93% | 90% | 27% | 0% |
| audible-fast | 100% | 100% | 87% | 47% | 0% |
| audible-fastest | 83% | 80% | 70% | 37% | 0% |
| ultrasound-normal | 100% | 100% | 97% | 100% | 53% |
| ultrasound-fast | 100% | 100% | 100% | 100% | 73% |
| ultrasound-fastest | 77% | 77% | 63% | 60% | 23% |
| dt-fast | 97% | 63% | 20% | 0% | 0% |
| dt-fastest | 70% | 80% | 7% | 0% | 0% |

### Reverb (32 B, phone device, 20 dB pink SNR)

| protocol \ RT60 (DRR) | 0.2 s (+3) | 0.4 s (0) | 0.8 s (−3) | 0.8 s (−9) |
|---|---|---|---|---|
| audible-normal | 100% | 100% | 90% | 70% |
| audible-fast | 100% | 100% | 43% | 13% |
| audible-fastest | 100% | 87% | 0% | 0% |
| ultrasound-fast | 100% | 100% | 27% | 10% |

### Payload length (audible, living room at 0 dB)

| protocol | len | airtime | success | goodput |
|---|---|---|---|---|
| audible-fast | 16 | 1.83 s | 97% | 8.4 B/s |
| audible-fast | 64 | 4.65 s | 87% | 11.9 B/s |
| audible-fast | 140 | 9.26 s | 93% | 14.1 B/s |
| audible-fastest | 16 | 1.26 s | 80% | 10.2 B/s |
| audible-fastest | 64 | 2.67 s | 73% | 17.6 B/s |
| audible-fastest | 140 | 4.97 s | 63% | 17.8 B/s |

### Conclusions

- **Reverb, not noise, is the main enemy.** Fast breaks down at RT60 0.8 s; Normal holds up best (longer symbols ride out the echo tail). Fastest already loses frames at 0.4 s, a typical living room.
- **Fastest is unreliable even in good conditions** (~75–85% at 10 dB). Default stays **audible-fast**: 100% down to 0 dB in the living-room model.
- **Use full frames.** Per-frame success barely depends on length, while each transmission pays ~1 s of fixed overhead, so goodput rises with payload size. Fountain block size defaults to the max (129 B), not the ~64 B originally guessed.
- **Ultrasound beats audible against pink noise**, because room/TV noise has little energy above 15 kHz. That only holds if the phone speaker actually reproduces 15–19.5 kHz; our simple low-pass profiles can't settle that. **Real-device test required** before choosing a default.
- **DT protocols are the weakest everywhere.** Candidates to hide from the picker.
- **No wrong-data decodes** for payloads ≥ 16 B across ~5,000 trials; the per-frame CRC remains cheap insurance for the small-payload failures seen in milestone 0.
- **Decode latency is ~0**: frames decode ~0.2 s *before* the waveform buffer ends (ggwave pads the tail). So perceived delay on devices is airtime, plus whatever the browser adds.

## Milestone 3 — typed messages + UI (2026-10-20)

- Frame header is 6 bytes (magic, kind, nonce, CRC-16), leaving 134 bytes per SINGLE message (132 of payload after type+flags). Longer messages are refused until fountain coding lands.
- **Compression only pays off above ~100 bytes** (`spike/compression.ts`, deflate-raw via CompressionStream):

  | sample | raw | deflate |
  |---|---|---|
  | short text | 31 B | 33 B (+6%) |
  | URL | 41 B | 43 B (+5%) |
  | long Maps URL | 86 B | 86 B |
  | contact JSON | 103 B | 95 B (−8%) |
  | Wi-Fi string | 61 B | 63 B (+3%) |
  | prompt JSON | 94 B | 82 B (−13%) |
  | paragraph | 244 B | 153 B (−37%) |

  "Compress only if smaller" handles this. **Future experiment:** a static dictionary for short messages (`https://`, `www.`, `.com`, JSON keys) via a second flags bit; `https://` alone is 8 bytes ≈ 0.5 s of Fast airtime.
- Untrusted input: URL cards only for http(s) (anything else renders as text); decompression capped at 64 KB; vCard values escaped and line breaks stripped (prevents property injection); all rendering via text nodes.
- No web API can add a contact or join Wi-Fi. Contacts use a generated `.vcf` (download) plus the share sheet with the file where `navigator.canShare({ files })` allows it. Prompts go through `navigator.share({ text })`, whose system sheet lists the installed assistant apps.
- Headless Edge (`msedge --headless=new --screenshot`) is handy for layout checks; its window can't go narrower than ~500 px, so 390 px screenshots look cropped. Dev-only `#listen-demo` hash shows sample cards.

### Field notes (2026-10-20, Android + laptop)

- Share sheet works as hoped (prompt → assistant apps).
- Longer single-frame messages decode fine even with deliberate noise and talking over them.

## Dual-band spike (2026-10-20): audible + ultrasound at the same time

`npx tsx spike/dual-band.ts`. Audible-fast and ultrasound-fast occupy disjoint bands (1.9–6.4 kHz vs 15–19.5 kHz), so two transmissions can be summed into one waveform.

- `rxToggleProtocol` is global but **captured per instance at `init`**, so we can create one audible-only and one ultrasound-only decoder. On a clean mix each decodes its own frame. A single all-protocol decoder only gets one of the two.
- Living room model, 64 B per band, same *total* transmit power (each band at −3 dB), 30 trials:

  | SNR | audible alone | ultra alone | dual: audible | dual: ultra | dual goodput vs best single |
  |---|---|---|---|---|---|
  | 10 | 100% | 100% | 100% | 100% | 2.00× |
  | 0 | 100% | 100% | 97% | 100% | 1.97× |
  | −5 | 87% | 100% | 70% | 100% | 1.70× |
  | −10 | 30% | 87% | 3% | 80% | 0.96× |

- Conclusion: ~2× throughput in ordinary conditions, breaking even only when it's very noisy. Pairs naturally with fountain coding (each band carries different blocks; the receiver doesn't care which band a block came from). Receivers should always run both decoders.
- Not modeled: speaker nonlinearity / intermodulation when playing both bands loudly. **Real-phone test needed.**

## Milestone 4 — fountain coding + dual band (2026-10-20)

End-to-end simulator (`npm run sim -- --only F,G`), living room model, broadcast mode with 200 ms gaps between rounds, 12 trials per cell. Median seconds of listening until the whole message decodes:

| message | mode | 10 dB | 0 dB | −5 dB | 0 dB, late joiner |
|---|---|---|---|---|---|
| 100 B | audible-fast | 6 s | 6 s | 6 s | 9 s |
| 100 B | dual fast | 6 s | 6 s | 6 s | 10 s |
| 500 B | audible-fast | 25 s | 25 s | 25 s | 40 s |
| 500 B | ultrasound-fast | 25 s | 25 s | 25 s | 38 s |
| 500 B | dual fast | 16 s | 16 s | 25 s | 28 s |
| 1500 B | audible-fast | 71 s | 71 s | 89 s | 101 s |
| 1500 B | ultrasound-fast | 71 s | 71 s | 71 s | 84 s |
| 1500 B | dual fast | 35 s | 35 s | 44 s | 56 s |

Block size (500 B, audible-fast): 129 B → 25 s, 64 B → 32 s, 32 B → 41 s (61 s at −5 dB). **Full-size blocks win**, confirming the milestone 2 conclusion end to end.

- Back-to-back rounds with a 200 ms gap decode reliably; every trial completed.
- **Dual band halves delivery time for long messages** (1500 B: 71 → 35 s). At 500 B (k = 4) the gain is 25 → 16 s, limited by rounding to whole rounds. Single-frame messages gain only diversity, not speed.
- Late joiners pay roughly one extra round plus the partial round they walked in on.
- The v1 target "500-byte broadcast" lands at ~16 s in the model (dual fast).

## Manual test checklist (real devices)

- [x] `AudioContext({ sampleRate: 48000 })` honored on Android Chrome (laptop Chrome too)
- [ ] ...and on iOS Safari
- [x] `getUserMedia` constraints applied on Android Chrome
- [ ] ...and on iOS Safari
- [x] Laptop → Android, audible-fast, normal room
- [x] Ultrasound over the air, laptop → Android, quiet office with good acoustics: works well (the laptop speaker and phone mic do handle 15–19.5 kHz)
- [ ] audible-fastest over the air
- [ ] With a TV on: audible-fast vs ultrasound-fast (simulator predicts ultrasound wins if the speaker reproduces it)
- [ ] Big echoey room (kitchen/hallway): audible-normal vs audible-fast (simulator predicts Fast fails at RT60 ~0.8 s)
- [x] Ultrasound from a *phone* speaker: Android → laptop and laptop → Android both flawless (quiet office)
- [x] Android → laptop (audible and ultrasound)
- [ ] Contact card "Add to contacts" (.vcf download): Android offers import? iOS shows contact preview?
- [ ] Contact card "Share" with .vcf file: does Chrome allow text/vcard in the share sheet?
- [ ] "Pick from my contacts" (Contact Picker API) on Android Chrome
- [ ] Prompt card "Send to assistant…": share sheet lists Claude/Gemini/etc. and they receive the text
- [ ] Repeated message bumps "heard N×" instead of adding a card
- [ ] Phone → phone: dual fast vs audible-fast on a ~400 B message (expect ~2× faster); listen for distortion when both bands play loudly
- [ ] Late joiner: start Broadcast, begin listening ~20 s later, still decodes
- [ ] Three listeners (laptop + 2 phones) receive one ~500 B broadcast (v1 "done" criterion)
- [ ] Screen Wake Lock keeps a broadcast going on Android
- [x] URL timing: 40 B on audible-normal felt like ~4–6 s by hand, consistent with 4.4 s airtime. No hidden device latency.
- [ ] iOS: ringer switch / silent mode effect on playback; `navigator.audioSession.type`
- [ ] iOS: output volume/routing while mic is active (matters for the v2 offer/answer)
