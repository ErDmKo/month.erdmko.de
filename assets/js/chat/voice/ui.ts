import { cleanHtml, genTagName, genText, domCreatorRef } from '../../utils';
import {
    CHAT_REF_VOICE_JOIN,
    CHAT_REF_VOICE_MUTE,
    CHAT_REF_VOICE_LEAVE,
    CHAT_REF_VOICE_STATUS,
    CHAT_REF_VOICE_PARTICIPANTS,
} from '../chat-ui/template';
import type { ChatUiRefs } from '../chat-ui/template';
import { VOICE_PARTICIPANT_SENDER_NAME } from '@month/gen/chat';
import type { VoiceParticipant } from '@month/gen/chat';

// ── Button visibility: reflects whether the local user is in the call ────────

export const setInCall = (refs: ChatUiRefs, inCall: boolean): void => {
    refs[CHAT_REF_VOICE_JOIN].hidden = inCall;
    refs[CHAT_REF_VOICE_MUTE].hidden = !inCall;
    refs[CHAT_REF_VOICE_LEAVE].hidden = !inCall;
};

// ── Status text ───────────────────────────────────────────────────────────────

export const setStatus = (refs: ChatUiRefs, text: string): void => {
    refs[CHAT_REF_VOICE_STATUS].textContent = text;
};

// ── Mute button label ─────────────────────────────────────────────────────────

export const setMuteLabel = (refs: ChatUiRefs, muted: boolean): void => {
    refs[CHAT_REF_VOICE_MUTE].textContent = muted ? 'Unmute' : 'Mute';
};

// ── Participant list ──────────────────────────────────────────────────────────

export const renderParticipants = (
    ctx: Window,
    refs: ChatUiRefs,
    participants: readonly VoiceParticipant[]
): void => {
    const ulEl = refs[CHAT_REF_VOICE_PARTICIPANTS];
    cleanHtml(ulEl);
    for (const participant of participants) {
        domCreatorRef(
            ctx,
            ulEl,
            genTagName('li', [
                genText(participant[VOICE_PARTICIPANT_SENDER_NAME]),
            ])
        );
    }
};

// ── Full reset after leaving/disconnecting ────────────────────────────────────

export const resetVoiceUi = (ctx: Window, refs: ChatUiRefs): void => {
    setInCall(refs, false);
    setStatus(refs, '');
    setMuteLabel(refs, false);
    renderParticipants(ctx, refs, []);
};
