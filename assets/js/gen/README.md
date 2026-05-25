# gen/

Auto-generated TypeScript files. Not tracked in git.

| File | Source | Bazel target |
|---|---|---|
| `styles.ts` | `assets/css/style.css` via postcss-modules | `//assets/js:styles_ts` |
| `chat.ts` | `contracts/chat/chat.proto` via `cargo build` | `//assets/js:chat_ts` |

## Regenerate

```
npm run gen
```

## Import alias

```ts
import { $chat__message } from '@month/gen/styles';
import { encodeClientFrame } from '@month/gen/chat';
```
