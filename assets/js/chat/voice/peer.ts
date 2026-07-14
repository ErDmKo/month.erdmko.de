// ── RTCPeerConnection lifecycle for one voice call ───────────────────────────
//
// No STUN server is configured — the server always announces PUBLIC_IP via
// NAT1To1IPs (see server/src/voice/mod.rs's `init_rtc`), so ICE candidates
// from `iceServers: []` are sufficient.

export type VoicePeerCallbacks = {
    onIceCandidate: (candidate: RTCIceCandidate) => void;
    onRemoteTrack: (stream: MediaStream) => void;
    onIceStateChange: (state: RTCIceConnectionState) => void;
};

export const createVoicePeerConnection = (
    ctx: Window,
    localStream: MediaStream,
    callbacks: VoicePeerCallbacks
): RTCPeerConnection => {
    const pc = new ctx.RTCPeerConnection({ iceServers: [] });

    for (const track of localStream.getAudioTracks()) {
        pc.addTrack(track, localStream);
    }

    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate) callbacks.onIceCandidate(e.candidate);
    };

    pc.ontrack = (e: RTCTrackEvent) => {
        if (e.streams[0]) callbacks.onRemoteTrack(e.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
        callbacks.onIceStateChange(pc.iceConnectionState);
    };

    return pc;
};

export const createVoiceOffer = async (
    pc: RTCPeerConnection
): Promise<string> => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer.sdp ?? '';
};

export const applyVoiceAnswer = (
    pc: RTCPeerConnection,
    sdp: string
): Promise<void> =>
    pc.setRemoteDescription({ type: 'answer', sdp });

export const addVoiceIceCandidate = (
    pc: RTCPeerConnection,
    candidate: string,
    sdpMid: string,
    sdpMLineIndex: number
): Promise<void> =>
    pc.addIceCandidate({ candidate, sdpMid, sdpMLineIndex });

export const closeVoicePeerConnection = (
    pc: RTCPeerConnection | null,
    stream: MediaStream | null
): void => {
    if (pc) pc.close();
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
