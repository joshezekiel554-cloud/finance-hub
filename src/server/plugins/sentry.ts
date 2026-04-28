import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "~/lib/env.js";
import { logger } from "~/lib/logger.js";

interface SentryLike {
  init: (opts: { dsn: string; environment?: string; tracesSampleRate?: number }) => void;
  captureException: (
    err: unknown,
    ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ) => void;
}

async function sentryPluginImpl(app: FastifyInstance): Promise<void> {
  if (!env.SENTRY_DSN) {
    logger.debug("sentry: SENTRY_DSN unset — Sentry hook disabled");
    return;
  }

  let Sentry: SentryLike;
  try {
    // Conditional import: project may not have @sentry/node installed.
    // Annotate as `any` to satisfy TS when the package is absent at typecheck time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ "@sentry/node" as string);
    Sentry = (mod.default ?? mod) as SentryLike;
  } catch (err) {
    logger.warn(
      { err },
      "sentry: SENTRY_DSN set but @sentry/node not installed — install it to enable error reporting",
    );
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 1.0,
  });

  logger.info({ env: env.NODE_ENV }, "sentry: initialized");

  // Capture 5xx errors. `onError` fires before the error handler has set
  // reply.statusCode, so derive status from the error itself (defaults to
  // 500 — anything without an explicit statusCode is a real server error).
  app.addHook("onError", async (req: FastifyRequest, _reply: FastifyReply, err) => {
    const e = err as { statusCode?: number; status?: number };
    const status = e.statusCode ?? e.status ?? 500;
    if (status >= 500) {
      Sentry.captureException(err, {
        tags: {
          method: req.method,
          url: req.url ?? "",
          status: String(status),
        },
        extra: { request_id: req.id },
      });
    }
  });
}

export const sentryPlugin = fp(sentryPluginImpl, { name: "sentry" });
