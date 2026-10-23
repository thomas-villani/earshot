# Earshot — Data over Sound in the Browser

*Send things to people within earshot — no app, no install, no server.*

## Concept

A single static web page for moving data between nearby devices without any server. It uses whatever channel works: sound for messages and handshakes, a direct WebRTC link for files on a shared network, and the screen plus camera for files when there is no shared network. Sound is always how two devices find each other, hence the name.

- **v1 — Acoustic messaging.** Send short messages (text, links, contact cards, Wi-Fi credentials, assistant prompts) purely over sound. One sender, any number of listeners. Fully offline after the page loads.
- **v2 — Acoustic-signaled WebRTC.** Use sound only for the WebRTC handshake (offer/answer), then move files over a direct peer-to-peer data channel at Wi-Fi speeds. Still no signaling server.
- **v3 — Visual transfer.** Stream a file as animated codes on one screen, read by the other phone's camera. No network at all, so it works where v2 can't (different networks, no Wi-Fi). It reuses the fountain code.
- **v4 (idea) — Nearby multiplayer.** The v2 connection becomes a game transport: walk up, chirp, play.

**Choosing a channel for a file (v2 + v3):** try WebRTC first (same Wi-Fi or a phone hotspot: MB/s). If it can't connect, offer "Show as code" (screen → camera: tens of KB/s, no network). Short messages always go over sound.

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
| VISUAL_DONE | 0x12 | v3: `[fileId: u32]` | sender stops its code stream |
| GAME_INVITE | 0x20 | v4 reserved | — |

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
RTC_OFFER / RTC_ANSWER payload (src/rtc/sdp-compact.ts):
  [ver/setup: u8]             high nibble version (1); low nibble setup: 0 actpass, 1 active, 2 passive
  [sessionId: u32]            offer picks it; answer echoes it
  [ufrag: n u8][6-bit packed] ice-chars are exactly the base64 alphabet: 4 chars → 3 bytes
  [pwd:   n u8][6-bit packed] 24 chars (Chrome) → 18 bytes; 32 (Firefox) → 24
  [fingerprint: 32 bytes]     SHA-256 DTLS fingerprint, binary
  [candCount: u8]
  per candidate: [kind: u8][address][port: u16]
    kind 0 host-ipv4 (4 B) | 1 host-ipv6 (16 B) | 2 host-mDNS (<uuid>.local as 16 B)
         3 srflx-ipv4 (4 B) | 4 srflx-ipv6 (16 B)
```

The fixed part is 61 bytes (Chrome credentials). Candidates are chosen to fit a byte budget (default 132 B, one SINGLE frame): LAN IPv4 first, then public IPv4 (srflx), then IPv6 and mDNS in the browser's own order. UDP only: TCP, relay, and duplicates are dropped. Measured: offer 113–125 B, answer 99–132 B. **Both sides carry candidates.** An answer can be cut to 61 B by leaving them out (the offerer then learns the answerer as peer-reflexive from its checks), and that works in loopback, but on real devices it can deadlock, so it stays a lab option only. See "Answer carries candidates" below. Template constants (m-line, `a=sctp-port`, `a=mid:0`, etc.) live in `buildSdp`. Both sides open the same pre-negotiated data channel (`negotiated: true, id: 0`).

**Raw IPs vs mDNS.** Without media permission, Chrome hides host addresses behind mDNS names (19 B each). Earshot always holds mic permission, so Chrome emits raw host addresses for every interface instead (7 B for IPv4). That is smaller, and it avoids mDNS resolution, which is the top v2 risk below. A public-IPv4-only offer (no host candidates) failed to connect on the same machine, because it needs the router to hairpin. Host candidates are essential on a shared LAN.

**Privacy.** An offer chirps the sender's LAN and public IP addresses to everyone in earshot. A WebRTC peer learns them anyway, but here bystanders do too. The README must say so when file transfer ships.

**Answer carries candidates.** Measured phone ↔ laptop in milestone 2. Without them, the answerer's connectivity checks are the only way the connection can form. Chrome gives up on unanswered checks after about 15 s and reports `failed`. A backgrounded Android page stops answering checks, so if the offerer is backgrounded for more than ~15 s before applying the answer, the answerer gives up first. The offerer has no address to try, and nothing recovers. With candidates, the offerer probes the answerer itself once it applies the answer, and the same situation connected within 0.1 s. The cost is about 60 B of airtime on the answer, still one frame.

**Backgrounding.** Android Chrome stops answering ICE while the page is hidden. A connection survived 42 s in the background, but the other side reports `disconnected` after a few seconds and `failed` after about 15 s. The app keeps the page in the foreground during a handshake and transfer (with a "keep this page open" note), and reconnects when it becomes visible again.

**Gathering** waits for completion, or until a srflx IPv4 candidate has arrived and 300 ms pass with no new candidate (3 s cap). With mic permission, STUN on dead interfaces (VM adapters, some IPv6) never answers, so plain "complete" took the full 3 s. Early settle measured 0.4–0.8 s.

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
2. **Same-network pair via QR or copy-paste** of the compact blob (isolates WebRTC issues from acoustic ones). Done with copy-paste (`lab/pair.html`), phone ↔ laptop; QR comes with v3.
3. **Acoustic handshake:** replace copy-paste with sound; add the verification code.
4. **File transfer** with backpressure, hashing, progress.
5. **Cross-platform matrix:** Android Chrome, iOS Safari, desktop Chrome/Firefox/Safari; same Wi-Fi vs. one-side-cellular.

**Done when (target):** a 20 MB photo moves from an Android phone to an iPhone on the same Wi-Fi after a sub-15-second chirp handshake.

---

## v3 — Visual Transfer (Animated Codes)

### Idea

The sender's screen plays a rapid sequence of 2D barcodes. Each one carries a fountain-coded block of the file. The receiver points its camera at the screen and collects blocks until it can decode. Because the data is fountain coded, missed frames, blur, and starting late don't matter, just as with a late joiner over sound.

This is the fallback for the document-sharing case when v2 can't connect. That covers two phones on different cellular networks, no Wi-Fi, guest networks with client isolation, and airplane mode. It is one-way and needs no network after the page loads. Sound stays useful alongside it (see *Using sound with it*).

### Choosing a code

The real limit isn't camera resolution. These are the limits that matter:
- **Motion blur and focus.** Phones are handheld and the screen is close. Small modules blur first.
- **Display and camera timing.** Browser camera streams run at about 30 fps, and phone screens refresh at 60–120 Hz. A rolling shutter can catch half of one code and half of the next. Each code needs to stay up for at least 2–3 camera frames, so the practical ceiling is about 10–15 codes per second.
- **Decode time.** Decoding a large QR code in JS or WASM takes several to tens of milliseconds on a phone. Decoding runs in a buffered worker pool (see *Architecture*), so it limits latency more than throughput. It still sets how large a code a mid-range phone can keep up with.
- **Screen artifacts.** Moiré, glare, and auto-brightness all interfere.

QR binary capacity (approximate) at error-correction level L (~7% recovery) vs M (~15%):

| Version | Modules | L | M |
|---|---|---|---|
| 10 | 57×57 | ~270 B | ~210 B |
| 20 | 97×97 | ~860 B | ~670 B |
| 25 | 117×117 | ~1,270 B | ~1,000 B |
| 40 | 177×177 | ~2,950 B | ~2,330 B |

**Use level L.** The fountain code already handles lost frames. A QR code either decodes or it doesn't, so heavy in-symbol error correction mostly wastes capacity. This mirrors the block-size result over sound: a frame that is lost costs little, so pack each frame full.

**Starting point:** QR at L, with the version and frame rate chosen by measurement. A guess of v20–25 at 8–12 codes/s gives about 7–15 KB/s, so a 1 MB PDF takes roughly 1–2 minutes. Faster speeds come from tuning, not from bigger codes.

**Denser codes, later, if QR tops out:**
- **Color.** Three color channels could in principle carry about 3× the data. Examples are JAB Code (an ISO-standardized color barcode) and libcimbar, which uses colored symbols and claims far higher throughput than QR. The cost is sensitivity to white balance and screen color. It would be a v3.x experiment kept behind the same interface.
- **Custom grid.** A plain black-and-white grid with our own finder pattern and no QR overhead. We would control density and redundancy directly. This is the visual counterpart to "write a custom OFDM modem".

### Architecture

The fountain and framing layers don't change. "Binary in, binary out" pays off here. A `Symbology` interface sits beside `Modem`:

```ts
interface Symbology {
  readonly maxFrameBytes: number;
  render(frame: Uint8Array, canvas: HTMLCanvasElement): void;
  decode(image: ImageBitmap | ImageData): Promise<Uint8Array[]>;
}
```

- **Rendering:** a small QR encoder to canvas, run at full brightness with a white quiet zone. The screen stays awake via Wake Lock.
- **Slow sender, greedy receiver.** The sender changes codes well below the camera's frame rate. Start at about 10 codes/s, so each code stays up for about 3 camera frames at 30 fps, and at least one capture of each code is clean rather than a half-and-half blend. Codes swap only on `requestAnimationFrame`, so a single display refresh never shows two codes, and each code is held for a whole number of refreshes. The receiver still captures every camera frame: extra frames are extra chances, the duplicate filter drops repeats, and blended frames fail to decode harmlessly. The codes-per-second setting is tuned in the milestone-1 bench.
- **Decoding:** `BarcodeDetector` where available (Chrome on Android), with a QR decoder fallback for other browsers. That fallback may be the first new runtime dependency besides ggwave, so pick it carefully: small, maintained, and permissively licensed.
- **Capture is separate from decoding.** Decoding only has to catch up eventually, not keep pace with the camera:
  1. `getUserMedia({video: {facingMode: 'environment', width: {ideal: 1920}}})`. Grab every frame via `requestVideoFrameCallback`.
  2. **Shrink before stashing.** Raw 1080p RGBA is about 8 MB per frame, so stashing it is not an option. Convert to grayscale (1 byte per pixel) and crop to the code's last known position with some margin. Before the first decode, use a centered square. The result is well under 1 MB per frame.
  3. **Drop near-duplicates.** Each code stays up for 2–3 camera frames. A cheap downsampled pixel difference skips frames that are almost identical to the previous one.
  4. **Bounded ring buffer → worker pool.** Transfer the buffers to 2–4 dedicated workers (`BarcodeDetector` is available in workers), which decode in parallel. When the buffer is full, drop the oldest frames. The fountain code doesn't care which frames are lost.
  5. Decoded frames go back to the main thread and into the generation decoders. The transfer finishes when the backlog drains, which may be a moment after the last useful frame was captured.

  This makes the camera's frame rate the receive ceiling, not decode speed on one core. The milestone-1 bench should measure both paths, inline decode and the buffered pool.

### Packets for files

Files need far more blocks than the 255 a u8 `k` allows. For example, 1 MB at about 1,000 B per block is about 1,000 blocks. One giant random linear system is O(k²·B) work, which is too slow in JS at that size. Instead, split the file into **generations** of up to 255 blocks. Each generation is decoded independently with the existing `FountainDecoder`.

```
Visual frame (inside a 6-byte frame header, new kind = File):
  [fileId: u32]      random per transfer
  [gen: u16]         generation index
  [genCount: u16]
  [k: u8]            blocks in this generation
  [seed: u16]
  [block]
```

- The sender rotates through the unfinished generations: systematic blocks first, then repair blocks.
- **Metadata frame:** `{name, size, mime, sha256}` in a packed binary form, repeated every ~20 frames. A late joiner learns the file name and size quickly.
- The receiver shows a per-generation progress grid, checks the SHA-256 of the full file, then offers Download or Share. Nothing opens automatically.
- Size cap: a generous limit (e.g. 10 MB), enforced from the metadata before allocating any memory.

### Using sound with it

- **Done signal:** when the receiver finishes, it chirps a short `VISUAL_DONE {fileId}` message. The sender stops and shows "Received ✓". This needs no network and no back-and-forth over the camera.
- **Rate hint (stretch):** the receiver chirps its decode success rate now and then, so the sender can slow down or switch to a smaller code version.
- **Same UI as v2:** if a WebRTC connection works, use it. If not, offer "Show as code" with one tap. The QR handshake from v2 milestone 2 uses the same renderer and decoder.

### v3 risks to test early

- The real decode rate and success rate of `BarcodeDetector` per code version on mid-range Android phones. This is the number that decides everything.
- The decoder fallback on iOS Safari (no `BarcodeDetector`) and its CPU cost.
- Screen refresh vs camera exposure (tearing and rolling shutter). Hold each code for N display frames.
- Glare and auto-exposure. A dark border around a bright code may help.
- Memory for large files on phones. Keep generations as `Uint8Array`s and assemble the file once at the end via `Blob`.

### v3 milestones

1. **Bench page:** render QR codes at versions 10–40, levels L and M, and 5–20 fps. A second phone reports decode success rate and decode time. Record the results in NOTES.md and pick the defaults from them.
2. **Generations:** multi-generation fountain with metadata frames, unit-tested end to end with simulated frame loss (no camera).
3. **Screen → camera transfer** of a file, with progress, SHA-256 check, and Download/Share.
4. **Sound done signal,** plus integration into the v2 send flow as the fallback.
5. **Stretch:** adaptive rate; a color or custom-grid experiment behind `Symbology`.

**Done when (target):** a 1 MB PDF moves from Android to Android with no network in under 2 minutes, holding the phone casually.

---

## v4 sketch — Nearby multiplayer

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
- v3: is QR enough, or does a color/custom grid code pay for its fragility? Decide from the milestone-1 bench numbers.
- A custom modem: see *Experiments*.

---

## Experiments (curiosities, not on the app roadmap)

Things worth trying for the fun of it, or as a last-resort fallback. Each one plugs in behind the existing `Modem` interface, so nothing above it changes. Each one gets evaluated with the channel simulator first.

### OFDM modem

**How ggwave works today:** multi-tone FSK. Each 4-bit nibble selects 1 of 16 tones spaced 46.875 Hz apart (one FFT bin at 48 kHz / 1024). Six nibbles sound at once as 6 tones over 96 bins, which is 4.5 kHz. The symbol duration is 192/128/64 ms for Normal/Fast/Fastest. Reed–Solomon adds about 40%. Fast nets about 15 B/s. The design is deliberately wasteful: only 1 bin in 16 carries energy, and symbols are long so echoes can die out.

**The ceiling:** Shannon's limit for about 10 kHz of usable phone bandwidth at about 30 dB SNR is about 100 kbit/s. Reverb, not noise, is the practical limit: intersymbol interference and frequency-selective fading.

**The design:** OFDM with every bin carrying data. Use QPSK to start, and adapt the modulation per bin later. A cyclic prefix absorbs early echoes. Pilot tones drive channel estimation and equalization. Add sample-clock drift tracking, a convolutional or LDPC code with frequency interleaving, and a chirp preamble for synchronization.

**Rough budget for 2–8 kHz:** 128 bins × 2 bits per symbol over a symbol of about 31 ms (21.3 ms + 10 ms prefix) gives about 8 kbit/s raw. After pilots and a rate-½ code, that's **about 400–500 B/s, roughly 30× ggwave Fast**. Ultrasound adds more on top. These are estimates to check in the simulator.

**Where it would help:** handshake latency (about 7 s → under 1 s for about 100 B), and a fallback for when WebRTC and the camera both fail.

### Melody encoding ("musical steganography")

Make the transmission sound like a pleasant tune instead of a chirp.

- **Basic version:** pick notes from a pentatonic scale, where any sequence sounds consonant. For example, 16 notes over about 3 octaves carry 4 bits per note. Rhythm, such as note duration chosen from a few values, can carry more bits. Decode by tracking the fundamental frequency with an FFT, using harmonic summing so a richer timbre (a synth voice with overtones) still decodes. At about 6–8 notes/s, expect about 3–4 B/s. It is slow, but charming.
- **Clever version:** reuse the arithmetic coder *in reverse*. Feed the message bits to an arithmetic **decoder** driven by a melody model, such as a Markov model of note-to-note intervals trained on folk tunes. The output is a melody that the model considers likely, so it *sounds like music*. The receiver transcribes the notes and runs the arithmetic **encoder** to recover the bits. This is the trick behind language-model steganography, applied to tunes. The cost: less entropy per note, so even slower.
- **Hard parts:** reverb smears legato notes, so use short plucky envelopes with gaps. Octave errors in pitch tracking are another problem. Use the fountain code plus CRCs as-is. A melody only needs to be unambiguous to the decoder, not to people.

### Others

- Adaptive bit loading per bin, measured from a training preamble (DSL style).
- Color or custom-grid visual codes (see v3).
