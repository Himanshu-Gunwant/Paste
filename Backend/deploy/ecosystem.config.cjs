// PM2 process definitions (docs/ARCHITECTURE.md §17).
// API runs as two fork instances (ports offset by PM2's NODE_APP_INSTANCE);
// the worker runs as a single dedicated process.
module.exports = {
  apps: [
    {
      name: 'paste-api',
      script: 'dist/server.js',
      instances: 2,
      exec_mode: 'fork',
      kill_timeout: 10000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        LOG_LEVEL: 'info',
      },
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'paste-worker',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      // Workers drain queues on SIGTERM; give them room (§17).
      kill_timeout: 30000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      out_file: 'logs/worker-out.log',
      error_file: 'logs/worker-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
