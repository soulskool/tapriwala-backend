/**
 * PM2 process definition for the single-VPS deployment.
 *
 *   npm run build && pm2 start ecosystem.config.cjs && pm2 save
 *
 * One instance, deliberately. Socket.IO rooms live in this process's memory,
 * so running a second instance would mean a kitchen tablet connected to worker
 * B never hears an order placed through worker A. Going multi-instance is what
 * the Redis adapter is for — that is a Phase 2 decision, not a config tweak.
 */
module.exports = {
  apps: [
    {
      name: 'acd-cafe-api',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 12000,
    },
  ],
};
