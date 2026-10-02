import type { UpstreamWsFailure } from "./upstream-adapter";

/** Only complete requests may use this policy; continuations must recover context first. */
export function shouldReconnectResponsesWs(failure: UpstreamWsFailure): boolean {
  if (failure.cacheableAsUnsupported) return false;
  switch (failure.reason) {
    case "ws_closed_before_first_event":
      return true;
    case "ws_error_pre_first_event":
      // A slow first event, oversized payload or cancelled request will not
      // benefit from immediately spending the same wait budget a second time.
      return !/timeout|timed\s*out|too large|exceeded|aborted/i.test(failure.message ?? "");
    case "ws_upgrade_rejected":
      return /^HTTP (500|502|503|504)\b/.test(failure.message ?? "");
    default:
      return false;
  }
}
