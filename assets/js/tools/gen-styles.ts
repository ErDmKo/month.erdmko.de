// Converts style.module.json → styles.ts (individual named exports per class)
// Usage: node gen-styles-ts.js <input.json> <output.ts>
//
// Each class name becomes a named export with a sanitized identifier:
//   "inner-page"        → export const $inner_page = "_hVLkiw"
//   "chat__message--own"→ export const $chat__message__own = "_zbDI3n"
//
// The $ prefix avoids collisions with reserved words and makes imports
// visually distinct. esbuild inlines these as string literal constants,
// keeping the original class name strings out of the bundle entirely.
import * as fs from 'fs';

const [,, input, output] = process.argv;
const mapping: Record<string, string> = JSON.parse(fs.readFileSync(input, 'utf8'));

const toIdent = (key: string): string =>
    '$' + key.replace(/-/g, '_');

const lines = [
    '// AUTO-GENERATED — do not edit. Rebuild //assets/css:css_build to regenerate.',
    '',
    ...Object.entries(mapping).map(
        ([k, v]) => `export const ${toIdent(k)} = ${JSON.stringify(v)};`
    ),
    '',
];
fs.writeFileSync(output, lines.join('\n'));
