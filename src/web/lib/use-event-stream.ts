// React hook + module singleton for the SSE connection. ONE EventSource
// per browser tab regardless of how many components subscribe — every
// page in the app shares the same stream and dispatches events through
// per-type subscribers.
//
// Why module-level: re-mounting a hook (route change, React Strict Mode
// double-invoke, etc.) shouldn't tear down and rebuild the connection.
// We open it on the first subscription and keep it for the page lifetime.

import { useEffect, useRef } from "react";

// Mirrors the discriminated union in src/server/plugins/sse.ts. Keep in
// sync — when adding a new event type to the server, add it here.
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

export type SSEEventType = SSEEvent["type"];
type Listener<T extends SSEEventType> = (
  event: Extract<SSEEvent, { type: T }>,
) => void;

// Singleton state. The connection is lazy: first subscription opens it.
let source: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
const listeners = new Map<SSEEventType, Set<Listener<SSEEventType>>>();

function dispatch(event: SSEEvent): void {
  const set = listeners.get(event.type);
  if (!set) return;
  for (const fn of set) {
    try {
      (fn as Listener<typeof event.type>)(event);
    } catch (err) {
      console.error("[sse] listener threw", err);
    }
  }
}

function totalListeners(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

function open(): void {
  if (source) return;
  reconnectAttempt = 0;
  source = new EventSource("/api/events/stream");
  source.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as SSEEvent;
      dispatch(ev);
    } catch (err) {
      console.warn("[sse] bad message", err, msg.data);
    }
  };
  source.onerror = () => {
    // EventSource auto-reconnects on its own with the browser's default
    // backoff (3s in most), but on hard errors (auth, server gone) it
    // stays in CLOSED. We add explicit exponential backoff so a server
    // restart during dev doesn't hammer with reconnects.
    if (source?.readyState === EventSource.CLOSED) {
      teardown();
      const delay = Math.min(30_000, 1_000 * Math.pow(2, reconnectAttempt));
      reconnectAttempt++;
      reconnectTimer = window.setTimeout(() => {
        if (totalListeners() > 0) open();
      }, delay);
    }
  };
}

function teardown(): void {
  if (source) {
    source.close();
    source = null;
  }
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// React hook. Call inside any component that wants to react to a given
// event type. The handler is debounced to its latest closure via a ref
// so callers don't have to memoize.
export function useEventStream<T extends SSEEventType>(
  type: T,
  handler: Listener<T>,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const wrapped: Listener<SSEEventType> = (event) => {
      // Type-narrow via the ref — the indirection lets the latest
      // closure run without needing to re-subscribe each render.
      // The double-cast is required because TS can't relate the generic
      // T to the broader union; the runtime invariant is that dispatch
      // only routes events of matching type to this listener.
      (handlerRef.current as unknown as Listener<SSEEventType>)(event);
    };
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(wrapped);
    open();

    return () => {
      const s = listeners.get(type);
      if (!s) return;
      s.delete(wrapped);
      if (s.size === 0) listeners.delete(type);
      if (totalListeners() === 0) teardown();
    };
  }, [type]);
}
