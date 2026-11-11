/**
 * Architectural guardrail: enforces the Page Object Model (`tests/e2e/pages/*`) across all E2E suites.
 * See `tests/e2e/README.md` for details.
 */
import * as fs from 'fs';
import * as path from 'path';

const SUITES_DIR = __dirname;
const SELF_FILENAME = path.basename(__filename);

const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
    {
        label: 'direct Puppeteer DOM/navigation call (use a Page Object in tests/e2e/pages/)',
        regex: /\bpage\.(goto|reload|\$\$?eval|\$\$?|waitForSelector|waitForFunction|click|type|focus|keyboard|evaluate|evaluateOnNewDocument|cookies|setCookie|content|url)\b/,
    },
    {
        label: 'inline DOM query inside a suite (move DOM logic into tests/e2e/pages/)',
        regex: /\bdocument\.(querySelector|querySelectorAll|getElementById)\b/,
    },
];

describe('E2E Page Object architecture enforcement', () => {
    test('all E2E test suites interact with the browser strictly through Page Objects in tests/e2e/pages/', () => {
        const suiteFiles = fs
            .readdirSync(SUITES_DIR)
            .filter((f) => f.endsWith('.test.ts') && f !== SELF_FILENAME);

        expect(suiteFiles.length).toBeGreaterThanOrEqual(3);

        const violations: string[] = [];
        for (const file of suiteFiles) {
            const fullPath = path.join(SUITES_DIR, file);
            const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
            lines.forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
                for (const rule of FORBIDDEN_PATTERNS) {
                    if (rule.regex.test(line)) {
                        violations.push(
                            `${file}:${index + 1} — ${rule.label}: ${trimmed}`
                        );
                    }
                }
            });
        }

        expect(violations).toEqual([]);
    });
});
