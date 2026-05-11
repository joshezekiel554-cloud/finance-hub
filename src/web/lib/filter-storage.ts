// src/web/lib/filter-storage.ts
//
// Scoped localStorage for URL search-param state. Keyed by user + route
// so collaborators sharing a browser don't pollute each other.

const PREFIX = "finance-hub:filters";

function key(userId: string, routePath: string): string {
  return `${PREFIX}:${userId}:${routePath}`;
}

export function readFilterStorage<T extends Record<string, unknown>>(
  userId: string,
  routePath: string,
): T | null {
  try {
    const raw = localStorage.getItem(key(userId, routePath));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeFilterStorage(
  userId: string,
  routePath: string,
  value: Record<string, unknown>,
): void {
  try {
    localStorage.setItem(key(userId, routePath), JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled — silently no-op.
  }
}

export function clearFilterStorage(userId: string, routePath: string): void {
  try {
    localStorage.removeItem(key(userId, routePath));
  } catch {
    // No-op.
  }
}
