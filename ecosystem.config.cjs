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
    // BullMQ worker process. Separate node process so sync work doesn't take
    // the web server down on a crash, and so memory caps can be tuned
    // independently. Activated in week 3 by bullmq-engineer.
    {
      name: "finance-hub-worker",
      cwd: "/home/deploy/finance-hub",
      script: "dist/jobs/worker.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      merge_logs: true,
      restart_delay: 4000,
      max_restarts: 10,
    },
  ],
};
