import { getEnvConfig } from "@/lib/config/env.schema";

export function getResponsesWsFirstEventTimeoutMs(providerTimeoutMs = 0): number {
  return Math.max(getEnvConfig().RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS ?? 90_000, providerTimeoutMs);
}
