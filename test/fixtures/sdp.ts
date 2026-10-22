// Real SDP captured from Edge (Chromium) on Windows, 2026-10-22, with every address replaced by a
// documentation-range one (203.0.113.0/24, 2001:db8::/32) or a generic private one.

/** Offer without media permission: host addresses hidden behind mDNS names. */
export const chromeOfferMdns = [
  'v=0',
  'o=- 5541351479585939661 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 61001 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1248993303 1 udp 2113937151 77471497-2ff8-4b82-aabc-2e67252fea82.local 61001 typ host generation 0 network-cost 999',
  'a=candidate:3477363775 1 udp 2113939711 7aa3d759-6694-4ba7-9d6e-a668ba829798.local 61002 typ host generation 0 network-cost 999',
  'a=candidate:3773110615 1 udp 1677732095 2001:db8:c880:dbe0:ccb8:a41b:b8a0:7b17 61002 typ srflx raddr :: rport 0 generation 0 network-cost 999',
  'a=candidate:3290671117 1 udp 1677729535 203.0.113.7 61001 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=ice-ufrag:r6HL',
  'a=ice-pwd:SPCjCeFfMHR4lg+icm4IdmRy',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 12:6E:CB:0E:54:8D:9C:0C:8B:01:A8:4B:8E:AB:85:2B:00:1C:5E:E2:66:0D:AC:15:F4:1B:1A:60:57:83:74:16',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

export const chromeAnswerMdns = [
  'v=0',
  'o=- 6645108679698089167 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:27771567 1 udp 2113937151 77471497-2ff8-4b82-aabc-2e67252fea82.local 60649 typ host generation 0 network-cost 999',
  'a=candidate:1391145725 1 udp 2113939711 7aa3d759-6694-4ba7-9d6e-a668ba829798.local 60650 typ host generation 0 network-cost 999',
  'a=ice-ufrag:3T2l',
  'a=ice-pwd:Cw+Z3kjDy3kxtx7b2XpoTpdI',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 F3:00:B9:73:F4:2A:B6:76:26:FD:6E:EB:CC:BC:B2:DE:C5:6C:B0:D3:E5:3F:F3:51:DA:4F:D8:60:09:42:D9:6F',
  'a=setup:active',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

/**
 * Candidates after the page was granted microphone permission (as Earshot always is): Chrome then
 * shows raw host addresses instead of mDNS names, for every interface, plus useless TCP-active ones.
 */
export const chromeCandidatesWithMic = [
  'a=candidate:722627002 1 udp 2122260223 172.20.0.1 58033 typ host generation 0 network-id 5',
  'a=candidate:413154579 1 udp 2121998079 192.168.1.50 58034 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:3169107 1 udp 2122197247 2001:db8:c880:dbe0::1001 58035 typ host generation 0 network-id 2 network-cost 10',
  'a=candidate:4115787516 1 udp 2122131711 2001:db8:c880:dbe0:ccb8:a41b:b8a0:7b17 58036 typ host generation 0 network-id 3 network-cost 10',
  'a=candidate:1273810241 1 udp 2122066175 2001:db8:c880:dbe0:5d2:91ff:fe00:42 58037 typ host generation 0 network-id 4 network-cost 10',
  'a=candidate:1482313658 1 udp 1685790463 203.0.113.7 58034 typ srflx raddr 192.168.1.50 rport 58034 generation 0 network-id 1 network-cost 10',
  'a=candidate:1440582434 1 tcp 1518280447 172.20.0.1 9 typ host tcptype active generation 0 network-id 5',
  'a=candidate:1718607755 1 tcp 1518018303 192.168.1.50 9 typ host tcptype active generation 0 network-id 1 network-cost 10',
  'a=candidate:2130688459 1 tcp 1518217471 2001:db8:c880:dbe0::1001 9 typ host tcptype active generation 0 network-id 2 network-cost 10',
];

export const chromeOfferWithMic = chromeOfferMdns.replace(
  /(a=candidate:.*\r\n)+/,
  chromeCandidatesWithMic.map((l) => l + '\r\n').join(''),
);

/** Firefox-style credentials: 8-hex ufrag, 32-hex pwd, attributes in a different order. */
export const firefoxStyleOffer = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 4123456789012345678 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 192.168.1.60 50001 typ host',
  'a=candidate:1 1 TCP 2105524479 192.168.1.60 9 typ host tcptype active',
  'a=candidate:2 1 UDP 1686052863 203.0.113.9 50001 typ srflx raddr 192.168.1.60 rport 50001',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:2f1d6c1e0b0a4e8f9c7d6b5a4e3f2a1b',
  'a=ice-ufrag:9a8b7c6d',
  'a=mid:0',
  'a=setup:actpass',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');
