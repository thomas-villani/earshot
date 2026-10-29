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

## Text compression (2026-10-20)

Static-model compressor for short messages (`src/compress/`): byte-level vocabulary + minimum-cost segmentation + arithmetic coding with fixed token frequencies.

- **Vocabulary:** candidates are the first 30,000 GPT-2 BPE merges (rough frequency order from 40 GB of web text), plus all 256 single bytes so any input encodes. Trained by repeated {segment corpus optimally → set cost = −log2(usage frequency)}, pruned to the N most-used tokens, then refined.
- **Training data** (in git-ignored `data/`; credits in THIRD_PARTY_NOTICES.md): 250k Tatoeba English sentences, Sherlock Holmes (Gutenberg), 40k synthetic URLs/emails/contacts/Wi-Fi payloads. Dev set: 3k held-out sentences + 150 paragraphs + 1.5k synthetic items from a different seed.
- **Vocabulary size sweep** (dev set, bits per byte; model JSON size): 1k 3.93 (9 KB) · 2k 3.57 (20 KB) · **4k 3.36 (45 KB)** · 8k 3.25 (93 KB) · 16k 3.22 (196 KB). Chose 4k: diminishing returns beyond. Loaded lazily (20 KB gzipped chunk).
- **Packed payloads:** contact/Wi-Fi/prompt fields joined with 0x1E instead of JSON or `WIFI:` QR syntax.
- **Held-out evaluation** (`npm run eval:compress`, hand-written messages never used in training). "Before" = old JSON/QR payloads with deflate-if-smaller:

  | category | before | after | saving | airtime on Fast |
  |---|---|---|---|---|
  | short texts (20) | 27.9 B | 11.8 B | 58% | 2.97 → 2.01 s |
  | URLs (15) | 48.3 B | 31.7 B | 34% | 4.18 → 3.20 s |
  | contacts (8) | 67.1 B | 36.9 B | 45% | 5.31 → 3.53 s |
  | Wi-Fi (6) | 43.5 B | 21.7 B | 50% | 3.93 → 2.60 s |
  | prompts (8) | 77.3 B | 26.9 B | 65% | 5.90 → 2.87 s |
  | long notes (4) | 164 B | 92.3 B | 44% | 2 fountain blocks → 1 frame |

  Overall 3354 → 1721 bytes (**49% smaller**). URLs gain least because of random IDs.
- Ideas not yet tried: an order-1 context (previous-token class) model; a URL-specific sub-model.

## v1 polish: PWA, logo, demo GIF (2026-10-21)

- **Logo:** `public/icons/icon.svg`: a speaker, a wave and a microphone on the accent purple, meaning one device's sound reaches another's mic. Earlier drafts were dropped: a dot with arcs read as a sideways Wi-Fi symbol, a speaker with arcs as a volume control, and upward arcs as Wi-Fi itself. The maskable variant is full-bleed with the art scaled to 88%, so it sits well inside the 40% safe circle. PNGs (192, 512, maskable 512, 180 apple-touch) were rasterized with ImageMagick.
- **Manifest + service worker:** `public/manifest.webmanifest` (standalone, portrait). `sw.js` is generated at build time by a small plugin in `vite.config.ts`, which writes the bundle's file list into it, so it needs no dependency. It precaches the bundle on install, including the lazily loaded compression model chunk. Navigations are network-first, so a new deploy shows up on the next online visit. Hashed assets are cache-first. The cache name is a hash of the file list, so each deploy replaces the old cache.
- **Verified in headless Edge over CDP:** no manifest or installability errors, 12 files cached, and the page reloads with the network off and is controlled by the worker. Compression still works offline (the meter shows the 12-byte compressed size), so the model chunk is coming from the cache.
- **Demo GIF (`docs/demo.gif`, about 400 KB)** is a real decode, not a mockup:
  - A Node script renders the actual Dual Fast transmission to a WAV.
  - A headless Edge receiver hears that WAV through Chromium's fake microphone (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=msg.wav%noloop`) and decodes it.
  - A second Edge instance types the text and presses Send.
  - Both are screenshotted over CDP at about 9 fps, composited side by side, and encoded with ffmpeg.
  - Quirk: under screenshot load, the fake mic's audio arrived 3–4.5 s later than the wall clock predicted (it varied between runs). The two streams were therefore aligned afterward on the frame where the receiver's spectrogram lights up.

## v2 milestone 1: compact SDP + in-page loopback (2026-10-22)

- `src/rtc/sdp-compact.ts` (parse, select, encode, decode, rebuild) and `src/rtc/peer.ts` (createOffer / acceptOffer / applyAnswer around the bytes). Lab page: `lab/rtc.html`, dev server only, not in the build.
- Fixtures in `test/fixtures/sdp.ts` are real Edge captures with **all addresses replaced**: the raw capture contained the laptop's public IPv4 and IPv6.
- **Mic permission changes the candidates.** Without it, Chrome gives mDNS names (`<uuid>.local`). With it, Chrome gives raw addresses for every interface (Wi-Fi, a WSL virtual adapter, 3 IPv6 addresses) plus TCP-active candidates on port 9, which are useless. That is why selection works to a byte budget instead of packing everything.
- **Packing:** 6-bit ICE credentials save 7 B over ASCII. The fixed part is 61 B, so a 132 B frame leaves 71 B for candidates: 10 IPv4 or 3 IPv6/mDNS.
- **Loopback results** (headless Edge, Windows, same machine; both sides only see each other's compact bytes):

  | scenario | offer | answer | opens? | path |
  |---|---|---|---|---|
  | mDNS, both carry candidates | 125 B | 99 B | yes, ~3 ms after answer | host → host |
  | mDNS, answer carries none | 125 B | 61 B | yes | host → prflx |
  | mDNS, 80 B budget (srflx only) | 68 B | 68 B | **no** (10 s timeout) | needs NAT hairpin |
  | mic, both carry candidates | 120 B | 132 B | yes | host → host |
  | mic, answer carries none | 120 B | 61 B | yes | host → prflx |
  | mic, 80 B budget (LAN IPv4 only) | 75 B | 75 B | yes | host → host |

- **Gathering:** without mic, 130–490 ms. With mic, it always hit the 3 s cap, waiting on STUN from interfaces that can't reach it. It now settles 300 ms after the last candidate once a srflx IPv4 is in: 0.4–0.8 s.
- **Open question for milestone 3:** should the answer carry candidates? With none it is 61 B (about half the airtime). But then the answerer is only reachable as peer-reflexive, which works on a shared LAN and is weaker across NATs. A middle ground is LAN IPv4 + srflx IPv4 (about 75 B). Decide with phone-to-phone numbers in milestone 2. **Resolved in milestone 2: yes, the answer carries them.**
- Not yet verified: Firefox and Safari accepting `buildSdp` output. The Firefox-style fixture only covers parsing. That is for milestone 2/5 on real devices.

## v2 milestone 2: copy-paste pairing on real devices (2026-10-22)

- `lab/pair.html` (dev server only): Phone A makes an offer, the text (`ES1O` + base64url) goes over any chat app, and Phone B pastes it and sends back an answer (`ES1A…`). It logs ICE and connection state, page visibility, the selected path, RTT, and an 8 MB throughput test. "Copy report" masks public addresses.
- Tested: Android Chrome (Phone A) ↔ Windows Edge (Phone B), same Wi-Fi.
- **Full answer (both carry candidates): connected every time.** Offer 113 B (LAN IPv4, srflx IPv4, 2 IPv6), answer 120 B. The selected path was **direct IPv6, host → host**: both devices have global IPv6 addresses on the home Wi-Fi.
- **Answer without candidates (61 B): deadlocks if the paste is slow.** The phone sat in a chat app for 42 s. Edge started checks as soon as it made the answer, got no replies from the backgrounded phone, and reported `failed` after **15.1 s** (15.2 s in another run). The phone applied the answer 7 s after that, and nothing happened: it had no address to try, and Edge had stopped checking. In the headless 40 s late-paste test this worked only because a headless "phone" never goes to the background, so it kept answering the checks.
- **The same stall with a full answer recovers:** Edge had also reported `failed`, and when the phone applied the answer, it went checking → connected → channel open in 0.1 s.
- **Decision:** the answer carries candidates (≈75–132 B, still one frame). `omitCandidates` stays in `peer.ts` for the lab only.
- **Backgrounding:** an Android page in the background stops answering ICE. The connection came back fine after 42 s hidden, but the other side reports `disconnected` within seconds and `failed` after ~15 s. Design: keep the page in the foreground during handshake and transfer, and reconnect on `visibilitychange`.
- **ICE error 701** (STUN server unreachable) appears ~39.5 s after gathering starts, which is the end of the STUN retransmit schedule (0.5 + 1 + 2 + 4 + 8 + 16 + 8 s). It comes from interfaces with no route (the WSL adapter, some IPv6). Harmless: gathering settled 0.4 s in.
- **Dev setup gotcha:** typing `192.168.1.21:5173` into Android Chrome uses plain http, and the HTTPS-only dev server drops it with ERR_EMPTY_RESPONSE. Type `https://` explicitly.
- Laptop throughput: the WSL virtual adapter path gave 1.6 MB/s, IPv6 Wi-Fi gave 19.6 MB/s (headless, same machine). Phone throughput not yet recorded.
- **Deferred to milestone 3** (easier once the handshake is by sound): phone ↔ phone, and one phone on mobile data.

## v2 milestone 3: acoustic handshake (2026-10-23, in progress)

- `src/rtc/handshake.ts`: offer/answer as typed messages (0x10/0x11, raw bytes), `splitFrameBytes`, and the 4-digit `verificationCode` (SHA-256 of the offer fingerprint followed by the answer fingerprint). `lab/handshake.html` runs the protocol and **ships in the build** (`/lab/handshake.html`), so two phones can try it without a laptop.
- **Airtime** (ggwave, one frame): 70 B 5.0 s, 100 B 6.8 s, 140 B 9.3 s on Fast; Fastest is about half. Splitting the offer across both bands makes each frame ~75 B: **5.3 s per offer round on Dual Fast**.
- **Headless, two tabs, real modem** (`?bus`: a BroadcastChannel stands in for the air):

  | B taps Accept | connected after | why |
  |---|---|---|
  | right away | 12.4 s | answer fits in A's first listening window |
  | 4 s late (4 s slack) | 27.5 s | missed the window by 0.2 s, so it waited one more offer round |
  | 4 s late (6 s slack) | 16.5 s | fits; the slack is now 6 s |

  Codes matched every time, and chat crossed the channel.
- **Real devices** (Dual Fast, volume 50, live site):

  | A (offers) → B (answers) | network | connected after first offer | path | RTT median | 8 MB |
  |---|---|---|---|---|---|
  | laptop → phone | phone on 5G, laptop on home Wi-Fi | **14.0 s** (answer after round 1) | direct IPv6 | 53 ms | not valid (test started several times; now guarded) |
  | laptop → phone | same Wi-Fi | 28.6 s (Accept missed window 1) | direct IPv6 | 18 ms | 1.2 MB/s |
  | laptop → phone | same Wi-Fi | worked (first try, no report) | | | |
  | phone → phone | same Wi-Fi | **failed**: handshake and code fine, ICE checking → failed after 15.4 s | | | |

  - After the answer is applied, the channel opens in 0.3–0.5 s.
  - **5G works without TURN thanks to IPv6.** The phone's IPv4 was carrier NAT (100.64/10), but carrier and home both hand out global IPv6, and host ↔ host IPv6 connected directly. Over IPv4 alone this case would need TURN.
  - Phone ↔ phone failure: a phone works as the answering side (laptop → phone), so it is not an answerer bug. Remaining suspects: the second phone left the page, or the Wi-Fi isolates those two clients. The labs now log per-pair STUN counters on failure to tell these apart.
  - 1.2 MB/s over Wi-Fi is low (headless laptop ↔ laptop: 19 MB/s). Suspects: phone Wi-Fi power saving (jumpy RTT 7–30 ms), 16 KB chunks, 4 MB buffer cap. Tune in milestone 4.

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
- [x] Phone → phone (Android ↔ Android), dual fast, with compression on: short and long messages delivered every time, and a ~500-character message took ~30 s. A cat reliably notices the ultrasound band.
- [ ] Late joiner: start Broadcast, begin listening ~20 s later, still decodes
- [ ] Three listeners (laptop + 2 phones) receive one ~500 B broadcast (v1 "done" criterion)
- [ ] Screen Wake Lock keeps a broadcast going on Android
- [ ] Install to the home screen on Android (Chrome menu → Install app): icon looks right, the app opens standalone, and it still opens and sends in airplane mode
- [ ] Mic permission persists for the installed app (or re-prompts once)
- [x] URL timing: 40 B on audible-normal felt like ~4–6 s by hand, consistent with 4.4 s airtime. No hidden device latency.
- [ ] iOS: ringer switch / silent mode effect on playback; `navigator.audioSession.type`
- [ ] iOS: output volume/routing while mic is active (matters for the v2 offer/answer)
- [ ] v2: lab/rtc.html loopback on Android Chrome (dev server over LAN): all scenarios connect; note gather times with mic granted
- [ ] v2: Safari and Firefox accept a remote description built by `buildSdp`
- [x] v2: copy-paste pairing, Android Chrome ↔ Windows Edge, same Wi-Fi (lab/pair.html): connects, direct IPv6
- [ ] v2: pairing phone ↔ phone (Android ↔ Android), same Wi-Fi; record throughput
- [ ] v2: pairing with one phone on mobile data (expected to fail on carrier NAT unless both sides have IPv6)
- [ ] v2: reconnect after the page returns from the background
- [ ] v2: sound handshake phone ↔ phone (lab/handshake.html on the live site): time to connect, codes match, chat works
- [ ] v2: sound handshake with one phone on mobile data
