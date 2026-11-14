// ── RTCPeerConnection lifecycle for one voice call ───────────────────────────
//
// No STUN server is configured — the server always announces PUBLIC_IP via
// NAT1To1IPs (see server/src/voice/mod.rs's `init_rtc`), so ICE candidates
// from `iceServers: []` are sufficient.

import {
    bindArg,
    observer,
    pipe,
    taskChain,
    taskMap,
    trigger,
} from '../../utils';
import type { ObserverInstance, ReadonlyTupleOf, Task } from '../../utils';

// ── Peer event tuple ──────────────────────────────────────────────────────────

export const VOICE_PEER_ICE_CANDIDATE = 0 as const;
export const VOICE_PEER_REMOTE_TRACK = 1 as const;
export const VOICE_PEER_ICE_STATE = 2 as const;

export const VOICE_PEER_EVENT_TYPE = 0 as const;
export const VOICE_PEER_ICE_CANDIDATE_VALUE = 1 as const;
export const VOICE_PEER_REMOTE_TRACK_STREAM = 1 as const;
export const VOICE_PEER_ICE_STATE_VALUE = 1 as const;

export type VoicePeerEvent =
    | ReadonlyTupleOf<{
          [VOICE_PEER_EVENT_TYPE]: typeof VOICE_PEER_ICE_CANDIDATE;
          [VOICE_PEER_ICE_CANDIDATE_VALUE]: RTCIceCandidate;
      }>
    | ReadonlyTupleOf<{
          [VOICE_PEER_EVENT_TYPE]: typeof VOICE_PEER_REMOTE_TRACK;
          [VOICE_PEER_REMOTE_TRACK_STREAM]: MediaStream;
      }>
    | ReadonlyTupleOf<{
          [VOICE_PEER_EVENT_TYPE]: typeof VOICE_PEER_ICE_STATE;
          [VOICE_PEER_ICE_STATE_VALUE]: RTCIceConnectionState;
      }>;

// ── VoicePeer tuple: peerConnection + its event stream ────────────────────────

const PEER_CONNECTION = 0 as const;
const PEER_EVENTS = 1 as const;

export type VoicePeer = ReadonlyTupleOf<{
    [PEER_CONNECTION]: RTCPeerConnection;
    [PEER_EVENTS]: ObserverInstance<VoicePeerEvent>;
}>;

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
    for (const track of localTracks) {
        peerConnection.addTrack(track, localStream);
    }

    peerConnection.addEventListener(
        'icecandidate',
        (e: RTCPeerConnectionIceEvent) => {
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

const createRtcOfferTask =
    (peerConnection: RTCPeerConnection): Task<RTCSessionDescriptionInit> =>
    (resolve, reject) => {
        peerConnection.createOffer().then(resolve, reject);
    };

const setLocalDescriptionTask =
    (
        peerConnection: RTCPeerConnection,
        offer: RTCSessionDescriptionInit
    ): Task<RTCSessionDescriptionInit> =>
    (resolve, reject) => {
        peerConnection
            .setLocalDescription(offer)
            .then(() => resolve(offer), reject);
    };

export const createVoiceOfferTask = (
    peerConnection: RTCPeerConnection
): Task<string> =>
    pipe(
        createRtcOfferTask(peerConnection),
        taskChain(bindArg(peerConnection, setLocalDescriptionTask)),
        taskMap((offer: RTCSessionDescriptionInit) => offer.sdp ?? '')
    );

export const applyVoiceAnswerTask =
    (peerConnection: RTCPeerConnection, sdp: string): Task<void> =>
    (resolve, reject) => {
        peerConnection
            .setRemoteDescription({ type: 'answer', sdp })
            .then(resolve, reject);
    };

export const addVoiceIceCandidateTask =
    (
        peerConnection: RTCPeerConnection,
        candidate: string,
        sdpMid: string,
        sdpMLineIndex: number
    ): Task<void> =>
    (resolve, reject) => {
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
    (audioEl: HTMLAudioElement, stream: MediaStream): Task<void> =>
    (resolve, reject) => {
        audioEl.srcObject = stream;
        audioEl.play().then(resolve, reject);
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
