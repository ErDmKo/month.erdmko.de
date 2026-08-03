import {
    bindArg,
    createLogger,
    noop,
    on,
    pipe,
    taskChain,
    taskFork,
    trigger,
    Task,
} from '../../utils';
import {
    CLIENT_FRAME_VOICE_JOIN,
    CLIENT_FRAME_VOICE_LEAVE,
    CLIENT_FRAME_VOICE_OFFER,
    CLIENT_FRAME_VOICE_ICE,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_VOICE_STATE,
    SERVER_FRAME_VOICE_ANSWER,
    SERVER_FRAME_VOICE_ICE,
    SERVER_FRAME_VOICE_ERROR,
    SERVER_VOICE_STATE_PARTICIPANTS,
    SERVER_VOICE_ANSWER_REQUEST_ID,
    SERVER_VOICE_ANSWER_SDP,
    SERVER_VOICE_ICE_CANDIDATE,
    SERVER_VOICE_ICE_SDP_MID,
    SERVER_VOICE_ICE_SDP_MLINE_IDX,
    SERVER_VOICE_ERROR_REQUEST_ID,
    SERVER_VOICE_ERROR_CODE,
} from '@month/gen/chat';
import type { ServerFramePayload } from '@month/gen/chat';
import type { ChatSocket } from '../protocol/incoming';
import {
    CHAT_SOCKET_OUTGOING,
    CHAT_SOCKET_INCOMING,
} from '../protocol/incoming';
import {
    CHAT_REF_VOICE_JOIN,
    CHAT_REF_VOICE_MUTE,
    CHAT_REF_VOICE_LEAVE,
    CHAT_REF_VOICE_REMOTE_AUDIO,
} from '../chat-ui/template';
import type { ChatUiRefs } from '../chat-ui/template';
import {
    CHAT_UI_EVENT_TYPE,
    CHAT_UI_INIT,
    CHAT_UI_INIT_REFS,
    CHAT_UI_JOINED,
    CHAT_UI_JOINED_SENDER_ID,
    CHAT_UI_ERROR,
} from '../chat-ui/events';
import type { ChatUiObs, ChatUiEvent } from '../chat-ui/events';
import {
    createVoicePeerConnection,
    createVoiceOfferTask,
    applyVoiceAnswerTask,
    addVoiceIceCandidateTask,
    getVoiceUserMediaTask,
    playVoiceRemoteAudioTask,
    closeVoicePeerConnection,
    setVoiceMuted,
    voicePeerConnection,
    voicePeerEvents,
    VOICE_PEER_ICE_CANDIDATE,
    VOICE_PEER_REMOTE_TRACK,
    VOICE_PEER_ICE_STATE,
} from './peer';
import type { VoicePeer, VoicePeerEvent } from './peer';
import {
    setInCall,
    setStatus,
    setMuteLabel,
    renderParticipants,
    resetVoiceUi,
} from './ui';

const voiceLog = createLogger('voice');

// Note: `navigator` is already part of the standard `Window` interface in
// this project's (trimmed) lib.dom typings, but `RTCPeerConnection` isn't —
// same pattern other modules use for e.g. `FileReader`/`Blob`/`WebSocket`.
declare global {
    interface Window {
        RTCPeerConnection: typeof RTCPeerConnection;
    }
}

// ── initVoice ─────────────────────────────────────────────────────────────────
//
// Wires the voice bar (join/mute/leave buttons, status, participant list) to
// the existing chat WebSocket. Uses the same `ChatSocket` as chat/attachments
// — no separate connection.

export const initVoice =
    (ctx: Window, socket: ChatSocket, chatUiObs: ChatUiObs): Task<void> =>
    (resolve) => {
        const outgoing = socket[CHAT_SOCKET_OUTGOING];
        const incoming = socket[CHAT_SOCKET_INCOMING];

        let refs: ChatUiRefs | null = null;
        let localStream: MediaStream | null = null;
        let peer: VoicePeer | null = null;
        let isMuted = false;
        let hasJoinedChat = false; // tracks whether we've ever seen a real senderId

        const showError = (message: string) => {
            chatUiObs(bindArg([CHAT_UI_ERROR, message] as const, trigger));
        };

        // ── Leave / cleanup ───────────────────────────────────────────────────

        const leaveVoice = (sendLeave: boolean) => {
            if (!peer && !localStream) return; // not in a call — no-op
            if (sendLeave) {
                outgoing(
                    bindArg(
                        [
                            CLIENT_FRAME_VOICE_LEAVE,
                            [`voice-leave-${Date.now()}`],
                        ] as const,
                        trigger
                    )
                );
            }
            closeVoicePeerConnection(
                peer ? voicePeerConnection(peer) : null,
                localStream
            );
            peer = null;
            localStream = null;
            isMuted = false;
            if (refs) resetVoiceUi(ctx, refs);
        };

        // ── Peer event handling (ICE candidates, remote track, ICE state) ─────

        const handlePeerEvent = (event: VoicePeerEvent) => {
            if (event[0] === VOICE_PEER_ICE_CANDIDATE) {
                const candidate = event[1];
                outgoing(
                    bindArg(
                        [
                            CLIENT_FRAME_VOICE_ICE,
                            [
                                `voice-ice-${Date.now()}`,
                                candidate.candidate,
                                candidate.sdpMid ?? '',
                                candidate.sdpMLineIndex ?? 0,
                            ],
                        ] as const,
                        trigger
                    )
                );
                return;
            }
            if (event[0] === VOICE_PEER_REMOTE_TRACK) {
                if (!refs) return;
                pipe(
                    playVoiceRemoteAudioTask(
                        ctx,
                        refs[CHAT_REF_VOICE_REMOTE_AUDIO],
                        event[1]
                    ),
                    taskFork(noop, (e) =>
                        voiceLog(ctx, '<audio>.play() rejected', e)
                    )
                );
                return;
            }
            if (event[0] === VOICE_PEER_ICE_STATE) {
                if (!refs) return;
                const state = event[1];
                if (state === 'connected' || state === 'completed') {
                    setStatus(refs, 'Connected');
                } else if (state === 'failed') {
                    setStatus(refs, 'Connection failed');
                } else if (state === 'disconnected') {
                    setStatus(refs, 'Reconnecting...');
                }
            }
        };

        // ── Join ──────────────────────────────────────────────────────────────

        const joinVoice = (): void => {
            if (!refs || peer || localStream) return; // already in a call
            setStatus(refs, 'Requesting microphone...');
            pipe(
                getVoiceUserMediaTask(ctx),
                taskChain(
                    (stream: MediaStream): Task<string> =>
                        (resolveOffer, rejectOffer) => {
                            if (!refs) {
                                rejectOffer(new Error('voice UI not ready'));
                                return;
                            }
                            localStream = stream;
                            setInCall(refs, true);
                            setStatus(refs, 'Connecting...');
                            outgoing(
                                bindArg(
                                    [
                                        CLIENT_FRAME_VOICE_JOIN,
                                        [`voice-join-${Date.now()}`],
                                    ] as const,
                                    trigger
                                )
                            );
                            peer = createVoicePeerConnection(ctx, stream);
                            voicePeerEvents(peer)(bindArg(handlePeerEvent, on));
                            createVoiceOfferTask(
                                ctx,
                                voicePeerConnection(peer)
                            )(resolveOffer, rejectOffer);
                        }
                ),
                taskChain((sdp: string): Task<void> => (resolveSend) => {
                    outgoing(
                        bindArg(
                            [
                                CLIENT_FRAME_VOICE_OFFER,
                                [`voice-offer-${Date.now()}`, sdp],
                            ] as const,
                            trigger
                        )
                    );
                    resolveSend();
                }),
                taskFork(noop, (e) => {
                    if (
                        e instanceof Error &&
                        e.message === 'voice UI not ready'
                    ) {
                        return;
                    }
                    // Distinguish "mic denied" (getUserMedia rejected before
                    // any peer connection exists) from later offer/negotiation
                    // failures, matching the ticket's two distinct error paths.
                    if (!peer) {
                        if (refs) setStatus(refs, '');
                        showError(`Microphone access denied: ${String(e)}`);
                        return;
                    }
                    showError(`Failed to create voice offer: ${String(e)}`);
                    leaveVoice(true);
                })
            );
        };

        // ── Mute ──────────────────────────────────────────────────────────────

        const toggleMute = () => {
            if (!refs || !localStream) return;
            isMuted = !isMuted;
            setVoiceMuted(localStream, isMuted);
            setMuteLabel(refs, isMuted);
        };

        // ── Incoming WS events ────────────────────────────────────────────────

        on((event: ServerFramePayload) => {
            const variant = event[SERVER_FRAME_PAYLOAD_VARIANT];

            if (variant === SERVER_FRAME_VOICE_STATE) {
                if (!refs) return;
                renderParticipants(
                    ctx,
                    refs,
                    event[SERVER_FRAME_PAYLOAD_VALUE][
                        SERVER_VOICE_STATE_PARTICIPANTS
                    ]
                );
                return;
            }

            if (variant === SERVER_FRAME_VOICE_ANSWER) {
                if (!peer) return;
                const sdp =
                    event[SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ANSWER_SDP];
                pipe(
                    applyVoiceAnswerTask(ctx, voicePeerConnection(peer), sdp),
                    taskFork(noop, (e) =>
                        showError(`Failed to apply voice answer: ${String(e)}`)
                    )
                );
                void event[SERVER_FRAME_PAYLOAD_VALUE][
                    SERVER_VOICE_ANSWER_REQUEST_ID
                ];
                return;
            }

            if (variant === SERVER_FRAME_VOICE_ICE) {
                if (!peer) return;
                const value = event[SERVER_FRAME_PAYLOAD_VALUE];
                pipe(
                    addVoiceIceCandidateTask(
                        ctx,
                        voicePeerConnection(peer),
                        value[SERVER_VOICE_ICE_CANDIDATE],
                        value[SERVER_VOICE_ICE_SDP_MID],
                        value[SERVER_VOICE_ICE_SDP_MLINE_IDX]
                    ),
                    taskFork(noop, (e) =>
                        showError(
                            `Failed to add voice ICE candidate: ${String(e)}`
                        )
                    )
                );
                return;
            }

            if (variant === SERVER_FRAME_VOICE_ERROR) {
                const value = event[SERVER_FRAME_PAYLOAD_VALUE];
                showError(`Voice error: ${value[SERVER_VOICE_ERROR_CODE]}`);
                void value[SERVER_VOICE_ERROR_REQUEST_ID];
                // Any voice error while attempting/holding a call is treated as
                // fatal to that call — tear down rather than leave a half-open
                // RTCPeerConnection dangling with no matching server-side state.
                leaveVoice(false);
                return;
            }
        }, incoming);

        // ── chatUiObs: INIT (wire buttons) + JOINED (disconnect cleanup) ──────

        chatUiObs(
            bindArg((event: ChatUiEvent) => {
                if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_INIT) {
                    refs = event[CHAT_UI_INIT_REFS];
                    resetVoiceUi(ctx, refs);

                    refs[CHAT_REF_VOICE_JOIN].addEventListener(
                        'click',
                        joinVoice
                    );
                    refs[CHAT_REF_VOICE_MUTE].addEventListener(
                        'click',
                        toggleMute
                    );
                    refs[CHAT_REF_VOICE_LEAVE].addEventListener(
                        'click',
                        bindArg(true, leaveVoice)
                    );

                    resolve();
                    return;
                }

                if (event[CHAT_UI_EVENT_TYPE] === CHAT_UI_JOINED) {
                    const senderId = event[CHAT_UI_JOINED_SENDER_ID];
                    if (senderId !== null) {
                        hasJoinedChat = true;
                        return;
                    }
                    // senderId === null: either the initial pre-join state, or
                    // the chat socket just closed. Only the latter matters —
                    // and only if we were actually mid-call — since closing
                    // the chat WS also makes any further ClientVoiceLeave a
                    // no-op send into a dead socket.
                    if (hasJoinedChat) {
                        hasJoinedChat = false;
                        leaveVoice(false);
                    }
                }
            }, on)
        );
    };
