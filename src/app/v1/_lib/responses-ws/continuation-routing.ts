import { hasResponsesWsContinuation } from "./continuation";
import { isWebsocketClientRequest } from "./eligibility";

export function isResponsesWsContinuationRequest(
  headers: Headers | undefined,
  body: Record<string, unknown> | null
): boolean {
  return Boolean(hasResponsesWsContinuation(body) && headers && isWebsocketClientRequest(headers));
}
