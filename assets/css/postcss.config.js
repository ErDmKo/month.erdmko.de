const path = require('path');
const fs = require('fs');

module.exports = {
    plugins: [
        require('postcss-modules')({
            // Short deterministic hash: 6 chars of content hash
            generateScopedName: '_[hash:base64:6]',
            getJSON(_cssFileName, json) {
                // Write to minified/ so Bazel's out_dirs = ["minified"] captures it
                fs.mkdirSync('minified', { recursive: true });
                fs.writeFileSync(
                    path.join('minified', 'style.module.json'),
                    JSON.stringify(json, null, 2)
                );
            },
        }),
        require('cssnano')({
            preset: 'default',
        }),
    ],
};
