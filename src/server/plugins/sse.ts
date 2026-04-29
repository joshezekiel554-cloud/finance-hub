// In-memory SSE broker, exposed as a Fastify decorator.
//
// Pattern: any backend module that mutates state worth pushing
// (activities, tasks, comments, mentions) calls
// `app.sseBroker.publish(userId, event)`. The broker fans out to every
// open EventSource for that user. Cross-process (clustered pm2) is NOT
// supported — single-process server only. If we ever need multi-process,
// swap the in-memory Map for Redis pub/sub keyed on the same userId; the
// publish API stays the same.
//
// Authentication is enforced at the route layer (`/api/events/stream`),
// which only registers a writer for the *currently logged-in* user. The
// broker itself doesn't know about auth — it just fans out by userId.

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply } from "fastify";
import { events } from "../../lib/events.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "sse-broker" });

// Discriminated union of every event type the front-end might subscribe
// to. Adding a new event = add a member here + a `publish` call from the
// emitting module. The payloads are deliberately minimal — clients that
// need full detail re-fetch via the existing API (React Query
// invalidation pattern), so we don't have to worry about staleness.
export type SSEEvent =
  | {
      type: "activity.created";
      activityId: string;
      customerId: string;
      kind: string;
    }
  | { type: "task.created"; taskId: string; customerId: string | null }
  | { type: "task.updated"; taskId: string; customerId: string | null }
  | { type: "task.completed"; taskId: string; customerId: string | null }
  | { type: "task.deleted"; taskId: string; customerId: string | null }
  | {
      type: "comment.created";
      commentId: string;
      parentType: string;
      parentId: string;
    }
  | {
      type: "comment.updated";
      commentId: string;
      parentType: string;
      parentId: string;
    }
  | {
      type: "comment.deleted";
      commentId: string;
      parentType: string;
      parentId: string;
    }
  | {
      type: "mention";
      mentionedUserId: string;
      byUserId: string;
      parentType: string;
      parentId: string;
      excerpt: string;
    }
  | { type: "ping"; ts: number };

export type SSEBroker = {
  // Register a writer for a user. Returns an unsubscribe function the
  // caller MUST invoke when the connection closes — otherwise the writer
  // leaks and we'll keep trying to write into a dead socket.
  subscribe: (userId: string, reply: FastifyReply) => () => void;
  // Fan out to every subscriber for the given user. No-op if the user
  // has zero open connections (offline / not subscribed).
  publish: (userId: string, event: SSEEvent) => void;
  // Broadcast to ALL connected users. Use sparingly — most events are
  // user-scoped. Currently only used by the heartbeat.
  publishAll: (event: SSEEvent) => void;
  // Active connection count, exposed for /health surfaces and tests.
  size: () => { users: number; connections: number };
};

declare module "fastify" {
  interface FastifyInstance {
    sseBroker: SSEBroker;
  }
}

function createBroker(): SSEBroker {
  const subscribers = new Map<string, Set<FastifyReply>>();

  function send(reply: FastifyReply, event: SSEEvent): boolean {
    try {
      // SSE message format: each event is `data: <json>\n\n`. Multiple
      // newlines after the payload mark message boundary. Adding `event:`
      // would let clients listen by name; we just use the discriminator
      // inside the JSON instead.
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch (err) {
      // Socket likely closed; the unsubscribe should fire from the close
      // handler in the route, but we defensively return false here so the
      // broker can prune.
      log.warn({ err }, "sse write failed");
      return false;
    }
  }

  return {
    subscribe(userId, reply) {
      let set = subscribers.get(userId);
      if (!set) {
        set = new Set();
        subscribers.set(userId, set);
      }
      set.add(reply);
      log.debug(
        { userId, conns: set.size },
        "sse subscriber registered",
      );
      return () => {
        const s = subscribers.get(userId);
        if (!s) return;
        s.delete(reply);
        if (s.size === 0) subscribers.delete(userId);
        log.debug(
          { userId, conns: s.size },
          "sse subscriber unregistered",
        );
      };
    },

    publish(userId, event) {
      const set = subscribers.get(userId);
      if (!set || set.size === 0) return;
      for (const reply of set) send(reply, event);
    },

    publishAll(event) {
      for (const set of subscribers.values()) {
        for (const reply of set) send(reply, event);
      }
    },

    size() {
      let connections = 0;
      for (const set of subscribers.values()) connections += set.size;
      return { users: subscribers.size, connections };
    },
  };
}

export const ssePlugin = fp(async function ssePlugin(app: FastifyInstance) {
  const broker = createBroker();
  app.decorate("sseBroker", broker);

  // Heartbeat every 25 seconds. Keeps intermediate proxies (nginx
  // default proxy_read_timeout is 60s) from dropping idle SSE
  // connections, and gives clients a steady "still alive" signal so
  // they can detect a dead server quicker than waiting for the next
  // real event.
  const HEARTBEAT_MS = 25_000;
  const interval = setInterval(() => {
    broker.publishAll({ type: "ping", ts: Date.now() });
  }, HEARTBEAT_MS);
  // Allow the process to exit cleanly without the heartbeat keeping it
  // alive. Fastify's app.close() doesn't know about this timer.
  interval.unref();

  // Bridge from the in-process domain event bus to connected clients.
  // Activity events fan out to ALL users (the customer detail page
  // filters client-side); task/comment/mention events do too for now,
  // and the relevant components filter on customerId / mentionedUserId.
  // When we add per-user routing (e.g., notifications addressed only to
  // the assignee), switch publishAll → broker.publish(userId, …).
  const offActivity = events.on("activity.created", (e) => {
    broker.publishAll({ type: "activity.created", ...e });
  });
  const offTaskCreated = events.on("task.created", (e) => {
    broker.publishAll({ type: "task.created", ...e });
  });
  const offTaskUpdated = events.on("task.updated", (e) => {
    broker.publishAll({ type: "task.updated", ...e });
  });
  const offTaskCompleted = events.on("task.completed", (e) => {
    broker.publishAll({ type: "task.completed", ...e });
  });
  const offTaskDeleted = events.on("task.deleted", (e) => {
    broker.publishAll({ type: "task.deleted", ...e });
  });
  const offComment = events.on("comment.created", (e) => {
    broker.publishAll({ type: "comment.created", ...e });
  });
  const offCommentUpdated = events.on("comment.updated", (e) => {
    broker.publishAll({ type: "comment.updated", ...e });
  });
  const offCommentDeleted = events.on("comment.deleted", (e) => {
    broker.publishAll({ type: "comment.deleted", ...e });
  });
  const offMention = events.on("mention", (e) => {
    // Mentions ARE per-user — only push to the mentioned user. They'll
    // see a toast / bell badge from this. The other listeners use
    // publishAll because everyone benefits from seeing the timeline
    // update; mentions are personal.
    broker.publish(e.mentionedUserId, { type: "mention", ...e });
  });

  app.addHook("onClose", async () => {
    clearInterval(interval);
    offActivity();
    offTaskCreated();
    offTaskUpdated();
    offTaskCompleted();
    offTaskDeleted();
    offComment();
    offCommentUpdated();
    offCommentDeleted();
    offMention();
  });
});
