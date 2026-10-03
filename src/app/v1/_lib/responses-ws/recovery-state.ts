import { createHash } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
import type { ProxySession } from "../proxy/session";

const TTL_MS = 120_000;
const MAX_SCOPES = 4096;
const MAX_PROVIDERS = 16;
declare global {
  var __cchResponsesWsRecoveryState: Map<string, Map<number, number>> | undefined;
}
const cache = (globalThis.__cchResponsesWsRecoveryState ??= new Map<string, Map<number, number>>());

async function withinRedisBudget<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("responses_ws_recovery_redis_timeout")), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recoveryKey(session: ProxySession): string | null {
  if (session.originalFormat && session.originalFormat !== "response") return null;
  const keyId = session.authState?.key?.id;
  const identity =
    session.headers?.get("thread-id") ??
    session.headers?.get("session_id") ??
    session.headers?.get("session-id") ??
    session.sessionId;
  if (keyId == null || !identity) return null;
  const model = session.getOriginalModel() ?? session.request.message.model;
  return `cch:responses-ws-recovery:${createHash("sha256")
    .update(JSON.stringify([keyId, identity, model]))
    .digest("hex")}`;
}

function prune(): void {
  for (const [key, providers] of cache) {
    for (const [id, expires] of providers) if (expires <= Date.now()) providers.delete(id);
    if (providers.size === 0) cache.delete(key);
  }
  while (cache.size > MAX_SCOPES) cache.delete(cache.keys().next().value!);
}

/** Redis preserves the short exclusion across reconnects/workers; local state covers outages. */
export async function rememberResponsesWsRecoveryFailure(
  session: ProxySession,
  providerId: number
): Promise<void> {
  const key = recoveryKey(session);
  if (!key || !Number.isInteger(providerId) || providerId <= 0) return;
  prune();
  const providers = cache.get(key) ?? new Map<number, number>();
  providers.set(providerId, Date.now() + TTL_MS);
  while (providers.size > MAX_PROVIDERS) providers.delete(providers.keys().next().value!);
  cache.set(key, providers);
  prune();
  try {
    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (redis?.status === "ready") {
      await withinRedisBudget(
        redis
          .multi()
          .zadd(key, Date.now() + TTL_MS, providerId)
          .expire(key, TTL_MS / 1000)
          .exec()
      );
    }
  } catch {
    // Recovery must still work when Redis is unavailable.
  }
}

export async function getResponsesWsRecoveryExcludedProviderIds(
  session: ProxySession
): Promise<number[]> {
  const key = recoveryKey(session);
  if (!key) return [];
  prune();
  const providers = new Set(cache.get(key)?.keys());
  try {
    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (redis?.status === "ready") {
      const ids = await withinRedisBudget(
        redis.zrangebyscore(key, Date.now() + 1, "+inf", "LIMIT", 0, MAX_PROVIDERS)
      );
      for (const value of ids) {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) providers.add(id);
      }
    }
  } catch {
    // Process-local exclusions are sufficient to preserve recovery on this worker.
  }
  return [...providers];
}

export function clearResponsesWsRecoveryStateForTests(): void {
  cache.clear();
}
