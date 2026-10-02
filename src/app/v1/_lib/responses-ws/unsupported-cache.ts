/**
 * Short-TTL diagnostic cache for provider endpoints that rejected the
 * OpenAI Responses WebSocket protocol.
 *
 * Definitive protocol rejections populate this cache. It never suppresses
 * routing attempts: the next eligible request still probes WS before HTTP.
 * Not persisted to Redis or disk; a process restart clears the diagnostics.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type Entry = {
  expiresAt: number;
  reason: string;
};

const cache = new Map<string, Entry>();

function buildKey(providerId: number, endpointId: number | null | undefined): string {
  return `${providerId}:${endpointId ?? "default"}`;
}

export function markResponsesWsUnsupported(
  providerId: number,
  endpointId: number | null | undefined,
  reason: string,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  cache.set(buildKey(providerId, endpointId), {
    expiresAt: Date.now() + Math.max(1000, ttlMs),
    reason,
  });
}

export function isResponsesWsUnsupported(
  providerId: number,
  endpointId: number | null | undefined
): { unsupported: boolean; reason?: string } {
  const key = buildKey(providerId, endpointId);
  const entry = cache.get(key);
  if (!entry) return { unsupported: false };
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return { unsupported: false };
  }
  return { unsupported: true, reason: entry.reason };
}

export function clearResponsesWsUnsupportedCache(): void {
  cache.clear();
}
