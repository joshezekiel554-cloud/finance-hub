// pm2 process config for the VPS (mirrors orders.feldart.com pattern).
// .cjs extension because pm2 expects CommonJS and our package.json sets type: "module".

module.exports = {
  apps: [
    {
      name: "finance-hub",
      cwd: "/home/deploy/finance-hub",
      script: "dist/server/server.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: "3001",
      },
      max_memory_restart: "1G",
      merge_logs: true,
      // Auto-restart on crash with exponential backoff
      restart_delay: 4000,
      max_restarts: 10,
    },
    // BullMQ worker process — added in week 4 when the first cron job lands.
    // Will be a separate node process: `node dist/jobs/worker.js`.
    // Commented out until the schema + queue infra is ready.
    // {
    //   name: "finance-hub-worker",
    //   cwd: "/home/deploy/finance-hub",
    //   script: "dist/jobs/worker.js",
    //   exec_mode: "fork",
    //   instances: 1,
    //   env: { NODE_ENV: "production" },
    //   max_memory_restart: "512M",
    //   merge_logs: true,
    // },
  ],
};
