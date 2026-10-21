# Earshot technical guide

This guide explains how Earshot moves bytes through the air between two browsers: first the physics and theory behind each piece, then the concrete design as it is built. It covers v1 (acoustic messaging). The formats themselves are specified in [SPEC.md](SPEC.md), and every measured number here comes from [NOTES.md](NOTES.md), where you can find the full tables and how to reproduce them.

The whole stack, from the top down:

```
 sender                                                     receiver
 ──────                                                     ────────
 typed message (text, link, contact, Wi-Fi, prompt)         message card
      │ pack fields, pick smallest codec                         ▲ validate, decompress
      ▼                                                          │
 encoded message bytes                                      encoded message bytes
      │ ≤ 134 B: one SINGLE frame                                ▲ SINGLE: as is
      │ longer: fountain-coded blocks                            │ FOUNTAIN: Gaussian elimination
      ▼                                                          │
 frames (6-byte header + CRC-16, ≤ 140 B)                   frames (CRC checked, echoes dropped)
      │ ggwave encode, one frame per band                        ▲ ggwave decode, one decoder per band
      ▼                                                          │
 waveform (audible + ultrasound mixed) ── speaker ~~~ air ~~~ mic ── AudioWorklet
```

Contents:

1. [The acoustic channel](#1-the-acoustic-channel)
2. [The modem](#2-the-modem)
3. [Framing](#3-framing)
4. [Messages](#4-messages)
5. [Compression](#5-compression)
6. [Fountain coding](#6-fountain-coding)
7. [Dual-band transmission](#7-dual-band-transmission)
8. [The receive pipeline](#8-the-receive-pipeline)
9. [The channel simulator](#9-the-channel-simulator)
10. [Looking ahead](#10-looking-ahead)

---

## 1. The acoustic channel

A speaker and a microphone a meter apart look like a simple link, but sound is a hostile medium for data:

- **Reverb.** Sound bounces off walls, floors and furniture, so the mic hears the direct signal plus a smeared tail of delayed copies. Rooms are described by RT60, the time for that tail to decay by 60 dB. If one tone's echo is still ringing when the next tone starts, the receiver confuses them. This turned out to be the main enemy in simulation, more than noise.
- **Frequency response.** Phone speakers are tiny. They reproduce little bass and often roll off near the top of the audible range, and small mics have their own shape. A protocol that relies on frequencies the hardware can't reproduce simply fails. This matters most for ultrasound (15–19.5 kHz), which is close to where phone hardware gives up.
- **Noise.** Voices, TVs, fans and traffic. Most room noise sits at low and middle frequencies, with little energy above 15 kHz.
- **Clock drift.** Sender and receiver each have their own sample clock, and the two never agree exactly. A receiver running a few hundred parts per million fast or slow sees every tone at a slightly wrong frequency and duration. In the milestone 0 spike, ggwave decoded correctly at 48 kHz even with 500 ppm of drift.
- **Device DSP.** Browsers and phones run voice-call processing on the microphone by default: echo cancellation, noise suppression and automatic gain control (AGC). These are built to keep speech and remove everything else, so steady data tones are exactly what they try to remove, and AGC changes the level mid-transmission.

Earshot's countermeasures at this layer:

- The mic is always opened with `echoCancellation`, `noiseSuppression` and `autoGainControl` set to `false`. The settings the browser actually applied (`track.getSettings()`) are logged in the debug drawer, because a browser is allowed to ignore the request. On Android Chrome, all three came back `false` (and `voiceIsolation` too), with a 48 kHz sample rate, 16-bit samples and one channel. iOS Safari has not been checked yet.
- The `AudioContext` is created at a fixed **48 kHz**, so the browser resamples the mic to that rate. In the spike, 44.1 kHz input was fragile: decoding succeeded or failed depending on the chunk size, and even native 44.1 kHz in and out failed. Forcing 48 kHz sidesteps that. Android Chrome and laptop Chrome honored the request.

## 2. The modem

Earshot uses [ggwave](https://github.com/ggerganov/ggwave) (npm `ggwave@0.4.0`, pinned), a WebAssembly build of a C++ data-over-sound library.

### How ggwave signals

ggwave uses **multi-frequency FSK** (frequency-shift keying). The band is divided into many narrow frequency bins. In each symbol period, the transmitter plays several tones at once, and *which* bins carry a tone encodes the data bits. The receiver runs an FFT on each block of samples, finds the loudest bins and maps them back to bits. Start and end marker sequences around each transmission let the receiver find where the data begins and ends; these markers cost roughly a second of fixed overhead per transmission.

On top of this, ggwave adds **Reed–Solomon error correction**: extra parity bytes computed from the payload, which let the decoder repair a limited number of corrupted bytes. Reed–Solomon is a good fit for FSK, because a misread tone corrupts a whole symbol, and RS works on whole bytes.

### Protocols and bands

ggwave offers several protocols that trade speed against robustness. A slower protocol uses longer tones, which survive reverb tails better. Measured airtimes at 48 kHz:

| Protocol | Band | 33-byte payload | 140-byte payload |
|---|---|---|---|
| Normal (audible or ultrasound) | 1.9–6.4 kHz / 15–19.5 kHz | 3.75 s | 13.55 s |
| Fast | same | 2.73 s | 9.26 s |
| Fastest | same | 1.71 s | 4.97 s |
| DT Fast | lower dual-tone band | 6.83 s | 26.15 s |
| DT Fastest | lower dual-tone band | 3.75 s | 13.42 s |

On a full frame, Fastest moves about 28 B/s and Fast about 15 B/s. The audible and ultrasound variants of each tier are identical except for the band. DT Normal never decoded in testing, even on a clean digital loopback, so it is left out of the picker. The other DT protocols are kept under "Low tones (unreliable)".

**Audible vs ultrasound.** The audible band (1.9–6.4 kHz) is reproduced well by every speaker and mic, and you can hear when a transfer is happening. The ultrasound band (15–19.5 kHz) is quiet to most adults and avoids most room noise, but it depends on hardware reaching that high. In practice, laptop speakers, Android phone speakers and their mics all handled it in tests. It is not inaudible to animals: cats have been seen reacting to it.

### The 140-byte limit and binding quirks

A single ggwave transmission carries at most **140 bytes**. Everything above the modem is built around that "frame" size. The milestone 0 spike found several quirks in the JavaScript binding, and the adapter in `src/modem/ggwave-modem.ts` hides them all:

- **Binary is clean.** `encode` accepts a `Uint8Array`, and all 256 byte values, including `0x00`, round-trip. No base64 is needed, so all 140 bytes are usable.
- **More than 140 bytes is silently truncated.** The adapter throws instead.
- **Results alias static WASM memory.** `encode` and `decode` return views that the next call overwrites, so the adapter copies them immediately.
- **At most four live instances.** Creating a fifth returns an invalid handle, and the next `encode` crashes the WASM module. The adapter uses three (one transmitter and two receivers) and always frees before re-creating.
- **`decode` silently drops partial frames.** Each call must get an exact multiple of 1024 samples (ggwave's `samplesPerFrame`), or nothing ever decodes. The adapter buffers incoming audio into 1024-sample blocks.
- **The receive protocol set is captured at `init`.** `rxToggleProtocol` is a global switch, but each instance snapshots it when created. The adapter uses this to build one audible-only and one ultrasound-only decoder (section 7).
- **It prints on every encode.** The adapter passes silent `print`/`printErr` hooks to the factory and disables ggwave's log.
- **It can return wrong bytes without an error** on small payloads. That gets its own section next.

Nothing outside `src/modem/` imports ggwave. Everything else talks to a narrow `Modem` interface (`encode`, `encodeParallel`, `pushSamples`, `setSampleRate`, `maxFrameBytes`) and works on `Uint8Array`, so a faster custom modem could replace ggwave later without changes elsewhere.

The **volume** setting in the app (5–100, default 25) is passed straight to ggwave's `encode` as its output volume.

## 3. Framing

Every transmission is one **frame** of at most 140 bytes, with a 6-byte header:

```
 offset   0         1        2      3      4      5      6 ...
        ┌─────────┬────────┬─────────────┬─────────────┬──────────────────────┐
        │ magic   │ kind   │ nonce (u16) │ crc16 (u16) │ body (≤ 134 bytes)   │
        │ 0xE1    │ 0 or 1 │ big-endian  │ big-endian  │                      │
        └─────────┴────────┴─────────────┴─────────────┴──────────────────────┘
                                          CRC covers bytes 0–3 and the body
```

- **magic + version** is `0xE1` for v1. Anything else is rejected, so stray decodes from other ggwave apps, or a future incompatible version, are ignored.
- **kind** is `0` = SINGLE (the body is a whole message) or `1` = FOUNTAIN (the body is a fountain packet, section 6).
- **nonce** is a random 16-bit number chosen once per page load (a "sender session").
- **crc16** is CRC-16/CCITT-FALSE (polynomial `0x1021`, initial value `0xFFFF`), computed over every byte of the frame except the CRC field itself.

### Why a CRC on top of Reed–Solomon?

ggwave already does error correction, so it might seem redundant to add a checksum. But the spike showed that **ggwave sometimes returns wrong bytes, and even the wrong length, without signaling an error.** On a clean loopback, with 25 random payloads per cell, Fastest produced wrong data in 4 of 25 two-byte trials and 8 of 25 three-byte trials. An earlier fixed-alignment sweep saw about 5% wrong decodes at 8–11 bytes on Fastest. The Reed–Solomon parity on tiny payloads is simply too short to always detect damage, so a corrupted frame can come out "successfully" decoded.

A 16-bit CRC catches all but about 1 in 65,536 of those random corruptions, for 2 bytes per frame. In the simulator, no payload of 16 bytes or more decoded wrongly across about 5,000 trials, so the CRC is cheap insurance rather than a constant firefight. Fountain-coded messages get a second, end-to-end CRC-32 over the reassembled message (section 6).

### The nonce: echoes and dedupe

The nonce does two jobs:

- **Self-echo suppression.** A device that is listening hears its own speaker. Every frame carries the sender's nonce, and the receiver drops frames whose nonce matches its own session. The receiver also simply stops listening while transmitting (section 8); the nonce check catches whatever slips through, such as a late reflection.
- **Telling senders apart.** Dedupe keys and fountain decoders are scoped by nonce, so two people broadcasting at once don't get their blocks mixed together.

Sixteen bits is enough for a room full of devices. A collision would only mean two senders' messages could be confused, and the CRCs would reject mixed fountain data.

## 4. Messages

A message is what a frame (or a fountain-coded block stream) carries:

```
 ┌──────────┬───────────┬──────────────────────────┐
 │ type u8  │ flags u8  │ payload (maybe compressed)│
 └──────────┴───────────┴──────────────────────────┘
               │
               └─ low nibble = codec: 0 none, 1 deflate-raw, 2 text model v1
                  high nibble: unused in v1
```

| Type | Code | Payload before compression |
|---|---|---|
| TEXT | `0x01` | UTF-8 text |
| URL | `0x02` | UTF-8 URL |
| CONTACT | `0x03` | `name␞phone␞email␞org` |
| WIFI | `0x04` | `auth␞ssid␞password[␞1]`, auth = `W` (WPA), `E` (WEP) or `N` (open); a trailing `1` means hidden |
| ASSISTANT_PROMPT | `0x05` | `prompt[␞context]` |
| RTC_OFFER / RTC_ANSWER | `0x10` / `0x11` | reserved for v2 |
| GAME_INVITE | `0x20` | reserved for v3 |

`␞` is byte `0x1E`, the ASCII "record separator". It almost never appears in real text, which makes it a cheaper field separator than JSON or the `WIFI:T:…;S:…;` QR syntax. Any `0x1E` inside a value is replaced with a space before packing, and **trailing empty fields are dropped**, so a contact with only a name is just the name. Packing alone saves a lot: an earlier JSON contact like `{"n":"…","p":"…"}` spends a dozen bytes on punctuation and keys.

The largest message that fits in a SINGLE frame is 140 − 6 = **134 bytes** after encoding (type, flags and compressed payload). Anything longer is fountain coded.

### Validation and safety

Everything decoded came from the air, and anyone in range can transmit, so the decoder treats all input as untrusted:

- **Strict parsing.** Text must be valid UTF-8 (a fatal decoder is used). A contact needs a name, Wi-Fi needs a known auth letter and an SSID, and a prompt can't be empty. Anything malformed is rejected, and the rejection is logged in the debug drawer.
- **Unknown codecs are rejected**, not guessed at (see [forward compatibility](#forward-compatibility)). Unknown *types* with a valid codec are shown as a hex dump.
- **Decompression is capped** at 65,535 bytes, for both deflate and the text model, which defuses "decompression bomb" payloads.
- **Links:** a URL message only becomes a link card if it is `http://` or `https://` with no whitespace and parses as a URL. Anything else, such as `javascript:` or `intent:`, is downgraded to plain text. Links open only on a tap of **Open** (in a new tab, with `noopener noreferrer`).
- **Contacts:** "Add to contacts" generates a vCard 3.0 file. Values are escaped (`\`, `;` and `,`) and line breaks are stripped, so a malicious name can't inject extra vCard properties.
- **Nothing is automatic.** No auto-open, auto-download, auto-join or auto-run. All text is rendered through text nodes, never as HTML.

## 5. Compression

Airtime is the scarce resource: on Fast, every extra byte costs about 60 ms of airtime. Shrinking messages is worth real effort.

### Why general-purpose compressors fail on short messages

Compressors like deflate (zip, gzip) learn as they go. They find repeated strings *within the input* and replace later copies with back-references. A 30-byte message has almost nothing to repeat, and the compressor still pays for its own headers and code tables. Measured with deflate-raw (the leanest variant, via the browser's `CompressionStream`):

| Sample | Raw | Deflate |
|---|---|---|
| Short text | 31 B | 33 B (+6%) |
| URL | 41 B | 43 B (+5%) |
| Long Maps URL | 86 B | 86 B |
| Contact (JSON) | 103 B | 95 B (−8%) |
| Wi-Fi string | 61 B | 63 B (+3%) |
| Prompt (JSON) | 94 B | 82 B (−13%) |
| Paragraph | 244 B | 153 B (−37%) |

Deflate only starts paying off around 100 bytes. Most Earshot messages are shorter than that.

The fix is to bring the knowledge with you. A **static model**, built in advance and shipped with the page, already "knows" that ` the` and `https://www.` are common, so even a one-word message benefits.

### The static model

The text model (`src/compress/`) has three parts.

**1. A byte-level vocabulary.** The model has 4,096 tokens: an end-of-message token, all 256 single bytes (so *any* input can be encoded, including emoji or binary), and 3,839 multi-byte tokens such as ` the`, `ing`, `.com` and `https://`. The multi-byte candidates come from **GPT-2's byte-pair-encoding merges**. BPE builds a vocabulary by repeatedly merging the most frequent adjacent pair, so its merge list is a ready-made, roughly frequency-ordered list of useful byte strings, drawn from about 40 GB of web text. Earshot takes the first 30,000 merges as candidates and keeps the most useful ones (see training below).

**2. Minimum-cost segmentation.** A string can be split into tokens many ways: `there` could be `there`, `the`+`re` or `t`+`h`+`e`+`r`+`e`. Each token has a cost in bits (below), and the encoder picks the split with the *lowest total cost* using dynamic programming. Walking left to right, it keeps the cheapest way to reach each position, extending from every reachable position through a trie of token byte strings. This is optimal for the model, unlike greedy longest-match, which can paint itself into a corner.

**3. Arithmetic coding.** Each token has a fixed probability *p* (its frequency in the training corpus). Arithmetic coding turns a sequence of tokens into a single binary fraction, spending very close to **−log₂ p bits per token**:

| Token probability | Cost |
|---|---|
| 1/2 | 1 bit |
| 1/64 | 6 bits |
| 1/1024 | 10 bits |
| 1/65536 | 16 bits |

The intuition: the coder starts with the interval [0, 1) and, for each token, narrows it to that token's slice, whose width is proportional to *p*. A likely token keeps most of the interval, while a rare one shrinks it a lot. At the end, it writes just enough bits to pin down a number inside the final interval, and an interval of width *w* needs about −log₂ *w* bits. So a common 4-byte token like ` the` might cost only a handful of bits, while an unusual byte costs more than 8. This is also why the segmentation minimizes the sum of −log₂ *p*: that sum *is* the output size.

The coder is a classic 32-bit integer arithmetic coder (Witten–Neal–Cleary style) with static cumulative frequencies, scaled so their total is at most 2¹⁶ (which keeps all the arithmetic exact in JavaScript numbers). An explicit end-of-message token marks where the message stops. The decoder also detects runaway reads past the end of the input and rejects them as corrupt.

### Training

`tools/train-compressor.ts` builds the model from:

- 250,000 English sentences from **Tatoeba** (short, everyday text),
- *The Adventures of Sherlock Holmes* from **Project Gutenberg** (longer prose),
- 40,000 **synthetic** URLs, email addresses, contacts and Wi-Fi payloads in Earshot's packed formats.

The procedure is a simple form of expectation–maximization:

1. Start every token at a flat cost.
2. Segment the whole corpus optimally with the current costs.
3. Set each token's cost to −log₂ of how often it was used. Repeat a few times.
4. Prune to the 4,096 most-used tokens, then refine again on the smaller vocabulary, with smoothing so that no token has zero probability.

The dev set is held out: 3,000 sentences, 150 paragraphs and 1,500 synthetic items generated from a different random seed.

**Vocabulary size sweep** (dev set):

| Vocabulary | Bits per byte | Model JSON |
|---|---|---|
| 1k | 3.93 | 9 KB |
| 2k | 3.57 | 20 KB |
| **4k** | **3.36** | **45 KB** |
| 8k | 3.25 | 93 KB |
| 16k | 3.22 | 196 KB |

Gains flatten out beyond 4k while the model keeps doubling in size, so 4k was chosen. Plain ASCII text is 8 bits per byte, so 3.36 bits per byte is less than half. The model is loaded lazily, as a roughly 20 KB gzipped chunk, the first time a message is encoded or decoded.

### Results

Evaluated with `npm run eval:compress` on hand-written messages never used in training. "Before" means the older format (JSON or QR-style payloads, deflated if that was smaller); "after" means packed payloads plus the best codec:

| Category | Before | After | Saving | Airtime on Fast |
|---|---|---|---|---|
| Short texts (20) | 27.9 B | 11.8 B | 58% | 2.97 → 2.01 s |
| URLs (15) | 48.3 B | 31.7 B | 34% | 4.18 → 3.20 s |
| Contacts (8) | 67.1 B | 36.9 B | 45% | 5.31 → 3.53 s |
| Wi-Fi (6) | 43.5 B | 21.7 B | 50% | 3.93 → 2.60 s |
| Prompts (8) | 77.3 B | 26.9 B | 65% | 5.90 → 2.87 s |
| Long notes (4) | 164 B | 92.3 B | 44% | 2 fountain blocks → 1 frame |

Overall, 3,354 bytes became 1,721 bytes: **49% smaller**. (This combines the field packing and the model. Both contribute.) URLs gain the least, because random IDs in paths and query strings are essentially incompressible.

### Choosing a codec

The sender doesn't guess. It encodes the payload **three ways**, raw, deflate-raw and text model, and keeps the smallest, recording the choice in the codec nibble. Raw wins for tiny or random payloads (and on ties), the text model for most short text, and deflate can win on long, repetitive input.

### Forward compatibility

The codec nibble has room for 16 codecs. A receiver that sees a codec it doesn't know rejects the message instead of guessing. That's why **a retrained model must get a new codec ID**: tokens are identified by position in the model, so decoding new-model output with the old model would silently produce garbage. With a new ID, older pages fail cleanly.

## 6. Fountain coding

### Why broadcast needs rateless codes

A long message must be split across several frames, and over sound some of those frames will be lost. The usual fix, where the receiver tells the sender which pieces it missed, doesn't work here:

- **There's no back channel.** A broadcast has any number of listeners and no acknowledgments, and listeners would talk over each other anyway.
- **Late joiners.** Someone who starts listening halfway through has missed the beginning.
- **Every listener loses different frames.** Retransmitting "chunk 3" helps one listener and wastes airtime for everyone else.

A **fountain code** (or rateless code) solves all three. The sender turns k source blocks into an *endless* stream of encoded blocks, each a combination of source blocks. A listener can rebuild the message from *any* k or so blocks it happens to catch, no matter which ones or in what order. There is no such thing as a missing chunk, only "not enough yet". Like filling a glass at a fountain, you don't care which drops you catch.

### Random linear codes over GF(2)

Earshot uses a **random linear fountain code over GF(2)**. GF(2) is arithmetic on single bits, where addition is XOR. Each encoded block is the XOR of a subset of the k source blocks, and the subset is described by a k-bit coefficient vector. For example, with k = 4, the vector `1011` means block 0 ⊕ block 2 ⊕ block 3.

A receiver that collects encoded blocks is collecting linear equations over the unknown source blocks. Once it has k *linearly independent* equations, it can solve for every source block. Random linear codes are a better fit than the better-known LT codes at Earshot's small block counts (a few to a few dozen blocks): LT codes are designed for thousands of blocks and need noticeably more overhead when k is small.

How much extra does a receiver need? If it already has k − 1 independent blocks, a random new combination fails to help only if it falls inside the space already covered, which happens with probability about 1/2. Each further block halves the chance of still being stuck, so a few blocks beyond k almost always suffice. SPEC.md's rule of thumb is k plus 1–3 frames.

### Design details

**Systematic first.** Seeds `0` to `k−1` mean "source block *seed* alone", so the first k frames are just the message, block by block. A listener that hears all of them decodes with exactly k frames and zero overhead. Seeds of k and above select a pseudo-random subset.

**Seeded coefficients.** The subset isn't sent; only a 16-bit seed is. Both sides derive the coefficient vector from (seed, k) with a small xorshift32 generator, retrying in the rare case it comes out all zeros. After the systematic blocks, the sender walks through seeds starting from a random offset, so it can emit tens of thousands of distinct combinations before repeating.

**Source layout.** The message is prefixed with its length and a CRC-32, zero-padded, and split into k equal blocks:

```
 ┌─────────────┬───────────────┬──────────────────────────┬─────────┐
 │ len (u16)   │ crc32 (u32)   │ encoded message          │ zero pad│
 └─────────────┴───────────────┴──────────────────────────┴─────────┘
 └──────── block 0 ────────┴──── block 1 ────┴─ … ─┴──── block k−1 ──┘
```

The CRC-32 (IEEE, as used by zip and PNG) verifies the *reassembled* message. Each frame has its own CRC-16, but a CRC-32 over the whole result guards against anything that slips through and gets mixed into the solution. If it fails, the receiver discards that decoder and starts over.

**Even blocks.** Rather than filling 129-byte blocks and leaving the last one mostly padding, the encoder computes k = ⌈(6 + len) / 129⌉ and then sizes the blocks evenly as B = ⌈(6 + len) / k⌉. For example, a 500-byte encoded message needs 506 source bytes, so k = 4 and B = 127, with 2 bytes of padding.

**Packet header.** A fountain frame's body is:

```
 ┌──────────────┬────────┬─────────────┬──────────────────────────┐
 │ msgId (u16)  │ k (u8) │ seed (u16)  │ encoded block (B bytes)  │
 └──────────────┴────────┴─────────────┴──────────────────────────┘
```

`msgId` is the low 16 bits of the CRC-32 of the encoded message, so it is derived from the *content*. If you press Send again with the same text, the new frames feed listeners' existing decoders, topping them up instead of starting a new transfer. With the 6-byte frame header and 5-byte packet header, a full frame carries 140 − 11 = **129 bytes** of block data. Because k is a single byte, a message can have at most 255 blocks, about 32 KB encoded, which would take a very long time to send.

**Incremental Gaussian elimination.** The receiver doesn't wait for k blocks and then solve a big system. It reduces each block as it arrives. It keeps at most one stored row per "pivot" column, where a row's pivot is its lowest set coefficient bit. A new block is XORed against the stored rows whose pivot bits it contains, in ascending order. If anything is left, it becomes a new stored row, and the rank goes up by one. If it reduces to zero, the block was redundant and is dropped. Once the rank reaches k, a back-substitution pass turns each row into a single source block, the length and CRC-32 are checked, and the message is complete. The progress bar in the Listen tab shows this rank ("3 / 7 blocks").

**Send vs Broadcast.** *Send* plays ⌈(k + max(1, ⌈k/4⌉)) / lanes⌉ rounds: all k systematic blocks plus about 25% repair blocks (at least one), divided across the bands in use. *Broadcast* keeps generating fresh combinations until you press Stop, and requests a Screen Wake Lock, because mobile browsers suspend audio when the screen sleeps.

### Block size and overhead

Should blocks be large or small? Smaller blocks lose less per lost frame, but every transmission pays about one second of fixed marker overhead, plus 11 bytes of headers. The simulator settled it. First, frame success barely depends on payload length:

| Protocol | Payload | Airtime | Success (living room, 0 dB) | Goodput |
|---|---|---|---|---|
| audible-fast | 16 B | 1.83 s | 97% | 8.4 B/s |
| audible-fast | 64 B | 4.65 s | 87% | 11.9 B/s |
| audible-fast | 140 B | 9.26 s | 93% | 14.1 B/s |

Then end to end, a 500-byte message on audible-fast with block sizes of 129, 64 and 32 bytes took a median of **25 s, 32 s and 41 s** to deliver (41 s rose to 61 s at −5 dB). Full-size blocks win, so the default is the maximum, 129 bytes, rather than the 64 bytes originally guessed.

Overhead, all told: 11 header bytes per 140-byte frame (about 8%), 6 bytes per message for length and CRC-32, padding smaller than k bytes, and on lossy channels a few extra frames beyond k. A listener who hears every systematic frame pays no reception overhead at all.

## 7. Dual-band transmission

The audible (1.9–6.4 kHz) and ultrasound (15–19.5 kHz) protocols occupy separate, non-overlapping bands. So two frames can be encoded separately, **added together into one waveform**, and played at once, like two radio stations on different frequencies.

**Mixing.** Each band's waveform is scaled by **1/√2** before summing, which splits the power evenly so the mix is about as loud overall as a single transmission (each band at −3 dB). The sum is clipped to [−1, 1].

**Receiving.** One ggwave decoder that listens for every protocol locks onto only one of the two transmissions. The adapter therefore creates two decoders, one that only listens for audible protocols (plus DT, which overlaps that band) and one that only listens for ultrasound, and feeds both the same samples. Receivers always run both, whatever mode the sender chose.

**What goes on each lane.** A transmission proceeds in *rounds*, with one frame per lane (band) per round, separated by 200 ms of silence. For fountain messages, each lane carries a different seed, which is the throughput win: the decoder doesn't care which band a block arrived on. A SINGLE message repeats the same frame on both lanes, which gives diversity rather than speed (if one band is drowned out, the other may still get through), and the receiver counts the two copies as one.

**Measured gain.** In the living-room model with 64 bytes per band, at the same *total* power (30 trials):

| SNR | Audible alone | Ultra alone | Dual: audible | Dual: ultra | Dual goodput vs best single |
|---|---|---|---|---|---|
| 10 dB | 100% | 100% | 100% | 100% | 2.00× |
| 0 dB | 100% | 100% | 97% | 100% | 1.97× |
| −5 dB | 87% | 100% | 70% | 100% | 1.70× |
| −10 dB | 30% | 87% | 3% | 80% | 0.96× |

That's about **2× throughput in ordinary conditions**, breaking even only when it's very noisy, because each band gets half the power. End to end, dual band cut delivery of a 1,500-byte message from 71 s to 35 s. For 500 bytes (k = 4), the gain was 25 s to 16 s, limited by rounding up to whole rounds. That's why **Dual Fast** is the default mode.

The simulator does not model speaker nonlinearity: playing two bands loudly through a small speaker can create intermodulation products. Phone-to-phone tests on Android have worked in both directions, but this is worth keeping an eye on with other hardware.

## 8. The receive pipeline

**Capture.** When you tap Start listening, the page opens the mic with the DSP-off constraints from section 1 and connects it to an **AudioWorklet**, a small processor that runs on the browser's real-time audio thread. Web Audio delivers audio in 128-sample "render quanta". The worklet batches them into 2048-sample buffers and posts each one to the main thread, transferring the buffer rather than copying it. (The worklet is routed through a muted gain node, because worklets only run while connected to the audio graph.) The older `ScriptProcessorNode` that ggwave's own examples use is deprecated, and it runs on the main thread, where it is prone to glitches.

**Decoding.** The main thread passes each buffer to `modem.pushSamples`, which slices the stream into exact 1024-sample blocks (ggwave's frame size, see section 2) and runs both band decoders on every block. A finished frame comes out a little *before* its waveform ends, because ggwave pads the tail, so perceived latency is essentially airtime.

The same mic stream also feeds an `AnalyserNode` that draws the live spectrogram, with the audible and ultrasound bands marked.

**The deaf tail.** While a device is transmitting, its receive path ignores the mic completely, and it stays deaf for another **300 ms** after the last round so that the room's echo can die down. The nonce check (section 3) is the second line of defense.

**Frame handling.** Each decoded frame goes through the `Receiver`:

1. Check magic, kind and CRC-16; otherwise reject (logged in the debug drawer).
2. Drop it if the nonce is our own (an echo).
3. **SINGLE:** decode the message. Copies of the identical frame from the same sender within **2 seconds** count once (the same frame arrives on both bands in dual mode). A later repeat bumps the card's "heard N×" counter instead of adding a new card.
4. **FOUNTAIN:** look up the decoder for (sender nonce, msgId), creating one if needed or if k or the block size changed. Add the block, update the progress bar, and when the rank reaches k, verify the CRC-32 and decode the message. Once a message is complete, further blocks for it are ignored.

**Stale decoders.** A partially received fountain message that gets no new block for **5 minutes** is forgotten, so abandoned transfers don't pile up in memory.

When a message completes, it appears as a card at the top of the Listen tab, the phone vibrates briefly where supported, and the Listen tab shows an unread count if you're on the Send tab.

## 9. The channel simulator

Tuning by waving phones around is slow and hard to repeat, so Earshot has a Node-based channel simulator (`test/channel-sim.ts`, `test/sim/`). It runs the real ggwave encoder and decoder, with a model of the air in between.

### Stages

```
 ggwave waveform
   → speaker low-pass        4th-order Butterworth; corner 19.5 kHz ("good"), 17.5 kHz ("phone"), 14 kHz ("cheap")
   → room impulse response   direct path + exponentially decaying noise tail (RT60), scaled to a direct-to-reverberant ratio
   → ambient noise           white or pink, at a target SNR
   → mic high-pass           200 Hz (small mics hear little low end)
   → gain and clipping       to [−1, 1]
   → clock drift             resampling by (1 + ppm × 10⁻⁶)
   → fed to the decoder in 2048-sample chunks, like the AudioWorklet
```

The room impulse response is synthetic: a unit direct path, then, after a 3 ms pre-delay, Gaussian noise whose amplitude falls by 60 dB over RT60, scaled so the tail's energy matches the requested direct-to-reverberant ratio (DRR). Higher DRR means you're closer to the speaker.

**SNR is measured against the *transmitted* signal**, not the signal after the speaker filter. A first version measured it after the filter, which silently scaled the noise down whenever the speaker attenuated the signal and made band-limiting look free. That bug was found and fixed. Now a speaker that can't reproduce a band pays for it in SNR, as it would against real ambient noise.

The default "living room" is a phone speaker and mic (17.5 kHz roll-off), RT60 0.4 s, DRR 0 dB, pink noise, and 50 ppm drift. Each transmission starts at a random offset against ggwave's 1024-sample grid.

### Experiments

`npm run sim -- [--trials N] [--only A,B,...]` runs these:

| ID | Experiment |
|---|---|
| A | SNR sweep, white noise, ideal speaker and mic, no reverb |
| B | SNR sweep, living room |
| C | Speaker/mic frequency response (flat, good, phone, cheap) |
| D | Reverb (RT60 0.2 to 0.8 s at various DRRs) |
| E | Payload length vs success and goodput |
| F | Whole-message delivery time through the fountain pipeline, including late joiners |
| G | Fountain block size |

### Key results

The tables in NOTES.md used 30 trials per cell for frame-level results (about ±9% sampling error) and 12 per cell for end-to-end runs.

**Living-room SNR sweep** (32-byte frames):

| Protocol \ SNR | 10 dB | 0 dB | −5 dB | −10 dB | −15 dB |
|---|---|---|---|---|---|
| audible-normal | 100% | 93% | 90% | 27% | 0% |
| audible-fast | 100% | 100% | 87% | 47% | 0% |
| audible-fastest | 83% | 80% | 70% | 37% | 0% |
| ultrasound-normal | 100% | 100% | 97% | 100% | 53% |
| ultrasound-fast | 100% | 100% | 100% | 100% | 73% |
| ultrasound-fastest | 77% | 77% | 63% | 60% | 23% |
| dt-fast | 97% | 63% | 20% | 0% | 0% |
| dt-fastest | 70% | 80% | 7% | 0% | 0% |

**Reverb** (32-byte frames, 20 dB SNR):

| Protocol \ RT60 (DRR) | 0.2 s (+3) | 0.4 s (0) | 0.8 s (−3) | 0.8 s (−9) |
|---|---|---|---|---|
| audible-normal | 100% | 100% | 90% | 70% |
| audible-fast | 100% | 100% | 43% | 13% |
| audible-fastest | 100% | 87% | 0% | 0% |
| ultrasound-fast | 100% | 100% | 27% | 10% |

**Whole-message delivery**, broadcast mode, living room (median seconds of listening until decoded):

| Message | Mode | 10 dB | 0 dB | −5 dB | 0 dB, late joiner |
|---|---|---|---|---|---|
| 100 B | audible-fast | 6 s | 6 s | 6 s | 9 s |
| 100 B | dual fast | 6 s | 6 s | 6 s | 10 s |
| 500 B | audible-fast | 25 s | 25 s | 25 s | 40 s |
| 500 B | ultrasound-fast | 25 s | 25 s | 25 s | 38 s |
| 500 B | dual fast | 16 s | 16 s | 25 s | 28 s |
| 1500 B | audible-fast | 71 s | 71 s | 89 s | 101 s |
| 1500 B | ultrasound-fast | 71 s | 71 s | 71 s | 84 s |
| 1500 B | dual fast | 35 s | 35 s | 44 s | 56 s |

Every end-to-end trial completed. Late joiners (who start listening somewhere in the first ~24 s) pay roughly one extra round plus the partial round they walked in on.

### What the numbers decided

- **Reverb, not noise, is the main enemy.** Fast breaks down at RT60 0.8 s, while Normal holds up best because its longer symbols ride out the echo tail. Normal is the mode to try in a big, echoey room.
- **Fastest is unreliable** even in good conditions (about 75–85% at 10 dB), so it is labeled "fragile". **Fast** is the default tier: 100% down to 0 dB in the living-room model.
- **Use full frames:** fountain blocks default to the maximum 129 bytes (section 6).
- **Ultrasound beats audible against pink noise**, because room noise has little energy above 15 kHz, as long as the speaker can reproduce the band. Real devices so far (laptops and Android phones) can.
- **DT protocols are the weakest everywhere** and are kept only under "unreliable".
- **Dual band roughly doubles throughput** (section 7), so Dual Fast became the default mode.
- **No wrong-data decodes** for payloads of 16 bytes or more across about 5,000 trials. The per-frame CRC remains for the tiny-payload failures seen in the spike.

The simulator is a model, not the real world. Real rooms, speakers and phones vary, so the open questions are listed in the manual test checklist in [NOTES.md](NOTES.md#manual-test-checklist-real-devices).

## 10. Looking ahead

At ggwave's tens of bytes per second, sound is fine for messages but hopeless for files. The v2 plan in [SPEC.md](SPEC.md) uses sound only for what it's good at: a short handshake.

WebRTC can connect two browsers directly, but first each side needs the other's connection details (ICE credentials, a DTLS certificate fingerprint and network candidates), which a signaling server normally relays. In v2, those details are stripped from the multi-kilobyte SDP down to a compact binary form of about 90–130 bytes, which is one or two frames. The sender chirps an offer, the receiver taps Accept and chirps an answer, and the browsers then open a peer-to-peer data channel and transfer the file at Wi-Fi speeds, with a SHA-256 check at the end. Both screens show a 4-digit code derived from the two fingerprints, so users can confirm that nobody else in earshot slipped in their own answer. Public STUN servers are the only network dependency; there is still no backend.

The v3 idea takes that same connection and uses it as a nearby multiplayer game transport. SPEC.md also leaves open a longer-term question: whether a custom modem (for example OFDM in an AudioWorklet) could push sound itself well past ggwave's speed.
