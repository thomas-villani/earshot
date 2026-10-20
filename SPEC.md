# Earshot — Data over Sound in the Browser

*Working name. Send a message to every phone within earshot — no app, no install, no server.*

## Concept

A single static web page that turns any phone's speaker and microphone into a short-range data link.

- **v1 — Acoustic messaging.** Send short messages (text, links, contact cards, Wi-Fi credentials, assistant prompts) purely over sound. One sender, any number of listeners. Fully offline after the page loads.
- **v2 — Acoustic-signaled WebRTC.** Use sound only for the WebRTC handshake (offer/answer), then move files over a direct peer-to-peer data channel at Wi-Fi speeds. Still no signaling server.
- **v3 (idea) — Nearby multiplayer.** The v2 connection becomes a game transport: walk up, chirp, play.

Same pattern as Samsung Smart Switch (high-frequency audio for the handshake, Wi-Fi Direct for the data), but built entirely on standard browser APIs so it works across Android and iOS.

## Non-goals

- No backend of any kind in v1 or v2 (STUN via public servers is allowed in v2; TURN is out of scope).
- No native apps.
- Not a secure channel by default — sound is a broadcast medium. See *Security*.

---

## Architecture

```
┌────────────┐   bytes   ┌──────────┐  frames  ┌─────────┐  Float32  ┌──────────────┐
│  Message   │ ────────▶ │ Framing  │ ───────▶ │  Modem  │ ────────▶ │ Audio out    │
│  (typed)   │           │ + chunk/ │          │ (ggwave │           │ (Web Audio)  │
│            │ ◀──────── │ fountain │ ◀─────── │ adapter)│ ◀──────── │ Mic in       │
└────────────┘           └──────────┘          └─────────┘           │ (AudioWorklet)│
                                                                     └──────────────┘
v2:  Message type RTC_OFFER / RTC_ANSWER  ──▶  rtc/ handshake  ──▶  RTCDataChannel ──▶ file transfer
```

The modem sits behind a narrow interface so ggwave can later be swapped for a custom (faster) modem without touching anything above it:

```ts
interface Modem {
  readonly maxFrameBytes: number;          // ggwave: 140
  encode(frame: Uint8Array, protocol: ProtocolId): Float32Array;
  pushSamples(samples: Float32Array): Uint8Array[]; // returns any frames decoded so far
  setSampleRate(rate: number): void;
}
```

### Modem: ggwave

- npm package `ggwave` (WASM). Latest release is 0.4.0 (July 2022) — stable but dormant; pin the version.
- Max payload per transmission: **140 bytes**.
- FSK with Reed-Solomon ECC. Protocols (approximate payload rates):

| Protocol | Band | ~Rate |
|---|---|---|
| Audible Normal | 1.9–6.4 kHz | 11 B/s |
| Audible Fast | 1.9–6.4 kHz | 17 B/s |
| Audible Fastest | 1.9–6.4 kHz | 34 B/s |
| Ultrasonic Normal/Fast/Fastest | 15–19.5 kHz | same as above |
| Dual-tone (DT) variants | 1.1–2.6 kHz | 4–11 B/s |

Default: **Audible Fast**. Expose a protocol picker in settings.

**Spike result (milestone 0, details in NOTES.md):** binary is clean. `encode` accepts a `Uint8Array` and every byte value round-trips, so frames get the full 140 bytes. The adapter hides the quirks: input must arrive in whole 1024-sample frames, >140 bytes is silently truncated, max 4 instances, and 44.1 kHz input is unreliable (we force a 48 kHz `AudioContext`). ggwave can also return wrong bytes without error on small payloads.

### Audio I/O

- **Capture:** `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })` — mandatory; browser DSP destroys the signal. Log the actual applied constraints via `track.getSettings()` (iOS may ignore some).
- **Processing:** AudioWorklet posts Float32 buffers to the main thread; main thread feeds `modem.pushSamples`. (Don't use the deprecated ScriptProcessorNode that ggwave's examples use.)
- **Sample rate:** read `audioContext.sampleRate` (usually 48000) and configure ggwave's input/output rates to match.
- **Playback:** `AudioBufferSourceNode` from the encoded waveform.
- **Self-echo:** a device must ignore its own transmissions — pause decoding while transmitting, and/or drop frames carrying our own session nonce.
- **User gesture:** AudioContext creation/resume and mic request happen inside a tap handler.
- **iOS ringer switch:** Web Audio may be silenced when the phone is on silent. Investigate `navigator.audioSession.type = 'play-and-record'` (Safari) and document the behavior.

---

## v1 — Acoustic Messaging

### Message model

A **message** is a typed payload:

```
message = [type: u8][flags: u8][payload ...]
flags low nibble: codec. 0 = none, 1 = deflate-raw (CompressionStream), 2 = text model v1 (see below)
```

| Type | Code | Payload | Receiver UI |
|---|---|---|---|
| TEXT | 0x01 | UTF-8 | Show + Copy |
| URL | 0x02 | UTF-8 URL | Show full URL + "Open" button (never auto-open) |
| CONTACT | 0x03 | `name␞phone␞email␞org` (␞ = 0x1E; trailing empties dropped) | Show + "Save contact" (generate .vcf) |
| WIFI | 0x04 | `auth␞ssid␞password[␞1 if hidden]`, auth = W/E/N (WPA/WEP/open) | Show SSID + copy password |
| ASSISTANT_PROMPT | 0x05 | `prompt[␞context]` | Show + Copy (never auto-execute) |
| RTC_OFFER | 0x10 | v2 — see below | handled by rtc/ |
| RTC_ANSWER | 0x11 | v2 | handled by rtc/ |
| GAME_INVITE | 0x20 | v3 reserved | — |

The sender tries every codec and keeps the smallest (raw wins for tiny or random payloads).

**Text model v1** (`src/compress/`): a static model built for short messages, where deflate can't win. A 4,096-token byte-level vocabulary (selected from GPT-2's BPE merges, frequencies trained on Tatoeba + Gutenberg + synthetic URLs/contacts; `npm run train:compress`) is applied with a minimum-cost segmentation, then arithmetic coded with fixed token frequencies and an end-of-message token. About 3.4 bits per byte on held-out English; 49% smaller than raw/deflate on the held-out message set (`npm run eval:compress`, numbers in NOTES.md). A retrained model must use a new codec id so older pages reject it instead of decoding garbage.

### Frames

Every transmission is one **frame** (≤ `modem.maxFrameBytes`).

```
frame header:
  [magic+version: u8]   0xE1 for v1 — reject anything else
  [kind: u8]            0 = SINGLE, 1 = FOUNTAIN
  [nonce: u16]          random per sender session (self-echo filtering, dedupe)
  [crc16: u16]          CRC-16 over the rest of the frame; ggwave returns wrong
                        bytes without error on small payloads (measured in milestone 0)

SINGLE:   header + message bytes            (message fits in one frame)
FOUNTAIN: header + [msgId: u16][k: u8][seed: u16] + encoded block (B bytes)
```

ggwave already does error correction per frame; add a CRC32 over the reassembled message (inside the fountain-encoded data) to catch reassembly errors.

### Long messages & broadcast: fountain coding

For messages that don't fit in one frame, use a **random linear fountain code over GF(2)** (better than LT codes at the small block counts we'll have, k ≈ 2–40):

- Source = `[len: u16][crc32: u32][message]`, zero-padded to `k × B` bytes, split into k blocks.
- Each emitted frame: pick a 16-bit seed, PRNG(seed) selects a random nonempty subset of the k blocks, payload = XOR of that subset.
- Receiver: collects (seed, payload) pairs, runs incremental Gaussian elimination over GF(2); decodes once rank = k (typically needs k + 1–3 frames).
- Sender in **broadcast mode** loops forever emitting fresh seeds. Late joiners and lossy listeners just keep collecting — there's no "missed chunk" concept.
- Block size B: default to the largest that fits a frame (140 − 6 header − 5 fountain = 129 bytes); keep it tunable. The milestone 2 simulator found frame success is nearly independent of payload length, while each transmission pays ~1 s of fixed marker overhead, so full frames give the best goodput (see NOTES.md).

As built (milestone 4):
- **Systematic first:** seeds `0..k-1` mean "source block *seed* alone"; seeds ≥ k select a pseudo-random subset from (seed, k). A lossless listener decodes from exactly k frames.
- **Even blocks:** k = ⌈(6 + len) / 129⌉, then B = ⌈(6 + len) / k⌉ so the last block isn't mostly padding.
- **msgId = CRC-32(message) & 0xFFFF**, so re-sending the same content tops up listeners mid-decode instead of starting a new transfer.
- **Dual band (lanes):** each round plays one frame per lane simultaneously, e.g. audible-fast + ultrasound-fast (~2× throughput; see NOTES.md). SINGLE messages repeat the same frame on every lane for diversity; fountain lanes carry different seeds. Receivers always run one decoder per band. Default transmit mode: Dual Fast.
- **Send** = ⌈(k + max(1, ⌈k/4⌉)) / lanes⌉ rounds (blocks plus repair margin); **Broadcast** loops until stopped and holds a Screen Wake Lock.

### UI

Single page, mobile-first, two tabs:

**Send**
- Text area with type auto-detection (URL → URL type) and a type override.
- "Send once" and "Broadcast (loop)" buttons; show estimated airtime.
- Hint to turn volume up.

**Listen**
- Big "Listen" button (mic permission).
- Live spectrogram canvas (fun + invaluable for debugging).
- Fountain progress bar per in-flight message ("12/17 blocks").
- Decoded messages as cards with type-appropriate actions.

**Settings / Debug drawer**
- Protocol picker, block size, frame log (raw hex, decode timestamps), applied mic constraints.

### Test harness (build early)

A Node-based channel simulator so tuning doesn't require waving phones around:

`encode → channel(…) → decode`, where channel applies:
- gain loss and clipping
- additive white/pink noise at a target SNR
- reverb: convolution with a synthetic room impulse response (exponentially decaying noise, RT60 0.2–0.8 s)
- sample-rate mismatch (e.g. 48000 → 44100 resample) and slight clock drift
- speaker/mic frequency response (band-pass; phones roll off hard above ~18 kHz, which matters for ultrasonic)
- dropped frames (for fountain tests)

Output: frame success rate vs SNR per protocol/block size, and end-to-end time to decode a message of N bytes.

Also unit tests for framing round-trips and fountain decoding (random loss, duplicate frames, out-of-order).

### v1 milestones

0. **Spike:** ggwave in Node + browser; confirm binary handling, sample-rate config, decode from streamed chunks.
1. **Hello, sound:** a single SINGLE frame sent from one device, decoded on another (laptop ↔ Android now; Android ↔ iOS both directions when an iPhone is available).
2. **Harness:** minimal channel simulator + baseline numbers, so later tuning choices are measured rather than guessed.
3. **Typed messages + UI:** framing, message types, receiver cards, spectrogram.
4. **Fountain:** long messages and broadcast mode; verify a late-joining listener decodes.
5. **Polish:** protocol picker, ultrasonic toggle, PWA manifest, GitHub Pages deploy, README with demo GIF.

**Done when (targets, revised as we measure):** two random phones (one Android, one iPhone) exchange a URL in a normal room in under ~10 s, and three listeners simultaneously receive a ~500-byte broadcast message. Airtime depends heavily on protocol: a 140-byte frame is ~9 s on Fast and ~5 s on Fastest.

---

## v2 — Acoustic-Signaled WebRTC (File Transfer)

### Idea

WebRTC needs signaling: each side's ICE credentials, DTLS fingerprint, and candidates. Normally a server relays them. Here, sound does — a two-way chirp exchange — and then the browsers connect directly.

### Compact SDP

Full SDP is KBs; the parts that matter for a data-channel-only session are small. Wait for ICE gathering to complete (non-trickle), extract fields, binary-pack them, and rebuild a full SDP from a fixed template on the other side.

```
RTC_OFFER / RTC_ANSWER payload:
  [sessionId: u32]            offer picks it; answer echoes it
  [ufrag: len-prefixed ascii] typically 4 chars
  [pwd: len-prefixed ascii]   typically 22–24 chars
  [fingerprint: 32 bytes]     SHA-256 DTLS fingerprint, binary
  [candCount: u8]
  per candidate:
    [kind: u8]                host-mDNS | host-ipv4 | srflx-ipv4 | (ipv6 later)
    host-mDNS: [uuid: 16 bytes]   (Chrome/Safari obfuscate host IPs as <uuid>.local)
    ipv4:      [ip: 4 bytes]
    [port: u16]
```

Expected size ≈ 90–130 bytes → one frame, or two via fountain. Worth trying: the answer may omit candidates entirely, since the offerer learns the answerer's address as a peer-reflexive candidate from its incoming connectivity checks. Template constants (m-line, `a=sctp-port`, `a=setup`, etc.) live in code; the offer uses `setup:actpass`, the answer `setup:active`.

### Handshake flow

1. Sender picks a file → creates `RTCPeerConnection` + data channel → gathers ICE (host + STUN srflx) → compacts offer → **plays it on a loop** (re-transmit every few seconds until answered or cancelled).
2. Receiver (Listen tab) decodes RTC_OFFER → shows "Incoming file from nearby device — Accept?" → on accept, builds answer → plays RTC_ANSWER.
3. **Collision handling:** receiver waits a random 0–800 ms after the offer ends before answering; if the sender hears garbage instead of a clean answer, it keeps looping the offer and receivers retry with backoff (simple ALOHA).
4. Sender decodes answer (matching `sessionId`) → `setRemoteDescription` → stops looping.
5. ICE + DTLS complete → data channel opens.
6. **Verification code:** both screens show a 4-digit code derived from hash(offer fingerprint ‖ answer fingerprint). Users glance to confirm — protects against a third device in earshot injecting its own answer.

v2 is **one-to-one** per handshake. To send to another device, the sender starts a fresh offer.

### File transfer protocol (over the data channel)

- Control message (JSON): `{name, size, mime, sha256}`.
- Data: 16 KB binary chunks; respect backpressure via `bufferedAmountLowThreshold` / `onbufferedamountlow`.
- Receiver assembles chunks → verifies SHA-256 → offers a download (Blob URL) and, where supported, the Web Share API.
- Progress bar + throughput on both sides.

### v2 risks to test early

- **mDNS candidate resolution across devices/browsers** (esp. Android Chrome ↔ iOS Safari). Networks with client isolation or blocked multicast (guest/corporate Wi-Fi) will break host candidates.
- **Different networks** (one on cellular): STUN srflx works on friendly NATs; symmetric/carrier NAT needs TURN → out of scope, show a clear error.
- **iOS background behavior** during long transfers (screen must stay on — consider the Screen Wake Lock API).
- Whether any browser rejects reconstructed SDP that differs cosmetically from what it generated.

### v2 milestones

1. **Two-tab loopback:** compact/expand SDP round-trip, connect two `RTCPeerConnection`s in one page via the compact format (no sound).
2. **Same-network pair via QR or copy-paste** of the compact blob (isolates WebRTC issues from acoustic ones).
3. **Acoustic handshake:** replace copy-paste with sound; add the verification code.
4. **File transfer** with backpressure, hashing, progress.
5. **Cross-platform matrix:** Android Chrome, iOS Safari, desktop Chrome/Firefox/Safari; same Wi-Fi vs. one-side-cellular.

**Done when (target):** a 20 MB photo moves from an Android phone to an iPhone on the same Wi-Fi after a sub-15-second chirp handshake.

---

## v3 sketch — Nearby multiplayer

Once a data channel exists, it's a game transport:
- **Host-as-hub star topology:** host chirps an offer per joining player (or uses the first connection to broker the rest).
- Use `ordered: false, maxRetransmits: 0` channels for game state, a reliable channel for lobby/chat.
- `GAME_INVITE` message type carries game id + host session so listeners can join from the Listen tab.
- Demo game candidates: shared drawing canvas, Pong, trivia buzzer.

---

## Security notes

- Anyone in earshot can **hear** every transmission and **send** frames. Treat all decoded content as untrusted.
- Never auto-open URLs, auto-save files, auto-join Wi-Fi, or auto-run assistant prompts — always one explicit tap with the full content visible.
- v2 relies on the DTLS fingerprint exchanged over sound + the visual verification code for peer authenticity.
- Stretch (v1): optional passphrase mode — PBKDF2 → AES-GCM encrypt the message before framing.

## Stack

- Vite + vanilla TypeScript (no framework needed), Vitest for tests.
- Static deploy to GitHub Pages via GitHub Actions (HTTPS satisfies mic + secure-context requirements).
- No runtime dependencies beyond `ggwave` (CompressionStream, Web Crypto, WebRTC are built in).

```
earshot/
  index.html
  src/
    main.ts
    audio/        capture worklet, playback, spectrogram
    modem/        Modem interface, ggwave adapter
    framing/      frame + message encode/decode, CRC32
    fountain/     random linear fountain over GF(2)
    rtc/          (v2) compact SDP, handshake state machine, file transfer
    ui/           tabs, cards, settings/debug drawer
  test/
    channel-sim.ts
    framing.test.ts
    fountain.test.ts
    sdp-compact.test.ts
  .github/workflows/deploy.yml
```

## Open questions

- Name (Earshot? something else?).
- Audible vs. ultrasonic default — audible is more reliable and makes transfers obvious; ultrasonic is magic when it works. Measure before deciding.
- Worth writing a custom faster modem (OFDM in an AudioWorklet) once v1 works? ggwave tops out around 34 B/s; a custom modem might reach hundreds of B/s to a few kB/s in good conditions.
