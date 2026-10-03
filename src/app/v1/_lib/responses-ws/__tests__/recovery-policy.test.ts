import { describe, expect, it } from "vitest";
import { ProxyError, ResponsesWsContinuationError } from "../../proxy/errors";
import type { ProxySession } from "../../proxy/session";
import { ensureInternalSecret } from "../internal-secret";
import { shouldRecoverResponsesWsFailure } from "../recovery-policy";
const session = () =>
  ({
    headers: new Headers({
      "x-cch-client-transport": "websocket",
      "x-cch-responses-ws-forward": "1",
      "x-cch-internal-secret": ensureInternalSecret(),
    }),
    request: { message: { store: false, previous_response_id: "resp_previous" } },
    clientAbortSignal: null,
  }) as unknown as ProxySession;
describe("Responses WS failure recovery policy", () => {
  it.each([502, 503, 504, 524, 408, 429])("recovers status %s on a continuation", (status) => {
    expect(shouldRecoverResponsesWsFailure(session(), new ProxyError("diagnostic", status))).toBe(
      true
    );
  });
  it.each([400, 401, 403, 404, 413, 422, 499])("preserves status %s", (status) => {
    expect(shouldRecoverResponsesWsFailure(session(), new ProxyError("diagnostic", status))).toBe(
      false
    );
  });
  it("recovers explicitly lost context but leaves plain local failures intact", () => {
    expect(
      shouldRecoverResponsesWsFailure(
        session(),
        new ResponsesWsContinuationError("ws_error_pre_first_event")
      )
    ).toBe(true);
    expect(shouldRecoverResponsesWsFailure(session(), new Error("local error"))).toBe(false);
  });
  it("preserves client cancellation and complete requests", () => {
    const request = session();
    Object.assign(request, { clientAbortSignal: AbortSignal.abort() });
    expect(shouldRecoverResponsesWsFailure(request, new ProxyError("diagnostic", 524))).toBe(false);
    Object.assign(request, { clientAbortSignal: null });
    delete request.request.message.previous_response_id;
    expect(shouldRecoverResponsesWsFailure(request, new ProxyError("diagnostic", 524))).toBe(false);
  });
});
