---
title: "Voice VPS and Network"
ticket: "VOICE-30"
status: "completed"
draft: false
weight: 30
---

# VOICE-30 VPS & Network

## Depends on
- `VOICE-10`

## Goal
Open the necessary firewall ports and expose configuration so the server can receive WebRTC media traffic.

## Scope

### Firewall
Open UDP port range on the VPS (e.g. via `ufw` or `iptables`):
```
ufw allow 50000:50100/udp
```
Range size of 100 ports is enough for ~50 simultaneous peer connections (2 ports per peer).

### Environment variables
Add to the `.env` file (or server environment):

```
PUBLIC_IP=<your VPS public IPv4>
RTP_PORT_MIN=50000
RTP_PORT_MAX=50100
```

Read in `server/src/voice/mod.rs` at startup:
```rust
let public_ip: String = std::env::var("PUBLIC_IP").expect("PUBLIC_IP must be set");
let port_min: u16 = std::env::var("RTP_PORT_MIN").unwrap_or("50000".into()).parse().unwrap();
let port_max: u16 = std::env::var("RTP_PORT_MAX").unwrap_or("50100".into()).parse().unwrap();
```

These values are passed into `RTCConfiguration` in `VOICE-40`.

### Why NAT1To1IPs instead of STUN
A VPS typically has a public IP assigned to the network interface but not directly visible to the process (the NIC shows a private IP, e.g. `10.x.x.x`). Without `NAT1To1IPs`, `webrtc-rs` would advertise the private IP in ICE candidates and the browser could never reach the server.

Setting `NAT1To1IPs = [PUBLIC_IP]` tells `webrtc-rs` to always announce this IP in candidates, bypassing the need to discover it via an external STUN server.

## Deliverables
- `.env` updated with `PUBLIC_IP`, `RTP_PORT_MIN`, `RTP_PORT_MAX`
- `server/src/voice/mod.rs` reads and validates these vars at startup (panic with a clear message if missing)
- Firewall rules applied on VPS
- No code changes to the HTTP server itself

## Tests
- Manual: `nc -u <PUBLIC_IP> 50000` from a remote machine succeeds (port is reachable)
- Startup: server panics with `"PUBLIC_IP must be set"` if env var is missing

## Acceptance
- UDP traffic on 50000–50100 reaches the VPS from the public internet
- Server startup fails loudly (not silently) with a missing `PUBLIC_IP`
- `RTP_PORT_MIN` / `RTP_PORT_MAX` are parsed and available for `VOICE-40`
