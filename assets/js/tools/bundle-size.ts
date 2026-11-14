// Calculates raw, gzip-9, and brotli-11 sizes for browser JS bundles.
//
// Usage:
//   bazel run //assets/js:bundle-size
//   bazel run //assets/js:bundle-size -- --compare /path/to/baseline.json
//   bazel build //assets/js:bundle_sizes_json

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

type BundleMetrics = {
    name: string;
    rawBytes: number;
    gzipBytes: number;
    brotliBytes: number;
};

type SizeReport = {
    bundles: BundleMetrics[];
    total: Omit<BundleMetrics, 'name'>;
};

const DEFAULT_RUNFILE_BUNDLES = [
    'assets/js/chat-bundle.js',
    'assets/js/month-bundle.js',
    'assets/js/tetris-bundle.js',
    'assets/js/tennis-bundle.js',
    'assets/js/snowflake-bundle.js',
];

const measureFile = (filePath: string): BundleMetrics => {
    const buf = fs.readFileSync(filePath);
    const gzipBuf = zlib.gzipSync(buf, {
        level: zlib.constants.Z_BEST_COMPRESSION,
    });
    const brotliBuf = zlib.brotliCompressSync(buf, {
        params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]:
                zlib.constants.BROTLI_MAX_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
    });
    return {
        name: path.basename(filePath),
        rawBytes: buf.length,
        gzipBytes: gzipBuf.length,
        brotliBytes: brotliBuf.length,
    };
};

const formatBytes = (n: number): string =>
    `${n.toLocaleString('en-US')} B (${(n / 1024).toFixed(2)} KiB)`;

const formatDelta = (before: number, after: number): string => {
    const diff = after - before;
    if (diff === 0) return '0 B (0.00%)';
    const sign = diff > 0 ? '+' : '';
    const pct = before > 0 ? ((diff / before) * 100).toFixed(2) : '0.00';
    return `${sign}${diff.toLocaleString('en-US')} B (${sign}${pct}%)`;
};

const pad = (s: string, width: number, right = false): string =>
    right ? s.padStart(width) : s.padEnd(width);

const printReport = (report: SizeReport, baseline: SizeReport | null): void => {
    if (!baseline) {
        const headers = ['Bundle', 'Raw', 'Gzip (q9)', 'Brotli (q11)'];
        const rows = [
            ...report.bundles.map((b) => [
                b.name,
                formatBytes(b.rawBytes),
                formatBytes(b.gzipBytes),
                formatBytes(b.brotliBytes),
            ]),
            [
                'TOTAL',
                formatBytes(report.total.rawBytes),
                formatBytes(report.total.gzipBytes),
                formatBytes(report.total.brotliBytes),
            ],
        ];
        const widths = headers.map((h, i) =>
            Math.max(h.length, ...rows.map((r) => r[i].length))
        );
        const sep = widths.map((w) => '-'.repeat(w)).join('  ');
        console.log(headers.map((h, i) => pad(h, widths[i], i > 0)).join('  '));
        console.log(sep);
        rows.forEach((r, idx) => {
            if (idx === rows.length - 1) console.log(sep);
            console.log(r.map((c, i) => pad(c, widths[i], i > 0)).join('  '));
        });
        return;
    }

    const baseMap = new Map(baseline.bundles.map((b) => [b.name, b]));
    const headers = [
        'Bundle',
        'Raw Before',
        'Raw After',
        'Raw Δ',
        'Brotli Before',
        'Brotli After',
        'Brotli Δ',
    ];
    const rows = [
        ...report.bundles.map((b) => {
            const prev = baseMap.get(b.name);
            return [
                b.name,
                prev ? formatBytes(prev.rawBytes) : 'n/a',
                formatBytes(b.rawBytes),
                prev ? formatDelta(prev.rawBytes, b.rawBytes) : 'n/a',
                prev ? formatBytes(prev.brotliBytes) : 'n/a',
                formatBytes(b.brotliBytes),
                prev ? formatDelta(prev.brotliBytes, b.brotliBytes) : 'n/a',
            ];
        }),
        [
            'TOTAL',
            formatBytes(baseline.total.rawBytes),
            formatBytes(report.total.rawBytes),
            formatDelta(baseline.total.rawBytes, report.total.rawBytes),
            formatBytes(baseline.total.brotliBytes),
            formatBytes(report.total.brotliBytes),
            formatDelta(baseline.total.brotliBytes, report.total.brotliBytes),
        ],
    ];
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => r[i].length))
    );
    const sep = widths.map((w) => '-'.repeat(w)).join('  ');
    console.log(headers.map((h, i) => pad(h, widths[i], i > 0)).join('  '));
    console.log(sep);
    rows.forEach((r, idx) => {
        if (idx === rows.length - 1) console.log(sep);
        console.log(r.map((c, i) => pad(c, widths[i], i > 0)).join('  '));
    });
};

const resolvePath = (p: string): string => {
    if (path.isAbsolute(p)) return p;
    const wsDir = process.env['BUILD_WORKSPACE_DIRECTORY'];
    if (wsDir) {
        const candidate = path.resolve(wsDir, p);
        if (fs.existsSync(candidate) || !fs.existsSync(p)) return candidate;
    }
    return path.resolve(p);
};

const args = process.argv.slice(2);
let jsonOut: string | null = null;
let comparePath: string | null = null;
const files: string[] = [];

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && args[i + 1]) {
        jsonOut = resolvePath(args[++i]);
    } else if (args[i] === '--compare' && args[i + 1]) {
        comparePath = resolvePath(args[++i]);
    } else {
        files.push(args[i]);
    }
}

const targetFiles =
    files.length > 0
        ? files
        : DEFAULT_RUNFILE_BUNDLES.filter((f) => fs.existsSync(f));

if (targetFiles.length === 0) {
    console.error('No bundle files found to measure.');
    process.exit(1);
}

const bundles = targetFiles.map(measureFile);
const total = bundles.reduce(
    (acc, b) => ({
        rawBytes: acc.rawBytes + b.rawBytes,
        gzipBytes: acc.gzipBytes + b.gzipBytes,
        brotliBytes: acc.brotliBytes + b.brotliBytes,
    }),
    { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 }
);

const report: SizeReport = { bundles, total };

if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

const baseline: SizeReport | null = comparePath
    ? JSON.parse(fs.readFileSync(comparePath, 'utf8'))
    : null;

printReport(report, baseline);
