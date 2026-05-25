# ASSETS-61 CSS Class Stability for E2E Selectors

## Status: OPEN

## Blocks
- `ASSETS-60` (e2e Puppeteer tests)

## Problem

`attachments-ui.test.ts` relies on a hardcoded `SEL` map of CSS class names to locate DOM elements:

```ts
const SEL = {
    nicknameInput: '.chat__input:not(.chat__textarea)',
    joinButton: '.chat__button:not(...)',
    messageTextarea: '.chat__textarea',
    sendButton: '.chat__button--send',
    attachButton: '.chat__button--attach',
    fileInput: 'input[type="file"]',
    uploadPreviewFilename: '.chat__upload-filename',
    uploadProgress: '.chat__upload-progress',
    removeButton: '.chat__button--remove',
    attachmentItem: '.chat__attachment-item',
    attachmentName: '.chat__attachment-name',
    downloadButton: '.chat__button--download',
    downloadProgress: '.chat__attachment-progress',
    messageList: '.chat__messages',
};
```

If CSS is processed with class name mangling (e.g. cssnano `reduceIdents`, or any CSS Modules / atomic CSS approach that renames classes), these selectors break silently — Puppeteer finds no elements, tests time out.

## Goal

Establish a CSS build convention that guarantees the above class names survive the build pipeline unchanged, while still allowing minification of everything else.

## Options

### Option A — No mangling (current implicit assumption)
Keep class names as-is. Add explicit `cssnano` config that disables `reduceIdents` and any class renaming plugin. Document the convention: classes used in tests must follow BEM (`chat__*`) and must not be renamed.

**Pros**: Zero migration cost.  
**Cons**: Relies on convention, easy to break accidentally.

### Option B — `data-testid` attributes
Add `data-testid="chat-join-button"` etc. to HTML templates. Update `SEL` to use `[data-testid="..."]` selectors. Strip `data-testid` in production builds via a Tera filter or build-time transform.

**Pros**: Decouples test selectors from styling completely.  
**Cons**: Templates need editing; need a strip step for production.

### Option C — CSS Modules with explicit exports
Migrate chat styles to CSS Modules. Export stable names for test use. Build produces hashed local names but exports a mapping.

**Pros**: True encapsulation.  
**Cons**: Significant refactor; requires CSS Modules support in the Bazel pipeline.

## Recommended approach

**Option B (`data-testid`)** — minimal template changes, zero CSS pipeline risk, standard practice for e2e testing. Strip in production is a one-liner Tera macro or sed in the build step.

## Scope

- Add `data-testid` attributes to relevant elements in `server/templates/chat.html` and any TS-rendered templates in `assets/js/chat/`.
- Update `SEL` in `attachments-ui.test.ts` to use `[data-testid="..."]`.
- Document the convention in `assets/js/CODESTYLE.md`.
- Optionally: strip `data-testid` in production Tera render.

## Deliverables
- [ ] `data-testid` attributes added to chat UI templates
- [ ] `SEL` map in `attachments-ui.test.ts` updated
- [ ] CODESTYLE.md updated with `data-testid` convention
- [ ] (optional) production strip of `data-testid`
