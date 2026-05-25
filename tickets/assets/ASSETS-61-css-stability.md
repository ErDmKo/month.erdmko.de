# ASSETS-61 CSS Class Stability for E2E Selectors

## Status: PARTIALLY DONE

## Blocks
- `ASSETS-60` (e2e Puppeteer tests)

## Problem

`attachments-ui.test.ts` relied on hardcoded CSS class name strings to locate DOM elements. If CSS is processed with class name mangling (e.g. cssnano `reduceIdents`, or CSS Modules), these selectors break silently — Puppeteer finds no elements, tests time out.

## What was done

**Option C (CSS Modules with exports) — partially implemented.**

The planned approach was Option B (`data-testid`). What actually landed was different:

- `assets/css/style.css` is processed via `postcss-modules` with `generateScopedName: '_[hash:base64:6]'`, producing `css/minified/style.module.json` with hashed class names.
- `assets/js/tools/gen-styles.ts` reads that JSON and emits `assets/js/gen/styles.ts` with named exports per class (e.g. `export const $chat__input = "_xYz123"`).
- `attachments-ui.test.ts` now imports those exports and builds selectors dynamically:

```ts
import { $chat__button, $chat__input, $chat__textarea, $chat__messages } from '../../../assets/js/gen/styles';

const SEL = {
    nicknameInput: `${c($chat__input)}:not(${c($chat__textarea)})`,
    joinButton: c($chat__button),
    messageTextarea: c($chat__textarea),
    messageList: c($chat__messages),
    // remaining selectors still use hardcoded class strings
    uploadPreviewFilename: '.chat__upload-filename',
    uploadProgress: '.chat__upload-progress',
    attachmentItem: '.chat__attachment-item',
    attachmentName: '.chat__attachment-name',
    downloadProgress: '.chat__attachment-progress',
};
```

- `css.min` / `css.max` template error on `/random` fixed: added `.min` and `.max` classes to `style.css` so they appear in `style.module.json` and Tera can resolve `{{ css.min }}` / `{{ css.max }}`.

## Remaining work

- [ ] Remaining SEL entries in `attachments-ui.test.ts` still use hardcoded class strings (`chat__upload-filename`, `chat__upload-progress`, `chat__attachment-item`, `chat__attachment-name`, `chat__attachment-progress`) — these need to be added to the CSS and imported from `gen/styles` the same way
- [ ] CODESTYLE.md does not yet document the CSS Modules + `gen/styles` import convention for E2E selectors
