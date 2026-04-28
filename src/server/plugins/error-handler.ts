import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { ZodError } from "zod";
import { env } from "~/lib/env.js";

interface HttpishError extends Error {
  statusCode?: number;
  status?: number;
  code?: string;
}

function isProd(): boolean {
  return env.NODE_ENV === "production";
}

export async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id;

    if (err instanceof ZodError) {
      req.log.warn(
        {
          err,
          request_id: requestId,
          validation_issues: err.issues,
          url: req.url,
          method: req.method,
        },
        "validation error",
      );
      reply.code(400).send({
        error: "validation_error",
        message: "Request validation failed",
        request_id: requestId,
        issues: err.issues,
      });
      return;
    }

    const httpErr = err as HttpishError;
    const status = httpErr.statusCode ?? httpErr.status ?? 500;

    if (status >= 500) {
      req.log.error(
        {
          err,
          request_id: requestId,
          url: req.url,
          method: req.method,
        },
        "request failed",
      );

      reply.code(status).send({
        error: "internal_error",
        message: isProd() ? "Internal Server Error" : err.message,
        request_id: requestId,
        ...(httpErr.code ? { code: httpErr.code } : {}),
      });
      return;
    }

    // 4xx — expected, log as warn without stack noise
    req.log.warn(
      {
        request_id: requestId,
        status,
        code: httpErr.code,
        url: req.url,
        method: req.method,
        message: err.message,
      },
      "client error",
    );

    reply.code(status).send({
      error: codeForStatus(status),
      message: err.message,
      request_id: requestId,
      ...(httpErr.code ? { code: httpErr.code } : {}),
    });
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url ?? "";
    const isApiOrOAuth = url.startsWith("/api") || url.startsWith("/oauth");

    // In production, non-API routes fall back to the SPA's index.html so
    // client-side routing works on hard refresh. API/OAuth and all dev
    // requests get a structured JSON 404.
    if (isProd() && !isApiOrOAuth && req.method === "GET") {
      // @fastify/static decorates `reply.sendFile` when registered.
      const replyAny = reply as FastifyReply & { sendFile?: (p: string) => void };
      if (typeof replyAny.sendFile === "function") {
        replyAny.sendFile("index.html");
        return;
      }
    }

    req.log.warn(
      { request_id: req.id, url, method: req.method },
      "route not found",
    );
    reply.code(404).send({
      error: "not_found",
      message: `Route ${req.method} ${url} not found`,
      request_id: req.id,
    });
  });
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable_entity";
    case 429:
      return "rate_limited";
    default:
      return "client_error";
  }
}
