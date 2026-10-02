import { afterEach, describe, expect, it, vi } from "vitest";
import { isResponsesWsContinuationRequest } from "../continuation-routing";

describe("Responses WS continuation identification", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("requires the trusted tunnel and a nonempty previous response ID", () => {
    vi.stubEnv("CCH_RESPONSES_WS_INTERNAL_SECRET", "test-only-secret");
    const headers = new Headers({
      "x-cch-client-transport": "websocket",
      "x-cch-responses-ws-forward": "1",
      "x-cch-internal-secret": "test-only-secret",
    });
    expect(isResponsesWsContinuationRequest(headers, { previous_response_id: "resp_1" })).toBe(
      true
    );
    for (const body of [null, {}, { previous_response_id: "" }, { previous_response_id: 42 }]) {
      expect(isResponsesWsContinuationRequest(headers, body)).toBe(false);
    }
    headers.delete("x-cch-internal-secret");
    expect(isResponsesWsContinuationRequest(headers, { previous_response_id: "resp_1" })).toBe(
      false
    );
    expect(isResponsesWsContinuationRequest(undefined, { previous_response_id: "resp_1" })).toBe(
      false
    );
    expect(
      isResponsesWsContinuationRequest(new Headers(), { previous_response_id: "resp_1" })
    ).toBe(false);
  });
});
