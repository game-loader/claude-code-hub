import { isLocalCapacityError } from "@/lib/memory/governor";
import { normalizeResponsesWsRecoveryEvent } from "../../../../../server-lib/responses-ws-recovery";
import { ProxyError, ResponsesWsContinuationError } from "../proxy/errors";
import type { ProxySession } from "../proxy/session";
import { isResponsesWsContinuationRequest } from "./continuation-routing";

export { normalizeResponsesWsRecoveryEvent };

export function shouldRecoverResponsesWsFailure(session: ProxySession, error: unknown): boolean {
  if (
    !isResponsesWsContinuationRequest(session.headers, session.request.message) ||
    session.clientAbortSignal?.aborted ||
    isLocalCapacityError(error)
  )
    return false;
  if (error instanceof ResponsesWsContinuationError) return true;
  return (
    error instanceof ProxyError &&
    (error.statusCode >= 500 || [408, 429].includes(error.statusCode))
  );
}
