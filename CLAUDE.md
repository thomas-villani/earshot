# CLAUDE.md

## Project

Earshot: a no-install web app that sends data between nearby phones using sound. v1 is pure acoustic messaging (ggwave modem + framing + fountain coding for broadcast). v2 uses sound only to exchange a compacted WebRTC offer/answer, then transfers files over a direct data channel. **Read `SPEC.md` before starting any milestone** — it is the source of truth for formats, message types, and milestone order.

## Commands

- `npm run dev` — Vite dev server (use `--host` to test on phones on the LAN; mic access requires HTTPS or localhost, so use a dev cert or a tunnel when testing on a phone)
- `npm test` — Vitest (framing, fountain, SDP compaction, channel simulator)
- `npm run sim` — run the acoustic channel simulator and print success-rate tables
- `npm run build` — static build for GitHub Pages

(Set these up in milestone 0 if they don't exist yet.)

## Ground rules

- **No backend.** Everything ships as static files. Public STUN servers are the only allowed network dependency (v2).
- **The modem stays behind the `Modem` interface** in `src/modem/`. Nothing outside that folder imports ggwave directly.
- **Binary in, binary out.** Framing, fountain, and RTC code operate on `Uint8Array`. Any base64/string workarounds for ggwave live only inside the adapter.
- **Mic constraints:** always request `echoCancellation`, `noiseSuppression`, `autoGainControl` = `false`, and log `track.getSettings()` in the debug drawer.
- **Use AudioWorklet**, not ScriptProcessorNode.
- **Untrusted input:** never auto-open URLs, auto-download, or auto-execute anything decoded from sound.
- Keep dependencies minimal; prefer built-in Web APIs (CompressionStream, Web Crypto, WebRTC).

## Working style

- Work milestone by milestone as listed in `SPEC.md`; finish each with tests passing and a short note in `NOTES.md` on what was learned (especially device/browser quirks and measured numbers).
- Pure logic (framing, fountain, SDP compaction) gets unit tests before it is wired to audio.
- Use the channel simulator to justify tuning choices (protocol, block size) with numbers, not guesses.
- When a behavior can only be verified on real phones (iOS audio session, mDNS resolution, mic constraints), say so explicitly and add it to a manual test checklist in `NOTES.md` rather than assuming it works.
