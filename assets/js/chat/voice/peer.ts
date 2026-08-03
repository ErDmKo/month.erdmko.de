// ── RTCPeerConnection lifecycle for one voice call ───────────────────────────
//
// No STUN server is configured — the server always announces PUBLIC_IP via
// NAT1To1IPs (see server/src/voice/mod.rs's `init_rtc`), so ICE candidates
// from `iceServers: []` are sufficient.

import { bindArg, createLogger, observer, trigger } from '../../utils';
import type { ObserverInstance, Task } from '../../utils';

const voiceLog = createLogger('voice');

// ── Peer event tuple ──────────────────────────────────────────────────────────

export const VOICE_PEER_ICE_CANDIDATE = 0 as const;
export const VOICE_PEER_REMOTE_TRACK = 1 as const;
export const VOICE_PEER_ICE_STATE = 2 as const;

export type VoicePeerEvent =
    | readonly [
          type: typeof VOICE_PEER_ICE_CANDIDATE,
          candidate: RTCIceCandidate,
      ]
    | readonly [type: typeof VOICE_PEER_REMOTE_TRACK, stream: MediaStream]
    | readonly [
          type: typeof VOICE_PEER_ICE_STATE,
          state: RTCIceConnectionState,
      ];

// ── VoicePeer tuple: peerConnection + its event stream ────────────────────────

const PEER_CONNECTION = 0 as const;
const PEER_EVENTS = 1 as const;

export type VoicePeer = readonly [
    peerConnection: RTCPeerConnection,
    events: ObserverInstance<VoicePeerEvent>,
];

export const voicePeerConnection = (peer: VoicePeer): RTCPeerConnection =>
    peer[PEER_CONNECTION];

export const voicePeerEvents = (
    peer: VoicePeer
): ObserverInstance<VoicePeerEvent> => peer[PEER_EVENTS];

export const createVoicePeerConnection = (
    ctx: Window,
    localStream: MediaStream
): VoicePeer => {
    const peerConnection = new ctx.RTCPeerConnection({ iceServers: [] });
    const events = observer<VoicePeerEvent>();

    const localTracks = localStream.getAudioTracks();
    voiceLog(ctx, 'local mic tracks:', localTracks.length);
    for (const track of localTracks) {
        peerConnection.addTrack(track, localStream);
    }

    peerConnection.addEventListener(
        'icecandidate',
        (e: RTCPeerConnectionIceEvent) => {
            voiceLog(
                ctx,
                'onicecandidate',
                e.candidate ? e.candidate.candidate : '(end of candidates)'
            );
            if (e.candidate) {
                events(
                    bindArg(
                        [VOICE_PEER_ICE_CANDIDATE, e.candidate] as const,
                        trigger
                    )
                );
            }
        }
    );

    peerConnection.addEventListener('track', (e: RTCTrackEvent) => {
        voiceLog(ctx, 'ontrack fired');
        if (e.streams[0]) {
            events(
                bindArg(
                    [VOICE_PEER_REMOTE_TRACK, e.streams[0]] as const,
                    trigger
                )
            );
        }
    });

    peerConnection.addEventListener('iceconnectionstatechange', () => {
        voiceLog(ctx, 'iceConnectionState');
        events(
            bindArg(
                [
                    VOICE_PEER_ICE_STATE,
                    peerConnection.iceConnectionState,
                ] as const,
                trigger
            )
        );
    });

    return [peerConnection, events] as const;
};

// ── SDP offer/answer, as Tasks ────────────────────────────────────────────────
//
// `peerConnection.createOffer`/`setLocalDescription`/`setRemoteDescription` are native
// Promise-returning WebRTC APIs; each Task below wraps exactly one such
// boundary with `.then(resolve, reject)` (no further chaining), the same
// pattern `readFileAsArrayBuffer` uses to wrap `FileReader`'s callback API.

export const createVoiceOfferTask =
    (ctx: Window, peerConnection: RTCPeerConnection): Task<string> =>
    (resolve, reject) => {
        peerConnection.createOffer().then((offer) => {
            voiceLog(ctx, 'created offer, sdp length', offer.sdp?.length ?? 0);
            peerConnection
                .setLocalDescription(offer)
                .then(() => resolve(offer.sdp ?? ''), reject);
        }, reject);
    };

export const applyVoiceAnswerTask =
    (ctx: Window, peerConnection: RTCPeerConnection, sdp: string): Task<void> =>
    (resolve, reject) => {
        voiceLog(ctx, 'received answer, sdp length', sdp.length, sdp);
        peerConnection
            .setRemoteDescription({ type: 'answer', sdp })
            .then(() => {
                voiceLog(ctx, 'setRemoteDescription(answer) OK');
                resolve();
            }, reject);
    };

export const addVoiceIceCandidateTask =
    (
        ctx: Window,
        peerConnection: RTCPeerConnection,
        candidate: string,
        sdpMid: string,
        sdpMLineIndex: number
    ): Task<void> =>
    (resolve, reject) => {
        voiceLog(ctx, 'received remote ICE candidate', candidate);
        peerConnection
            .addIceCandidate({ candidate, sdpMid, sdpMLineIndex })
            .then(resolve, reject);
    };

export const getVoiceUserMediaTask =
    (ctx: Window): Task<MediaStream> =>
    (resolve, reject) => {
        ctx.navigator.mediaDevices
            .getUserMedia({ audio: true, video: false })
            .then(resolve, reject);
    };

export const playVoiceRemoteAudioTask =
    (ctx: Window, audioEl: HTMLAudioElement, stream: MediaStream): Task<void> =>
    (resolve, reject) => {
        voiceLog(
            ctx,
            'setting <audio> srcObject from remote stream',
            stream.id
        );
        audioEl.srcObject = stream;
        audioEl.play().then(() => {
            voiceLog(ctx, '<audio>.play() resolved');
            resolve();
        }, reject);
    };

export const closeVoicePeerConnection = (
    peerConnection: RTCPeerConnection | null,
    stream: MediaStream | null
): void => {
    if (peerConnection) peerConnection.close();
    if (stream) stream.getTracks().forEach((t) => t.stop());
};

export const setVoiceMuted = (
    stream: MediaStream | null,
    muted: boolean
): void => {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
        track.enabled = !muted;
    }
};
