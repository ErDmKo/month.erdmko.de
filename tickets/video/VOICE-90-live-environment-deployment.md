---
title: "Voice Live Environment Deployment"
ticket: "VOICE-90"
status: "completed"
draft: false
weight: 90
---

# VOICE-90 Live Environment Deployment

## Depends on
- `VOICE-30` (VPS and network design)
- `VOICE-70` (browser client)
- `VOICE-80` (inbound RTP jitter buffer)

## Goal
Make the audio-only MCU voice call work from real browsers against the public
deployment, rather than only on local or container-loopback networking.

## Current gap
The production container starts with the defaults from `VoiceConfig`:

```
PUBLIC_IP=127.0.0.1
RTP_PORT_MIN=50000
RTP_PORT_MAX=50100
```

The Ansible Docker command publishes only TCP port 8080. Browser ICE candidates
therefore advertise a loopback address and the server RTP port range is not
reachable from the internet.

## Scope

### Container runtime configuration
- Set `PUBLIC_IP` to the VPS public IPv4 address when starting the container.
- Set `RTP_PORT_MIN=50000` and `RTP_PORT_MAX=50100` explicitly so the deployed
  range matches the published range.
- Publish the complete UDP range with Docker:

```bash
--publish 50000-50100:50000-50100/udp
```

- Keep HTTP publishing unchanged unless the reverse proxy configuration requires
  a different private bind address.
- Store the public IP and RTP range as Ansible inventory or group variables, not
  as values baked into the image.

### VPS and edge network
- Allow UDP `50000:50100` in the host firewall and provider firewall/security
  group, if either is enabled.
- Confirm no host service occupies the RTP range.
- Verify the public HTTPS reverse proxy continues to forward the existing chat
  WebSocket upgrade connection without timeout or buffering regressions.
- Confirm the public origin is HTTPS because browser microphone access requires
  a secure context outside localhost.

### Diagnostics
- Record the deployed public IP and RTP range in the deployment documentation.
- Capture startup logs showing the selected voice configuration.
- On an ICE failure, collect browser ICE candidate details and server logs before
  changing WebRTC settings.
- Do not expose a TURN credential or add an external STUN/TURN dependency in
  this ticket; document relay-only network failures as a follow-up instead.

## Deliverables
- `ansible/push.yaml` publishes the RTP UDP range and injects voice environment
  variables from inventory/group variables.
- Documented VPS firewall/provider firewall rule for UDP `50000:50100`.
- Documented public HTTPS and WebSocket proxy requirements.
- A successful public two-browser voice-call validation record.

## Tests
- Deployment: inspect the running container and confirm `PUBLIC_IP`,
  `RTP_PORT_MIN`, and `RTP_PORT_MAX` have the intended values.
- Network: from a network outside the VPS, confirm UDP packets can reach a port
  inside the configured RTP range while a call is negotiating.
- Browser: two separate browsers on external networks join the same chat room,
  grant microphone access, reach ICE `connected`, and hear each other.
- Regression: chat messaging and WebSocket reconnect behavior remain functional
  during and after a voice call.
- Negative: remove the UDP firewall rule in a controlled test and confirm the
  failure is observable through ICE state and server logs.

## Acceptance
- Public ICE candidates advertise the VPS public IPv4 address, never
  `127.0.0.1` or a private Docker/VPS address.
- The container exposes the configured RTP UDP range and the VPS accepts it.
- Two external browsers establish an audio call through the public HTTPS site.
- Repeated join, leave, and reconnect cycles do not require a container restart.
- Any network type that cannot connect without a relay is documented for a
  follow-up TURN decision.
