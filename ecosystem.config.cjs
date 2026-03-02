module.exports = {
  apps: [
    {
      name: 'server',
      script: './run-server.sh',
      watch: [
        'assets',
      ],
      ignore_watch: [
        'node_modules',
        'bazel-*',
      ],
    },
  ],
};
