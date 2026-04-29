// In-process domain event bus.
//
// Why this exists: modules like the activity ingester or the (future)
// task service need to fan out "something happened" without knowing about
// the SSE broker, the audit log fan-out, or any other side-effect that
// might consume the event. The bus is the inversion-of-control layer —
// emitters publish; consumers subscribe at boot. Single process only;
// if we ever need cross-process delivery, swap the EventEmitter for
// Redis pub/sub with the same API.

import { EventEmitter } from "node:events";

export type DomainEventMap = {
  "activity.created": {
    activityId: string;
    customerId: string;
    kind: string;
  };
  "task.created": { taskId: string; customerId: string | null };
  "task.updated": { taskId: string; customerId: string | null };
  "task.completed": { taskId: string; customerId: string | null };
  "comment.created": {
    commentId: string;
    parentType: string;
    parentId: string;
  };
  mention: {
    mentionedUserId: string;
    byUserId: string;
    parentType: string;
    parentId: string;
    excerpt: string;
  };
};

class TypedEventBus {
  private inner = new EventEmitter();

  // Setting a moderate max — most modules will register a handful of
  // listeners. Above ~20 we'd be doing something wrong (like adding a
  // listener per request); the warning surfaces leaks.
  constructor() {
    this.inner.setMaxListeners(50);
  }

  emit<K extends keyof DomainEventMap>(type: K, payload: DomainEventMap[K]): void {
    this.inner.emit(type, payload);
  }

  on<K extends keyof DomainEventMap>(
    type: K,
    handler: (payload: DomainEventMap[K]) => void,
  ): () => void {
    const wrapped = handler as (...args: unknown[]) => void;
    this.inner.on(type, wrapped);
    return () => this.inner.off(type, wrapped);
  }
}

export const events = new TypedEventBus();
