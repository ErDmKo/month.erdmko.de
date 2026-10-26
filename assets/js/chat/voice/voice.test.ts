import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { pipe, SIGNAL_GET, taskFork } from '../../utils';
import {
    encodeClientFrame,
    decodeClientFrame,
    encodeServerFrame,
    decodeServerFrame,
    CLIENT_FRAME_VOICE_JOIN,
    CLIENT_FRAME_VOICE_LEAVE,
    CLIENT_FRAME_VOICE_OFFER,
    CLIENT_FRAME_VOICE_ICE,
    SERVER_FRAME_VOICE_STATE,
    SERVER_FRAME_VOICE_ANSWER,
    SERVER_FRAME_VOICE_ICE,
    SERVER_FRAME_VOICE_ERROR,
    CLIENT_FRAME_PAYLOAD_VARIANT,
    CLIENT_FRAME_PAYLOAD_VALUE,
    SERVER_FRAME_PAYLOAD_VARIANT,
    SERVER_FRAME_PAYLOAD_VALUE,
    CLIENT_VOICE_JOIN_REQUEST_ID,
    CLIENT_VOICE_LEAVE_REQUEST_ID,
    CLIENT_VOICE_OFFER_REQUEST_ID,
    CLIENT_VOICE_OFFER_SDP,
    CLIENT_VOICE_ICE_REQUEST_ID,
    CLIENT_VOICE_ICE_CANDIDATE,
    CLIENT_VOICE_ICE_SDP_MID,
    CLIENT_VOICE_ICE_SDP_MLINE_IDX,
    SERVER_VOICE_STATE_PARTICIPANTS,
    VOICE_PARTICIPANT_SENDER_ID,
    VOICE_PARTICIPANT_SENDER_NAME,
    SERVER_VOICE_ANSWER_REQUEST_ID,
    SERVER_VOICE_ANSWER_SDP,
    SERVER_VOICE_ICE_CANDIDATE,
    SERVER_VOICE_ICE_SDP_MID,
    SERVER_VOICE_ICE_SDP_MLINE_IDX,
    SERVER_VOICE_ERROR_REQUEST_ID,
    SERVER_VOICE_ERROR_CODE,
} from '@month/gen/chat';
import {
    setInCall,
    setStatus,
    setMuteLabel,
    renderParticipants,
    resetVoiceUi,
} from './ui';
import {
    setVoiceMuted,
    closeVoicePeerConnection,
    createVoiceOfferTask,
    applyVoiceAnswerTask,
    addVoiceIceCandidateTask,
} from './peer';
import {
    createChatUiState,
    CHAT_UI_STATE_VOICE_IN_CALL,
    CHAT_UI_STATE_VOICE_MUTED,
    CHAT_UI_STATE_VOICE_STATUS,
    CHAT_UI_STATE_VOICE_PARTICIPANTS,
} from '../chat-ui/state';

const ctx = globalThis as unknown as Window;

test('voice client frames encode/decode round-trip', () => {
    const joinBuf = encodeClientFrame(ctx, [CLIENT_FRAME_VOICE_JOIN, ['vj-1']]);
    const joinDecoded = decodeClientFrame(ctx, joinBuf);
    assert.ok(joinDecoded !== null);
    assert.equal(
        joinDecoded![CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_VOICE_JOIN
    );
    assert.equal(
        joinDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_JOIN_REQUEST_ID],
        'vj-1'
    );

    const leaveBuf = encodeClientFrame(ctx, [
        CLIENT_FRAME_VOICE_LEAVE,
        ['vl-1'],
    ]);
    const leaveDecoded = decodeClientFrame(ctx, leaveBuf);
    assert.ok(leaveDecoded !== null);
    assert.equal(
        leaveDecoded![CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_VOICE_LEAVE
    );
    assert.equal(
        leaveDecoded![CLIENT_FRAME_PAYLOAD_VALUE][
            CLIENT_VOICE_LEAVE_REQUEST_ID
        ],
        'vl-1'
    );

    const offerBuf = encodeClientFrame(ctx, [
        CLIENT_FRAME_VOICE_OFFER,
        ['vo-1', 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'],
    ]);
    const offerDecoded = decodeClientFrame(ctx, offerBuf);
    assert.ok(offerDecoded !== null);
    assert.equal(
        offerDecoded![CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_VOICE_OFFER
    );
    assert.equal(
        offerDecoded![CLIENT_FRAME_PAYLOAD_VALUE][
            CLIENT_VOICE_OFFER_REQUEST_ID
        ],
        'vo-1'
    );
    assert.equal(
        offerDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_OFFER_SDP],
        'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
    );

    const iceBuf = encodeClientFrame(ctx, [
        CLIENT_FRAME_VOICE_ICE,
        [
            'vi-1',
            'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host',
            '0',
            0,
        ],
    ]);
    const iceDecoded = decodeClientFrame(ctx, iceBuf);
    assert.ok(iceDecoded !== null);
    assert.equal(
        iceDecoded![CLIENT_FRAME_PAYLOAD_VARIANT],
        CLIENT_FRAME_VOICE_ICE
    );
    assert.equal(
        iceDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_ICE_REQUEST_ID],
        'vi-1'
    );
    assert.equal(
        iceDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_ICE_CANDIDATE],
        'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host'
    );
    assert.equal(
        iceDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_ICE_SDP_MID],
        '0'
    );
    assert.equal(
        iceDecoded![CLIENT_FRAME_PAYLOAD_VALUE][CLIENT_VOICE_ICE_SDP_MLINE_IDX],
        0
    );
});

test('voice server frames encode/decode round-trip', () => {
    const stateBuf = encodeServerFrame(ctx, [
        SERVER_FRAME_VOICE_STATE,
        [
            [
                ['0xaaa', 'alice'],
                ['0xbbb', 'bob'],
            ],
        ],
    ]);
    const stateDecoded = decodeServerFrame(ctx, stateBuf);
    assert.ok(stateDecoded !== null);
    assert.equal(
        stateDecoded![SERVER_FRAME_PAYLOAD_VARIANT],
        SERVER_FRAME_VOICE_STATE
    );
    const participants =
        stateDecoded![SERVER_FRAME_PAYLOAD_VALUE][
            SERVER_VOICE_STATE_PARTICIPANTS
        ];
    assert.equal(participants.length, 2);
    assert.equal(participants[0][VOICE_PARTICIPANT_SENDER_ID], '0xaaa');
    assert.equal(participants[0][VOICE_PARTICIPANT_SENDER_NAME], 'alice');
    assert.equal(participants[1][VOICE_PARTICIPANT_SENDER_NAME], 'bob');

    const answerBuf = encodeServerFrame(ctx, [
        SERVER_FRAME_VOICE_ANSWER,
        ['vo-1', 'v=0\r\na=sendrecv\r\n'],
    ]);
    const answerDecoded = decodeServerFrame(ctx, answerBuf);
    assert.ok(answerDecoded !== null);
    assert.equal(
        answerDecoded![SERVER_FRAME_PAYLOAD_VARIANT],
        SERVER_FRAME_VOICE_ANSWER
    );
    assert.equal(
        answerDecoded![SERVER_FRAME_PAYLOAD_VALUE][
            SERVER_VOICE_ANSWER_REQUEST_ID
        ],
        'vo-1'
    );
    assert.equal(
        answerDecoded![SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ANSWER_SDP],
        'v=0\r\na=sendrecv\r\n'
    );

    const srvIceBuf = encodeServerFrame(ctx, [
        SERVER_FRAME_VOICE_ICE,
        ['candidate:2 1 UDP 123 10.0.0.1 50001 typ host', '0', 0],
    ]);
    const srvIceDecoded = decodeServerFrame(ctx, srvIceBuf);
    assert.ok(srvIceDecoded !== null);
    assert.equal(
        srvIceDecoded![SERVER_FRAME_PAYLOAD_VARIANT],
        SERVER_FRAME_VOICE_ICE
    );
    assert.equal(
        srvIceDecoded![SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ICE_CANDIDATE],
        'candidate:2 1 UDP 123 10.0.0.1 50001 typ host'
    );
    assert.equal(
        srvIceDecoded![SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ICE_SDP_MID],
        '0'
    );
    assert.equal(
        srvIceDecoded![SERVER_FRAME_PAYLOAD_VALUE][
            SERVER_VOICE_ICE_SDP_MLINE_IDX
        ],
        0
    );

    const errBuf = encodeServerFrame(ctx, [
        SERVER_FRAME_VOICE_ERROR,
        ['vj-1', 'VOICE_ROOM_FULL'],
    ]);
    const errDecoded = decodeServerFrame(ctx, errBuf);
    assert.ok(errDecoded !== null);
    assert.equal(
        errDecoded![SERVER_FRAME_PAYLOAD_VARIANT],
        SERVER_FRAME_VOICE_ERROR
    );
    assert.equal(
        errDecoded![SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ERROR_REQUEST_ID],
        'vj-1'
    );
    assert.equal(
        errDecoded![SERVER_FRAME_PAYLOAD_VALUE][SERVER_VOICE_ERROR_CODE],
        'VOICE_ROOM_FULL'
    );
});

test('voice UI helpers update signals and reset call state', () => {
    const state = createChatUiState();
    setInCall(state, true);
    assert.equal(state[CHAT_UI_STATE_VOICE_IN_CALL][SIGNAL_GET](), true);

    setStatus(state, 'Connected');
    assert.equal(state[CHAT_UI_STATE_VOICE_STATUS][SIGNAL_GET](), 'Connected');

    setMuteLabel(state, true);
    assert.equal(state[CHAT_UI_STATE_VOICE_MUTED][SIGNAL_GET](), true);

    renderParticipants(state, [
        ['u1', 'alice'],
        ['u2', 'bob'],
    ]);
    assert.deepEqual(state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_GET](), [
        ['u1', 'alice'],
        ['u2', 'bob'],
    ]);

    resetVoiceUi(state);
    assert.equal(state[CHAT_UI_STATE_VOICE_IN_CALL][SIGNAL_GET](), false);
    assert.equal(state[CHAT_UI_STATE_VOICE_MUTED][SIGNAL_GET](), false);
    assert.equal(state[CHAT_UI_STATE_VOICE_STATUS][SIGNAL_GET](), '');
    assert.deepEqual(state[CHAT_UI_STATE_VOICE_PARTICIPANTS][SIGNAL_GET](), []);
});

test('voice peer helpers toggle track mute, close resources, and run SDP/ICE tasks', async () => {
    let stopped = 0;
    const track1 = {
        enabled: true,
        stop: () => {
            stopped++;
        },
    };
    const stream = {
        getAudioTracks: () => [track1],
        getTracks: () => [track1],
    } as unknown as MediaStream;

    setVoiceMuted(stream, true);
    assert.equal(track1.enabled, false);
    setVoiceMuted(stream, false);
    assert.equal(track1.enabled, true);

    let pcClosed = false;
    let remoteDesc: unknown = null;
    let addedCandidate: unknown = null;
    const mockPc = {
        createOffer: () => Promise.resolve({ type: 'offer', sdp: 'offer-sdp' }),
        setLocalDescription: () => Promise.resolve(),
        setRemoteDescription: (desc: unknown) => {
            remoteDesc = desc;
            return Promise.resolve();
        },
        addIceCandidate: (cand: unknown) => {
            addedCandidate = cand;
            return Promise.resolve();
        },
        close: () => {
            pcClosed = true;
        },
    } as unknown as RTCPeerConnection;

    const mockLogCtx = {
        localStorage: { getItem: () => null },
    } as unknown as Window;

    const sdp = await new Promise<string>((resolve, reject) => {
        pipe(
            createVoiceOfferTask(mockLogCtx, mockPc),
            taskFork(resolve, reject)
        );
    });
    assert.equal(sdp, 'offer-sdp');

    await new Promise<void>((resolve, reject) => {
        pipe(
            applyVoiceAnswerTask(mockLogCtx, mockPc, 'answer-sdp'),
            taskFork(resolve, reject)
        );
    });
    assert.deepEqual(remoteDesc, { type: 'answer', sdp: 'answer-sdp' });

    await new Promise<void>((resolve, reject) => {
        pipe(
            addVoiceIceCandidateTask(mockLogCtx, mockPc, 'cand-1', '0', 0),
            taskFork(resolve, reject)
        );
    });
    assert.deepEqual(addedCandidate, {
        candidate: 'cand-1',
        sdpMid: '0',
        sdpMLineIndex: 0,
    });

    closeVoicePeerConnection(mockPc, stream);
    assert.equal(pcClosed, true);
    assert.equal(stopped, 1);
});
