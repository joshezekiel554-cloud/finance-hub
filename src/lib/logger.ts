import os from "node:os";
import { pino, type Logger, type LoggerOptions } from "pino";
import { env } from "./env.js";

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["set-cookie"]',
];

let cached: Logger | undefined;

export function createLogger(extraBindings: Record<string, unknown> = {}): Logger {
  if (cached) return cached.child(extraBindings);

  const isDev = env.NODE_ENV === "development";
  const level = env.LOG_LEVEL ?? (isDev ? "debug" : "info");

  const opts: LoggerOptions = {
    level,
    base: {
      app: "finance-hub",
      env: env.NODE_ENV,
      host: os.hostname(),
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (isDev) {
    cached = pino({
      ...opts,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,app,env,host",
          singleLine: false,
        },
      },
    });
  } else {
    cached = pino(opts);
  }

  return cached.child(extraBindings);
}

export const logger = createLogger();
