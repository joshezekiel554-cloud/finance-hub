// SSE route. Single endpoint per connected user — every page on the
// frontend shares one EventSource and dispatches events through React
// Query invalidations or component-level handlers via the
// `useEventStream` hook.
//
// Auth: requireAuth gates the connection; only authenticated users can
// subscribe. The broker is keyed on user.id so events are naturally
// scoped — there's no cross-user leakage.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";

const eventsRoute: FastifyPluginAsync = async (app) => {
  app.get("/stream", async (req, reply) => {
    const user = await requireAuth(req);

    // SSE handshake. Important headers:
    //   - Content-Type: text/event-stream — without this, browsers treat
    //     the response as a normal request and buffer/close it.
    //   - Cache-Control: no-cache, no-transform — proxies (nginx) buffer
    //     by default; no-transform stops gzip from accumulating.
    //   - Connection: keep-alive — must remain open for the lifetime of
    //     the subscription.
    //   - X-Accel-Buffering: no — nginx-specific opt-out from response
    //     buffering, otherwise events trickle out in 4-8KB chunks.
    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();

    // Initial event so the client knows the channel is open. React's
    // useEventStream uses this to clear "connecting…" state.
    reply.raw.write(
      `data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`,
    );

    const unsubscribe = app.sseBroker.subscribe(user.id, reply);

    // Tear down on either side closing. `req.raw.on('close')` fires on
    // client disconnect; the onClose hook on Fastify itself fires on
    // graceful shutdown. Both unsubscribe defensively (the broker
    // tolerates a double-unsubscribe — second call is a no-op).
    req.raw.on("close", () => {
      unsubscribe();
    });

    // Tell Fastify NOT to send a normal reply — we own the response
    // stream from here. Returning the raw response prevents Fastify from
    // appending its own body or closing the connection.
    return reply;
  });
};

export default eventsRoute;
