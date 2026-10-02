import type { ProviderChainItem } from "@/types/message";
import { isActualRequest } from "./provider-chain-formatter";

type UpstreamTransport = "websocket" | "http";

export function getUsageLogTransport(
  chain: ProviderChainItem[] | null | undefined
): UpstreamTransport | null {
  if (!chain?.length) return null;
  let finalIndex = chain.findLastIndex((item) => item.reason === "hedge_winner");
  if (finalIndex < 0) finalIndex = chain.findLastIndex(isActualRequest);
  if (finalIndex < 0) {
    finalIndex = chain.findLastIndex((item) => item.reason === "responses_ws_attempted");
  }
  if (finalIndex < 0) return null;

  const final = chain[finalIndex];
  if ("upstreamTransport" in final) return final.upstreamTransport ?? null;

  // Older rows only recorded WS decisions. Scope them to the final attempt;
  // late hedge losers and earlier retries must not change the winner's tag.
  for (let index = finalIndex; index >= 0; index--) {
    const item = chain[index];
    if (item.id !== final.id) continue;
    if (index !== finalIndex && isActualRequest(item)) break;
    if (
      (final.routingAttemptId &&
        item.routingAttemptId &&
        final.routingAttemptId !== item.routingAttemptId) ||
      (final.attemptNumber != null &&
        item.attemptNumber != null &&
        final.attemptNumber !== item.attemptNumber) ||
      (final.endpointId != null && item.endpointId != null && final.endpointId !== item.endpointId)
    )
      continue;
    if (item.reason === "responses_ws_fallback") return "http";
    if (item.reason === "responses_ws_attempted") return "websocket";
  }

  // An actual HTTP status is enough evidence for legacy ordinary HTTP rows.
  // Rejections before dispatch and rows without a decision chain stay unknown.
  return final.statusCode != null && final.statusCode > 0 ? "http" : null;
}
