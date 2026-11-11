import { initChatEffect } from '@month/chat';

if (document.readyState === 'complete') {
    initChatEffect(window);
} else {
    window.addEventListener('load', () => {
        initChatEffect(window);
    });
}
